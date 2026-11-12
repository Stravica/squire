"""What Squire's core entry points share: the one config, canonical paths,
the approvals ledger in the owner's state folder, the Mac's own commands,
Squire's Claude sign-in and the Squire's name and personality.

Standard library only; run by /usr/bin/python3.
"""

import calendar
import fcntl
import json
import os
import pwd
import re
import signal
import stat
import subprocess
import tempfile
import time
import unicodedata


class SquireError(Exception):
    """A reason to stop, said in words the owner can act on."""


class Paths:
    """Paths judged the way the Mac sees them: links resolved, names folded
    as the volume folds them."""

    @staticmethod
    def canonical(path, cwd):
        path = os.path.expanduser(path)
        if not os.path.isabs(path):
            path = os.path.join(cwd, path)
        return os.path.realpath(path)

    @staticmethod
    def fold(path):
        """A path as the Mac's volume compares it. The volume folds case in
        full and the Unicode forms of a name alike: the long s opens s, the
        sharp s ss, an accent composed or not the same file. str.lower does
        neither, so the fold is the decomposed form, case-folded, decomposed
        again."""
        return unicodedata.normalize('NFD', unicodedata.normalize('NFD', path).casefold())

    @staticmethod
    def within(path, parent):
        """True when path is parent or lies inside it, both sides folded as
        the volume folds them."""
        child, parent = Paths.fold(path), Paths.fold(parent).rstrip('/')
        return child == parent or child.startswith(parent + '/')

    @staticmethod
    def overlap(a, b):
        return Paths.within(a, b) or Paths.within(b, a)


class Config:
    """The one core config: SQUIRE_HOME/squire.json, or the default Squire
    home under the user's Library when SQUIRE_HOME is unset."""

    NAME = 'squire.json'
    DEFAULT_TIMEOUT = 600
    MAX_TIMEOUT = 86400

    def __init__(self, home=None):
        self.home = home or self.default_home()
        self.path = os.path.join(self.home, self.NAME)
        try:
            with open(self.path, encoding='utf-8') as f:
                data = json.load(f)
        except FileNotFoundError:
            raise SquireError(f'Squire\'s config {self.path} is missing')
        except (OSError, ValueError):
            raise SquireError(f'Squire\'s config {self.path} cannot be read as JSON')
        if not isinstance(data, dict):
            raise SquireError(f'Squire\'s config {self.path} must hold one JSON object')
        owner = data.get('ownerFolder')
        if not isinstance(owner, str) or not os.path.isabs(owner):
            raise SquireError(f'Squire\'s config {self.path} must name ownerFolder as an absolute path')
        timeout = data.get('approvalTimeoutSeconds', self.DEFAULT_TIMEOUT)
        if isinstance(timeout, bool) or not isinstance(timeout, int) or not 1 <= timeout <= self.MAX_TIMEOUT:
            raise SquireError(f'Squire\'s config {self.path} must give approvalTimeoutSeconds as a whole number '
                              f'from 1 to {self.MAX_TIMEOUT}')
        keychain = data.get('keychain')
        if keychain is not None and not (isinstance(keychain, str) and os.path.isabs(keychain)):
            raise SquireError(f'Squire\'s config {self.path} must give keychain as an absolute path')
        self.owner_folder = os.path.realpath(owner)
        self.timeout = timeout
        self.keychain = keychain
        self.data = data

    @staticmethod
    def default_home():
        home = os.environ.get('SQUIRE_HOME')
        if home:
            return home
        return os.path.join(os.path.expanduser('~'), 'Library', 'Application Support', 'Squire')

    @property
    def ledger_path(self):
        return os.path.join(self.owner_folder, 'state', 'approvals.jsonl')


