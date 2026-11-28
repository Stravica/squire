"""Squire's session runner, run by its launchd agent (started at load, kept
alive):

    /usr/bin/python3 -B <Squire home>/core/tools/runner.py

It keeps one Claude Code Remote Control session running in the owner's
folder, under the owner's own Claude sign-in, with Squire's safety floor in
it. One runner at a time: a second one exits.

Before each start it moves any Claude Code settings file out of the owner's
folder, then checks the floor: core's settings and the four floor hooks
present and as lay-down recorded them, the config folder's settings equal to
core's, a claude it can trust, and a Claude sign-in. When any of these
fails, no session starts, the health check says why and the runner exits
non-zero (its agent runs it again).

Before each start it writes the Squire's name and personality from the
owner's squire.json into CLAUDE.md in Squire's config folder, and the
session's --name is the stored squireName. During the first set-up, while
set-up's record in the Squire home shows set-up short of its first
conversation (no phone step done) and no session has yet been recorded in
the Squire home, it holds its lock and starts no session; set-up opened
again later never holds it.

While the session runs it looks for a settings file every second: one
appearing stops the session (its whole process group), is moved and named,
and a new session starts. A server is judged live by evidence, never by its
wording alone: its process alive, and a bridge pointer written after its
start naming its pid, or a session record written since its start; a
connected word (Connected or Reconnected) is a fast path only. A server is
replaced only when its process dies, when 60 seconds after its start it has
shown none of that evidence, or when a disconnection line is not followed by
a connected word within 60 seconds. A live server is never replaced for its
wording. A server that stops before it was ever live leaves its own last line
in runner.json's problems, where the health check prints it, until a session
starts; one stopped after it was live leaves nothing.
"""

import fcntl
import hashlib
import json
import os
import pwd
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time

CORE = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))


class FloorCheck:
    """The floor's files in the installed core, against the digests lay-down
    recorded, and the config folder's settings against core's."""

    FILES = ('settings.json', 'hooks/pre-tool-use.py', 'hooks/user-prompt-submit.py', 'hooks/session-start.py',
             'hooks/config-change.py')

    def __init__(self, home):
        self.home = home
        self.core = os.path.join(home, 'core')

    def problems(self):
        found = []
        try:
            with open(os.path.join(self.home, 'core-digests.json'), encoding='utf-8') as f:
                digests = json.load(f)
            if not isinstance(digests, dict):
                raise ValueError
        except (OSError, ValueError):
            digests = None
            found.append('no session: the record of the floor\'s digests (core-digests.json in the Squire home) '
                         'is missing or unreadable; lay core down again')
        for rel in self.FILES:
            try:
                with open(os.path.join(self.core, rel), 'rb') as f:
                    digest = hashlib.sha256(f.read()).hexdigest()
            except OSError:
                found.append(f'no session: the floor file core/{rel} is missing; lay core down again')
                continue
            if digests is not None and digests.get(rel) != digest:
                found.append(f'no session: the floor file core/{rel} has changed since core was laid down; '
                             'lay core down again')
        settings = os.path.join(self.home, 'claude-config', 'settings.json')
        if not self.same_json(settings, os.path.join(self.core, 'settings.json')):
            found.append('no session: Claude Code\'s settings for Squire (claude-config/settings.json) are missing '
                         'or differ from core\'s settings.json; lay core down again')
        return found

    @staticmethod
    def same_json(a, b):
        try:
            with open(a, encoding='utf-8') as fa, open(b, encoding='utf-8') as fb:
                return json.load(fa) == json.load(fb)
        except (OSError, ValueError):
            return False


class OwnerSettings:
    """Claude Code settings files in the owner's folder, by any spelling the
    disk folds to their names: none may sit there while the session runs."""

    NAMES = ('settings.json', 'settings.local.json')

    def __init__(self, owner, home):
        self.folder = os.path.join(owner, '.claude')
        self.kept = os.path.join(home, 'moved-settings')

    def present(self):
        from squire import Paths

        try:
            names = os.listdir(self.folder)
        except OSError:
            return []
        return [n for n in names if Paths.fold(n) in self.NAMES]

    def move(self):
        """Moves each into a folder of its own in the Squire home; returns the
        names it could not move."""
        stuck = []
        for name in self.present():
            try:
                os.makedirs(self.kept, mode=0o700, exist_ok=True)
                into = tempfile.mkdtemp(prefix=time.strftime('%Y%m%dT%H%M%SZ-', time.gmtime()), dir=self.kept)
                shutil.move(os.path.join(self.folder, name), os.path.join(into, name))
            except OSError:
                stuck.append(name)
        return stuck


