"""Squire's wake-up router.

    /usr/bin/python3 -B wake-up.py <text>   delivers one wake-up now
    /usr/bin/python3 -B wake-up.py --due    delivers the owner's picked wake-ups
                                            that have come due, and the retries
                                            now due (the scheduler's agent runs
                                            it every 60 seconds); then the
                                            health check's known fixes the
                                            owner said yes to, and once a day
                                            the warning of a sign-in that ends
                                            within seven days; then, once core
                                            is installed, an update that did
                                            not finish, the Claude Code watch,
                                            the weekly update check (which
                                            stages and tells, and never
                                            installs), and the support
                                            tickets to send

A wake-up reaches only Squire's own session: the one session record in the
Squire home, its process alive and the one it was, its socket its own and
listening from that process. When that cannot be shown, nothing is sent and
logs/wake-ups.log says why. A failed delivery goes nowhere else; it is
retried at most 3 times over 10 minutes, each retry a minute or more after
the last attempt and checked again from scratch. Every wake-up's text starts
"Squire wake-up:", so it can never be taken as the owner's yes or no.

Each wake-up's state is wake-ups/<id>.json in the Squire home, written before
its message is: when it cannot be written, nothing is sent and the router
exits non-zero.
"""

import hashlib
import json
import os
import re
import socket
import subprocess
import sys
import tempfile
import time

CORE = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))


class Framing:
    """What a wake-up says to the session."""

    START = 'Squire wake-up:'

    @classmethod
    def content(cls, state, now):
        if state.get('due'):
            return f'{cls.START} due {state["due"]}, delivered {time.strftime("%H:%M", time.localtime(now))}\n' \
                   f'{state["text"]}'
        return f'{cls.START} {state["text"]}'


class Identity:
    """Squire's own session, from the session records alone and never by
    name, checked from scratch at every attempt in one order: the records,
    the session aimed at, the process, then the socket."""

    def __init__(self, home):
        self.folder = os.path.join(home, 'sessions')

    def records(self):
        try:
            names = sorted(n for n in os.listdir(self.folder) if n.endswith('.json') and not n.startswith('.'))
        except FileNotFoundError:
            return []
        found = []
        for name in names:
            try:
                with open(os.path.join(self.folder, name), encoding='utf-8') as f:
                    record = json.load(f)
            except (OSError, ValueError):
                record = None
            found.append(record if isinstance(record, dict) else {})
        return found

    def check(self, aimed):
        """('ok', '', record), ('failed', reason, record) for a failure that is
        retried, or ('not sent', reason, record) for an identity failure."""
        from squire import Process

        records = self.records()
        if not records:
            return 'failed', 'no record', None
        if len(records) > 1:
            return 'not sent', 'more than one record', None
        record = records[0]
        if aimed is not None and record.get('sessionId') != aimed:
            return 'not sent', 'session changed', record
        started = record.get('pidStartedAt')
        if not isinstance(started, str) or Process.started_at(record.get('pid')) != started:
            return 'failed', 'process gone', record
        try:
            found = os.stat(record.get('socket'))
        except FileNotFoundError:
            return 'failed', 'missing socket', record
        except (OSError, TypeError, ValueError):
            return 'not sent', 'stale record (its socket cannot be read)', record
        if found.st_ino != record.get('socketInode'):
            return 'not sent', 'stale record (another socket at its path)', record
        if found.st_uid != os.getuid():
            return 'not sent', 'another user\'s socket', record
        if found.st_uid != record.get('socketOwner'):
            return 'not sent', 'stale record (its socket\'s owner changed)', record
        return 'ok', '', record


