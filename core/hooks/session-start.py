"""Records Squire's session, run by Claude Code at every SessionStart from
core's settings. Prints nothing and always exits 0.

The job: at startup and at clear it writes the job's record in the approvals
ledger, keeping one the ledger already holds for that id, so the floor knows
it saw the job start. It never removes a job's marks: any other start under
an id the floor has never seen (a resume, say) is a job it cannot place, and
the job starts holding untrusted input and the owner's private things.

The session: with CLAUDE_CODE_MESSAGING_SOCKET and CLAUDE_CODE_MESSAGING_TOKEN
set, it waits up to 10 seconds for the socket, then writes
sessions/<session id>.json in the Squire home, readable by its user only:
the session id, the socket with its inode and owner, the token, the session
process (the hook's parent, the one listening on the socket) and that
process's start, the source and the time. No socket, no record. It removes
the records of sessions whose process is gone and any earlier record of its
own session process.
"""

import json
import os
import stat
import sys
import tempfile
import time

CORE = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))


class SessionStart:
    CLEAN = ('startup', 'clear')
    UNPLACED = 'a job the floor did not see start'
    SOCKET_WAIT = 10.0

    @classmethod
    def handle(cls, raw):
        sys.path.insert(0, os.path.join(CORE, 'lib'))
        from squire import Config, Ledger

        event = json.loads(raw.decode('utf-8'))
        if not isinstance(event, dict) or event.get('hook_event_name') != 'SessionStart':
            return
        session, source = event.get('session_id'), event.get('source')
        if not isinstance(session, str) or not session:
            return
        config = Config()
        now = time.time()
        with Ledger(config.ledger_path) as ledger:
            if source in cls.CLEAN:
                ledger.job(session, source, now)
            elif not ledger.seen(session):
                for kind in ('untrusted', 'private'):
                    ledger.taint(session, kind, cls.UNPLACED, now)
        cls.record(config.home, session, source)

    @classmethod
    def record(cls, home, session, source):
        from squire import Process

        socket_path = os.environ.get('CLAUDE_CODE_MESSAGING_SOCKET')
        token = os.environ.get('CLAUDE_CODE_MESSAGING_TOKEN')
        if not socket_path or not token or session in ('.', '..') or os.path.basename(session) != session:
            return
        found = cls.socket(socket_path)
        if found is None:
            return
        pid = os.getppid()
        record = {'sessionId': session, 'socket': socket_path, 'socketInode': found.st_ino, 'socketOwner': found.st_uid,
                  'token': token, 'pid': pid, 'pidStartedAt': Process.started_at(pid), 'source': source,
                  'recordedAt': time.time()}
        folder = os.path.join(home, 'sessions')
        os.makedirs(folder, mode=0o700, exist_ok=True)
        for name in os.listdir(folder):
            if not name.endswith('.json') or name == session + '.json':
                continue
            try:
                with open(os.path.join(folder, name), encoding='utf-8') as f:
                    other = json.load(f)
                mine = other.get('pid') == pid and other.get('pidStartedAt') == record['pidStartedAt']
                gone = not isinstance(other.get('pidStartedAt'), str) or \
                    Process.started_at(other.get('pid')) != other.get('pidStartedAt')
            except (OSError, ValueError, AttributeError):
                continue
            if mine or gone:
                try:
                    os.unlink(os.path.join(folder, name))
                except OSError:
                    pass
        fd, tmp = tempfile.mkstemp(prefix='.session-', dir=folder)
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            json.dump(record, f, indent=2)
            f.write('\n')
        os.replace(tmp, os.path.join(folder, session + '.json'))

    @classmethod
    def socket(cls, path):
        """The socket at path, waited for; None when none appears in time."""
        end = time.monotonic() + cls.SOCKET_WAIT
        while True:
            try:
                found = os.stat(path)
                if stat.S_ISSOCK(found.st_mode):
                    return found
            except OSError:
                pass
            if time.monotonic() >= end:
                return None
            time.sleep(0.1)


if __name__ == '__main__':
    try:
        SessionStart.handle(sys.stdin.buffer.read())
    except Exception:
        pass
    sys.exit(0)