class Claude:
    """The claude the session runs: from where Claude Code installs itself,
    never a PATH lookup, and only one this user owns that no one else may
    change; and the environment it runs in, built from nothing."""

    LOCATIONS = ('~/.local/bin/claude', '/usr/local/bin/claude', '/opt/homebrew/bin/claude')
    MAC_PATH = ('/usr/bin', '/bin', '/usr/sbin', '/sbin')
    HOMEBREW = '/opt/homebrew/bin'

    def __init__(self, home):
        self.user_home = os.path.expanduser('~')
        self.path = self.find()
        self.env = None
        if self.path:
            self.env = {
                'PATH': ':'.join(self.MAC_PATH + (os.path.dirname(self.path), self.HOMEBREW)),
                'HOME': self.user_home,
                'USER': pwd.getpwuid(os.getuid()).pw_name,
                'SQUIRE_HOME': home,
                'CLAUDE_CONFIG_DIR': os.path.join(home, 'claude-config'),
                'LANG': 'en_US.UTF-8',
            }

    def find(self):
        for location in self.LOCATIONS:
            path = os.path.join(self.user_home, location[2:]) if location.startswith('~/') else location
            try:
                found = os.stat(path)
            except OSError:
                continue
            if stat.S_ISREG(found.st_mode) and found.st_uid == os.getuid() \
                    and not found.st_mode & (stat.S_IWGRP | stat.S_IWOTH) and os.access(path, os.X_OK):
                return path
        return None

    def signed_in(self, cwd):
        """claude auth status, in the session's environment, answers signed in."""
        try:
            r = subprocess.run([self.path, 'auth', 'status'], cwd=cwd, env=self.env, stdin=subprocess.DEVNULL,
                               capture_output=True, text=True, timeout=60)
            return r.returncode == 0 and json.loads(r.stdout).get('loggedIn') is True
        except (OSError, subprocess.SubprocessError, ValueError, AttributeError):
            return False


