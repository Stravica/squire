"""Squire's safety floor, run by Claude Code before every tool call.

Reads the hook event as JSON on stdin. Exit 0 lets the call through; exit 2
blocks it, with the reason on stderr for Squire to tell the owner. A call
the floor cannot class as free waits for the owner's yes to that one call.
A job that has taken in untrusted input and the owner's private things may
not also act out in the world. A read is marked by the literal paths it
reaches; a plain read the floor cannot resolve may be put to a small model,
and otherwise waits for the owner's yes. Squire's own files, its config, the
approvals ledger, Claude Code's settings in the owner's folder and the
Keychain are never the session's to change or read, yes or no. Anything
the floor cannot read or trust blocks the call.
"""

import fnmatch
import glob
import hashlib
import json
import os
import re
import select
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
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


class Word(str):
    """One word of a shell command, its quotes taken off. It is literal when
    zsh would pass it on as written: no pattern, brace, variable, escape or
    other expansion, and a ~ only as the home folder at its start."""

    def __new__(cls, text, literal=True):
        word = super().__new__(cls, text)
        word.literal = literal
        return word


class ShellCommand:
    """A Bash command as zsh reads it, split into its simple commands, each
    a list of words. It is plain when it holds nothing but words joined by
    ;, &&, || or |: no redirection, no substitution, no subshell, no
    background job, one line, every quote closed."""

    WORD_CHARS = set('/._-+,:@%=')
    ENDS = set(' \t\n\r;&|<>()')

    def __init__(self, text):
        self.plain = True
        self.segments = [[]]
        chars, literal, started = [], True, False

        def end():
            nonlocal chars, literal, started
            if started:
                self.segments[-1].append(Word(''.join(chars), literal))
            chars, literal, started = [], True, False

        def join():
            end()
            self.segments.append([])

        def take(quoted):
            # Quoted characters are word characters; a quoted ~ at the start
            # is a file named ~, which the floor does not resolve.
            nonlocal literal, started
            if not started and quoted.startswith('~'):
                literal = False
            chars.extend(quoted)
            started = True

        i, n = 0, len(text)
        while i < n:
            c = text[i]
            if c in ' \t':
                end()
            elif c in '\n\r':
                self.plain = False
                join()
            elif c == "'":
                close = text.find("'", i + 1)
                if close < 0:
                    self.plain, close = False, n
                take(text[i + 1:close])
                i = close
            elif c == '"':
                j = i + 1
                while j < n and text[j] != '"':
                    if text[j] in '$`\\':
                        literal = False
                        if text[j] == '`' or text.startswith('$(', j):
                            self.plain = False
                        if text[j] == '\\':
                            j += 1
                    j += 1
                if j >= n:
                    self.plain = False
                take(text[i + 1:j])
                i = j
            elif c == '\\':
                literal = False
                take(text[i + 1:i + 2])
                i += 1
            elif c in ';&|':
                if text[i:i + 2] in ('&&', '||'):
                    i += 1
                elif c == '&' or text[i + 1:i + 2] in (';', '&', '|'):
                    # A background job, a pipe of errors, a case's ends, &> or &|.
                    self.plain = False
                join()
            elif c in '<>':
                # A redirection: its target stays a word of the command.
                self.plain = False
                end()
            elif c == '(' and not started and not self.segments[-1]:
                self.plain = False
                join()
            elif c == '(':
                # zsh's (a|b) alternation inside a word: one unresolved word.
                depth, j = 0, i
                while j < n:
                    depth += {'(': 1, ')': -1}.get(text[j], 0)
                    if depth == 0:
                        break
                    j += 1
                if j >= n:
                    self.plain, j = False, n - 1
                chars.extend(text[i:j + 1])
                literal, started = False, True
                i = j
            elif c == ')' or c == '`' or text.startswith('$(', i):
                # A command substitution's commands are simple commands of
                # their own.
                self.plain = False
                join()
                i += 1 if c == '$' else 0
            else:
                if c == '$':
                    literal = False
                elif c == '~':
                    literal = literal and not started and (i + 1 == n or text[i + 1] == '/' or text[i + 1] in self.ENDS)
                elif c == '=':
                    literal = literal and started
                elif not (c.isalnum() or c in self.WORD_CHARS):
                    literal = False
                chars.append(c)
                started = True
            i += 1
        end()
        self.segments = [s for s in self.segments if s]