class Ledger:
    """The approvals ledger: append-only JSON lines in the owner's state
    folder, written by the floor (and by the health check's perform step,
    which marks a known fix's yes used) and read whole under an exclusive
    lock.

    Records: a request for a yes ({type: request, id, session, item, at},
    where a known fix's item is "fix:<fault>");
    the owner's answer ({type: answer, request, session, answer, at}); a yes
    used up ({type: use, request, at}); what a job has taken in
    ({type: taint, session, kind, source, at}); a small-model call the
    floor made for a job ({type: model, session, at}); and a job the floor
    saw start ({type: job, session, source, at}). A record that cannot be
    read makes the whole ledger untrusted.
    """

    KINDS = {'request', 'answer', 'use', 'taint', 'model', 'job'}

    def __init__(self, path):
        self.path = path
        self.file = None
        self.records = []

    def __enter__(self):
        try:
            os.makedirs(os.path.dirname(self.path), exist_ok=True)
            self.file = open(self.path, 'a+', encoding='utf-8')
            fcntl.flock(self.file.fileno(), fcntl.LOCK_EX)
            self.file.seek(0)
            text = self.file.read()
        except (OSError, ValueError):
            self.close()
            raise SquireError(f'the approvals ledger {self.path} cannot be opened')
        for line in text.splitlines():
            try:
                record = json.loads(line)
            except ValueError:
                record = None
            if not isinstance(record, dict) or record.get('type') not in self.KINDS:
                self.close()
                raise SquireError(f'the approvals ledger {self.path} holds a record that cannot be read')
            self.records.append(record)
        return self

    def __exit__(self, *exc):
        self.close()

    def close(self):
        if self.file:
            self.file.close()
            self.file = None

    def append(self, record):
        self.file.write(json.dumps(record, sort_keys=True) + '\n')
        self.file.flush()
        self.records.append(record)

    def _of(self, kind, **match):
        return [r for r in self.records if r.get('type') == kind and all(r.get(k) == v for k, v in match.items())]

    def open_requests(self, session, now, timeout):
        """Requests in this job with no answer, raised less than timeout ago."""
        answered = {r.get('request') for r in self._of('answer')}
        return [r for r in self._of('request', session=session)
                if r.get('id') not in answered and now < r.get('at', 0) + timeout]

    def approval(self, session, item, now, timeout):
        """The request for this item in this job the owner said yes to, not
        yet used, the yes given less than timeout ago; or None."""
        used = {r.get('request') for r in self._of('use')}
        for request in self._of('request', session=session, item=item):
            if request.get('id') in used:
                continue
            for answer in self._of('answer', request=request.get('id'), session=session):
                if answer.get('answer') == 'yes' and now < answer.get('at', 0) + timeout:
                    return request
        return None

    def request(self, session, item, now):
        record = {'type': 'request', 'id': f'r-{len(self._of("request")) + 1}', 'session': session, 'item': item, 'at': now}
        self.append(record)
        return record

    def taints(self, session):
        """What this job has taken in, by kind: the sources, in order."""
        found = {'untrusted': [], 'private': []}
        for r in self._of('taint', session=session):
            if r.get('kind') in found and r.get('source') not in found[r['kind']]:
                found[r['kind']].append(r.get('source'))
        return found

    def taint(self, session, kind, source, now):
        if source not in self.taints(session).get(kind, []):
            self.append({'type': 'taint', 'session': session, 'kind': kind, 'source': source, 'at': now})

    def model_calls(self, session):
        """How many small-model calls the floor has made for this job."""
        return len(self._of('model', session=session))

    def model_call(self, session, now):
        self.append({'type': 'model', 'session': session, 'at': now})

    def seen(self, session):
        """True when the floor saw this job start: the ledger holds its record."""
        return bool(self._of('job', session=session))

    def job(self, session, source, now):
        """Records a job the floor saw start, keeping one it already holds."""
        if not self.seen(session):
            self.append({'type': 'job', 'session': session, 'source': source, 'at': now})

    def fix_yeses(self):
        """The owner's yeses to known fixes not yet used, oldest first: each
        (request, answer)."""
        used = {r.get('request') for r in self._of('use')}
        found = []
        for request in self._of('request'):
            item = request.get('item')
            if not isinstance(item, str) or not item.startswith('fix:') or request.get('id') in used:
                continue
            answer = next((a for a in self._of('answer', request=request.get('id')) if a.get('answer') == 'yes'), None)
            if answer is not None:
                found.append((request, answer))
        return found

    def yeses(self, prefix):
        """The owner's yeses, not yet used, to requests whose item starts
        with prefix (an update's "update:", a ticket's "ticket:"), oldest
        first: each (request, answer)."""
        used = {r.get('request') for r in self._of('use')}
        found = []
        for request in self._of('request'):
            item = request.get('item')
            if not isinstance(item, str) or not item.startswith(prefix) or request.get('id') in used:
                continue
            answer = next((a for a in self._of('answer', request=request.get('id')) if a.get('answer') == 'yes'), None)
            if answer is not None:
                found.append((request, answer))
        return found

    @classmethod
    def read_shared(cls, path):
        """The ledger read once under a shared lock, creating nothing; None
        when it cannot be read."""
        try:
            with open(path, encoding='utf-8') as f:
                fcntl.flock(f.fileno(), fcntl.LOCK_SH)
                text = f.read()
        except (OSError, ValueError):
            return None
        ledger = cls(path)
        for line in text.splitlines():
            try:
                record = json.loads(line)
            except ValueError:
                return None
            if not isinstance(record, dict):
                return None
            ledger.records.append(record)
        return ledger

    @classmethod
    def fix_pending(cls, path):
        """True when the ledger holds a known fix's yes not yet used. One read
        under a shared lock, creating nothing; a ledger that cannot be read
        holds none."""
        ledger = cls.read_shared(path)
        return bool(ledger and ledger.fix_yeses())

    @classmethod
    def yeses_in(cls, path, prefix):
        """yeses(prefix) from one shared read; none when it cannot be read."""
        ledger = cls.read_shared(path)
        return ledger.yeses(prefix) if ledger else []

    def requests_for(self, prefix):
        """Every request whose item starts with prefix, oldest first, each with
        its answer record (or None)."""
        found = []
        for request in self._of('request'):
            item = request.get('item')
            if isinstance(item, str) and item.startswith(prefix):
                answer = next(iter(self._of('answer', request=request.get('id'))), None)
                found.append((request, answer))
        return found

    def used(self, request_id):
        return bool(self._of('use', request=request_id))