class Evidence:
    """Whether a Remote Control server is live, by evidence alone: a bridge
    pointer in Squire's Claude Code config folder naming the server's pid (or
    a process in its process group), written since the server started, or a
    session record in the Squire home written since it started. A pointer for
    another process, one written before the start, or one that cannot be read
    is no evidence, nor is a record an earlier server left. Read again at every
    look, never kept."""

    POINTER = 'bridge-pointer.json'

    def __init__(self, home):
        self.home = home
        self.projects = os.path.join(home, 'claude-config', 'projects')

    def pointer(self, pid, since, alive=True):
        """The newest bridge pointer naming the server pid (a process in its
        process group too, while alive is True), written at or after since
        (seconds since the epoch), or None."""
        if isinstance(pid, bool) or not isinstance(pid, int) or pid <= 0:
            return None
        try:
            names = os.listdir(self.projects)
        except OSError:
            return None
        found = None
        for name in names:
            path = os.path.join(self.projects, name, self.POINTER)
            try:
                written = os.stat(path).st_mtime
                if written < since:
                    continue
                with open(path, encoding='utf-8') as f:
                    record = json.load(f)
            except (OSError, ValueError):
                continue
            if not isinstance(record, dict):
                continue
            named = record.get('pid')
            if isinstance(named, bool) or not isinstance(named, int):
                continue
            if named != pid and not (alive and self.in_group(named, pid)):
                continue
            if found is None or written > found[0]:
                found = (written, record)
        return found[1] if found else None

    @staticmethod
    def in_group(pid, server):
        """True when the process pid is alive in the server's process group
        (the server leads its own group)."""
        if pid <= 0:
            return False
        try:
            return os.getpgid(pid) == server
        except OSError:
            return False

    def session_since(self, since):
        """True when a session record was written at or after since."""
        folder = os.path.join(self.home, 'sessions')
        try:
            names = [n for n in os.listdir(folder) if n.endswith('.json') and not n.startswith('.')]
        except OSError:
            return False
        for name in names:
            try:
                with open(os.path.join(folder, name), encoding='utf-8') as f:
                    at = json.load(f).get('recordedAt')
            except (OSError, ValueError, AttributeError):
                continue
            if isinstance(at, (int, float)) and not isinstance(at, bool) and at >= since:
                return True
        return False

    def held(self):
        """The server runner.lock names, while that process is the one the
        lock recorded: (pid, its start in seconds since the epoch), or None."""
        import calendar
        from squire import Process

        try:
            with open(os.path.join(self.home, 'runner.lock'), encoding='utf-8') as f:
                record = json.loads(f.read() or '{}')
        except (OSError, ValueError):
            return None
        if not isinstance(record, dict):
            return None
        pid, started = record.get('pid'), record.get('startedAt')
        if not isinstance(started, str) or Process.started_at(pid) != started:
            return None
        try:
            since = calendar.timegm(time.strptime(started, '%Y-%m-%dT%H:%M:%SZ'))
        except ValueError:
            return None
        return pid, since

    def live(self):
        """The server runner.lock names, when it is alive and live by
        evidence: {'pid', 'since', 'pointer'} (pointer the bridge pointer
        naming it, or None when a session record is the evidence), or None."""
        held = self.held()
        if held is None:
            return None
        pid, since = held
        pointer = self.pointer(pid, since)
        if pointer is None and not self.session_since(since):
            return None
        return {'pid': pid, 'since': since, 'pointer': pointer}

    def output(self):
        """The end of the servers' output (logs/session.log), terminal
        escapes removed; '' when it cannot be read."""
        try:
            with open(os.path.join(self.home, 'logs', 'session.log'), 'rb') as f:
                size = f.seek(0, os.SEEK_END)
                f.seek(max(0, size - Runner.TAIL))
                return Runner.ESCAPES.sub('', f.read().decode('utf-8', 'replace'))
        except OSError:
            return ''

    def last_line(self):
        """The server's own last line: the last non-blank line of its output
        that is not Claude Code's own line at a stop, control characters
        removed, cut at 300 characters; None when there is none."""
        lines = [line for line in self.output().splitlines() if line.strip() and not Runner.STOP_LINE.search(line)]
        if not lines:
            return None
        return ''.join(c for c in lines[-1].strip() if c.isprintable())[:Runner.REASON_MOST]

    ENVIRONMENT = re.compile(r'^[A-Za-z0-9_-]{1,200}$')
    ADDRESS = re.compile(r'https://claude\.ai/code\?environment=([A-Za-z0-9_-]{1,200})')

    def environment(self, live):
        """The live server's environment id: from the bridge pointer naming
        it, else the last environment address in the servers' output; None
        when neither gives one."""
        pointer = (live or {}).get('pointer') or {}
        named = pointer.get('environmentId')
        if isinstance(named, str) and self.ENVIRONMENT.match(named):
            return named
        found = self.ADDRESS.findall(self.output())
        return found[-1] if found else None