class SmallModel:
    """The small model, asked one question about a plain read the floor
    cannot resolve: does the command, run from the working folder, read
    anything under the inbox? Only the claude command line Claude Code's
    installer lays down is run, never one found on PATH, and it is given the
    command, the working folder and the inbox's place, nothing else."""

    PLACES = ('~/.local/bin/claude', '/usr/local/bin/claude', '/opt/homebrew/bin/claude')
    PER_JOB = 3
    DEADLINE = 10
    MOST = 1024
    RULE = 'Answer with one word: yes, no or unsure.'
    QUESTION = ('The inbox folder is: {inbox}\n'
                'The working folder is: {cwd}\n'
                'The command, run by zsh from the working folder, is:\n{command}\n'
                'Does this command read anything under the inbox folder? Answer yes, no or unsure.\n')
    ARGS = ['-p', '--model', 'haiku', '--safe-mode', '--tools', '', '--setting-sources', '', '--strict-mcp-config',
            '--no-session-persistence', '--output-format', 'text', '--system-prompt', RULE]

    def __init__(self, program):
        self.program = program

    @classmethod
    def find(cls):
        """The first claude in the fixed places whose file (the target of a
        link) is the hook's user's own and not writable by anyone; or None."""
        for place in cls.PLACES:
            target = os.path.realpath(os.path.expanduser(place))
            try:
                st = os.stat(target)
            except OSError:
                continue
            if stat.S_ISREG(st.st_mode) and st.st_uid == os.getuid() and not st.st_mode & stat.S_IWOTH:
                return cls(target)
        return None

    def ask(self, command, cwd, inbox):
        """'yes', 'no' or 'unsure'. The call leads its own process group, and
        the whole group is killed when the call ends, at the deadline at the
        latest; only a process that exited 0 within the deadline answers."""
        question = self.QUESTION.format(inbox=inbox, cwd=cwd, command=command)
        with tempfile.TemporaryFile() as given:
            given.write(question.encode('utf-8'))
            given.seek(0)
            try:
                child = subprocess.Popen([self.program] + self.ARGS, stdin=given, stdout=subprocess.PIPE,
                                         stderr=subprocess.DEVNULL, start_new_session=True)
            except OSError:
                return 'unsure'
        try:
            out = self.output(child)
        finally:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except OSError:
                pass
            child.wait()
            child.stdout.close()
        answer = out.decode('utf-8', 'replace').strip().lower() if out is not None else ''
        return answer if answer in ('yes', 'no', 'unsure') else 'unsure'

    def output(self, child):
        """What the child printed, once it has exited 0 within the deadline;
        else None. The floor never waits for its output to close: a process
        it started may hold it open."""
        deadline = time.monotonic() + self.DEADLINE
        fd, out, reading = child.stdout.fileno(), b'', True
        while child.poll() is None:
            left = deadline - time.monotonic()
            if left <= 0:
                return None
            if not reading:
                time.sleep(min(left, 0.05))
                continue
            if select.select([fd], [], [], min(left, 0.05))[0]:
                chunk = os.read(fd, 4096)
                out += chunk
                reading = bool(chunk) and len(out) <= self.MOST
        while reading and len(out) <= self.MOST and select.select([fd], [], [], 0)[0]:
            chunk = os.read(fd, 4096)
            out += chunk
            reading = bool(chunk)
        if child.returncode != 0 or len(out) > self.MOST:
            return None
        return out