class Process:
    """A process as the Mac reports it, by its id."""

    MONTHS = ('Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec')

    @classmethod
    def started_at(cls, pid):
        """The process's start as /bin/ps reports it in the C locale and UTC,
        written as ISO 8601 UTC to the second; None when no process has the id."""
        if isinstance(pid, bool) or not isinstance(pid, int) or pid <= 0:
            return None
        try:
            r = subprocess.run(['/bin/ps', '-o', 'lstart=', '-p', str(pid)], stdin=subprocess.DEVNULL,
                               capture_output=True, text=True, timeout=10,
                               env={'LC_ALL': 'C', 'TZ': 'UTC0', 'PATH': '/usr/bin:/bin'})
        except (OSError, subprocess.SubprocessError):
            return None
        parts = r.stdout.split()
        if r.returncode != 0 or len(parts) != 5 or parts[1] not in cls.MONTHS:
            return None
        try:
            hour, minute, second = (int(x) for x in parts[3].split(':'))
            fields = (int(parts[4]), cls.MONTHS.index(parts[1]) + 1, int(parts[2]), hour, minute, second)
        except ValueError:
            return None
        return '%04d-%02d-%02dT%02d:%02d:%02dZ' % fields


class System:
    """The Mac's own commands, each by its full path in the system folders,
    read under SQUIRE_SYSTEM_ROOT only when it names an existing absolute
    folder; and the environment every command Squire starts runs in, built
    from nothing: no API key or token and no inherited PATH ever reaches it."""

    FOLDERS = ('/usr/bin', '/bin', '/usr/sbin', '/sbin')
    LANG = 'en_US.UTF-8'

    @staticmethod
    def root():
        root = os.environ.get('SQUIRE_SYSTEM_ROOT')
        if root and os.path.isabs(root) and os.path.isdir(root):
            return root.rstrip('/')
        return ''

    @classmethod
    def command(cls, path):
        return cls.root() + path

    @classmethod
    def env(cls, home=None, **extra):
        root = cls.root()
        user = pwd.getpwuid(os.getuid()).pw_name
        env = {'HOME': os.path.expanduser('~'), 'USER': user, 'LOGNAME': user, 'LANG': cls.LANG,
               'PATH': ':'.join(root + folder for folder in cls.FOLDERS)}
        if os.environ.get('TMPDIR'):
            env['TMPDIR'] = os.environ['TMPDIR']
        if home:
            env['SQUIRE_HOME'] = home
        if root:
            env['SQUIRE_SYSTEM_ROOT'] = root
        env.update(extra)
        return env

    OWN_HOME_WITHIN = 10

    @classmethod
    def own_home(cls):
        """True when the home folder given is the account's own, as the
        account database names it (its NFSHomeDirectory, read with the Mac's
        dscl): only there are launchd agents loaded. False when it cannot be
        read."""
        record = os.path.join('/Users', pwd.getpwuid(os.getuid()).pw_name)
        try:
            r = subprocess.run([cls.command('/usr/bin/dscl'), '.', '-read', record, 'NFSHomeDirectory'],
                               cwd='/', env=cls.env(), stdin=subprocess.DEVNULL, capture_output=True, text=True,
                               timeout=cls.OWN_HOME_WITHIN)
        except (OSError, subprocess.SubprocessError, ValueError):
            return False
        said = r.stdout.strip()
        if r.returncode != 0 or not said.startswith('NFSHomeDirectory:'):
            return False
        own = said[len('NFSHomeDirectory:'):].strip()
        if not os.path.isabs(own) or '\n' in own:
            return False
        return os.path.realpath(os.path.expanduser('~')) == os.path.realpath(own)