class Runner:
    TICK = 1.0
    GRACE = 1.5
    CONNECT_WITHIN = 60
    CONNECTED = re.compile(r'\b(?:Connected|Reconnected)\b')
    # A disconnection line: Reconnecting or disconnected, in either case, only
    # as the status word itself in the status position of a status line, the
    # line's first field after the server's status mark (the marks, dots and
    # spaces before its first word), ended by the dot between fields or by the
    # line's end. The same word anywhere else in the output, within a
    # session's title that the server prints in that position among it, is
    # never a disconnection line.
    DISCONNECTED = re.compile(r'^[^\w\n]*(?:reconnecting|disconnected)[ \t]*(?:·|$)', re.IGNORECASE | re.MULTILINE)
    ESCAPES = re.compile(r'\x1b\[[0-9;?]*[ -/]*[@-~]')
    TAIL = 65536
    STOPPED = 'no session: Claude Code\'s Remote Control server stopped before any session started: '
    # Claude Code's own line when its server is stopped with no session: it
    # names no reason, so the line before it is the one kept.
    STOP_LINE = re.compile(r'^\s*(?:\[[^\]]*\]\s*)?Environment preserved\b')
    REASON_MOST = 300

    def __init__(self, config):
        self.home = config.home
        self.owner = config.owner_folder
        self.state_file = os.path.join(self.home, 'runner.json')
        self.log = os.path.join(self.home, 'logs', 'session.log')
        self.settings = OwnerSettings(self.owner, self.home)
        self.server = None
        self.lock = None
        self.offset = 0
        self.started = 0.0
        self.started_at = 0.0
        self.carried = []

    @staticmethod
    def main():
        sys.path.insert(0, os.path.join(CORE, 'lib'))
        from squire import Config, SquireError

        try:
            runner = Runner(Config())
        except SquireError as e:
            sys.stderr.write(f'runner: no session: {e}.\n')
            return 1
        runner.lock = os.open(os.path.join(runner.home, 'runner.lock'), os.O_RDWR | os.O_CREAT, 0o600)
        try:
            fcntl.flock(runner.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            sys.stderr.write('runner: another runner holds this Squire home; this one exits.\n')
            return 1
        # Asked to stop (launchd sends SIGTERM): the session goes with the runner.
        for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            signal.signal(signum, signal.default_int_handler)
        signal.signal(signal.SIGCHLD, runner.server_ended)
        try:
            return runner.run()
        except KeyboardInterrupt:
            runner.stop()
            return 0

    def run(self):
        self.stop_leftover()
        self.hold(None)
        self.recover()
        while True:
            if self.awaiting_set_up():
                time.sleep(self.TICK)
                continue
            problems = [f'no session: the Claude Code settings file .claude/{name} in the owner\'s folder could '
                        'not be moved' for name in self.settings.move()]
            problems = problems or FloorCheck(self.home).problems()
            claude = Claude(self.home)
            if not problems and not claude.path:
                problems = ['no session: no claude Squire can trust at ~/.local/bin/claude, /usr/local/bin/claude or '
                            '/opt/homebrew/bin/claude (Claude Code installed, owned by this user and changeable by '
                            'no one else)']
            problems = problems or self.answer_questions()
            if not problems and not claude.signed_in(self.home):
                problems = ['no session: Claude Code is not signed in for Squire; the owner signs in once with '
                            'Squire\'s Claude Code config folder (claude-config in the Squire home)']
            self.carried = self.stopped_reason()
            self.write_json(self.state_file, {'problems': problems + self.carried})
            if problems:
                return 1
            self.persona()
            self.claude_code()
            self.start(claude)
            outcome = self.watch()
            self.stop()
            if outcome == 'died':
                return 1

    def awaiting_set_up(self):
        """True only during the first set-up, while set-up's record in the
        Squire home shows it has not yet reached its first conversation (no
        phone step done): the session starts for the first conversation, not
        part way through set-up. Once a session has been recorded in the
        Squire home, as the first conversation's is, set-up opened again never
        holds the session, whatever its record says after a re-run that
        paused. A home with no set-up record, or one that cannot be read,
        waits for nothing."""
        try:
            with open(os.path.join(self.home, 'set-up.json'), encoding='utf-8') as f:
                done = json.load(f).get('done')
        except (OSError, ValueError, AttributeError):
            return False
        if not isinstance(done, list) or 'phone' in done:
            return False
        try:
            recorded = [n for n in os.listdir(os.path.join(self.home, 'sessions'))
                        if n.endswith('.json') and not n.startswith('.')]
        except OSError:
            recorded = []
        if recorded:
            return False
        waiting = ['no session: Squire\'s set-up has not reached its first conversation yet; open Squire to finish '
                   'set-up']
        try:
            with open(self.state_file, encoding='utf-8') as f:
                written = json.load(f).get('problems')
        except (OSError, ValueError, AttributeError):
            written = None
        if written != waiting:
            self.write_json(self.state_file, {'problems': waiting})
        return True

    def persona(self):
        """The Squire's name and personality into what the session loads."""
        from squire import Persona

        try:
            Persona.write(self.home, self.owner)
        except OSError:
            pass

    def stopped_reason(self):
        """The reason the last server stopped before any session, kept beside
        other problems until a session starts."""
        try:
            with open(self.state_file, encoding='utf-8') as f:
                problems = json.load(f).get('problems')
            return [p for p in problems if isinstance(p, str) and p.startswith(self.STOPPED[:60])][:1]
        except (OSError, ValueError, AttributeError, TypeError):
            return []

    def session_since(self):
        """True when a session record was written after the server started."""
        return Evidence(self.home).session_since(self.started_at)

    def live(self, status, alive=True):
        """The server judged live by evidence at this look: a connected word
        as its last status word, a bridge pointer naming it written since its
        start, or a session record written since its start."""
        if status == 'connected':
            return True
        if self.server is not None and Evidence(self.home).pointer(self.server.pid, self.started_at, alive) is not None:
            return True
        return self.session_since()

    def record_stopped(self):
        """The server's own last line, as the reason it stopped before it was
        ever live: its last non-blank line that is not Claude Code's own line
        at a stop, terminal escapes and control characters removed, cut at
        300 characters."""
        code = self.server.poll() if self.server is not None else None
        try:
            with open(self.log, 'rb') as f:
                size = f.seek(0, os.SEEK_END)
                f.seek(max(self.offset, size - self.TAIL))
                text = self.ESCAPES.sub('', f.read().decode('utf-8', 'replace'))
        except OSError:
            text = ''
        lines = [line for line in text.splitlines() if line.strip() and not self.STOP_LINE.search(line)]
        if lines:
            reason = self.STOPPED + ''.join(c for c in lines[-1].strip() if c.isprintable())[:self.REASON_MOST]
        else:
            reason = f'no session: Claude Code\'s Remote Control server stopped before any session with no output ' \
                     f'(exit {code})'
        self.write_json(self.state_file, {'problems': [reason]})

    def answer_questions(self):
        """The config folder's .claude.json answers "trust this folder" and
        "Enable Remote Control" in advance, keeping all else it holds."""
        path = os.path.join(self.home, 'claude-config', '.claude.json')
        try:
            with open(path, encoding='utf-8') as f:
                state = json.load(f)
        except FileNotFoundError:
            state = {}
        except (OSError, ValueError):
            state = None
        if not isinstance(state, dict) or not isinstance(state.get('projects', {}), dict):
            return ['no session: Claude Code\'s state for Squire (claude-config/.claude.json) cannot be read']
        projects = state.setdefault('projects', {})
        if not isinstance(projects.get(self.owner), dict):
            projects[self.owner] = {}
        projects[self.owner]['hasTrustDialogAccepted'] = True
        state['remoteDialogSeen'] = True
        self.write_json(path, state)
        return []

    def name(self):
        try:
            with open(os.path.join(self.owner, 'squire.json'), encoding='utf-8') as f:
                name = json.load(f).get('squireName')
        except (OSError, ValueError, AttributeError):
            name = None
        return name.strip() if isinstance(name, str) and name.strip() else 'Squire'

    def start(self, claude):
        from squire import Process

        os.makedirs(os.path.dirname(self.log), exist_ok=True)
        self.started_at = time.time()
        with open(self.log, 'ab') as log:
            self.offset = os.fstat(log.fileno()).st_size
            self.server = subprocess.Popen(
                [claude.path, 'remote-control', '--spawn', 'session', '--permission-mode', 'bypassPermissions',
                 '--name', self.name()],
                cwd=self.owner, env=claude.env, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                start_new_session=True)
        self.started = time.monotonic()
        self.hold(self.server.pid)

    def hold(self, server):
        """This runner and its server, kept in the lock file the runner holds,
        so an update's install can end them."""
        from squire import Process

        record = {'runner': os.getpid(), 'runnerStartedAt': Process.started_at(os.getpid())}
        if server is not None:
            record.update({'pid': server, 'startedAt': Process.started_at(server)})
        os.ftruncate(self.lock, 0)
        os.pwrite(self.lock, json.dumps(record).encode('utf-8'), 0)

    def recover(self):
        """An update's install that did not finish (install.json present, no
        install holding install.lock) is settled by update.py --recover,
        started beside this runner, which starts as usual."""
        from squire import System

        if not os.path.lexists(os.path.join(self.home, 'install.json')):
            return
        try:
            fd = os.open(os.path.join(self.home, 'install.lock'), os.O_RDONLY)
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            finally:
                os.close(fd)
        except FileNotFoundError:
            pass
        except OSError:
            return
        try:
            subprocess.Popen([System.command('/usr/bin/python3'), '-B', os.path.join(CORE, 'tools', 'update.py'),
                              '--recover'], cwd='/', env=System.env(self.home), stdin=subprocess.DEVNULL,
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except OSError:
            pass

    def claude_code(self):
        """At the first start, Claude Code's version and launcher recorded in
        claude-code.json; a later start keeps the record it finds."""
        from squire import ClaudeCode

        ClaudeCode.record_once(self.home)

    def watch(self):
        """Until the session must stop: 'settings', 'replace' or 'died'. Live
        is judged again at every look; a server is replaced when, 60 seconds
        or more after its start, this look finds no evidence it is live, or
        when a disconnection line has had no connected word after it for 60
        seconds, whatever pointer stands."""
        dropped, ever_live = None, False
        while True:
            time.sleep(self.TICK)
            if self.carried and self.session_since():
                self.carried = []
                self.write_json(self.state_file, {'problems': []})
            if self.settings.present():
                return 'settings'
            if self.server.poll() is not None:
                if not ever_live and not self.live(self.status(), alive=False):
                    self.record_stopped()
                return 'died'
            now = time.monotonic()
            status = self.status()
            if status == 'connected':
                dropped = None
            elif status == 'disconnected' and dropped is None:
                dropped = now
            live = self.live(status)
            ever_live = ever_live or live
            if not live and now - self.started >= self.CONNECT_WITHIN:
                return 'replace'
            if dropped is not None and now - dropped >= self.CONNECT_WITHIN:
                return 'replace'

    def status(self):
        """The server's last status word since its start: 'connected',
        'disconnected', or None when it has shown neither. A disconnection
        word counts only as DISCONNECTED reads it, in the status position; a
        carriage return starts a line, as a terminal redraws its status line
        in place."""
        try:
            with open(self.log, 'rb') as f:
                size = f.seek(0, os.SEEK_END)
                f.seek(max(self.offset, size - self.TAIL))
                text = self.ESCAPES.sub('', f.read().decode('utf-8', 'replace')).replace('\r', '\n')
        except OSError:
            return None
        last_up = max((m.start() for m in self.CONNECTED.finditer(text)), default=-1)
        last_down = max((m.start() for m in self.DISCONNECTED.finditer(text)), default=-1)
        if last_up < 0 and last_down < 0:
            return None
        return 'connected' if last_up > last_down else 'disconnected'

    def stop(self):
        """Stops the server and everything in its process group: stopping the
        server alone leaves its session running."""
        server, self.server = self.server, None
        if server is None:
            return
        try:
            os.killpg(server.pid, signal.SIGTERM)
        except OSError:
            pass
        try:
            server.wait(self.GRACE)
        except subprocess.TimeoutExpired:
            pass
        try:
            os.killpg(server.pid, signal.SIGKILL)
        except OSError:
            pass
        server.wait()

    def server_ended(self, signum, frame):
        """A server that dies takes its session process with it at once, not
        at the next look: the session, left running in the group, would
        otherwise outlive it."""
        server = self.server
        if server is not None and server.poll() is not None:
            try:
                os.killpg(server.pid, signal.SIGKILL)
            except OSError:
                pass

    def stop_leftover(self):
        """A server left running by a runner that was killed outright is
        stopped, its process group with it. The lock file names the last
        server and its start, so a server long gone matches no process."""
        from squire import Process

        try:
            server = json.loads(os.pread(self.lock, 4096, 0).decode('utf-8') or '{}')
        except (OSError, ValueError):
            server = None
        if isinstance(server, dict) and isinstance(server.get('startedAt'), str) \
                and Process.started_at(server.get('pid')) == server['startedAt']:
            try:
                os.killpg(server['pid'], signal.SIGKILL)
            except OSError:
                pass

    @staticmethod
    def write_json(path, data):
        fd, tmp = tempfile.mkstemp(prefix='.runner-', dir=os.path.dirname(path))
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2)
            f.write('\n')
        os.replace(tmp, path)


if __name__ == '__main__':
    sys.exit(Runner.main())
