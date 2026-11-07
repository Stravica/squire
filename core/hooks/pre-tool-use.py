"""Squire's safety floor, run by Claude Code before every tool call.

Reads the hook event as JSON on stdin. Exit 0 lets the call through; exit 2
blocks it, with the reason on stderr for Squire to tell the owner. A call
the floor cannot class as free waits for the owner's yes to that one call.
A job that has taken in untrusted input and the owner's private things may
not also act out in the world. Squire's own files, its config, the
approvals ledger, Claude Code's settings in the owner's folder and the
Keychain are never the session's to change or read, yes or no. Anything
the floor cannot read or trust blocks the call.
"""

import fnmatch
import glob
import hashlib
import json
import os
import shlex
import subprocess
import sys
import time
from urllib.parse import urlsplit

CORE = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
PYTHON = '/usr/bin/python3'

try:
    sys.path.insert(0, os.path.join(CORE, 'lib'))
    from squire import Config, Ledger, Paths, SquireError
except Exception:
    sys.stderr.write("Squire's safety floor cannot load its core library, so this tool call is blocked.\n")
    sys.exit(2)


class ShellCommand:
    """A Bash command split into its simple commands. It is plain when it
    holds nothing but words joined by ;, &&, || or |: no redirection, no
    substitution, no subshell, no background job, one line."""

    JOINS = {';', '&&', '||', '|'}
    OPERATOR_CHARS = set('();<>|&')

    def __init__(self, text):
        self.segments = []
        self.plain = not any(mark in text for mark in ('\n', '\r', '`', '$('))
        lexer = shlex.shlex(text, posix=True, punctuation_chars=True)
        lexer.whitespace_split = True
        try:
            tokens = list(lexer)
        except ValueError:
            tokens, self.plain = text.split(), False
        segment = []
        for token in tokens:
            if token and set(token) <= self.OPERATOR_CHARS:
                if token not in self.JOINS:
                    self.plain = False
                if token in self.JOINS or token == '&':
                    self.segments.append(segment)
                    segment = []
            else:
                segment.append(token)
        self.segments.append(segment)
        self.segments = [s for s in self.segments if s]


