"""Records Squire's session, run by Claude Code at every SessionStart from
core's settings, and brings the handover note to the conversation after
/clear. Always exits 0.

The handover: each start of a session opens a new period for its /clear
prompt and a compaction is counted, per session id, in runtime/handover.json
in the Squire home. At source clear it prints the newest handover note saved
since the last pickup (state/handover/*.md in the owner's folder, newest by
modification time, never an empty one), whole, after one line saying it is
the handover from the last conversation, so it reaches the new
conversation's context, and records it picked up by its path and when. Only
that note is ever brought as the last conversation's: with none saved since
the last pickup, it prints at most one line saying older notes stay in the
owner's folder (when one never picked up is there). startup, resume and
compact print no handover. A note is never deleted. This comes first, before
and whatever happens to the steps below.

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
own session process. Once the session process that ran it is gone, it
writes nothing more.
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
    PICKUP = ('Squire note from Squire\'s own code (not a message from anyone): this is the handover note from the last '
              'conversation, saved at {path}. Pick up the work in progress from it; it follows whole.')
    OLDER = ('Squire note from Squire\'s own code (not a message from anyone): older handover notes stay in '
             'state/handover in the owner\'s folder; ask for one by name if you need it.')

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
        try:
            cls.handover(config, session, source)
        except Exception:
            pass
        now = time.time()
        parent = os.getppid()
        if not cls.alive(parent):
            return
        with Ledger(config.ledger_path) as ledger:
            if source in cls.CLEAN:
                ledger.job(session, source, now)
            elif not ledger.seen(session):
                for kind in ('untrusted', 'private'):
                    ledger.taint(session, kind, cls.UNPLACED, now)
        cls.record(config.home, session, source, parent)

    @classmethod
    def handover(cls, config, session, source):
        """The handover's part of a start (the module's docstring)."""
        from squire import Runtime, is_number

        folder = os.path.join(config.owner_folder, 'state', 'handover')
        shown, older = [], []
        now = time.time()

        def change(data):
            sessions = data.get('sessions') if isinstance(data.get('sessions'), dict) else {}
            mine = dict(sessions.get(session)) if isinstance(sessions.get(session), dict) else {}
            mine['period'] = (mine.get('period') if isinstance(mine.get('period'), int) else 0) + 1
            if source == 'compact':
                mine['compactions'] = (mine.get('compactions') if isinstance(mine.get('compactions'), int) else 0) + 1
            sessions[session] = mine
            data = {**data, 'sessions': sessions}
            if source == 'clear':
                picked = data.get('pickedUp') if isinstance(data.get('pickedUp'), list) else []
                since = data.get('pickedUpAt') if is_number(data.get('pickedUpAt')) else None
                note = cls.newest(folder, picked, since)
                if note:
                    data['pickedUp'] = picked + [note[0]]
                    data['pickedUpAt'] = now
                    shown.append(note)
                elif cls.newest(folder, picked):
                    older.append(True)
            return data

        Runtime.update(config.home, 'handover.json', change)
        for path, text in shown:
            print(cls.PICKUP.format(path=path))
            print(text.rstrip('\n'))
        if older:
            print(cls.OLDER)

    @staticmethod
    def newest(folder, picked, since=None):
        """(path, text) of the newest handover note in folder by modification
        time that is not empty, not in picked and, when since is given, saved
        after it; or None."""
        try:
            names = os.listdir(folder)
        except OSError:
            return None
        found = []
        for name in names:
            path = os.path.join(folder, name)
            if not name.endswith('.md') or path in picked:
                continue
            try:
                st = os.stat(path)
                if not stat.S_ISREG(st.st_mode) or st.st_size == 0 or (since is not None and st.st_mtime <= since):
                    continue
                with open(path, encoding='utf-8', errors='replace') as f:
                    text = f.read()
            except OSError:
                continue
            found.append((st.st_mtime, path, text))
        if not found:
            return None
        _, path, text = max(found)
        return path, text

    @staticmethod
    def alive(parent):
        """The session process that ran the hook is still there. Once it is
        gone the hook is launchd's child (process 1) and writes nothing more."""
        return parent != 1 and os.getppid() == parent

    @classmethod
    def record(cls, home, session, source, pid):
        from squire import Process

        socket_path = os.environ.get('CLAUDE_CODE_MESSAGING_SOCKET')
        token = os.environ.get('CLAUDE_CODE_MESSAGING_TOKEN')
        if not socket_path or not token or session in ('.', '..') or os.path.basename(session) != session:
            return
        found = cls.socket(socket_path, pid)
        if found is None:
            return
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
        if not cls.alive(pid):
            return
        fd, tmp = tempfile.mkstemp(prefix='.session-', dir=folder)
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            json.dump(record, f, indent=2)
            f.write('\n')
        os.replace(tmp, os.path.join(folder, session + '.json'))

    @classmethod
    def socket(cls, path, parent):
        """The socket at path, waited for; None when none appears in time, or
        the session process is gone."""
        end = time.monotonic() + cls.SOCKET_WAIT
        while cls.alive(parent):
            try:
                found = os.stat(path)
                if stat.S_ISSOCK(found.st_mode):
                    return found
            except OSError:
                pass
            if time.monotonic() >= end:
                return None
            time.sleep(0.1)
        return None


if __name__ == '__main__':
    try:
        SessionStart.handle(sys.stdin.buffer.read())
    except Exception:
        pass
    sys.exit(0)
