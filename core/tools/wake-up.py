"""Squire's wake-up router.

    /usr/bin/python3 -B wake-up.py <text>   delivers one wake-up now
    /usr/bin/python3 -B wake-up.py --due    delivers the owner's picked wake-ups
                                            that have come due, and the retries
                                            now due (the scheduler's agent runs
                                            it every 60 seconds)

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
            if sock.getsockopt(self.SOL_LOCAL, self.LOCAL_PEERPID) != self.record.get('pid'):
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
