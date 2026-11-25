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
the floor cannot read or trust blocks the call. Nothing spends beyond the
owner's plan: turning on usage credits or opening the upgrade page is
refused, yes or no, and a model outside the plan's set waits for the owner's
yes, its block naming usage credits. A big job starts only through Squire's
one job command, on the owner's yes, and on a second yes above 90% usage.
Squire's import and check-in commands run only as their one command, each on
the owner's yes to that run, and an import leaves its job holding untrusted
input. Each call of Squire's browser is asked on its own and leaves its job
holding untrusted input only; by default one that carries any of the
owner's details, runs a script in the page, sends a file, or is made while
the owner's details cannot be read is refused, yes or no.
"""

import fnmatch
import glob
import hashlib
import html
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
import unicodedata
from urllib.parse import unquote_plus, urlsplit

CORE = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
PYTHON = '/usr/bin/python3'

try:
    sys.path.insert(0, os.path.join(CORE, 'lib'))
    from squire import (HEAVY_JOBS, WINDOWS, Config, Ledger, Paths, Runtime, SquireError, paced_windows,
                        percent_words, read_usage, reset_words, second_yes_needed, youtube_link)
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


class FixRequest:
    """The request for one of the health check's known fixes, as the health
    check prints it: /usr/bin/python3 <Squire home>/core/tools/health.py
    --request runner|floor|sign-in, its path quoted or not (the default
    Squire home holds a space). The floor asks the owner for it, naming the
    one fault and its fix, and records the yes for the outside job; the
    request itself never runs in the session, yes or no, and the yes is left
    unused for the wake-ups scheduler, which makes the fix outside the
    session."""

    FIXES = {
        'runner': 'reload Squire\'s background jobs, the known fix for Squire\'s session runner not running',
        'floor': 'lay Squire\'s core down again from Squire\'s release folder, the known fix for a changed floor file',
        'sign-in': 'sign Squire in to Claude again before its sign-in ends (the sign-in page opens in the browser)',
    }
    APPROVED = ('The owner said yes to request {id}: {what}. Squire\'s scheduler makes this fix outside the session '
                'within a minute; the session never makes it, so nothing ran here.')

    @classmethod
    def of(cls, floor, tool, data):
        """The fault a Bash call asks to fix, or None."""
        command = data.get('command') if tool == 'Bash' else None
        if not isinstance(command, str):
            return None
        shell = ShellCommand(command)
        if not shell.plain or len(shell.segments) != 1:
            return None
        argv = shell.segments[0]
        if len(argv) < 4 or argv[0] != PYTHON or argv[-2] != '--request' or argv[-1] not in cls.FIXES \
                or not all(getattr(word, 'literal', True) for word in argv):
            return None
        script = floor.path(' '.join(argv[1:-2]), strict=False)
        return argv[-1] if floor.is_core_tool(script, 'health.py') else None

    @classmethod
    def settle(cls, ledger, session, fault, timeout):
        """Asks the owner, or, once the owner has said yes, blocks with the
        yes left for the outside job."""
        now = time.time()
        item = f'fix:{fault}'
        what = cls.FIXES[fault]
        approved = ledger.approval(session, item, now, timeout)
        if approved:
            return 2, cls.APPROVED.format(id=approved['id'], what=what)
        pending = ledger.open_requests(session, now, timeout)
        mine = next((r for r in pending if r.get('item') == item), None)
        if mine is None:
            mine = ledger.request(session, item, now)
            pending.append(mine)
        reason = Floor.ASK.format(id=mine['id'], what=what + '. Squire\'s scheduler makes it outside the session '
                                  'once the owner says yes')
        if len(pending) > 1:
            reason += Floor.OPEN.format(ids=', '.join(r['id'] for r in pending))
        return 2, reason


class ShownRequest:
    """The session's request to send a support ticket (ticket.py --send
    <ticket id>), as the health check prints it. It never runs in the
    session, yes or no. The floor asks the owner for it with a block that
    shows exactly what the yes approves: one line naming the request, then
    the outbox file's bytes, then one empty line and the words that make the
    session show that text inside one fenced code block. The request records
    what its block showed (the outbox file's and its state record's digest),
    so a yes binds only those bytes; the scheduler acts on it outside the
    session. Squire's updates are never asked for here: the session may
    never run Squire's update tool (Floor.NEVER_UPDATE)."""

    TOOLS = {'--send': 'ticket.py'}
    VALUES = {'--send': re.compile(r'^t-[0-9a-f]{32}\Z')}
    RELAY = ('Show the owner the text above inside a fenced code block: a line of three backticks with no language name, '
             'then the text exactly as written, unchanged, with nothing added inside the fence, then a line of three '
             'backticks. Your own words go only outside the fence. Then wait for their answer.')
    APPROVED = ('The owner said yes to request {id}: {what}. Squire\'s scheduler does this outside the session within a '
                'minute; the session never does, so nothing ran here.')

    @classmethod
    def of(cls, floor, tool, data):
        """(flag, value) for a Bash call that is one of these requests, or None."""
        command = data.get('command') if tool == 'Bash' else None
        if not isinstance(command, str):
            return None
        shell = ShellCommand(command)
        if not shell.plain or len(shell.segments) != 1:
            return None
        argv = shell.segments[0]
        if len(argv) < 4 or argv[0] != PYTHON or argv[-2] not in cls.TOOLS \
                or not all(getattr(word, 'literal', True) for word in argv):
            return None
        script = floor.path(' '.join(argv[1:-2]), strict=False)
        if not floor.is_core_tool(script, cls.TOOLS[argv[-2]]) or not cls.VALUES[argv[-2]].match(argv[-1]):
            return None
        return argv[-2], str(argv[-1])

    @staticmethod
    def read(path):
        try:
            with open(path, 'rb') as f:
                return f.read()
        except OSError:
            return None

    @classmethod
    def shown(cls, home, flag, value):
        """(item, what, the text the block shows), or (None, why, None)."""
        data = cls.read(os.path.join(home, 'outbox', f'{value}.json'))
        state = cls.read(os.path.join(home, 'outbox', f'{value}.state.json'))
        try:
            text = data.decode('ascii') if data is not None else None
            digest = json.loads(state.decode('utf-8')).get('digest') if state is not None else None
        except (UnicodeDecodeError, ValueError, AttributeError):
            text, digest = None, None
        if text is None or not isinstance(digest, str) or '\r' in text:
            return None, f'Squire has no support ticket {value} waiting to send, so nothing was asked.', None
        return (f'ticket:{value}:{hashlib.sha256(data).hexdigest()}:{digest}',
                'send this support ticket to Squire\'s support intake, exactly as it follows', text.rstrip('\n'))

    @classmethod
    def settle(cls, floor, ledger, session, flag, value):
        item, what, text = cls.shown(floor.config.home, flag, value)
        if item is None:
            return 2, what
        now = time.time()
        approved = ledger.approval(session, item, now, floor.config.timeout)
        if approved:
            return 2, cls.APPROVED.format(id=approved['id'], what=what)
        pending = ledger.open_requests(session, now, floor.config.timeout)
        mine = next((r for r in pending if r.get('item') == item), None)
        if mine is None:
            mine = ledger.request(session, item, now)
            pending.append(mine)
        head = Floor.ASK.format(id=mine['id'], what=what)
        if len(pending) > 1:
            head += Floor.OPEN.format(ids=', '.join(r['id'] for r in pending))
        return 2, f'{head}\n{text}\n\n{cls.RELAY}'


