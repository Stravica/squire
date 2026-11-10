"""Squire's support tickets: built once from allow-listed diagnostics into
the outbox in the Squire home, shown to the owner byte for byte in the
safety floor's block, sent only on the owner's yes by the scheduler, and
kept and retried exactly as approved when sending fails.

    /usr/bin/python3 -B ticket.py --send <ticket id>
        the session's request; the safety floor shows the owner the outbox
        file's exact bytes and asks for their yes, and never lets it run in
        the session
    /usr/bin/python3 -B ticket.py --perform
        the scheduler's send, outside the session: a ticket the owner said no
        to, or left unanswered past the ledger's timeout, is set aside; one
        the owner said a fresh, exact yes to is posted to the configured
        intake; one whose send failed is tried again with a growing wait

The health check builds a ticket (whoever runs it) for a fault it offers
one for, and offers it on a line of its own.
"""

import hashlib
import http.client
import json
import os
import pwd
import re
import ssl
import subprocess
import sys
import time
from urllib.parse import urlsplit

CORE = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
PYTHON = '/usr/bin/python3'
sys.path.insert(0, os.path.join(CORE, 'lib'))
sys.path.insert(0, os.path.join(CORE, 'tools'))

from squire import ClaudeCode, Config, Ledger, Records, SquireError, System, Version  # noqa: E402
from update import Install, Releases  # noqa: E402


class Ticket:
    """One ticket's diagnostics: only allow-listed fields, each value from a
    closed set or a fixed pattern, a value outside its set or pattern
    dropped; the privacy patterns run over the result as a second net. The
    bytes are canonical JSON, the same in the preview, the outbox and every
    attempt."""

    CODES = ('floor', 'agents', 'sign-in', 'runner', 'release', 'update-rollback-failed')
    FIXES = ('runner', 'floor', 'sign-in')
    AGENTS = ('com.stravica.squire.runner', 'com.stravica.squire.wake-ups', 'com.stravica.squire.backup')
    MODELS = (('MacBookAir', 'MacBook Air'), ('MacBookPro', 'MacBook Pro'), ('Macmini', 'Mac mini'), ('iMac', 'iMac'),
              ('MacStudio', 'Mac Studio'), ('MacPro', 'Mac Pro'))
    MAC = re.compile(r'^Mac\d+,\d+$')
    MACOS = re.compile(r'^\d+(\.\d+)*$')
    FACT_WITHIN = 5
    PRIVATE = (re.compile(r'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'),
               re.compile(r'\+\d[\d\s().-]{6,}\d|\b\d{3}[\s.-]\d{3,4}[\s.-]\d{4}\b'),
               re.compile(r'(?:\d[ .-]?){12,18}\d'))
    NETTED = ('destination', 'squireVersion', 'claudeCodeVersion', 'macOSVersion', 'macModelClass')

    def __init__(self, home):
        self.home = home

    def fields(self, intake, codes, tried):
        ticket = {
            'ticketId': 't-' + os.urandom(16).hex(),
            'installId': self.install_id(),
            'destination': intake,
            'squireVersion': Releases(self.home).installed(),
            'claudeCodeVersion': ClaudeCode.version(self.home),
            'macOSVersion': self.fact('/usr/bin/sw_vers', '-productVersion'),
            'macModelClass': self.model(),
            'agentsLoaded': self.agents(),
            'healthCodes': [c for c in codes if c in self.CODES],
            'fixesTried': [f for f in tried if f in self.FIXES],
            'createdAt': int(time.time()),
        }
        if not Version.of(ticket['squireVersion']):
            del ticket['squireVersion']
        if not Version.of(ticket['claudeCodeVersion']):
            del ticket['claudeCodeVersion']
        if not (isinstance(ticket['macOSVersion'], str) and self.MACOS.match(ticket['macOSVersion'])):
            del ticket['macOSVersion']
        if ticket['macModelClass'] is None:
            del ticket['macModelClass']
        names = self.account_names()
        for key in self.NETTED:
            value = ticket.get(key)
            if isinstance(value, str) and (any(p.search(value) for p in self.PRIVATE)
                                           or any(n.search(value) for n in names)):
                del ticket[key]
        return ticket

    def install_id(self):
        """128 random bits from the system's random source, made at the first
        ticket and kept in install-id in the Squire home, readable by its user
        only."""
        path = os.path.join(self.home, 'install-id')
        try:
            with open(path, encoding='utf-8') as f:
                found = f.read().strip()
            if re.match(r'^[0-9a-f]{32}$', found):
                return found
        except OSError:
            pass
        made = os.urandom(16).hex()
        Records.write_bytes(path, (made + '\n').encode('ascii'), durable=True)
        return made

    def fact(self, command, *args):
        """One of the Mac's own answers, bounded at 5 seconds; None when it
        does not answer."""
        try:
            r = subprocess.run([System.command(command), *args], cwd='/', env=System.env(), stdin=subprocess.DEVNULL,
                               capture_output=True, text=True, timeout=self.FACT_WITHIN)
        except (OSError, subprocess.SubprocessError, ValueError):
            return None
        return r.stdout.strip() if r.returncode == 0 else None

    def model(self):
        model = self.fact('/usr/sbin/sysctl', '-n', 'hw.model') or ''
        for prefix, name in self.MODELS:
            if model.startswith(prefix):
                return name
        return 'Mac' if self.MAC.match(model) else None

    def agents(self):
        if not System.own_home():
            return []
        loaded = []
        for label in self.AGENTS:
            try:
                if subprocess.run([System.command('/bin/launchctl'), 'print', f'gui/{os.getuid()}/{label}'], cwd='/',
                                  env=System.env(), stdin=subprocess.DEVNULL, capture_output=True,
                                  timeout=self.FACT_WITHIN).returncode == 0:
                    loaded.append(label)
            except (OSError, subprocess.SubprocessError):
                pass
        return loaded

    @staticmethod
    def account_names():
        entry = pwd.getpwuid(os.getuid())
        names = [entry.pw_name, entry.pw_gecos.split(',')[0].strip()]
        return [re.compile(r'(?<![A-Za-z0-9])' + re.escape(n) + r'(?![A-Za-z0-9])', re.IGNORECASE)
                for n in names if n and len(n) >= 3]