class Delivery:
    """One message on Claude Code's line format: one connection, the token
    line, a half-second pause in which the session closing means it turned
    the token away, the user line, then the sending side closed. The session
    closing within 10 seconds is the acknowledgement."""

    SOL_LOCAL, LOCAL_PEERPID = 0, 2
    WRITE_WITHIN = 5.0
    PAUSE = 0.5
    ACK_WITHIN = 10.0
    TIMEOUT = 'timeout before the line was written'

    def __init__(self, record):
        self.record = record

    def send(self, content):
        """(outcome, reason). The caller has recorded the attempt."""
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        end = time.monotonic() + self.WRITE_WITHIN
        try:
            sock.settimeout(self.WRITE_WITHIN)
            try:
                sock.connect(self.record['socket'])
            except FileNotFoundError:
                return 'failed', 'missing socket'
            except ConnectionRefusedError:
                return 'failed', 'refused connection'
            except socket.timeout:
                return 'failed', self.TIMEOUT
            except OSError as e:
                return 'failed', f'connection failed ({e.strerror or type(e).__name__})'
            try:
                peer = sock.getsockopt(self.SOL_LOCAL, self.LOCAL_PEERPID)
            except OSError as e:
                return 'failed', f'connection failed ({e.strerror or type(e).__name__})'
            if peer != self.record.get('pid'):
                return 'not sent', 'stale record (another process listens on its socket)'
            token = json.dumps({'type': 'auth', 'token': self.record.get('token')}, separators=(',', ':'))
            user = json.dumps({'type': 'user', 'message': {'role': 'user', 'content': content}}, separators=(',', ':'))
            try:
                self.write(sock, token, end)
                sock.settimeout(self.PAUSE)
                try:
                    if sock.recv(4096) == b'':
                        return 'failed', 'rejected token'
                except socket.timeout:
                    pass
                self.write(sock, user, end)
            except socket.timeout:
                return 'failed', self.TIMEOUT
            except OSError:
                return 'failed', 'rejected token (the session closed the connection)'
            return self.acknowledged(sock)
        finally:
            sock.close()

    @staticmethod
    def write(sock, line, end):
        left = end - time.monotonic()
        if left <= 0:
            raise socket.timeout()
        sock.settimeout(left)
        sock.sendall((line + '\n').encode('utf-8'))

    def acknowledged(self, sock):
        end = time.monotonic() + self.ACK_WITHIN
        try:
            sock.shutdown(socket.SHUT_WR)
            while True:
                left = end - time.monotonic()
                if left <= 0:
                    raise socket.timeout()
                sock.settimeout(left)
                if sock.recv(4096) == b'':
                    return 'delivered', ''
        except socket.timeout:
            return 'unknown', 'written and not acknowledged within 10 seconds; never retried'
        except OSError as e:
            return 'unknown', f'written, then the connection failed ({e.strerror or type(e).__name__}); never retried'


class FixTick:
    """The outside job for the health check's known fixes: when the approvals
    ledger holds an owner's yes to a known fix not yet used, the scheduler's
    run runs the health check's perform step once, bounded, with an
    environment built from nothing."""

    WITHIN = 1200

    def __init__(self, config):
        self.config = config

    def run(self):
        from squire import Ledger, System

        if not Ledger.fix_pending(self.config.ledger_path):
            return
        try:
            subprocess.run([System.command('/usr/bin/python3'), '-B', os.path.join(CORE, 'tools', 'health.py'), '--perform'],
                           cwd='/', env=System.env(self.config.home), stdin=subprocess.DEVNULL,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=self.WITHIN)
        except (OSError, subprocess.SubprocessError):
            pass


class SignInWarning:
    """Once a day, Squire's Claude sign-in is read; when it ends within seven
    days, one wake-up through Squire's own session names the day and the one
    action. sign-in.json in the Squire home keeps the day it last looked."""

    TEXT = ('Squire\'s Claude sign-in ends on {day}. The one thing to do: sign in again before then. To ask for it, '
            'run {python} {health} --request sign-in and ask the owner for their yes; the sign-in page then opens in '
            'the browser.')

    def __init__(self, router):
        self.router = router
        self.file = os.path.join(router.home, 'sign-in.json')

    def run(self, now):
        from squire import ClaudeSignIn

        today = time.strftime('%Y-%m-%d', time.localtime(now))
        try:
            with open(self.file, encoding='utf-8') as f:
                if json.load(f).get('checked') == today:
                    return
        except (OSError, ValueError, AttributeError):
            pass
        sign_in = ClaudeSignIn(self.router.home)
        if not sign_in.claude:
            return
        ends = sign_in.ends_soon(now)
        try:
            fd, tmp = tempfile.mkstemp(prefix='.sign-in-', dir=self.router.home)
            with os.fdopen(fd, 'w', encoding='utf-8') as f:
                json.dump({'checked': today}, f)
                f.write('\n')
            os.replace(tmp, self.file)
        except OSError:
            return
        if ends is None:
            return
        day = sign_in.day(ends)
        health = os.path.join(self.router.home, 'core', 'tools', 'health.py')
        state = {'id': f'sign-in-{day}-{today}', 'text': self.TEXT.format(day=day, python='/usr/bin/python3', health=health),
                 'session': None, 'attempts': [], 'state': 'retrying'}
        self.router.attempt(state, now)


class ClaudeCodeWatch:
    """Claude Code changed outside Squire: each tick compares its version and
    launcher with the record the runner made (claude-code.json); a
    difference, or a value it cannot read, runs the health check and sends
    its result in one wake-up, then the values read become the record, so
    the same change is never reported twice. No downgrade is offered."""

    TEXT = 'Claude Code changed outside Squire ({what}); the health check says: {said}'

    def __init__(self, router):
        self.router = router
        self.file = os.path.join(router.home, 'claude-code.json')

    def run(self, now):
        from squire import ClaudeCode, Records

        before = Records.read(self.file)
        if not isinstance(before, dict):
            return
        values = ClaudeCode.values(self.router.home)
        changes = ClaudeCode.changes(before, values)
        if not changes:
            return
        sys.path.insert(0, os.path.join(CORE, 'tools'))
        from update import HealthLines

        lines = HealthLines.run(self.router.home)
        said = 'the health check could not run' if lines is None else ('; '.join(lines) or 'all checks passed')
        state = {'id': f'claude-code-{int(now * 1000)}-{os.urandom(3).hex()}',
                 'text': self.TEXT.format(what=', and '.join(changes), said=said), 'session': None, 'attempts': [],
                 'state': 'retrying'}
        self.router.attempt(state, now)
        Records.write(self.file, values)