class Floor:
    """Judges one tool call against the owner's folder, Squire's home and
    the approvals ledger, and decides it."""

    FREE_COMMANDS = {'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'stat', 'file', 'pwd', 'date', 'find', 'echo', 'printf'}
    FIND_ACTIONS = {'-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprint0', '-fprintf', '-fls'}
    FREE_TOOLS = {'mcp__claude_ai_Gmail__create_draft', 'Agent'}
    SEND_TOOLS = {'mcp__claude_ai_Gmail__send_message'}
    PRIVATE = ('operator', 'state', 'reference', os.path.join('workspace', 'files'))

    # The reads the floor resolves to literal paths, by command: its options
    # that take no value, the options that take the next word, and the
    # options that make it read a folder's whole tree. find has its own.
    READS = {
        'cat': ('benstuv', '', ''),
        'head': ('', 'nc', ''),
        'tail': ('r', 'nc', ''),
        'wc': ('lwcm', '', ''),
        'grep': ('riclnhHvwxosqEF', 'e', 'rR'),
        'ls': ('laAh1RtrSdF', '', 'R'),
        'stat': ('lsxq', 'f', ''),
        'file': ('biIh', '', ''),
    }
    FIND_EXPRESSION = {'-name': 1, '-iname': 1, '-type': 1, '-maxdepth': 1, '-mindepth': 1, '-mtime': 1, '-size': 1,
                       '-print': 0, '!': 0, '-not': 0, '-a': 0, '-and': 0, '-o': 0, '-or': 0}
    LISTED = set(READS) | {'find'}
    # The commands that read no file: the options each may take.
    TEXT = {'echo': {'-n'}, 'printf': set(), 'pwd': {'-L', '-P'}, 'date': {'-u'}}
    QUARANTINE = 'com.apple.quarantine'
    # A call has its outcome within 12 seconds, and the small model may take
    # 10 of them; the walks of one call's trees for download marks share one
    # second. A tree not walked in that time is a read the floor cannot
    # resolve.
    WALK = 1.0

    NEVER_FLOOR = ('Squire\'s safety floor: the session may never change Squire\'s core, Squire\'s home and config, '
                   'the approvals ledger or Claude Code\'s settings, yes or no: {what}')
    NEVER_KEYCHAIN = ('The session may never read the Keychain, yes or no: a secret reaches a tool only through '
                      'Squire\'s secret helper, and is never shown.')
    ASK = ('Request {id}: this needs the owner\'s yes first: {what}\n'
           'Ask the owner and wait for their answer; a yes covers this one action, once.')
    OPEN = (' Open requests in this job: {ids}. With more than one open, the owner answers one by naming it, '
            'as yes or no followed by its request.')
    HOLDS = ' This job holds the owner\'s private things: {private}.'
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
        self.walk_left = self.WALK

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
            if verdict == 'model':
                verdict, taints = self.consult(session, self.item(tool, data), what, taints)
            with Ledger(self.config.ledger_path) as ledger:
                return self.settle(ledger, session, tool, data, verdict, what, taints)
        except SquireError as e:
            return 2, f'Squire\'s safety floor is closed: {e}, so this is blocked' + (f': {what}' if what else '.')

    def consult(self, session, item, command, taints):
        """A plain read the floor cannot resolve. A bare no from the small
        model lets it run, the job holding the owner's private things; a bare
        yes lets it run as an inbox read. Anything else, no claude, a yes the
        owner already gave, or a job past its calls, leaves it to the owner,
        and once it runs the job holds untrusted input and private things.
        The ledger is not held while the model is asked."""
        both = [('untrusted', command), ('private', command)]
        model = SmallModel.find()
        if model is None:
            return 'ask', taints + both
        now = time.time()
        with Ledger(self.config.ledger_path) as ledger:
            if ledger.approval(session, item, now, self.config.timeout) or \
                    ledger.model_calls(session) >= SmallModel.PER_JOB:
                return 'ask', taints + both
            ledger.model_call(session, now)
        answer = model.ask(command, self.cwd, self.inbox)
        if answer == 'no':
            return 'free', taints + [('private', command)]
        return ('free' if answer == 'yes' else 'ask'), taints + both

    def settle(self, ledger, session, tool, data, verdict, what, taints):
        """Decides a call against the ledger, held under its lock. A web fetch
        is free until the job holds the owner's private things; from then on
        its path or host can carry them out as well as its query can, and the
        floor cannot tell which do, so it is a send. A web search is free
        until the job holds untrusted input and private things; then its
        words can carry them out, so it is refused as one job."""
        now = time.time()
        held = ledger.taints(session)
        if verdict == 'fetch':
            verdict = 'ask' if held['private'] else 'free'
        if verdict == 'search':
            verdict = 'ask' if held['untrusted'] and held['private'] else 'free'
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
        if held['private']:
            reason += self.HOLDS.format(private='; '.join(held['private']))
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
        """('free' | 'fetch' | 'search' | 'model' | 'ask' | 'never', what to
        say, [(kind, source)] the job takes in when it runs)."""
        if tool == 'Bash':
            return self.judge_bash(self.field(data, 'command'))
        if tool in ('Read', 'Glob', 'Grep'):
            given = self.field(data, 'file_path') if tool == 'Read' else (data.get('path') or self.cwd)
            path = self.path(given)
            if self.is_keychain(path):
                return 'never', self.NEVER_KEYCHAIN, []
            pattern = str(data.get('pattern', ''))
            if tool == 'Glob' and (os.path.isabs(os.path.expanduser(pattern)) or '..' in pattern.split('/')):
                # A pattern that is absolute or climbs out of its folder: the
                # floor cannot resolve what it reads.
                source = f'Glob {pattern}'
                return 'ask', f'Glob {json.dumps(data, sort_keys=True, ensure_ascii=False)}', \
                    [('untrusted', source), ('private', source)]
            source = f'{tool} {given}'
            taints = self.taints_of(path, source, recursive=tool != 'Read')
            if any(kind == 'unresolved' for kind, _ in taints):
                # A tree too large to walk for download marks in time.
                return 'ask', f'{tool} {json.dumps(data, sort_keys=True, ensure_ascii=False)}', \
                    [('untrusted', source), ('private', source)]
            return 'free', '', taints
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
            searched = f'WebSearch {self.field(data, "query")}'
            return 'search', searched, [('untrusted', searched)]
        if tool in self.FREE_TOOLS:
            return 'free', '', []
        what = f'{tool} {json.dumps(data, sort_keys=True, ensure_ascii=False)}'
        if tool in self.SEND_TOOLS:
            return 'ask', what, []
        # A tool the floor does not know: it cannot tell what the tool reads.
        return 'ask', what, [('untrusted', tool), ('private', tool)]

    def judge_bash(self, command):
        """A command the list resolves is free and marked by its paths; a
        plain read it cannot resolve is the small model's or the owner's
        ('model'); a listed command that is not the Mac's own is asked and,
        once it runs, the job holds untrusted input and private things; any
        other program is asked and, once it runs, the job holds private
        things. Literal paths keep their marks throughout."""
        shell = ShellCommand(command)
        verdicts = [self.judge_argv(argv, shell.plain) for argv in shell.segments]
        never = next((v for v in verdicts if v[0] == 'never'), None)
        if never:
            return never[0], never[1].format(what=command), []
        taints = [t for v in verdicts for t in v[2]]
        kinds = {v[0] for v in verdicts}
        if shell.plain and kinds <= {'free'}:
            return 'free', '', taints
        if os.path.basename(self.config.ledger_path).lower() in command.lower():
            return 'never', self.NEVER_FLOOR.format(what=command), []
        if shell.plain and kinds <= {'free', 'model'}:
            return 'model', command, taints
        run = [('untrusted', command), ('private', command)] if 'read' in kinds else [('private', command)]
        return 'ask', command, taints + run

    def judge_argv(self, argv, plain=True):
        """One simple command, as its words: ('free' | 'model' | 'read' |
        'ask' | 'never', what, taints). In a command that is not plain, any
        word may be a redirection's target, so none may name the floor."""
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
        words = argv + [t.split('=', 1)[1] for t in argv if '=' in t] + \
            [p for t in argv if not getattr(t, 'literal', True) for p in re.split(r'[\s()|<>;&`]+', t) if p]
        paths = [p for p in (self.path(t, strict=False) for t in words) if p]
        if os.path.basename(argv[0]) == 'security' or any(self.is_keychain(p) for p in paths):
            return 'never', self.NEVER_KEYCHAIN, []
        # A listed read named by its path, or shadowed on the hook's PATH:
        # the floor cannot know what it reads.
        elsewhere = os.path.basename(argv[0]) in self.LISTED and not self.is_mac_command(argv[0])
        free = self.is_free(argv) and not elsewhere
        if (not free or not plain) and any(self.is_floor(p) for p in paths):
            return 'never', self.NEVER_FLOOR, []
        # Every word of a program, or of a read the list cannot resolve, may
        # be a path: each literal path in it keeps its mark. A program's word
        # marks the job where it names the inbox or a private folder, or a
        # path in one; a folder holding them marks only a read.
        every = argv[1:] + [Word(t.split('=', 1)[1], getattr(t, 'literal', True)) for t in argv[1:] if '=' in t]
        if argv[0] == 'cd':
            return 'model', '', self.marks(argv, every, holding=False)
        if not free:
            return ('read', '', []) if elsewhere else ('ask', '', self.marks(argv, every, holding=False))
        verdict, operands, recursive = self.reach(argv)
        if verdict == 'model' and argv[0] not in self.TEXT:
            operands = every
        taints = self.marks(argv, operands, recursive)
        if any(kind == 'unresolved' for kind, _ in taints):
            # A tree too large to walk for download marks in time: a read the
            # floor cannot resolve, the owner's to allow, never the model's.
            return 'read', '', [t for t in taints if t[0] != 'unresolved']
        return verdict, '', taints

    def marks(self, argv, words, recursive=False, holding=True):
        """What these words take in as paths: a literal word is its path, an
        unresolved one the paths its glob matches; an empty word is none."""
        taints = []
        for word in words:
            for given in ([word] if getattr(word, 'literal', True) else self.expand(word)):
                path = self.path(given, strict=False) if given else None
                if path:
                    taints += self.taints_of(path, ' '.join(argv), recursive, holding)
        return taints

    def reach(self, argv):
        """A command on the free set, by the list: ('free' when the list
        resolves it, else 'model'; the operands it reads as paths; whether it
        reads their whole trees). Words that are not paths (a pattern, text
        to print) are never among them."""
        command, args = argv[0], argv[1:]
        clear = all(getattr(word, 'literal', True) for word in argv)
        if command in self.TEXT:
            return ('free' if clear and self.text_known(command, args) else 'model'), [], False
        if command in ('brew', 'pip3'):
            return 'free', [], False
        if command == 'find':
            return self.reach_find(args, clear)
        flags, valued, tree = self.READS[command]
        operands, recursive, known, pattern, ended = [], False, True, None, False
        i = 0
        while i < len(args):
            word = args[i]
            if ended or not word.startswith('-'):
                operands.append(word)
            else:
                # Past the first operand, a word beginning with - is unresolved.
                known = known and not operands
                recursive = recursive or not word.startswith('--') and any(letter in tree for letter in word[1:])
                if command == 'grep' and word == '--':
                    ended = True
                elif command in ('head', 'tail') and word[1:].isdigit():
                    pass
                elif len(word) == 2 and word[1] in valued and i + 1 < len(args):
                    i += 1
                    if word == '-e':
                        pattern = args[i]
                elif len(word) > 1 and all(letter in flags for letter in word[1:]):
                    pass
                else:
                    known = False
            i += 1
        if command == 'grep':
            # The pattern is the first operand unless -e gives it; with no
            # file or folder named, grep is unresolved.
            if pattern is None:
                operands = operands[1:]
            known = known and bool(operands)
        if command == 'ls' and not operands:
            operands = [Word('.')]
        return ('free' if known and clear else 'model'), operands, recursive

    def reach_find(self, args, clear):
        """find: its folders first, then an expression of the listed
        primaries. It reads each folder's whole tree."""
        paths = []
        while len(paths) < len(args) and not args[len(paths)].startswith('-') and args[len(paths)] != '!':
            paths.append(args[len(paths)])
        known, i = bool(paths), len(paths)
        while i < len(args):
            takes = self.FIND_EXPRESSION.get(args[i])
            if takes is None or i + takes >= len(args):
                known = False
            i += 1 + (takes or 0)
        return ('free' if known and clear else 'model'), paths, True

    def text_known(self, command, args):
        """echo, printf, pwd and date read no file: only their listed options,
        and date's +format operand."""
        allowed = self.TEXT[command]
        if command == 'pwd':
            return all(word in allowed for word in args)
        if command == 'date':
            return all(word in allowed or word.startswith('+') for word in args)
        for word in args:
            if not word.startswith('-'):
                break
            if word not in allowed:
                return False
        return True

    @staticmethod
    def is_mac_command(name):
        """The bare name the hook's own PATH finds in /bin or /usr/bin."""
        if '/' in name:
            return False
        found = shutil.which(name)
        return bool(found) and os.path.dirname(os.path.normpath(found)) in ('/bin', '/usr/bin')

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

    def taints_of(self, path, source, recursive=False, holding=True):
        """What a read of path takes in: a read whose scope holds the owner's
        private things or the inbox, a folder above them included (unless
        holding is False), takes them in; so does a read of anything
        downloaded from the internet. A tree the floor cannot walk in time
        is ('unresolved', source)."""
        found = []
        near = Paths.overlap if holding else Paths.within
        if any(near(path, private) for private in self.private):
            found.append(('private', source))
        downloaded = near(path, self.inbox) or self.quarantined(path, recursive)
        if downloaded is None:
            found.append(('unresolved', source))
        elif downloaded:
            found.append(('untrusted', source))
        return found

    def quarantined(self, path, recursive=False):
        """Downloaded from the internet, as the Mac marks it: the path or a
        folder above it, or, for a recursive read, anything in its tree, the
        links inside it not followed. None when the tree is not walked in
        the time this call's walks have left."""
        if not os.path.lexists(path):
            return False
        above = [path]
        while os.path.dirname(above[-1]) != above[-1]:
            above.append(os.path.dirname(above[-1]))
        quiet = {'stdin': subprocess.DEVNULL, 'stdout': subprocess.PIPE, 'stderr': subprocess.DEVNULL}
        if subprocess.run(['/usr/bin/xattr', '-s', '-p', self.QUARANTINE] + above, **quiet).stdout:
            return True
        if not (recursive and os.path.isdir(path)):
            return False
        if self.walk_left <= 0:
            return None
        started = time.monotonic()
        try:
            walk = subprocess.run(['/usr/bin/find', path, '-xattrname', self.QUARANTINE, '-print', '-quit'],
                                  timeout=self.walk_left, **quiet)
        except subprocess.TimeoutExpired:
            return None
        finally:
            self.walk_left -= time.monotonic() - started
        return bool(walk.stdout)

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