class Outbox:
    """The outbox in the Squire home: outbox/<ticket id>.json, the ticket's
    bytes, and outbox/<ticket id>.state.json, its record ({digest, request,
    attempts}); outbox/faults.json names the ticket each fault's occurrence
    was offered, so a fault names the same ticket while it waits, and its
    next occurrence, once that ticket is sent or set aside, a new one."""

    RETRY_FIRST = 60
    RETRY_MOST = 6 * 3600
    POST_WITHIN = 30
    ID = re.compile(r'^t-[0-9a-f]{32}$')

    def __init__(self, config):
        self.config = config
        self.home = config.home
        self.folder = os.path.join(self.home, 'outbox')
        self.index_file = os.path.join(self.folder, 'faults.json')

    def file(self, ticket_id):
        return os.path.join(self.folder, f'{ticket_id}.json')

    def state_file(self, ticket_id):
        return os.path.join(self.folder, f'{ticket_id}.state.json')

    def waiting(self):
        try:
            names = sorted(os.listdir(self.folder))
        except OSError:
            return []
        return [n[:-5] for n in names if n.endswith('.json') and self.ID.match(n[:-5])]

    @classmethod
    def pending(cls, home):
        """True when a ticket waits in the outbox."""
        try:
            names = os.listdir(os.path.join(home, 'outbox'))
        except OSError:
            return False
        return any(n.endswith('.json') and cls.ID.match(n[:-5]) for n in names)

    def request(self, ticket_id):
        return f'{PYTHON} {os.path.join(self.home, "core", "tools", "ticket.py")} --send {ticket_id}'

    # ----------------------------------------------------- the health check

    def offers(self, present, codes):
        """The health check's ticket lines for the faults present, each
        {key: (about, fixes tried)}: a ticket built once per occurrence and
        offered on a line of its own, and every ticket waiting to send. When
        core's release.json names an intake that is not plain, no ticket is
        built and one line names the config, never the address."""
        index = Records.read(self.index_file)
        index = index if isinstance(index, dict) else {}
        kept = {k: v for k, v in index.items() if k in present or os.path.lexists(self.file(v))}
        lines = []
        intake = Releases(self.home).config().get('intake')
        if present and not Releases.plain(intake):
            lines.append('config: Squire\'s config, core/release.json, names a support intake Squire cannot send to, '
                         'so no support ticket was built')
        else:
            for key, (about, tried) in present.items():
                if key not in kept:
                    kept[key] = self.build(intake, codes, tried)
                ticket_id = kept[key]
                state = Records.read(self.state_file(ticket_id))
                if os.path.lexists(self.file(ticket_id)) and isinstance(state, dict) and not state.get('attempts'):
                    lines.append(f'ticket: {ticket_id} is ready to send about {about}; to send it, ask: '
                                 f'{self.request(ticket_id)}')
        for ticket_id in self.waiting():
            state = Records.read(self.state_file(ticket_id))
            attempts = state.get('attempts') if isinstance(state, dict) else None
            if isinstance(attempts, list) and attempts:
                lines.append(f'ticket: {ticket_id} is waiting to send ({len(attempts)} attempts so far)')
        if kept != index:
            try:
                Records.write(self.index_file, kept)
            except OSError:
                pass
        return lines

    def answered(self, key):
        """True when the owner has answered a request to send the ticket
        offered for this fault."""
        index = Records.read(self.index_file)
        ticket_id = index.get(key) if isinstance(index, dict) else None
        if not ticket_id:
            return False
        ledger = Ledger.read_shared(self.config.ledger_path)
        return bool(ledger) and any(answer is not None for _, answer in ledger.requests_for(f'ticket:{ticket_id}:'))

    def build(self, intake, codes, tried):
        ticket = Ticket(self.home).fields(intake, codes, tried)
        data = Records.canonical(ticket).encode('ascii')
        os.makedirs(self.folder, mode=0o700, exist_ok=True)
        Records.write_bytes(self.file(ticket['ticketId']), data, durable=True)
        Records.write(self.state_file(ticket['ticketId']),
                      {'digest': hashlib.sha256(data).hexdigest(), 'request': None, 'attempts': []}, canonical=True)
        return ticket['ticketId']

    # ------------------------------------------------------------- perform

    def perform(self):
        now = time.time()
        for ticket_id in self.waiting():
            try:
                self.one(ticket_id, now)
            except (OSError, ValueError, SquireError):
                continue
        return 0

    def one(self, ticket_id, now):
        try:
            with open(self.file(ticket_id), 'rb') as f:
                data = f.read()
        except OSError:
            return
        state = Records.read(self.state_file(ticket_id))
        if not isinstance(state, dict) or not isinstance(state.get('attempts'), list):
            return
        digest = hashlib.sha256(data).hexdigest()
        ledger = Ledger.read_shared(self.config.ledger_path)
        requests = ledger.requests_for(f'ticket:{ticket_id}:') if ledger else []
        if state.get('request') is None and requests:
            request, answer = requests[-1]
            at = request.get('at') if isinstance(request.get('at'), (int, float)) else 0
            if (answer and answer.get('answer') == 'no') or (answer is None and now >= at + self.config.timeout):
                return self.set_aside(ticket_id)
        exact = f'ticket:{ticket_id}:{digest}:{state.get("digest")}'
        for request, answer in reversed(requests):
            if request.get('item') == exact and answer and answer.get('answer') == 'yes' \
                    and Install.fresh(answer, now) and not ledger.used(request.get('id')):
                if self.use(request.get('id'), now):
                    state['request'], state['digest'] = request['id'], digest
                    Records.write(self.state_file(ticket_id), state, canonical=True)
                    return self.send(ticket_id, data, state, now)
        if state.get('request') is None or digest != state.get('digest'):
            return
        approved = next((r for r, _ in requests if r.get('id') == state['request']), None)
        if approved is None or approved.get('item', '').split(':')[2:3] != [digest]:
            return
        attempts = state['attempts']
        if attempts:
            last = attempts[-1].get('at')
            wait = min(self.RETRY_FIRST * 2 ** (len(attempts) - 1), self.RETRY_MOST)
            if not isinstance(last, (int, float)) or last > now or now - last < wait:
                return
        self.send(ticket_id, data, state, now)

    def use(self, request_id, now):
        """The yes marked used under the ledger's lock, before the send."""
        with Ledger(self.config.ledger_path) as ledger:
            if ledger.used(request_id):
                return False
            ledger.append({'type': 'use', 'request': request_id, 'at': int(now)})
        return True

    def set_aside(self, ticket_id):
        aside = os.path.join(self.folder, 'set-aside')
        os.makedirs(aside, mode=0o700, exist_ok=True)
        for path in (self.file(ticket_id), self.state_file(ticket_id)):
            if os.path.lexists(path):
                os.replace(path, os.path.join(aside, os.path.basename(path)))

    def send(self, ticket_id, data, state, now):
        """One post of the approved bytes to the configured intake, only while
        the ticket's destination is that intake; a 2xx clears the ticket, any
        other outcome keeps it waiting."""
        intake = Releases(self.home).config().get('intake')
        try:
            destination = json.loads(data.decode('ascii')).get('destination')
        except (ValueError, UnicodeError, AttributeError):
            return
        if not Releases.plain(intake) or destination != intake:
            return
        outcome = self.post(intake, data)
        state['attempts'].append({'at': int(now), 'outcome': outcome})
        if outcome == 'sent':
            for path in (self.file(ticket_id), self.state_file(ticket_id)):
                try:
                    os.unlink(path)
                except OSError:
                    pass
            return
        Records.write(self.state_file(ticket_id), state, canonical=True)

    def post(self, intake, data):
        """One HTTP POST carrying Host, Content-Type and Content-Length and the
        bytes alone; no redirect followed; 30 seconds to connect and 30 for
        the answer."""
        parts = urlsplit(intake)
        if parts.scheme == 'https':
            conn = http.client.HTTPSConnection(parts.hostname, parts.port, timeout=self.POST_WITHIN,
                                               context=ssl.create_default_context())
        else:
            conn = http.client.HTTPConnection(parts.hostname, parts.port, timeout=self.POST_WITHIN)
        try:
            conn.putrequest('POST', parts.path, skip_accept_encoding=True)
            conn.putheader('Content-Type', 'application/json')
            conn.putheader('Content-Length', str(len(data)))
            conn.endheaders(data)
            answer = conn.getresponse()
            answer.read(65536)
            return 'sent' if 200 <= answer.status < 300 else f'answered {answer.status}'
        except (OSError, http.client.HTTPException, ValueError):
            return 'failed'
        finally:
            conn.close()


def main(argv):
    try:
        config = Config()
    except SquireError as e:
        sys.stderr.write(f'ticket: {e}.\n')
        return 2
    if len(argv) == 2 and argv[0] == '--send':
        print(f'Sending ticket {argv[1]} is asked for in Squire\'s session: the safety floor shows the owner its exact '
              'bytes and asks for their yes, and Squire\'s scheduler sends it outside the session. Nothing was sent '
              'here.')
        return 0
    if argv == ['--perform']:
        return Outbox(config).perform()
    sys.stderr.write('ticket.py takes --send <ticket id> or --perform\n')
    return 2


if __name__ == '__main__':
    try:
        code = main(sys.argv[1:])
    except Exception as e:
        sys.stderr.write(f'ticket failed ({type(e).__name__}).\n')
        code = 1
    sys.exit(code)