class OutsideJobs:
    """The scheduler's outside jobs for updates and support tickets, once core
    is installed with its release.json, in this order: an install that did
    not finish is settled where nothing needs laying down, and otherwise
    handed to Squire Update (update.py --recover); Claude Code is compared
    with its record; the weekly check runs; and the outbox's tickets are set
    aside, sent or retried (ticket.py --perform). The tick never installs:
    Squire Update does, at the Mac. Each child runs in this run's process
    group, held to its end, and none stops an agent."""

    WITHIN = 1500

    def __init__(self, router):
        self.router = router
        self.config = router.config
        self.home = router.home

    def run(self, now):
        if not os.path.isfile(os.path.join(self.home, 'core', 'release.json')):
            return
        try:
            self.jobs(now)
        except Exception as e:
            self.router.log(f'the outside jobs for updates and tickets stopped ({type(e).__name__}: {e})')

    def jobs(self, now):
        sys.path.insert(0, os.path.join(CORE, 'tools'))
        from update import Install, WeeklyCheck
        from ticket import Outbox

        if Install.unfinished(self.home):
            self.child('update.py', '--recover')
        ClaudeCodeWatch(self.router).run(now)
        WeeklyCheck(self.config, self.send).run(time.time())
        if Outbox.pending(self.home):
            self.child('ticket.py', '--perform')

    def send(self, text, wake_id):
        self.router.attempt({'id': wake_id, 'text': text, 'session': None, 'attempts': [], 'state': 'retrying'},
                            time.time())

    def child(self, tool, flag):
        from squire import System

        try:
            subprocess.run([System.command('/usr/bin/python3'), '-B', os.path.join(CORE, 'tools', tool), flag], cwd='/',
                           env=System.env(self.home), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, timeout=self.WITHIN)
        except (OSError, subprocess.SubprocessError):
            pass