class Floor:
    """Judges one tool call against the owner's folder, Squire's home and
    the approvals ledger, and decides it."""

    FREE_COMMANDS = {'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'stat', 'file', 'pwd', 'date', 'find', 'echo', 'printf'}
    FIND_ACTIONS = {'-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprint0', '-fprintf', '-fls'}
    DRAFT_TOOLS = {'mcp__claude_ai_Gmail__create_draft'}
    PRIVATE = ('operator', 'state', 'reference', os.path.join('workspace', 'files'))

    NEVER_FLOOR = ('Squire\'s safety floor: the session may never change Squire\'s core, Squire\'s home and config, '
                   'the approvals ledger or Claude Code\'s settings, yes or no: {what}')
    NEVER_KEYCHAIN = ('The session may never read the Keychain, yes or no: a secret reaches a tool only through '
                      'Squire\'s secret helper, and is never shown.')
    ASK = ('Request {id}: this needs the owner\'s yes first: {what}\n'
           'Ask the owner and wait for their answer; a yes covers this one action, once.')
    OPEN = (' Open requests in this job: {ids}. With more than one open, the owner answers one by naming it, '
            'as yes or no followed by its request.')
    SPLIT = ('Squire will not do this as one job: it has taken in untrusted input ({untrusted}) and read the '
             'owner\'s private things ({private}), and this would act out in the world: {what}\n'
             'Split the work: end this job here, then start a new job holding only what the action needs; '
             'it will wait for the owner\'s yes.')

    def __init__(self, config, cwd):
        self.config = config
        self.cwd = cwd
        self.owner = config.owner_folder
        self.cores = [CORE, Paths.canonical(os.path.join(config.home, 'core'), cwd)]
        self.floor_paths = [os.path.realpath(config.home), CORE, config.ledger_path]
        self.keychain = Paths.canonical(config.keychain, cwd) if config.keychain else None
        self.private = [os.path.join(self.owner, p) for p in self.PRIVATE]
        self.inbox = os.path.join(self.owner, 'workspace', 'inbox')

    @classmethod
    def handle(cls, raw):
        """The hook: the event's bytes in, (exit code, reason) out."""
        try:
            event = json.loads(raw.decode('utf-8'))
        except ValueError:
            return 2, 'Squire\'s safety floor could not read this tool call (the event is not JSON), so it is blocked.'
        if not isinstance(event, dict) or event.get('hook_event_name') != 'PreToolUse':
            return 2, 'Squire\'s safety floor was given an event that is not a PreToolUse event, so the call is blocked.'
        tool, session, data = event.get('tool_name'), event.get('session_id'), event.get('tool_input', {})
        cwd = event.get('cwd') or os.getcwd()
        if not isinstance(tool, str) or not tool or not isinstance(session, str) or not session \
                or not isinstance(data, dict) or not isinstance(cwd, str):
            return 2, 'Squire\'s safety floor could not read this tool call (its tool, job or input is missing), so it is blocked.'
        floor = cls(Config(), cwd)
        return floor.decide(session, tool, data)

    def decide(self, session, tool, data):
        verdict, what, taints = self.judge(tool, data)
        if verdict == 'never':
            return 2, what
        try:
            with Ledger(self.config.ledger_path) as ledger:
                return self.settle(ledger, session, tool, data, verdict, what, taints)
        except SquireError as e:
            return 2, f'Squire\'s safety floor is closed: {e}, so this is blocked' + (f': {what}' if what else '.')

    def settle(self, ledger, session, tool, data, verdict, what, taints):
        """Decides a call against the ledger, held under its lock. A web fetch
        is free until the job holds the owner's private things; from then on
        its path or host can carry them out as well as its query can, and the
        floor cannot tell which do, so it is a send."""
        now = time.time()
        held = ledger.taints(session)
        if verdict == 'fetch':
            verdict = 'ask' if held['private'] else 'free'
        if verdict == 'free':
            for kind, source in taints:
                ledger.taint(session, kind, source, now)
            return 0, ''
        if held['untrusted'] and held['private']:
            return 2, self.SPLIT.format(untrusted='; '.join(held['untrusted']), private='; '.join(held['private']), what=what)
        item = self.item(tool, data)
        approved = ledger.approval(session, item, now, self.config.timeout)
        if approved:
            ledger.append({'type': 'use', 'request': approved['id'], 'at': now})
            for kind, source in taints:
                ledger.taint(session, kind, source, now)
            return 0, ''
        pending = ledger.open_requests(session, now, self.config.timeout)
        mine = next((r for r in pending if r.get('item') == item), None)
        if mine is None:
            mine = ledger.request(session, item, now)
            pending.append(mine)
        reason = self.ASK.format(id=mine['id'], what=what)
        if len(pending) > 1:
            reason += self.OPEN.format(ids=', '.join(r['id'] for r in pending))
        return 2, reason

    @staticmethod
    def item(tool, data):
        """One call is one item: the same tool and input, whatever the order
        of its keys; a Bash description is not part of it."""
        if tool == 'Bash':
            data = {k: v for k, v in data.items() if k != 'description'}
        text = json.dumps([tool, data], sort_keys=True, ensure_ascii=False, separators=(',', ':'))
        return hashlib.sha256(text.encode('utf-8')).hexdigest()

    def judge(self, tool, data):
        """('free' | 'fetch' | 'ask' | 'never', what to say, [(kind, source)] the job takes in when it runs)."""
        if tool == 'Bash':
            return self.judge_bash(self.field(data, 'command'))
        if tool in ('Read', 'Glob', 'Grep'):
            given = self.field(data, 'file_path') if tool == 'Read' else (data.get('path') or self.cwd)
            path = self.path(given)
            if self.is_keychain(path):
                return 'never', self.NEVER_KEYCHAIN, []
            return 'free', '', self.taints_of(path, f'{tool} {given}')
        if tool in ('Write', 'Edit', 'MultiEdit', 'NotebookEdit'):
            given = self.field(data, 'notebook_path' if tool == 'NotebookEdit' else 'file_path')
            path = self.path(given)
            if self.is_keychain(path):
                return 'never', self.NEVER_KEYCHAIN, []
            if self.is_floor(path):
                return 'never', self.NEVER_FLOOR.format(what=f'{tool} {given}'), []
            if tool == 'Write' and Paths.within(path, self.owner) and not os.path.lexists(path):
                return 'free', '', []
            return 'ask', f'{tool} {given}', []
        if tool == 'WebFetch':
            url = self.field(data, 'url')
            fetched = [('untrusted', f'WebFetch {url}')]
            return ('ask' if urlsplit(url).query else 'fetch'), f'WebFetch {url}', fetched
        if tool == 'WebSearch':
            return 'free', '', [('untrusted', f'WebSearch {self.field(data, "query")}')]
        if tool in self.DRAFT_TOOLS:
            return 'free', '', []
        return 'ask', f'{tool} {json.dumps(data, sort_keys=True, ensure_ascii=False)}', [('untrusted', tool)]

    def judge_bash(self, command):
        shell = ShellCommand(command)
        verdicts = [self.judge_argv(argv, shell.plain) for argv in shell.segments]
        never = next((v for v in verdicts if v[0] == 'never'), None)
        if never:
            return never[0], never[1].format(what=command), []
        taints = [t for v in verdicts for t in v[2]]
        if shell.plain and all(v[0] == 'free' for v in verdicts):
            return 'free', '', taints
        if os.path.basename(self.config.ledger_path).lower() in command.lower():
            return 'never', self.NEVER_FLOOR.format(what=command), []
        return 'ask', command, taints

    def judge_argv(self, argv, plain=True):
        """One simple command, as its words. In a command that is not plain,
        any word may be a redirection's target, so none may name the floor."""
        if not argv:
            return 'free', '', []
        if argv[0] == PYTHON and len(argv) >= 2:
            script = self.path(argv[1], strict=False)
            if self.is_core_tool(script, 'secret.py') and argv[2:3] == ['run']:
                # A tool handed a secret is not read-only, whatever it is: the
                # run is asked, naming the secret and the command it wraps.
                rest = argv[3:]
                wrapped = rest[rest.index('--') + 1:] if '--' in rest else []
                verdict, what, taints = self.judge_argv(wrapped, plain)
                name = rest[0] if rest else ''
                return ('never' if verdict == 'never' else 'ask'), what, \
                    taints + [('private', f'the secret {name} through Squire\'s secret helper')]
            if self.is_core_tool(script, 'health.py') and len(argv) == 2:
                return 'free', '', []
        words = argv + [t.split('=', 1)[1] for t in argv if '=' in t]
        paths = [p for p in (self.path(t, strict=False) for t in words) if p]
        if os.path.basename(argv[0]) == 'security' or any(self.is_keychain(p) for p in paths):
            return 'never', self.NEVER_KEYCHAIN, []
        free = self.is_free(argv)
        if (not free or not plain) and any(self.is_floor(p) for p in paths):
            return 'never', self.NEVER_FLOOR, []
        if not free:
            return 'ask', '', []
        taints = []
        for word in argv[1:]:
            if word.startswith('-'):
                continue
            for given in self.expand(word):
                path = self.path(given, strict=False)
                if path:
                    taints += self.taints_of(path, ' '.join(argv))
        return 'free', '', taints

    def expand(self, word):
        """The paths a shell word names: what a glob in it matches, or the word."""
        if not any(mark in word for mark in '*?['):
            return [word]
        return glob.glob(os.path.join(self.cwd, os.path.expanduser(word))) or [word]

    def is_free(self, argv):
        command, args = argv[0], argv[1:]
        if command in self.FREE_COMMANDS:
            return command != 'find' or not self.FIND_ACTIONS.intersection(args)
        if command == 'brew':
            return args[:1] in (['list'], ['info'], ['search'])
        if command == 'pip3':
            return args[:1] in (['show'], ['list'])
        return False

    def is_core_tool(self, path, name):
        return bool(path) and any(path.lower() == os.path.join(core, 'tools', name).lower() for core in self.cores)

    def is_floor(self, path):
        return any(Paths.within(path, floor) for floor in self.floor_paths) or self.is_settings(path)

    def is_settings(self, path):
        """Claude Code's settings for a folder in the owner's: a hook switched
        off there, or SQUIRE_HOME pointed elsewhere, would leave no floor."""
        folder, name = os.path.split(path.lower())
        return os.path.basename(folder) == '.claude' and fnmatch.fnmatchcase(name, 'settings*.json') \
            and Paths.within(path, self.owner)

    def is_keychain(self, path):
        return bool(self.keychain) and Paths.within(path, self.keychain)

    def taints_of(self, path, source):
        """What a read of path takes in: a read whose scope holds the owner's
        private things or the inbox, a folder above them included, takes them in."""
        found = []
        if any(Paths.overlap(path, private) for private in self.private):
            found.append(('private', source))
        if Paths.overlap(path, self.inbox) or self.quarantined(path):
            found.append(('untrusted', source))
        return found

    @staticmethod
    def quarantined(path):
        """Downloaded from the internet, as the Mac marks it."""
        if not os.path.exists(path):
            return False
        r = subprocess.run(['/usr/bin/xattr', '-p', 'com.apple.quarantine', path],
                           stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return r.returncode == 0

    def path(self, given, strict=True):
        try:
            return Paths.canonical(given, self.cwd)
        except (TypeError, ValueError, OSError):
            if strict:
                raise SquireError(f'the path {given!r} cannot be read')
            return None

    @staticmethod
    def field(data, key):
        value = data.get(key)
        if not isinstance(value, str):
            raise SquireError(f'the tool input has no {key}')
        return value


if __name__ == '__main__':
    try:
        code, message = Floor.handle(sys.stdin.buffer.read())
    except SquireError as e:
        code, message = 2, f'Squire\'s safety floor is closed: {e}. This tool call is blocked.'
    except Exception as e:
        code, message = 2, f'Squire\'s safety floor failed ({type(e).__name__}), so this tool call is blocked.'
    if message:
        sys.stderr.write(message + '\n')
    sys.exit(code)
