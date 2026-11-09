"""What Squire's core entry points share: the one config, canonical paths
and the approvals ledger in the owner's state folder.

Standard library only; run by /usr/bin/python3.
"""

import fcntl
import json
import os
import subprocess
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
    folder, written only by the floor and read whole under an exclusive lock.

    Records: a request for a yes ({type: request, id, session, item, at});
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