class WakeUpRouter:
    RETRIES = 3
    RETRY_GAP = 60
    RETRY_WITHIN = 600
    LATE = 7200
    PICKED = re.compile(r'^([01][0-9]|2[0-3]):([0-5][0-9])\s+(\S.*)$')

    def __init__(self, config):
        self.config = config
        self.home = config.home
        self.states = os.path.join(self.home, 'wake-ups')
        self.log_file = os.path.join(self.home, 'logs', 'wake-ups.log')
        self.identity = Identity(self.home)

    @staticmethod
    def main(argv):
        sys.path.insert(0, os.path.join(CORE, 'lib'))
        from squire import Config, SquireError

        if len(argv) != 1 or not argv[0].strip():
            sys.stderr.write('give one wake-up text, or --due: wake-up.py <text> | wake-up.py --due\n')
            return 2
        try:
            router = WakeUpRouter(Config())
        except SquireError as e:
            sys.stderr.write(f'wake-up: {e}.\n')
            return 2
        try:
            if argv[0] == '--due':
                router.due(time.time())
                FixTick(router.config).run()
                SignInWarning(router).run(time.time())
                OutsideJobs(router).run(time.time())
                return 0
            now = time.time()
            state = {'id': f'fired-{int(now * 1000)}-{os.urandom(3).hex()}', 'text': argv[0], 'session': None,
                     'attempts': [], 'state': 'retrying'}
            return 0 if router.attempt(state, now) == 'delivered' else 1
        except SquireError as e:
            router.log(f'{e}; nothing more was sent')
            return 1

    def due(self, now):
        """The retries now due, then the owner's picked wake-ups that have come due."""
        for state in self.saved():
            if state.get('state') == 'retrying':
                self.retry(state, now)
        for text, hour, minute in self.picked():
            at = time.mktime((*time.localtime(now)[:3], hour, minute, 0, 0, 0, -1))
            if at > now:
                lt = time.localtime(now)
                at = time.mktime((lt.tm_year, lt.tm_mon, lt.tm_mday - 1, hour, minute, 0, 0, 0, -1))
            due = '%02d:%02d' % (hour, minute)
            entry = f'{due} {text}'
            wake_id = f'picked-{time.strftime("%Y%m%d", time.localtime(at))}-{hour:02d}{minute:02d}-' \
                      f'{hashlib.sha256(entry.encode("utf-8")).hexdigest()[:10]}'
            if os.path.exists(os.path.join(self.states, wake_id + '.json')):
                continue
            state = {'id': wake_id, 'text': text, 'session': None, 'due': due, 'attempts': [], 'state': 'retrying'}
            late = int((now - at) // 60)
            if now - at >= self.LATE:
                reason = f'missed: due {due}, {late} minutes late'
                state['attempts'].append({'at': now, 'outcome': 'missed', 'reason': reason})
                state['state'] = 'missed'
                self.save(state)
                self.log(f'{wake_id} missed: due {due}, {late} minutes late, two hours or more; not sent')
            else:
                self.attempt(state, now)

    def picked(self):
        """The owner's picked wake-ups: wakeUps in the owner's squire.json,
        each "HH:MM text" in local time."""
        try:
            with open(os.path.join(self.config.owner_folder, 'squire.json'), encoding='utf-8') as f:
                entries = json.load(f).get('wakeUps')
        except (OSError, ValueError, AttributeError):
            return []
        found = []
        for entry in entries if isinstance(entries, list) else []:
            match = self.PICKED.match(entry.strip()) if isinstance(entry, str) else None
            if match:
                found.append((match.group(3), int(match.group(1)), int(match.group(2))))
        return found

    def saved(self):
        try:
            names = sorted(n for n in os.listdir(self.states) if n.endswith('.json') and not n.startswith('.'))
        except FileNotFoundError:
            return []
        found = []
        for name in names:
            try:
                with open(os.path.join(self.states, name), encoding='utf-8') as f:
                    state = json.load(f)
            except (OSError, ValueError):
                continue
            if isinstance(state, dict) and isinstance(state.get('attempts'), list) and state.get('id') == name[:-5]:
                found.append(state)
        return found

    def retry(self, state, now):
        attempts = state['attempts']
        if attempts and (len(attempts) > self.RETRIES or now - attempts[0].get('at', 0) >= self.RETRY_WITHIN):
            self.fail(state)
        elif not attempts or now - attempts[-1].get('at', 0) >= self.RETRY_GAP:
            self.attempt(state, now)

    def fail(self, state):
        state['state'] = 'failed'
        self.save(state)
        reasons = '; '.join(f'{a.get("reason")}' for a in state['attempts'])
        self.log(f'{state["id"]} failed after {len(state["attempts"])} attempts, never retried again: {reasons}')

    def attempt(self, state, now):
        """One attempt, recorded; returns its outcome."""
        kind, reason, record = self.identity.check(state.get('session'))
        if record is not None and state.get('session') is None:
            state['session'] = record.get('sessionId')
        attempt = {'at': now, 'outcome': kind, 'reason': reason}
        if kind == 'ok':
            # Recorded before anything is written: an attempt cut off midway
            # stays unknown and is never retried.
            state['attempts'].append({'at': now, 'outcome': 'unknown', 'reason': 'being delivered'})
            state['state'] = 'unknown'
            self.save(state)
            kind, reason = Delivery(record).send(Framing.content(state, time.time()))
            attempt = {'at': now, 'outcome': kind, 'reason': reason or f'delivered to session {record.get("sessionId")}'}
            state['attempts'][-1] = attempt
        else:
            state['attempts'].append(attempt)
        if kind == 'failed':
            state['state'] = 'retrying'
            if len(state['attempts']) > self.RETRIES or now - state['attempts'][0]['at'] >= self.RETRY_WITHIN:
                self.fail(state)
                return kind
        else:
            state['state'] = kind
        self.save(state)
        what = {'delivered': 'delivered', 'not sent': 'not sent, never retried', 'unknown': 'unknown',
                'failed': 'failed, a retry is due'}[kind]
        self.log(f'{state["id"]} {what}: {attempt["reason"]}')
        return kind

    def save(self, state):
        try:
            os.makedirs(self.states, mode=0o700, exist_ok=True)
            fd, tmp = tempfile.mkstemp(prefix='.wake-up-', dir=self.states)
            with os.fdopen(fd, 'w', encoding='utf-8') as f:
                json.dump(state, f, indent=2)
                f.write('\n')
            os.replace(tmp, os.path.join(self.states, state['id'] + '.json'))
        except OSError as e:
            from squire import SquireError
            raise SquireError(f'{state["id"]}: the wake-up state could not be written ({e.strerror or type(e).__name__})')

    def log(self, line):
        try:
            os.makedirs(os.path.dirname(self.log_file), exist_ok=True)
            with open(self.log_file, 'a', encoding='utf-8') as f:
                f.write(f'{time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())} {line}\n')
        except OSError as e:
            sys.stderr.write(f'wake-up: the log could not be written ({e.strerror}): {line}\n')


if __name__ == '__main__':
    sys.exit(WakeUpRouter.main(sys.argv[1:]))