class HeavyJob:
    """The start of a big job through Squire's one job command,
    /usr/bin/python3 '<Squire home>/core/tools/heavy-job.py'
    research|app|site|media, its path quoted as the health check's is. The
    floor asks the owner before every start, whatever the usage: the block's
    first line names the request and the big job, then the usage (each known
    window and when it resets; above the pacing lines, that the job can wait
    until then; or, when the usage is unknown, that Squire cannot see it),
    then the ask words. Its item is heavy:<class>; a yes covers that one
    start, once, and never another class. Above 90% in either known window,
    once the first yes is given, a second request (heavy:<class>:second)
    asks for a second yes, and the start runs only once both are given.
    Spelt any other way, the start is refused as any program naming Squire's
    home is (Floor.judge_argv)."""

    SCRIPT = 'heavy-job.py'
    ASK = 'Request {id}: this is a big job: {what}.'
    SECOND = ('Request {id}: usage is above 90% ({over}), so this big job needs a second yes from the owner before it '
              'starts: {what}.')
    WAIT = 'Ask the owner and wait for their answer; a yes covers this one start, once.'
    UNKNOWN = 'Squire cannot see the plan\'s usage right now, so it cannot say how much of the plan this job will leave.'
    DEFER = ('This big job can wait: {over}. It can wait until then; it starts now only on the owner\'s yes.')

    @classmethod
    def of(cls, floor, tool, data):
        """The class of big job a Bash call starts through the one command,
        or None."""
        command = data.get('command') if tool == 'Bash' else None
        if not isinstance(command, str):
            return None
        shell = ShellCommand(command)
        if not shell.plain or len(shell.segments) != 1:
            return None
        argv = shell.segments[0]
        if len(argv) < 3 or argv[0] != PYTHON or argv[-1] not in HEAVY_JOBS \
                or not all(getattr(word, 'literal', True) for word in argv):
            return None
        script = floor.path(' '.join(argv[1:-1]), strict=False)
        return str(argv[-1]) if floor.is_core_tool(script, cls.SCRIPT) else None

    @classmethod
    def usage(cls, usage, now):
        """The block's words on the plan's usage."""
        if usage is None:
            return cls.UNKNOWN
        shown = [f'{name} is at {percent_words(usage[key]["usedPercent"])} and resets {reset_words(usage[key]["resetsAt"], now)}'
                 for key, name, _ in WINDOWS if usage.get(key)]
        words = 'Usage of the plan now: ' + ('; '.join(shown) if shown else 'no window can be read right now') + '.'
        paced = paced_windows(usage)
        if paced:
            over = '; '.join(f'{name} is at {percent_words(window["usedPercent"])}, above {percent_words(line)}, and '
                             f'resets {reset_words(window["resetsAt"], now)}'
                             for key, name, window in paced for k, _, line in WINDOWS if k == key)
            words += '\n' + cls.DEFER.format(over=over)
        return words

    @staticmethod
    def raised(ledger, session, item, now, timeout):
        """This job's open request for item, raised when there is none; and
        every open request in the job."""
        pending = ledger.open_requests(session, now, timeout)
        mine = next((r for r in pending if r.get('item') == item), None)
        if mine is None:
            mine = ledger.request(session, item, now)
            pending.append(mine)
        return mine, pending

    @classmethod
    def settle(cls, floor, ledger, session, kind):
        now, timeout = time.time(), floor.config.timeout
        what, item = HEAVY_JOBS[kind], f'heavy:{kind}'
        usage = read_usage(floor.config.home, now)
        first = ledger.approval(session, item, now, timeout)
        second = None
        if first is None:
            mine, pending = cls.raised(ledger, session, item, now, timeout)
            head = cls.ASK.format(id=mine['id'], what=what)
        elif second_yes_needed(usage):
            second = ledger.approval(session, item + ':second', now, timeout)
            if second is None:
                mine, pending = cls.raised(ledger, session, item + ':second', now, timeout)
                over = ', '.join(f'{name} at {percent_words(usage[key]["usedPercent"])}' for key, name, _ in WINDOWS
                                 if usage.get(key) and usage[key]['usedPercent'] > 90)
                head = cls.SECOND.format(id=mine['id'], over=over, what=what)
        if first is None or (second is None and second_yes_needed(usage)):
            if len(pending) > 1:
                head += Floor.OPEN.format(ids=', '.join(r['id'] for r in pending))
            return 2, f'{head}\n{cls.usage(usage, now)}\n{cls.WAIT}'
        held = ledger.taints(session)
        if held['untrusted'] and held['private']:
            return 2, Floor.SPLIT.format(untrusted='; '.join(held['untrusted']), private='; '.join(held['private']),
                                         what=f'start a big job: {what}')
        for request in (first, second):
            if request:
                ledger.append({'type': 'use', 'request': request['id'], 'at': now})
        return 0, ''


class ImportRequest:
    """The session's import of the owner's notes, documents or another
    assistant's memory export through Squire's import command, run as this
    one command, its path quoted as the health check's is:
    /usr/bin/python3 '<Squire home>/core/tools/import-memory.py' <source>
    [<source> ...]. The floor asks the owner before every import, the
    question naming every source; a yes covers that one run, once. Once it
    runs, the job holds untrusted input: what an import takes in is words
    from elsewhere, kept in workspace/inbox/imported in the owner's folder.
    Spelt any other way, or naming a source in Squire's own files, the import
    is refused as any program naming Squire's home is (Floor.judge_argv)."""

    SCRIPT = 'import-memory.py'
    WHAT = ('take these into Squire\'s memory, copied into workspace/inbox/imported in the owner\'s folder and read as '
            'untrusted from then on: {sources}')

    @classmethod
    def of(cls, floor, tool, data):
        """The sources a Bash call imports through the one command, or None."""
        argv = Floor.one_command(tool, data)
        if argv is None or len(argv) < 3 or not floor.is_core_tool(floor.path(argv[1], strict=False), cls.SCRIPT):
            return None
        sources = [str(word) for word in argv[2:]]
        paths = [floor.path(source, strict=False) for source in sources]
        if any(p is None or floor.is_floor(p) or floor.is_keychain(p) for p in paths):
            return None
        return sources

    @classmethod
    def settle(cls, floor, ledger, session, sources):
        now = time.time()
        item = 'import:' + hashlib.sha256(json.dumps(sources).encode('utf-8')).hexdigest()
        approved = ledger.approval(session, item, now, floor.config.timeout)
        if approved:
            ledger.append({'type': 'use', 'request': approved['id'], 'at': now})
            ledger.taint(session, 'untrusted', 'the import of ' + ', '.join(sources), now)
            return 0, ''
        mine, pending = HeavyJob.raised(ledger, session, item, now, floor.config.timeout)
        reason = Floor.ASK.format(id=mine['id'], what=cls.WHAT.format(sources='; '.join(sources)))
        if len(pending) > 1:
            reason += Floor.OPEN.format(ids=', '.join(r['id'] for r in pending))
        return 2, reason


class CheckInRequest:
    """The session setting, changing or stopping one of the owner's
    check-ins through Squire's check-in command, run as this one command,
    its path quoted as the health check's is:
    /usr/bin/python3 '<Squire home>/core/tools/check-ins.py' set|change|stop|every
    <its words>. The floor asks the owner before every run, the question
    naming the times and the words; a yes covers that one run, once. Spelt
    any other way it is refused as any program naming Squire's home is
    (Floor.judge_argv)."""

    SCRIPT = 'check-ins.py'
    VERBS = {
        'set': (3, 'set a check-in at {0}: {1}'),
        'change': (3, 'move the check-in at {0} to {1}'),
        'stop': (2, 'stop the check-in at {0}'),
        'every': (5, 'set check-ins every {0} minutes from {1} to {2}: {3}'),
    }

    @classmethod
    def of(cls, floor, tool, data):
        """The words after the command a Bash call runs it with, or None."""
        argv = Floor.one_command(tool, data)
        if argv is None or len(argv) < 3 or argv[2] not in cls.VERBS \
                or not floor.is_core_tool(floor.path(argv[1], strict=False), cls.SCRIPT):
            return None
        return [str(word) for word in argv[2:]]

    @classmethod
    def what(cls, words):
        count, text = cls.VERBS[words[0]]
        if len(words) == count:
            return 'change the owner\'s check-ins: ' + text.format(*words[1:])
        return 'run Squire\'s check-in command with these words: ' + ' '.join(words)

    @classmethod
    def settle(cls, floor, ledger, session, words):
        now = time.time()
        item = 'check-in:' + hashlib.sha256(json.dumps(words).encode('utf-8')).hexdigest()
        approved = ledger.approval(session, item, now, floor.config.timeout)
        if approved:
            ledger.append({'type': 'use', 'request': approved['id'], 'at': now})
            return 0, ''
        mine, pending = HeavyJob.raised(ledger, session, item, now, floor.config.timeout)
        reason = Floor.ASK.format(id=mine['id'], what=cls.what(words))
        if len(pending) > 1:
            reason += Floor.OPEN.format(ids=', '.join(r['id'] for r in pending))
        return 2, reason


class MediaRequest:
    """The session's video and audio work through Squire's two media tools,
    each run as its one command, its path quoted as the health check's is,
    with its values after it: the transcription,
    /usr/bin/python3 '<Squire home>/core/tools/transcribe.py' <file>, and the
    video tool, /usr/bin/python3 '<Squire home>/core/tools/video.py' with
    clip <file> <from> <to>, audio <file> or smaller <file>. The floor asks
    the owner at every run, the question naming video and audio work: never
    free and never refused; a yes covers that one run, once. Once it runs,
    the job holds untrusted input (a transcript is words from elsewhere, and
    the video tool's answer names the owner's file), and the work on a file
    in the owner's private places holds those too. The transcription's
    --watch is the voice-notes job's own, run outside the session: from the
    session it is refused, as is either tool spelt any other way, another
    verb or another count of values (Floor.judge_argv)."""

    SCRIPTS = {
        'transcribe.py': 'turn a recording or video file into text on this Mac, kept as a note in workspace/transcripts '
                         'in the owner\'s folder: {arg}',
        'video.py': 'make {made} of a video of the owner\'s with Apple\'s avconvert on this Mac, as a new file in '
                    'workspace/files in the owner\'s folder, the original left as it was: {arg}',
    }
    # The video tool's verbs, with the count of values each takes.
    VERBS = {'clip': 4, 'audio': 2, 'smaller': 2}
    WHAT = 'video and audio work: {action}'

    @classmethod
    def of(cls, floor, tool, data):
        """(the tool's name, its values) when a Bash call runs one of the two
        tools as its one command, as Squire's instructions name it, or
        None."""
        argv = Floor.one_command(tool, data)
        if argv is None or len(argv) < 3:
            return None
        script = floor.path(argv[1], strict=False)
        values = tuple(str(word) for word in argv[2:])
        if floor.is_core_tool(script, 'transcribe.py'):
            name, given = 'transcribe.py', (values if len(values) == 1 else ())
        elif floor.is_core_tool(script, 'video.py'):
            name, given = 'video.py', (values[1:2] if len(values) == cls.VERBS.get(values[0], 0) else ())
        else:
            return None
        if not given or given[0].startswith('-') or not all(v.strip() for v in values):
            return None
        return name, values

    @classmethod
    def settle(cls, floor, ledger, session, asked):
        name, values = asked
        now = time.time()
        arg = values[-1] if name == 'transcribe.py' else values[1]
        made = {'clip': f'a clip from {values[2]} to {values[3]}' if len(values) == 4 else 'a clip',
                'audio': 'just the sound', 'smaller': 'a smaller copy'}.get(values[0], '')
        what = cls.WHAT.format(action=cls.SCRIPTS[name].format(arg=arg, made=made))
        item = 'media:' + hashlib.sha256(json.dumps([name, list(values)]).encode('utf-8')).hexdigest()
        approved = ledger.approval(session, item, now, floor.config.timeout)
        if approved:
            ledger.append({'type': 'use', 'request': approved['id'], 'at': now})
            source = ('the transcript of ' if name == 'transcribe.py' else 'the video tool\'s work on ') + arg
            given = floor.path(arg, strict=False)
            taints = [('untrusted', source)] + [(kind, source) for kind, _ in
                                                (floor.taints_of(given, source) if given else []) if kind == 'private']
            for kind, text in taints:
                ledger.taint(session, kind, text, now)
            return 0, ''
        mine, pending = HeavyJob.raised(ledger, session, item, now, floor.config.timeout)
        reason = Floor.ASK.format(id=mine['id'], what=what)
        if len(pending) > 1:
            reason += Floor.OPEN.format(ids=', '.join(r['id'] for r in pending))
        return 2, reason