class ClaudeSignIn:
    """Squire's Claude sign-in, read only through claude auth status in
    Squire's config folder: whether it answers signed in, and the day it
    ends (loginExpiresAt); the sign-in's secret is never read. claude is
    found only at the fixed places, never by PATH."""

    PLACES = ('~/.local/bin/claude', '/usr/local/bin/claude', '/opt/homebrew/bin/claude')
    STATUS_WITHIN = 30
    LOGIN_WITHIN = 900
    WARN_WITHIN = 7 * 86400
    ISO = re.compile(r'^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})$')

    def __init__(self, home):
        self.home = home
        self.config_dir = os.path.join(home, 'claude-config')
        self.claude = self.find()

    @classmethod
    def find(cls):
        for place in cls.PLACES:
            path = os.path.expanduser(place)
            try:
                found = os.stat(path)
            except OSError:
                continue
            if stat.S_ISREG(found.st_mode) and found.st_uid == os.getuid() \
                    and not found.st_mode & (stat.S_IWGRP | stat.S_IWOTH) and os.access(path, os.X_OK):
                return path
        return None

    def env(self):
        return System.env(CLAUDE_CONFIG_DIR=self.config_dir)

    def status(self):
        """(signed in, the sign-in's end in seconds since 1970 or None)."""
        if not self.claude:
            return False, None
        try:
            r = subprocess.run([self.claude, 'auth', 'status'], cwd='/', env=self.env(), stdin=subprocess.DEVNULL,
                               capture_output=True, text=True, timeout=self.STATUS_WITHIN)
            data = json.loads(r.stdout)
        except (OSError, subprocess.SubprocessError, ValueError):
            return False, None
        if r.returncode != 0 or not isinstance(data, dict) or data.get('loggedIn') is not True:
            return False, None
        return True, self.parse(data.get('loginExpiresAt'))

    @classmethod
    def parse(cls, value):
        """An ISO 8601 time as seconds since 1970; None when it is not one."""
        match = cls.ISO.match(value) if isinstance(value, str) else None
        if not match:
            return None
        year, month, day, hour, minute, second = (int(match.group(i)) for i in range(1, 7))
        zone = match.group(7)
        offset = 0
        if zone != 'Z':
            digits = zone[1:].replace(':', '')
            offset = (int(digits[:2]) * 3600 + int(digits[2:]) * 60) * (1 if zone[0] == '+' else -1)
        try:
            return calendar.timegm((year, month, day, hour, minute, second, 0, 0, 0)) - offset
        except (ValueError, OverflowError):
            return None

    def ends_soon(self, now):
        """The sign-in's end when it is signed in and ends within seven days;
        else None (an end that cannot be read included)."""
        signed_in, ends = self.status()
        if signed_in and ends is not None and now < ends <= now + self.WARN_WITHIN:
            return ends
        return None

    @staticmethod
    def day(ends):
        """The day a sign-in ends, YYYY-MM-DD in the Mac's local time."""
        return time.strftime('%Y-%m-%d', time.localtime(ends))

    def sign_in(self):
        """claude auth login into Squire's config folder, which opens the
        browser's sign-in page; bounded, its whole process group killed at
        the bound. True when it exited 0."""
        if not self.claude:
            return False
        try:
            child = subprocess.Popen([self.claude, 'auth', 'login'], cwd='/', env=self.env(), stdin=subprocess.DEVNULL,
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        except OSError:
            return False
        try:
            return child.wait(self.LOGIN_WITHIN) == 0
        except subprocess.TimeoutExpired:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except OSError:
                pass
            child.wait()
            return False


class Persona:
    """The Squire's name and personality: the bounds a value must keep to be
    stored, and the block lay-down and the runner write into CLAUDE.md in
    Squire's config folder, which Claude Code loads as the user's own
    instructions for Squire's session. The owner's squire.json is the one
    authority for both. The block also carries Squire's one standing line on
    updates (they install only from Squire Update on the owner's Mac) and the
    session's two routes: Squire's health check, which the session runs when
    the owner asks about Squire's health or for a support ticket, and the
    ticket route, a ticket the check offers shown in a fence and sent only on
    the owner's yes."""

    LIMITS = {'squireName': 40, 'personality': 400}
    OPEN = '<!-- squire persona -->'
    CLOSE = '<!-- end squire persona -->'
    UPDATES = ('Squire\'s updates install only from Squire Update on the owner\'s Mac, never from this session and never '
               'from the phone. When Squire tells you a release is waiting, tell the owner to open Squire Update on '
               'their Mac, and run nothing for it yourself.')
    HEALTH = ('Squire has a health check, and you run it yourself whenever the owner asks about Squire\'s health or for '
              'a support ticket, including when a Squire Update window has sent them to the chat.')
    TICKETS = ('When the check offers a support ticket, it names the request to send it on a line of its own: run that '
               'request, and when the safety floor shows you the ticket, show it to the owner as one line of JSON in a '
               'code fence and ask for their yes. The ticket is sent only on the owner\'s yes, by Squire outside this '
               'session; never send it any other way. When the check offers no ticket, tell the owner plainly that '
               'there is nothing to send, and never say that Squire has no health check or that you cannot run it. '
               'Show the owner no command, file path or tool name, only what the check found, in plain words.')

    @classmethod
    def problem(cls, key, value):
        """Why a value, trimmed, cannot be kept; None when it can."""
        limit = cls.LIMITS[key]
        if not isinstance(value, str) or not value:
            return 'it was empty'
        if len(value) > limit:
            return f'it was longer than {limit} characters'
        if any(unicodedata.category(c) == 'Cc' or c in '  ' for c in value):
            return 'it held a new line or a control character'
        if '<!--' in value or '-->' in value:
            return 'it held <!-- or -->, the marks that hold it in what Squire loads'
        if value.startswith('#'):
            return 'it started with #, which makes a heading'
        if '```' in value or '~~~' in value:
            return 'it held ``` or ~~~, which starts a block of code'
        return None

    @classmethod
    def of(cls, owner_folder):
        """The name and personality the owner's squire.json holds that can be
        kept; None when the file cannot be read."""
        try:
            with open(os.path.join(owner_folder, 'squire.json'), encoding='utf-8') as f:
                data = json.load(f)
        except (OSError, ValueError):
            return None
        if not isinstance(data, dict):
            return None
        return {key: data[key] for key in cls.LIMITS if key in data and cls.problem(key, data[key]) is None}

    @classmethod
    def block(cls, values):
        lines = [cls.OPEN]
        if 'squireName' in values:
            lines.append(f'Your name is {values["squireName"]}. You are the owner\'s own Squire, their assistant on '
                         'this Mac; use your name when you introduce yourself.')
        if 'personality' in values:
            lines.append(f'Your personality, in the owner\'s words: {values["personality"]}')
        lines.append(cls.UPDATES)
        lines.append(cls.HEALTH)
        lines.append(cls.TICKETS)
        lines.append(cls.CLOSE)
        return '\n'.join(lines) + '\n'

    @classmethod
    def write(cls, home, owner_folder):
        """Writes CLAUDE.md in Squire's config folder from the owner's
        squire.json, whole, through a file beside it. An owner's file that
        cannot be read leaves CLAUDE.md as last written."""
        values = cls.of(owner_folder)
        if values is None:
            return
        folder = os.path.join(home, 'claude-config')
        os.makedirs(folder, mode=0o700, exist_ok=True)
        fd, tmp = tempfile.mkstemp(prefix='.CLAUDE.md-', dir=folder)
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as f:
                f.write(cls.block(values))
            os.chmod(tmp, 0o600)
            os.replace(tmp, os.path.join(folder, 'CLAUDE.md'))
        except OSError:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise


class Records:
    """Squire's own state files in its home: read as JSON, written whole
    through a file beside them and a rename (mode 0600), and, where a record
    must survive a power cut, synced with its folder. A record whose digest
    a request carries is written in one canonical form."""

    @staticmethod
    def read(path):
        """The file's JSON, or None when it is missing or does not parse."""
        try:
            with open(path, encoding='utf-8') as f:
                return json.load(f)
        except (OSError, ValueError):
            return None

    @staticmethod
    def canonical(data):
        return json.dumps(data, sort_keys=True, separators=(',', ':'), ensure_ascii=True) + '\n'

    @staticmethod
    def write(path, data, durable=False, canonical=False):
        text = Records.canonical(data) if canonical else json.dumps(data, indent=2) + '\n'
        Records.write_bytes(path, text.encode('utf-8'), durable)

    @staticmethod
    def write_bytes(path, data, durable=False):
        folder = os.path.dirname(path)
        os.makedirs(folder, mode=0o700, exist_ok=True)
        fd, tmp = tempfile.mkstemp(prefix='.' + os.path.basename(path) + '-', dir=folder)
        try:
            with os.fdopen(fd, 'wb') as f:
                f.write(data)
                if durable:
                    f.flush()
                    os.fsync(f.fileno())
            os.chmod(tmp, 0o600)
            os.replace(tmp, path)
        except OSError:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
        if durable:
            Records.sync_folder(folder)

    @staticmethod
    def sync_folder(folder):
        fd = os.open(folder, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


class Version:
    """A Squire version: three whole numbers in ASCII digits joined by dots,
    each part 0 or starting 1 to 9, with nothing before or after it (not even
    a final newline), compared as numbers part by part. Anything else is not
    a version."""

    PATTERN = re.compile(r'^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\Z')

    @classmethod
    def of(cls, text):
        match = cls.PATTERN.match(text) if isinstance(text, str) else None
        return tuple(int(part) for part in match.groups()) if match else None


class ClaudeCode:
    """Claude Code as the owner's Mac has it, outside Squire: the version its
    launcher (~/.local/bin/claude) answers, and the launcher's resolved
    target, with that file's identity and the link's own, so a file put again
    at the same path, or a link made again, reads as a change. The runner
    records them in claude-code.json in the Squire home at its first start;
    the scheduler compares at every tick."""

    LAUNCHER = '~/.local/bin/claude'
    VERSION_WITHIN = 30
    ANSWER = re.compile(r'^(\d+\.\d+\.\d+) \(Claude Code\)$')

    @classmethod
    def version(cls, home):
        """The version claude --version answers through the launcher, in
        Squire's environment for Claude Code, or None when it exits non-zero,
        prints something else or does not answer. A launcher this user does
        not own, or that others may change, is never run."""
        launcher = os.path.expanduser(cls.LAUNCHER)
        try:
            found = os.stat(launcher)
        except OSError:
            return None
        if not stat.S_ISREG(found.st_mode) or found.st_uid != os.getuid() \
                or found.st_mode & (stat.S_IWGRP | stat.S_IWOTH) or not os.access(launcher, os.X_OK):
            return None
        env = {'PATH': ':'.join(System.FOLDERS + (os.path.dirname(launcher), '/opt/homebrew/bin')),
               'HOME': os.path.expanduser('~'), 'USER': pwd.getpwuid(os.getuid()).pw_name, 'SQUIRE_HOME': home,
               'CLAUDE_CONFIG_DIR': os.path.join(home, 'claude-config'), 'LANG': System.LANG}
        try:
            r = subprocess.run([launcher, '--version'], cwd='/', env=env, stdin=subprocess.DEVNULL,
                               capture_output=True, text=True, timeout=cls.VERSION_WITHIN)
        except (OSError, subprocess.SubprocessError, ValueError):
            return None
        match = cls.ANSWER.match(r.stdout.strip()) if r.returncode == 0 else None
        return match.group(1) if match else None

    @classmethod
    def values(cls, home):
        launcher = os.path.expanduser(cls.LAUNCHER)
        values = {'version': cls.version(home), 'target': None, 'file': None, 'link': None}
        try:
            link = os.lstat(launcher)
            values['link'] = [link.st_dev, link.st_ino]
            target = os.path.realpath(launcher)
            found = os.stat(target)
            values['file'] = [found.st_dev, found.st_ino, found.st_size, found.st_mtime_ns]
            values['target'] = target
        except OSError:
            pass
        return values

    @classmethod
    def record_once(cls, home):
        """The runner's first start: the values, written only when the Squire
        home holds no record yet."""
        path = os.path.join(home, 'claude-code.json')
        if os.path.lexists(path):
            return
        try:
            Records.write(path, cls.values(home))
        except OSError:
            pass

    @staticmethod
    def changes(before, now):
        """What changed between two readings, in plain words; empty when
        nothing did."""
        said = []
        if before.get('version') != now.get('version'):
            said.append(f'its version is now {now["version"]}' if now.get('version')
                        else 'its version could not be read')
        if before.get('target') != now.get('target'):
            said.append('its launcher now points at another file' if now.get('target')
                        else 'its launcher points at nothing')
        elif before.get('file') != now.get('file') or before.get('link') != now.get('link'):
            said.append('the file its launcher points at was put in place again')
        return said