class PageLink:
    """The session asking Squire's page server where the dashboard is, the
    one command Squire's instructions name for a link:
    /usr/bin/python3 '<Squire home>/core/tools/page-server.py' --where. It
    only reads where the page server already runs, so it is free, but only
    as that whole Bash command: the system python, the installed core's
    page-server.py by its full path, and --where alone. Inside a list, a
    pipeline, a subshell or a wrapper, with another interpreter, another
    argument or none, or by a relative path, the page server's script stays
    refused, yes or no, as any program naming Squire's home is
    (Floor.judge_argv): a session never starts a page server itself."""

    SCRIPT = 'page-server.py'

    @classmethod
    def of(cls, floor, tool, data):
        """True when a Bash call is exactly the link command, as its whole
        command."""
        argv = Floor.one_command(tool, data)
        if argv is None or len(argv) != 3 or argv[2] != '--where' or not os.path.isabs(argv[1]):
            return False
        return floor.is_core_tool(floor.path(argv[1], strict=False), cls.SCRIPT)


class VersionsCommand:
    """The session keeping, listing or getting back a version of what Squire
    builds, with Squire's versions command:
    /usr/bin/python3 '<Squire home>/core/tools/versions.py' keep|list '<folder>',
    or back '<folder>' <number>. It works on this Mac only, and going back
    first keeps any change not yet kept, so it is free and the job takes in
    nothing, but only as that whole Bash command, on one app's own folder
    (workspace/apps/<name> in the owner's folder, as the Mac resolves it).
    Any other folder, verb, word or option is refused, yes or no; spelt any
    other way the versions command stays refused, as any program naming
    Squire's home is (Floor.judge_argv)."""

    SCRIPT = 'versions.py'
    APPS = os.path.join('workspace', 'apps')
    NEVER = ('Squire\'s safety floor: Squire\'s versions command runs from the session only as the one command '
             'Squire\'s instructions name, with keep, list or back, one app\'s own folder in workspace/apps and, for '
             'back, one version number, yes or no. Nothing ran: {what}')

    @classmethod
    def of(cls, floor, tool, data):
        """None when the call is not the versions command as one plain
        command; else the floor's answer: (0, '') when it is free, (2, why)
        when it is refused."""
        argv = Floor.one_command(tool, data)
        if argv is None or not floor.is_core_tool(floor.path(argv[1], strict=False), cls.SCRIPT):
            return None
        verb, rest = argv[2:3], argv[3:]
        fits = (verb in (['keep'], ['list']) and len(rest) == 1) or \
            (verb == ['back'] and len(rest) == 2 and rest[1].isascii() and rest[1].isdigit())
        folder = floor.path(rest[0], strict=False) if fits and not rest[0].startswith('-') else None
        apps = os.path.join(floor.owner, cls.APPS)
        if folder and Paths.fold(os.path.dirname(folder)) == Paths.fold(apps) and os.path.isdir(folder):
            return 0, ''
        return 2, cls.NEVER.format(what=data.get('command'))


class WebsiteCommand:
    """Squire's website command as the session runs it, in its one plain
    spelling: /usr/bin/python3 '<Squire home>/core/tools/website.py' set-up
    <account id>, or deploy '<site folder>' <site name>. The set-up is asked,
    naming the account, each run on its own yes. A deploy goes live only as
    the owner previewed it and said yes to it. It is refused, yes or no,
    unless its folder is the site's own (workspace/sites/<site name> in the
    owner's folder, as the Mac resolves it) and that folder, as it now
    stands, is what the owner last previewed in this job: the preview check
    comes before where the site goes. Then it is asked, naming the site and
    the address it goes live at from the set-up's record in the Squire home,
    or saying the floor cannot tell where before the set-up has read the
    account; its item is the site's content as previewed, so a change after
    the yes needs a new preview and a new yes. A site is previewed by the one
    preview command (Python's http.server bound to the loopback, from the
    site's own folder): once the floor lets that run, it keeps the folder's
    content, by digest, as previewed in this job, in a runtime record the
    session cannot write. Spelt any other way, with another verb or other
    words, the website command is refused, naming its one spelling
    (Floor.judge_bash)."""

    SCRIPT = 'website.py'
    SITES = os.path.join('workspace', 'sites')
    PREVIEWS = 'site-previews.json'
    RECORD = 'cloudflare.json'
    KEEP = 200
    NAME = re.compile(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?')
    ACCOUNT = re.compile(r'[0-9a-fA-F]{32}')
    MOST_ENTRIES = 20000
    NEVER = ('Squire\'s safety floor: Squire\'s website command runs from the session only as the one command Squire\'s '
             'instructions name for each, exactly so and as one command, yes or no: {deploy} for a site\'s deploy, or '
             '{set_up} for the one-off Cloudflare set-up. Nothing ran: {{what}}')
    NEVER_FOLDER = ('Squire\'s safety floor: Squire deploys a site only from its own folder, workspace/sites/<site name> '
                    'in the owner\'s folder, yes or no, and this deploy of {name} names another folder. Nothing ran: '
                    '{what}')
    NEVER_PREVIEW = ('Squire\'s safety floor: a site goes live only as the owner has seen it, yes or no, so its deploy '
                     'waits for a preview of the site\'s own folder as it now stands. Preview it on this Mac first, '
                     'served on the loopback from its own folder ({preview}), show it to the owner, and preview it '
                     'again after any change; then its deploy is asked. Nothing ran: {what}')
    LIVE = ('put the site {name} live at {address}, as the owner previewed it from its folder {folder}, replacing '
            'whatever is live there now')
    CANNOT_TELL = ('deploy the site {name} from its folder {folder}. Squire cannot tell where it would go live: '
                   'Squire\'s Cloudflare set-up has not read the account on this Mac')
    SET_UP = ('run Squire\'s one-off Cloudflare set-up on account {account}: it reads the account\'s subscriptions, '
              'makes and keeps a deploy-only token, and removes the owner\'s set-up token')

    @staticmethod
    def quoted(path):
        return "'" + path.replace("'", "'\"'\"'") + "'"

    @classmethod
    def never(cls, floor):
        """The refusal of the website command spelt any other way, naming its
        one spelling; {what} is left to fill."""
        tool = f'{PYTHON} ' + cls.quoted(os.path.join(floor.config.home, 'core', 'tools', cls.SCRIPT))
        deploy, set_up = (s.replace('{', '{{').replace('}', '}}') for s in
                          (f"{tool} deploy '<site folder>' <site name>", f'{tool} set-up <account id>'))
        return cls.NEVER.format(deploy=deploy, set_up=set_up)

    @classmethod
    def of(cls, floor, tool, data):
        """None when the call is not the website command as one plain
        command; else ('set-up', account), ('deploy', folder, name) or
        ('never', why)."""
        argv = Floor.one_command(tool, data)
        if argv is None or not floor.is_core_tool(floor.path(argv[1], strict=False), cls.SCRIPT):
            return None
        words = [str(word) for word in argv[2:]]
        if len(words) == 2 and words[0] == 'set-up' and cls.ACCOUNT.fullmatch(words[1]):
            return ('set-up', words[1])
        if len(words) == 3 and words[0] == 'deploy' and not words[1].startswith('-'):
            return ('deploy', words[1], words[2])
        return ('never', cls.never(floor).format(what=data.get('command')))

    @classmethod
    def settle(cls, floor, session, tool, data, asked):
        command = data.get('command')
        if asked[0] == 'never':
            return 2, asked[1]
        taints = [('private', command)]
        if asked[0] == 'set-up':
            with Ledger(floor.config.ledger_path) as ledger:
                return floor.settle(ledger, session, tool, data, 'ask', cls.SET_UP.format(account=asked[1]), taints)
        _, given, name = asked
        folder = floor.path(given, strict=False)
        own = os.path.realpath(os.path.join(floor.owner, cls.SITES, name))
        if not cls.NAME.fullmatch(name) or not folder or Paths.fold(folder) != Paths.fold(own) \
                or not os.path.isdir(folder):
            return 2, cls.NEVER_FOLDER.format(name=name, what=command)
        digest = cls.digest(folder)
        if digest is None or digest != cls.previewed(floor, session, folder):
            preview = f'{PYTHON} -m {Floor.PREVIEW_MODULE} 0 --bind 127.0.0.1 --directory {cls.quoted(folder)}'
            return 2, cls.NEVER_PREVIEW.format(preview=preview, what=command)
        record = Runtime.read(floor.config.home, cls.RECORD)
        account, subdomain = record.get('accountId'), record.get('subdomain')
        if isinstance(account, str) and cls.ACCOUNT.fullmatch(account) and isinstance(subdomain, str) \
                and cls.NAME.fullmatch(subdomain):
            what = cls.LIVE.format(name=name, address=f'https://{name}.{subdomain}.workers.dev', folder=folder)
        else:
            account = subdomain = None
            what = cls.CANNOT_TELL.format(name=name, folder=folder)
        item = 'site:' + hashlib.sha256(json.dumps([folder, name, digest, account, subdomain]).encode('utf-8')).hexdigest()
        with Ledger(floor.config.ledger_path) as ledger:
            return floor.settle(ledger, session, tool, data, 'ask', what, taints, item=item)

    @classmethod
    def preview_of(cls, floor, tool, data):
        """The site's folder a Bash call previews by the one preview command
        (the stock Python's http.server, bound to the loopback, from a folder
        in workspace/sites), or None."""
        argv = Floor.one_command(tool, data)
        if argv is None or [str(word) for word in argv[1:3]] != ['-m', Floor.PREVIEW_MODULE]:
            return None
        bind = folder = None
        rest, i = [str(word) for word in argv[3:]], 0
        while i < len(rest):
            word = rest[i]
            name, sep, value = word.partition('=')
            if word in ('-b', '--bind', '-d', '--directory') and i + 1 < len(rest):
                if word in ('-b', '--bind'):
                    bind = rest[i + 1]
                else:
                    folder = rest[i + 1]
                i += 2
                continue
            if sep and name == '--bind':
                bind = value
            elif sep and name == '--directory':
                folder = value
            elif not word.isdigit():
                return None
            i += 1
        if bind is None or folder is None or not Floor.LOOPBACK.fullmatch(bind):
            return None
        path = floor.path(folder, strict=False)
        sites = os.path.realpath(os.path.join(floor.owner, cls.SITES))
        if not path or not os.path.isdir(path) or Paths.fold(os.path.dirname(path)) != Paths.fold(sites):
            return None
        return path

    @classmethod
    def keep(cls, floor, session, folder):
        """The site's folder, as it stands now, kept as previewed in this job."""
        digest = cls.digest(folder)
        if digest is None:
            return
        seen = {'session': session, 'folder': Paths.fold(folder), 'digest': digest, 'at': time.time()}
        try:
            Runtime.update(floor.config.home, cls.PREVIEWS,
                           lambda old: {'previews': ([p for p in old.get('previews', []) if isinstance(p, dict)]
                                                     + [seen])[-cls.KEEP:]})
        except OSError:
            pass

    @classmethod
    def previewed(cls, floor, session, folder):
        """The digest of the site's folder as last previewed in this job, or None."""
        record = Runtime.read(floor.config.home, cls.PREVIEWS)
        previews = record.get('previews') if isinstance(record.get('previews'), list) else []
        seen = [p for p in previews if isinstance(p, dict) and p.get('session') == session
                and p.get('folder') == Paths.fold(folder)]
        return seen[-1].get('digest') if seen else None

    @classmethod
    def digest(cls, folder):
        """A folder's content as one digest: each entry's path, kind, link
        target and bytes, never its times; None when it cannot be read whole."""
        def stop(error):
            raise error
        entries = []
        try:
            for root, folders, names in os.walk(folder, onerror=stop):
                folders.sort()
                for entry in sorted(folders + names):
                    path = os.path.join(root, entry)
                    rel = os.path.relpath(path, folder)
                    mode = os.lstat(path).st_mode
                    if stat.S_ISLNK(mode):
                        entries.append(['link', rel, os.readlink(path)])
                    elif stat.S_ISDIR(mode):
                        entries.append(['folder', rel])
                    elif stat.S_ISREG(mode):
                        content = hashlib.sha256()
                        with open(path, 'rb') as f:
                            for chunk in iter(lambda: f.read(1 << 20), b''):
                                content.update(chunk)
                        entries.append(['file', rel, content.hexdigest()])
                    else:
                        entries.append(['other', rel])
                    if len(entries) > cls.MOST_ENTRIES:
                        return None
        except OSError:
            return None
        return hashlib.sha256(json.dumps(entries).encode('utf-8')).hexdigest()


class OwnerDetails:
    """The owner's details, as the floor finds them for a browser call: the
    labelled lines of the owner's profile (operator/profile.md in the
    owner's folder, a line each for the name, email address, postal address,
    phone number and card number, led by its label and a colon) and the
    first name set-up keeps in the owner's squire.json. The floor decides in
    code: it matches the values those lines hold, never the profile's prose.
    A detail is found in a call's input wherever it is carried (any field,
    a script, an address with its escapes taken off), in any letter case:
    the names, the email address and the postal address (whole, or a part of
    it that holds a number, as a street or a postcode) as whole words, the
    phone and card numbers by their digits."""

    PROFILE = os.path.join('operator', 'profile.md')
    OWNER_CONFIG = 'squire.json'
    ORDER = ('name', 'email address', 'postal address', 'phone number', 'card number')
    LABELS = {
        'name': 'name', 'full name': 'name', 'first name': 'name', 'last name': 'name', 'surname': 'name',
        'email': 'email address', 'email address': 'email address', 'e-mail': 'email address',
        'e-mail address': 'email address',
        'address': 'postal address', 'postal address': 'postal address', 'home address': 'postal address',
        'street address': 'postal address',
        'phone': 'phone number', 'phone number': 'phone number', 'mobile': 'phone number',
        'mobile number': 'phone number', 'telephone': 'phone number', 'telephone number': 'phone number',
        'card': 'card number', 'card number': 'card number', 'credit card': 'card number',
        'debit card': 'card number', 'bank card': 'card number',
    }
    LINE = re.compile(r'^\s*(?:[-*+]\s+)?(?:\*\*|__)?([^\W\d_][^:*]*?)\s*(?:\*\*|__)?\s*:\s*(?:\*\*|__)?\s*(.*?)\s*$')
    NUMBERS = ('phone number', 'card number')
    # The fewest digits a phone or card number is matched by; a shorter one
    # is matched as words.
    FEWEST_DIGITS = 6
    PHONE_DIGITS = 9

    def __init__(self, values):
        """values: [(what, value)] as the owner keeps them."""
        self.words, self.digits = [], []
        for what, value in values:
            if what in self.NUMBERS:
                digits = re.sub(r'\D', '', unicodedata.normalize('NFKC', value))
                if what == 'phone number':
                    # Its last digits, so that it is found with or without
                    # its country code or leading zero.
                    digits = digits.lstrip('0')[-self.PHONE_DIGITS:]
                if len(digits) >= self.FEWEST_DIGITS:
                    self.digits.append((what, digits))
                    continue
            parts = [value]
            if what == 'postal address':
                parts += [p for p in re.split(r'[,;\n]', value) if re.search(r'\d', p)]
            for part in parts:
                said = self.words_of(part)
                if len(said.strip()) >= 2:
                    self.words.append((what, said))
                    self.words.append((what, ' ' + said.replace(' ', '') + ' '))

    @classmethod
    def read(cls, owner_folder):
        """The owner's details from the profile's labelled lines and the
        first name in the owner's squire.json; None when the floor cannot
        check a call for them: the profile cannot be read (unreadable, or
        not there yet), or squire.json is there and cannot be read."""
        try:
            with open(os.path.join(owner_folder, cls.PROFILE), encoding='utf-8') as f:
                profile = f.read()
        except (OSError, ValueError):
            return None
        values = []
        for line in profile.splitlines():
            m = cls.LINE.match(line)
            if not m:
                continue
            what = cls.LABELS.get(' '.join(m.group(1).casefold().split()))
            if what and m.group(2):
                values.append((what, m.group(2)))
        try:
            with open(os.path.join(owner_folder, cls.OWNER_CONFIG), encoding='utf-8') as f:
                config = json.load(f)
        except FileNotFoundError:
            config = {}
        except (OSError, ValueError):
            return None
        if not isinstance(config, dict):
            return None
        if isinstance(config.get('firstName'), str) and config['firstName'].strip():
            values.append(('name', config['firstName']))
        return cls(values)

    @staticmethod
    def words_of(text):
        """A text as words: its compatibility form, case folded, every run
        of other characters one space, with a space at each end."""
        folded = unicodedata.normalize('NFKC', text).casefold()
        return ' ' + re.sub(r'[\W_]+', ' ', folded).strip() + ' '

    @staticmethod
    def texts_of(data):
        """Every text a call's input carries, its keys among them, each also
        with its address and HTML escapes taken off."""
        found, stack = [], [data]
        while stack:
            item = stack.pop()
            if isinstance(item, dict):
                stack.extend(item.keys())
                stack.extend(item.values())
            elif isinstance(item, (list, tuple)):
                stack.extend(item)
            elif isinstance(item, str):
                found.append(item)
            elif isinstance(item, (int, float)) and not isinstance(item, bool):
                found.append(str(item))
        texts = []
        for text in found:
            forms = [unicodedata.normalize('NFKC', text)]
            for _ in range(3):
                plain = unicodedata.normalize('NFKC', html.unescape(unquote_plus(forms[-1])))
                if plain == forms[-1]:
                    break
                forms.append(plain)
            texts += forms
        return texts

    def found(self, data):
        """Which of the owner's details a call's input carries, in the order
        the owner's details are named; none when it carries none."""
        texts = self.texts_of(data)
        said = ' '.join(self.words_of(t) for t in texts)
        digits = [re.sub(r'\D', '', t) for t in texts]
        carried = {what for what, words in self.words if words in said}
        carried |= {what for what, number in self.digits if any(number in d for d in digits)}
        return [what for what in self.ORDER if what in carried]


class Floor:
    """Judges one tool call against the owner's folder, Squire's home and
    the approvals ledger, and decides it."""

    FREE_COMMANDS = {'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'stat', 'file', 'pwd', 'date', 'find', 'echo', 'printf'}
    FIND_ACTIONS = {'-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprint0', '-fprintf', '-fls'}
    # A connector's tools, as Claude Code names them: mcp__<connector>__<tool>.
    # The owner classes them himself, by exact full name, in connectorTools
    # { read, draft } in his squire.json; every other one is a tool that acts.
    CONNECTOR = 'mcp__'
    OWNER_CONFIG = 'squire.json'
    CONNECTOR_CLASSES = 'connectorTools'
    # A subagent is free on the session's own model (none named, or inherit)
    # or one in the plan's set, exactly as written; any other model may need
    # usage credits, so it is asked.
    AGENT_TOOLS = ('Agent', 'Task')
    PLAN_MODELS = ('opus', 'sonnet', 'haiku')
    AGENT_FREE_MODELS = PLAN_MODELS + ('inherit',)
    # Claude Code's own subagents, which run on the session's model; a file
    # of the same name is read as a file.
    BUILT_IN_AGENTS = ('general-purpose', 'Explore', 'Plan', 'statusline-setup', 'output-style-setup')
    MODEL_VARIABLES = re.compile(r'^(ANTHROPIC_MODEL|ANTHROPIC_DEFAULT_(OPUS|SONNET|HAIKU)_MODEL|CLAUDE_CODE_SUBAGENT_MODEL)'
                                 r'=(.*)\Z', re.S)
    CLAUDE = re.compile(r'(?:^|[\s/\'"`(=;&|])claude(?:$|[\s\'"`);&|])', re.IGNORECASE)
    SPENDING = re.compile(r'(?:^|[\s\'"`(=;&|])/(?:upgrade|usage-credits)', re.IGNORECASE)
    # Squire's browser: the tools of its one browser server, keyed playwright,
    # whatever they are called (a page can add tools of its own to it). The
    # floor checks a call only of a tool it lists here: one whose whole input
    # the floor reads for the owner's details and that acts on the page alone,
    # running no code of its own, reading no file of the Mac and sending no
    # file. Every other tool of the server is refused. A call that runs a
    # script in the page or sends a file cannot be checked either.
    BROWSER = 'mcp__playwright__'
    BROWSER_CHECKED = frozenset(f'mcp__playwright__browser_{name}'
                                for name in ('navigate', 'snapshot', 'click', 'type', 'fill_form'))
    BROWSER_UNCHECKED = ('mcp__playwright__browser_evaluate', 'mcp__playwright__browser_file_upload')
    PRIVATE = ('operator', 'state', 'reference', os.path.join('workspace', 'files'))
    # A preview on this Mac: Python's own web server, bound to the loopback.
    PYTHONS = re.compile(r'python(\d+(\.\d+)?)?')
    PREVIEW_MODULE = 'http.server'
    LOOPBACK = re.compile(r'127(\.\d{1,3}){3}|::1|\[::1\]|localhost', re.IGNORECASE)
    # A deploy to Cloudflare's Workers or Pages API names its account and its
    # script or project in its path.
    DEPLOY_PATH = re.compile(r'/accounts/([^/\s\'"]*)/(?:workers/scripts|pages/projects)/([^/\s\'"?#]*)', re.IGNORECASE)
    CANNOT_TELL = ('Squire cannot tell where this site would go live: the command does not name its account, project '
                   'or address in words Squire can read.')

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
    NEVER_PAGES = ('Squire\'s safety floor: the session never runs Squire\'s page server itself, yes or no; it only asks '
                   'the page server for the link, with the one link command Squire\'s instructions name, exactly as '
                   'written there. Nothing ran: {what}')
    NEVER_MEDIA = ('Squire\'s safety floor: Squire\'s transcription and its video tool run from the session only as the '
                   'one command Squire\'s instructions name for each, with its file and values after it, yes or no; '
                   'watching the Voice notes folder is the voice-notes job\'s own. Nothing ran: {what}')
    NEVER_YOUTUBE = ('Squire\'s safety floor: Squire fetches nothing from YouTube, no captions, no audio and no page, '
                     'yes or no. Offer the owner the two routes instead: the transcript from YouTube\'s own Show '
                     'transcript, pasted into the chat, or their own file, a recording or video of theirs. Nothing ran.')
    # A tool an earlier core held that asked YouTube for a video's words:
    # refused from the session wherever a Mac still holds it.
    EARLIER_YOUTUBE_TOOL = 'captions.py'
    VOICE_NOTES = 'Voice notes'
    # Places in the owner's folder whose words came from elsewhere: every
    # transcript (a voice note's included) and kept research.
    OUTSIDE = (os.path.join('workspace', 'transcripts'), os.path.join('workspace', 'research'))
    NEVER_UPDATE = ('Squire\'s safety floor: the session may never run Squire\'s update tool, yes or no. Squire\'s updates '
                    'install only from Squire Update on the owner\'s Mac; when a release is waiting, tell the owner to '
                    'open Squire Update there. Nothing ran.')
    NEVER_CD = ('Squire\'s safety floor: the session may not change folder into Squire\'s core, home or config; read '
                'the files there by their full path instead. Nothing ran: {what}')
    UPDATE_APP = 'Squire Update.app'
    NEVER_KEYCHAIN = ('The session may never read the Keychain, yes or no: a secret reaches a tool only through '
                      'Squire\'s secret helper, and is never shown.')
    NEVER_SPEND = ('Squire\'s safety floor: the session never turns on usage credits or opens the upgrade page, yes or '
                   'no. That is money beyond the plan, and the owner\'s own to do: if they want it, they type '
                   '/usage-credits or /upgrade in Claude themselves. Nothing ran.')
    CREDITS = ('{what}\nThis picks a model outside the plan\'s set (opus, sonnet and haiku), or one Squire cannot read, '
               'and that model may need usage credits, beyond what the plan includes.')
    NEVER_BROWSER_DETAILS = ('Squire\'s safety floor: by default Squire\'s browser gives a website none of the owner\'s '
                             'details, yes or no, and this call carries the owner\'s {details}. Nothing ran: {tool}. '
                             'Leave it out; if the owner wants a website to have it, they can type it themselves by '
                             'taking over the browser\'s window.')
    NEVER_BROWSER_UNCHECKED = ('Squire\'s safety floor: Squire\'s browser does not run a script in the page or send a '
                               'file, yes or no, because Squire cannot check either for the owner\'s details. Nothing '
                               'ran: {tool}. The owner can do that step themselves by taking over the browser\'s window.')
    NEVER_BROWSER_UNLISTED = ('Squire\'s safety floor: Squire\'s browser does not make a call Squire cannot check for '
                              'the owner\'s details, yes or no, and Squire has no check for this tool. Nothing ran: '
                              '{tool}. In the browser Squire only opens a page, reads it, types and clicks; the owner '
                              'can do any other step themselves by taking over the browser\'s window.')
    NEVER_MONEY = ('Squire\'s safety floor: Squire never changes what the owner\'s Cloudflare account pays, yes or no: '
                   'this call could write to the account\'s subscriptions, its billing or a zone\'s plan, which could '
                   'buy a plan or spend the owner\'s money. The floor lets only a plain read of them by curl or wget '
                   'be asked; a plan change is the owner\'s own to make on Cloudflare. Nothing ran: {what}')
    NEVER_BROWSER_DASHBOARD = ('Squire\'s safety floor: Squire\'s browser never opens the Cloudflare dashboard, yes or '
                               'no: a plan bought, a payment method added or a site put live there cannot be told '
                               'apart from anything else done on it, and could spend the owner\'s money. Squire\'s own '
                               'set-up and deploy do what a site needs on Cloudflare; anything else on the dashboard is '
                               'the owner\'s own to do. Nothing ran: {tool}')
    # Cloudflare's API and dashboard hosts, and the paths on the API that
    # change what the account pays.
    CLOUDFLARE_API = re.compile(r'(?<![A-Za-z0-9.-])api\.cloudflare\.com\.?(?::\d+)?(/[^\s\'"\\)]*)?', re.IGNORECASE)
    CLOUDFLARE_DASHBOARD = 'dash.cloudflare.com'
    MONEY_SEGMENTS = ('subscription', 'subscriptions', 'billing')
    NEVER_BROWSER_PROFILE = ('Squire\'s safety floor: Squire\'s browser makes no call while the owner\'s profile '
                             '(operator/profile.md in their folder) cannot be read, yes or no, because Squire cannot '
                             'then check the call for the owner\'s details. Nothing ran: {tool}. The guided first '
                             'conversation writes the profile; browse once it is there and can be read.')
    NEVER_OPEN_PREVIEW = ('Squire\'s safety floor: a preview is served on this Mac only, so a web server that would '
                          'listen beyond this Mac\'s loopback is never started, yes or no: Python\'s http.server with '
                          'no --bind, or bound to another address, can be reached from other machines. Start it bound '
                          'to the loopback (--bind 127.0.0.1) from the app\'s own folder. Nothing ran: {what}')
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
        self.floor_paths = [os.path.realpath(config.home), CORE, config.ledger_path,
                            os.path.realpath(os.path.join(os.path.expanduser('~'), 'Applications', self.UPDATE_APP))]
        self.keychain = Paths.canonical(config.keychain, cwd) if config.keychain else None
        self.private = [os.path.join(self.owner, p) for p in self.PRIVATE]
        self.inbox = os.path.join(self.owner, 'workspace', 'inbox')
        self.outside = [os.path.join(self.owner, p) for p in self.OUTSIDE]
        self.voice_notes = os.path.join(self.owner, self.VOICE_NOTES)
        self.walk_left = self.WALK
        self.session = None

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
        self.session = session
        job = HeavyJob.of(self, tool, data)
        if job:
            try:
                with Ledger(self.config.ledger_path) as ledger:
                    return HeavyJob.settle(self, ledger, session, job)
            except SquireError as e:
                return 2, f'Squire\'s safety floor is closed: {e}, so this is blocked.'
        for request in (ImportRequest, CheckInRequest, MediaRequest):
            asked = request.of(self, tool, data)
            if asked:
                try:
                    with Ledger(self.config.ledger_path) as ledger:
                        return request.settle(self, ledger, session, asked)
                except SquireError as e:
                    return 2, f'Squire\'s safety floor is closed: {e}, so this is blocked.'
        if PageLink.of(self, tool, data):
            return 0, ''
        website = WebsiteCommand.of(self, tool, data)
        if website:
            try:
                return WebsiteCommand.settle(self, session, tool, data, website)
            except SquireError as e:
                return 2, f'Squire\'s safety floor is closed: {e}, so this is blocked.'
        versions = VersionsCommand.of(self, tool, data)
        if versions:
            return versions
        shown = ShownRequest.of(self, tool, data)
        if shown:
            try:
                with Ledger(self.config.ledger_path) as ledger:
                    return ShownRequest.settle(self, ledger, session, *shown)
            except SquireError as e:
                return 2, f'Squire\'s safety floor is closed: {e}, so this is blocked.'
        fault = FixRequest.of(self, tool, data)
        if fault:
            try:
                with Ledger(self.config.ledger_path) as ledger:
                    return FixRequest.settle(ledger, session, fault, self.config.timeout)
            except SquireError as e:
                return 2, f'Squire\'s safety floor is closed: {e}, so this is blocked.'
        preview = WebsiteCommand.preview_of(self, tool, data)
        verdict, what, taints = self.judge(tool, data)
        if verdict == 'never':
            return 2, what
        try:
            if verdict == 'model':
                verdict, taints = self.consult(session, self.item(tool, data), what, taints)
            with Ledger(self.config.ledger_path) as ledger:
                answer = self.settle(ledger, session, tool, data, verdict, what, taints)
            if preview and answer[0] == 0:
                WebsiteCommand.keep(self, session, preview)
            return answer
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

    def settle(self, ledger, session, tool, data, verdict, what, taints, item=None):
        """Decides a call against the ledger, held under its lock. A web fetch
        is free until the job holds the owner's private things; from then on
        its path or host can carry them out as well as its query can, and the
        floor cannot tell which do, so it is a send. A web search is free
        until the job holds untrusted input and private things; then its
        words can carry them out, so it is refused as one job. The item a yes
        covers is the call itself unless one is given."""
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
        item = item or self.item(tool, data)
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
    def one_command(tool, data):
        """The words of a Bash call that is one plain simple command run by
        /usr/bin/python3, every word literal; or None. A Squire command the
        floor asks for is spelt only this way."""
        command = data.get('command') if tool == 'Bash' else None
        if not isinstance(command, str):
            return None
        shell = ShellCommand(command)
        if not shell.plain or len(shell.segments) != 1:
            return None
        argv = shell.segments[0]
        if len(argv) < 2 or argv[0] != PYTHON or not all(getattr(word, 'literal', True) for word in argv):
            return None
        return argv

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
            if Paths.within(path, self.voice_notes):
                # The Voice notes folder is the owner's input only: what lands
                # there is turned into text with no one asked.
                return 'ask', f'{tool} {given} (into the owner\'s Voice notes folder, which only the owner fills)', []
            if tool == 'Write' and Paths.within(path, self.owner) and not os.path.lexists(path):
                return 'free', '', []
            return 'ask', f'{tool} {given}', []
        if tool == 'WebFetch':
            url = self.field(data, 'url')
            if youtube_link(url):
                return 'never', self.NEVER_YOUTUBE, []
            fetched = [('untrusted', f'WebFetch {url}')]
            return ('ask' if urlsplit(url).query else 'fetch'), f'WebFetch {url}', fetched
        if tool == 'WebSearch':
            searched = f'WebSearch {self.field(data, "query")}'
            return 'search', searched, [('untrusted', searched)]
        if tool.startswith(self.BROWSER):
            return self.judge_browser(tool, data)
        what = f'{tool} {json.dumps(data, sort_keys=True, ensure_ascii=False)}'
        if tool.startswith(self.CONNECTOR):
            # An allowed read runs with no ask and leaves its job holding
            # untrusted input and the owner's private things; a draft tool
            # runs with no ask and no mark; every other connector tool, a near
            # or look-alike name, a later tool or the same name on another
            # connector among them, is one that acts: asked, naming it and its
            # input, and once it runs its job holds both.
            marks = [('untrusted', tool), ('private', tool)]
            kind = self.connector_class(tool)
            if kind == 'read':
                return 'free', '', marks
            if kind == 'draft':
                return 'free', '', []
            return 'ask', what, marks
        if tool in self.AGENT_TOOLS:
            if 'model' in data:
                if isinstance(data['model'], str) and data['model'] in self.AGENT_FREE_MODELS:
                    return 'free', '', []
                return 'ask', self.CREDITS.format(what=what), []
            if self.named_agent_free(data.get('subagent_type')):
                return 'free', '', []
            return 'ask', self.CREDITS.format(what=what), []
        if tool == 'SlashCommand' and isinstance(data.get('command'), str) and self.SPENDING.search(data['command']):
            return 'never', self.NEVER_SPEND, []
        # A tool the floor does not know: it cannot tell what the tool reads.
        return 'ask', what, [('untrusted', tool), ('private', tool)]

    def connector_class(self, tool):
        """'read' or 'draft' when the owner's own squire.json, read now, names
        this connector tool in that class by its whole name, byte for byte
        (no trim, no fold, no normalising, no split of its parts); None for
        every other tool. A file that cannot be read whole, or classes of
        another shape, are no classes; a name in both classes is in neither.
        Nothing in a call, a connector's word on its tools or anything Squire
        reads is a class."""
        try:
            with open(os.path.join(self.owner, self.OWNER_CONFIG), 'rb') as f:
                data = json.loads(f.read().decode('utf-8'))
        except (OSError, ValueError, UnicodeDecodeError):
            return None
        classes = data.get(self.CONNECTOR_CLASSES) if isinstance(data, dict) else None
        if not isinstance(classes, dict):
            return None
        read, draft = classes.get('read', []), classes.get('draft', [])
        if not isinstance(read, list) or not isinstance(draft, list) \
                or not all(isinstance(name, str) for name in read + draft):
            return None
        in_read = any(name == tool for name in read)
        in_draft = any(name == tool for name in draft)
        if in_read and not in_draft:
            return 'read'
        if in_draft and not in_read:
            return 'draft'
        return None

    def judge_browser(self, tool, data):
        """A call of Squire's browser. Refused, yes or no, when the floor
        cannot check it for the owner's details (it runs a script in the
        page or sends a file, its tool is not one the floor lists as one it
        checks, whatever the tool is called, or the owner's details cannot be
        read) or when it carries one of them, by whatever route; otherwise
        asked, each call on its own, and once it runs the job holds untrusted
        input only: a browser call is not a read of the owner's private
        things."""
        if tool in self.BROWSER_UNCHECKED:
            return 'never', self.NEVER_BROWSER_UNCHECKED.format(tool=tool), []
        if tool not in self.BROWSER_CHECKED:
            return 'never', self.NEVER_BROWSER_UNLISTED.format(tool=tool), []
        if self.on_dashboard(data.get('url')):
            return 'never', self.NEVER_BROWSER_DASHBOARD.format(tool=tool), []
        details = OwnerDetails.read(self.owner)
        if details is None:
            return 'never', self.NEVER_BROWSER_PROFILE.format(tool=tool), []
        carried = details.found(data)
        if carried:
            named = ', '.join(carried[:-1]) + ' and ' + carried[-1] if len(carried) > 1 else carried[0]
            return 'never', self.NEVER_BROWSER_DETAILS.format(details=named, tool=tool), []
        return 'ask', f'{tool} {json.dumps(data, sort_keys=True, ensure_ascii=False)}', [('untrusted', tool)]

    @classmethod
    def on_dashboard(cls, url):
        """True when a browser address is on the Cloudflare dashboard's host
        or a name under it: read as the browser would, unescaped, with
        https:// before it when it names no scheme, the host compared
        without case and with a trailing dot taken off."""
        if not isinstance(url, str):
            return False
        text = url
        for _ in range(3):
            text = unquote_plus(text)
        text = unicodedata.normalize('NFKC', text).strip()
        if not re.match(r'[A-Za-z][A-Za-z0-9+.-]*://', text):
            text = 'https://' + text.lstrip('/')
        try:
            host = (urlsplit(text).hostname or '').rstrip('.').lower()
        except ValueError:
            return False
        return host == cls.CLOUDFLARE_DASHBOARD or host.endswith('.' + cls.CLOUDFLARE_DASHBOARD)

    def spends_on_cloudflare(self, argv):
        """True when a command names a path on Cloudflare's API that changes
        what the account pays (its subscriptions, its billing or a zone,
        whose plan a change of the zone sets) and is not readable as a plain
        read: curl or wget sending no data and asking for no method but GET
        or HEAD. Any other program naming such a path could write to it, so
        it is counted as writing."""
        named = False
        for word in argv:
            text = unicodedata.normalize('NFKC', str(word))
            for match in self.CLOUDFLARE_API.finditer(text):
                segments = [unquote_plus(s).strip().lower() for s in
                            (match.group(1) or '').split('?')[0].split('#')[0].split('/') if s]
                if segments[:2] != ['client', 'v4']:
                    continue
                rest = segments[2:]
                if any(s in self.MONEY_SEGMENTS for s in rest) or (len(rest) == 2 and rest[0] == 'zones'):
                    named = True
        if not named:
            return False
        program = Paths.fold(os.path.basename(str(argv[0])))
        words = [str(word) for word in argv[1:]]
        if program == 'curl':
            return not self.curl_reads(words)
        if program == 'wget':
            return not self.wget_reads(words)
        return True

    @staticmethod
    def curl_reads(words):
        """curl's words ask for a plain read: no method but GET or HEAD, no
        data sent unless -G turns it into the address's query, no form and
        no upload."""
        get, sends, i = False, False, 0
        while i < len(words):
            word = words[i]
            if word.startswith('--'):
                name, sep, value = word.partition('=')
                if name == '--request':
                    method = value if sep else (words[i + 1] if i + 1 < len(words) else '')
                    i += 0 if sep else 1
                    if method.upper() not in ('GET', 'HEAD'):
                        return False
                elif name == '--get':
                    get = True
                elif name in ('--data', '--json') or name.startswith('--data-'):
                    sends = True
                elif name in ('--form', '--form-string', '--upload-file') or name.startswith('--form-'):
                    return False
            elif word.startswith('-') and len(word) > 1:
                letters = word[1:]
                for at, letter in enumerate(letters):
                    if letter == 'X':
                        method = letters[at + 1:] or (words[i + 1] if i + 1 < len(words) else '')
                        i += 0 if letters[at + 1:] else 1
                        if method.upper() not in ('GET', 'HEAD'):
                            return False
                        break
                    if letter == 'G':
                        get = True
                    elif letter == 'd':
                        sends = True
                        break
                    elif letter in 'FT':
                        return False
            i += 1
        return get or not sends

    @staticmethod
    def wget_reads(words):
        """wget's words ask for a plain read: no method but GET or HEAD and
        no data or file sent."""
        for i, word in enumerate(words):
            name, sep, value = word.partition('=')
            if name == '--method':
                method = value if sep else (words[i + 1] if i + 1 < len(words) else '')
                if method.upper() not in ('GET', 'HEAD'):
                    return False
            elif name in ('--post-data', '--post-file', '--body-data', '--body-file'):
                return False
        return True

    def named_agent_free(self, name):
        """True when a subagent called with no model runs on a model in the
        plan's set (or the session's own) for certain: no subagent named; or
        the agent file that names it, in the owner's folder's .claude/agents
        or the config folder's agents, names a model in the set, inherit or
        none, and has not changed since the floor saw this job start; or, with
        no file naming it and every file there readable, a built-in subagent.
        A file the floor cannot read, a name no file gives, a file changed
        since the job started, or a job the floor did not see start is not
        certain, so it is asked."""
        if name is None:
            return True
        if not isinstance(name, str) or not name:
            return False
        found, unreadable = None, False
        for folder in (os.path.join(self.owner, '.claude', 'agents'), os.path.join(self.config.home, 'claude-config', 'agents')):
            try:
                names = sorted(n for n in os.listdir(folder) if n.endswith('.md'))
            except FileNotFoundError:
                continue
            except OSError:
                unreadable = True
                continue
            for file_name in names:
                path = os.path.join(folder, file_name)
                try:
                    with open(path, encoding='utf-8') as f:
                        text = f.read(65536)
                    changed = os.stat(path).st_mtime
                except (OSError, ValueError):
                    unreadable = True
                    continue
                fields = self.frontmatter(text)
                if fields.get('name') == name and found is None:
                    found = (fields.get('model'), changed)
        if found is None:
            return name in self.BUILT_IN_AGENTS and not unreadable
        model, changed = found
        if model is not None and model not in self.AGENT_FREE_MODELS:
            return False
        ledger = Ledger.read_shared(self.config.ledger_path)
        session = getattr(self, 'session', None)
        jobs = [r for r in (ledger.records if ledger else []) if r.get('type') == 'job' and r.get('session') == session]
        started = jobs[0].get('at') if jobs else None
        return isinstance(started, (int, float)) and not isinstance(started, bool) and changed < started

    @staticmethod
    def frontmatter(text):
        """The key: value lines between an agent file's first two --- lines,
        each value with its quotes taken off; none when it has no frontmatter."""
        lines = text.split('\n')
        if not lines or lines[0].strip() != '---':
            return {}
        fields = {}
        for line in lines[1:]:
            if line.strip() == '---':
                return fields
            key, sep, value = line.partition(':')
            if sep and key.strip() and key.strip() not in fields:
                value = value.strip()
                if len(value) >= 2 and value[0] == value[-1] and value[0] in '"\'':
                    value = value[1:-1]
                fields[key.strip()] = value
        return {}

    def judge_bash(self, command):
        """A command the list resolves is free and marked by its paths; a
        plain read it cannot resolve is the small model's or the owner's
        ('model'); a listed command that is not the Mac's own is asked and,
        once it runs, the job holds untrusted input and private things; any
        other program is asked and, once it runs, the job holds private
        things. Literal paths keep their marks throughout. A claude command
        line whose words hold /usage-credits or /upgrade is refused, yes or
        no; one that picks a model outside the plan's set, or one the floor
        cannot read, is asked naming usage credits."""
        if self.CLAUDE.search(command) and self.SPENDING.search(command):
            return 'never', self.NEVER_SPEND, []
        shell = ShellCommand(command)
        if self.names_website(shell):
            return 'never', WebsiteCommand.never(self).format(what=command), []
        verdicts = [self.judge_argv(argv, shell.plain) for argv in shell.segments]
        never = next((v for v in verdicts if v[0] == 'never'), None)
        if never:
            return never[0], never[1].format(what=command), []
        if any(self.open_preview(argv) for argv in shell.segments):
            return 'never', self.NEVER_OPEN_PREVIEW.format(what=command), []
        taints = [t for v in verdicts for t in v[2]]
        kinds = {v[0] for v in verdicts}
        if shell.plain and kinds <= {'free'}:
            return 'free', '', taints
        if Paths.fold(os.path.basename(self.config.ledger_path)) in Paths.fold(command):
            return 'never', self.NEVER_FLOOR.format(what=command), []
        credits = self.picks_credits(shell)
        if shell.plain and kinds <= {'free', 'model'} and not credits:
            return 'model', command, taints
        run = [('untrusted', command), ('private', command)] if 'read' in kinds else [('private', command)]
        what = self.CREDITS.format(what=command) if credits else command
        if self.target_unread(shell):
            what += '\n' + self.CANNOT_TELL
        return 'ask', what, taints + run

    def names_website(self, shell):
        """True when a command names Squire's website command outside its
        one plain spelling (WebsiteCommand), in any word of a program, or of
        a command that is not plain, each word read from the folder its
        simple command runs in (a cd before it moves that)."""
        where = self.cwd
        for argv in shell.segments:
            if argv[0] == 'cd':
                try:
                    if len(argv) == 2 and getattr(argv[1], 'literal', True):
                        where = Paths.canonical(argv[1], where)
                except (TypeError, ValueError, OSError):
                    pass
                continue
            elsewhere = os.path.basename(argv[0]) in self.LISTED and not self.is_mac_command(argv[0])
            if shell.plain and self.is_free(argv) and not elsewhere:
                continue
            for piece in (p for word in argv for p in re.split(r'[\s()|<>;&`\'"=]+', word) if p):
                try:
                    if self.is_core_tool(Paths.canonical(piece, where), WebsiteCommand.SCRIPT):
                        return True
                except (TypeError, ValueError, OSError):
                    continue
        return False

    def target_unread(self, shell):
        """True when a command deploys a site somewhere the floor cannot read
        from its words: wrangler's deploy with no literal --name (or, for
        Pages, --project-name), or a call to Cloudflare's Workers or Pages
        API whose account, script or project is not written out."""
        for argv in shell.segments:
            words = [str(word) for word in argv]
            names = [Paths.fold(os.path.basename(word)) for word in words]
            at = next((i for i, n in enumerate(names) if n == 'wrangler' or n.startswith('wrangler@')), None)
            if at is not None and any(word in ('deploy', 'publish') for word in words[at + 1:]):
                option = '--project-name' if 'pages' in words[at + 1:] else '--name'
                rest, value = argv[at + 1:], None
                for i, word in enumerate(rest):
                    if word == option and i + 1 < len(rest):
                        value = rest[i + 1]
                    elif str(word).startswith(option + '='):
                        value = Word(str(word)[len(option) + 1:], getattr(word, 'literal', True))
                if value is None or not getattr(value, 'literal', True) or not str(value) or str(value).startswith('-'):
                    return True
            for word in argv:
                for match in self.DEPLOY_PATH.finditer(str(word)):
                    if not match.group(1) or not match.group(2) or not getattr(word, 'literal', True) \
                            or any(mark in match.group(0) for mark in '$`'):
                        return True
        return False

    @classmethod
    def open_preview(cls, argv):
        """True when one command starts Python's own web server (python -m
        http.server) with no bind to the loopback, or a bind beyond it: it
        would listen for other machines as well as this Mac. Its bind is
        read as Python reads it: -b or --bind (or a shortening of --bind)
        with the address next or after =, the last one given. A bind the
        floor cannot read as written counts as beyond the loopback."""
        if not argv or not cls.PYTHONS.fullmatch(os.path.basename(argv[0])):
            return False
        args, module, rest = argv[1:], None, []
        for i, word in enumerate(args):
            if word == '-m' and i + 1 < len(args):
                module, rest = args[i + 1], args[i + 2:]
                break
            if word.startswith('-m') and len(word) > 2:
                module, rest = word[2:], args[i + 1:]
                break
            if not word.startswith('-'):
                return False
        if module != cls.PREVIEW_MODULE:
            return False
        bind, i = None, 0
        while i < len(rest):
            word = rest[i]
            name, sep, value = word.partition('=')
            if word == '-b' or (word.startswith('--') and not sep and len(word) >= 3 and '--bind'.startswith(word)):
                bind = rest[i + 1] if i + 1 < len(rest) else Word('', literal=False)
                i += 2
                continue
            if sep and name.startswith('--') and len(name) >= 3 and '--bind'.startswith(name):
                bind = Word(value, getattr(word, 'literal', True))
            elif word.startswith('-b') and not word.startswith('--') and len(word) > 2:
                bind = Word(word[2:], getattr(word, 'literal', True))
            i += 1
        return bind is None or not getattr(bind, 'literal', True) or not cls.LOOPBACK.fullmatch(str(bind))

    def picks_credits(self, shell):
        """True when the command holds a claude command line (a word naming
        claude, by itself or by its full path) and picks a model outside the
        plan's set, or one the floor cannot read: by --model, by a --settings
        value (a model, or a model variable in its env, outside the set; or
        a value that is not readable JSON, such as a file), or by a model
        variable set anywhere in the command."""
        words = [word for argv in shell.segments for word in argv]
        if not any(Paths.fold(os.path.basename(word)) == 'claude' for word in words):
            return False
        plan = lambda value: isinstance(value, str) and value in self.PLAN_MODELS  # noqa: E731
        for i, word in enumerate(words):
            given = words[i + 1] if i + 1 < len(words) else None
            literal = getattr(given, 'literal', True)
            if word == '--model' and not (literal and plan(str(given) if given is not None else None)):
                return True
            if word.startswith('--model=') and not (getattr(word, 'literal', True) and plan(word[len('--model='):])):
                return True
            if word == '--settings' or word.startswith('--settings='):
                value = given if word == '--settings' else Word(word[len('--settings='):], getattr(word, 'literal', True))
                try:
                    settings = json.loads(value) if value is not None and getattr(value, 'literal', True) else None
                except ValueError:
                    settings = None
                env = settings.get('env', {}) if isinstance(settings, dict) else None
                if not isinstance(settings, dict) or ('model' in settings and not plan(settings['model'])) \
                        or not isinstance(env, dict) \
                        or any(self.MODEL_VARIABLES.match(f'{k}=') and not plan(v) for k, v in env.items()):
                    return True
            found = self.MODEL_VARIABLES.match(word)
            if found and not (getattr(word, 'literal', True) and plan(found.group(3))):
                return True
        return False

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
        # What the owner's Cloudflare account pays is never changed from the
        # session, by any program: the command a secret helper run wraps is
        # judged above, as itself.
        if self.spends_on_cloudflare(argv):
            return 'never', self.NEVER_MONEY, []
        words = argv + [t.split('=', 1)[1] for t in argv if '=' in t] + \
            [p for t in argv if not getattr(t, 'literal', True) for p in re.split(r'[\s()|<>;&`]+', t) if p]
        paths = [p for p in (self.path(t, strict=False) for t in words) if p]
        if os.path.basename(argv[0]) == 'security' or any(self.is_keychain(p) for p in paths):
            return 'never', self.NEVER_KEYCHAIN, []
        # A listed read named by its path, or shadowed on the hook's PATH:
        # the floor cannot know what it reads.
        elsewhere = os.path.basename(argv[0]) in self.LISTED and not self.is_mac_command(argv[0])
        free = self.is_free(argv) and not elsewhere
        if not free or not plain:
            # Squire's update tool, named in any word, or inside a word a
            # shell runs (zsh -c '...'): never run from the session.
            pieces = [p for t in argv for p in re.split(r'[\s()|<>;&`\'"=]+', t) if p]
            if any(self.is_update_tool(p) for p in (self.path(t, strict=False) for t in pieces) if p):
                return 'never', self.NEVER_UPDATE, []
            if any(self.is_core_tool(p, self.EARLIER_YOUTUBE_TOOL) for p in (self.path(t, strict=False) for t in pieces)
                   if p):
                return 'never', self.NEVER_YOUTUBE, []
            # Squire's job, import and check-in commands spelt any way but the
            # one the floor asks for (HeavyJob, ImportRequest, CheckInRequest),
            # and the page server's script any way but the link command
            # (PageLink): inside a shell's -c, say. Refused, yes or no.
            asked = (HeavyJob.SCRIPT, ImportRequest.SCRIPT, CheckInRequest.SCRIPT, PageLink.SCRIPT) + \
                tuple(MediaRequest.SCRIPTS)
            named = [name for p in (self.path(t, strict=False) for t in pieces) if p
                     for name in asked if self.is_core_tool(p, name)]
            if named:
                if PageLink.SCRIPT in named:
                    return 'never', self.NEVER_PAGES, []
                if any(name in MediaRequest.SCRIPTS for name in named):
                    return 'never', self.NEVER_MEDIA, []
                return 'never', self.NEVER_FLOOR, []
            if argv[0] == 'cd' and any(self.is_floor(p) for p in paths):
                return 'never', self.NEVER_CD, []
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
        """True when path is the core tool of that name, compared as the Mac's
        volume compares names, so a look-alike spelling the Mac opens as the
        same file is that tool (a long s for an s, say)."""
        return bool(path) and any(Paths.fold(path) == Paths.fold(os.path.join(core, 'tools', name))
                                  for core in self.cores)

    def is_floor(self, path):
        return any(Paths.within(path, floor) for floor in self.floor_paths) or self.is_settings(path)

    def is_update_tool(self, path):
        """Squire's update tool: update.py in the floor (the installed core,
        a kept release, the hook's own core), its name folded as the volume
        folds it."""
        return Paths.fold(os.path.basename(path)) == 'update.py' and self.is_floor(path)

    def is_settings(self, path):
        """Claude Code's settings for a folder in the owner's: a hook switched
        off there, or SQUIRE_HOME pointed elsewhere, would leave no floor.
        Its name is folded as the volume folds it."""
        folder, name = os.path.split(Paths.fold(path))
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
        downloaded = near(path, self.inbox) or any(near(path, place) for place in self.outside) \
            or self.quarantined(path, recursive)
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
