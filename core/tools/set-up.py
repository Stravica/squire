"""Squire's set-up, from the naming step on. Started by the app's own
executable once Apple's command line tools answer, never by the session:

    /usr/bin/python3 -B set-up.py <the app's core folder>

The executable has made the Mac check, taken the one yes, installed Claude
Code, signed Squire in and confirmed Apple's tools, and holds set-up's lock
for as long as this runs. These steps follow, in order, each recorded in
set-up.json in the Squire home only once its end state is seen: naming,
ownerFolder, layDown, backup, health, phone and firstConversation. A step
recorded done whose end state no longer holds runs again; phone and
firstConversation are never repeated once done. Every window is the Mac's own
osascript, every command runs from the system folders in an environment built
from nothing, and a step that cannot finish pauses set-up on "Squire: set-up
paused", naming what went wrong and the way on. Exits 0 when set-up is done.
"""

import hashlib
import importlib.util
import json
import os
import plistlib
import re
import shutil
import subprocess
import sys
import tempfile
import time

CORE = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
sys.path.insert(0, os.path.join(CORE, 'lib'))

from squire import Config, Paths, Persona, System  # noqa: E402

STEPS = ('yes', 'claudeCode', 'signIn', 'appleTools', 'naming', 'ownerFolder', 'layDown', 'backup', 'health', 'phone',
         'firstConversation')
TITLES = {
    'name': 'Squire: name your Squire',
    'personality': "Squire: your Squire's personality",
    'phone': 'Squire: your phone',
    'paused': 'Squire: set-up paused',
    'ready': 'Squire: ready',
}
AGENTS = ('com.stravica.squire.runner', 'com.stravica.squire.wake-ups', 'com.stravica.squire.backup')


class Paused(Exception):
    """A step that could not finish: what the owner reads on the paused window."""


class Windows:
    """Set-up's windows, drawn by the Mac's own osascript, each answered from
    osascript's own result. A window that cannot be answered gives None."""

    WITHIN = 3600

    def __init__(self, log):
        self.log = log

    def show(self, title, text, buttons=('OK',), default=None, answer=False):
        listed = '{' + ', '.join(json.dumps(b) for b in buttons) + '}'
        script = ['on run argv',
                  'display dialog (item 2 of argv) with title (item 1 of argv)'
                  + (' default answer ""' if answer else '')
                  + f' buttons {listed} default button {json.dumps(default or buttons[-1])}',
                  'end run']
        args = [System.command('/usr/bin/osascript')]
        for line in script:
            args += ['-e', line]
        try:
            r = subprocess.run(args + [title, text], cwd='/', env=System.env(), stdin=subprocess.DEVNULL,
                               capture_output=True, timeout=self.WITHIN)
        except (OSError, subprocess.SubprocessError) as e:
            self.log(f'window "{title}" could not be shown ({type(e).__name__})')
            return None
        if r.returncode != 0:
            self.log(f'window "{title}": osascript exited {r.returncode}')
            return None
        out = r.stdout.decode('utf-8', 'replace')
        return out[:-1] if out.endswith('\n') else out

    def button(self, title, text, buttons, default=None):
        out = self.show(title, text, buttons, default)
        match = re.match(r'^button returned:(.*)$', out or '', re.S)
        return match.group(1) if match and match.group(1) in buttons else None

    def typed(self, title, text):
        """The text the owner typed, untrimmed; None when it cannot be read."""
        out = self.show(title, text, ('OK',), answer=True)
        match = re.match(r'^button returned:[^,]*, text returned:(.*)$', out or '', re.S)
        return match.group(1) if match else None


class SetUpRecord:
    """set-up.json in the Squire home, written whole through the file beside
    it (set-up.json.new) and a rename, 0600."""

    def __init__(self, home):
        self.path = os.path.join(home, 'set-up.json')
        self.data = {}

    def load(self):
        with open(self.path, encoding='utf-8') as f:
            data = json.load(f)
        if not isinstance(data, dict) or not isinstance(data.get('done'), list) \
                or list(data['done']) != list(STEPS[:len(data['done'])]):
            raise ValueError('set-up.json is not a record set-up can read')
        self.data = data

    @property
    def done(self):
        return list(self.data.get('done') or [])

    def save(self, **changes):
        data = dict(self.data)
        for key, value in changes.items():
            if value is None:
                data.pop(key, None)
            else:
                data[key] = value
        new = self.path + '.new'
        try:
            fd = os.open(new, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, 'w', encoding='utf-8') as f:
                json.dump(data, f, indent=2, ensure_ascii=False)
                f.write('\n')
            os.chmod(new, 0o600)
            os.replace(new, self.path)
        except OSError as e:
            raise Paused(f'Squire could not write its own record of set-up ({e.strerror or type(e).__name__}). '
                         'Open Squire again.')
        self.data = data


class SetUp:
    """The steps from naming on, each with its end state."""

    LAY_DOWN_WITHIN = 300
    HEALTH_WITHIN = 120
    RUNNER_GRACE = 30
    SESSION_WITHIN = 120
    ADDRESS = 'https://claude.ai/code'
    DEFAULT_BACKUP = os.path.join('Library', 'Mobile Documents', 'com~apple~CloudDocs', 'Squire Backup')
    ASKED_AWAY = ('Desktop', 'Documents', 'Downloads', os.path.join('Library', 'Mobile Documents'))
    SET_UP_FAULTS = ('runner:', 'floor:', 'sign-in:', 'no session:', 'fixed:', 'still:', 'could not try:')

    def __init__(self, app_core):
        self.app_core = os.path.realpath(app_core)
        self.home = Config.default_home()
        self.user_home = os.path.expanduser('~')
        self.owner = os.path.join(self.user_home, 'Squire')
        self.release = os.path.join(self.home, 'release', 'core')
        self.record = SetUpRecord(self.home)
        self.windows = Windows(self.log)
        self.python = System.command('/usr/bin/python3')
        self.ready_lines = []

    def log(self, line):
        try:
            os.makedirs(os.path.join(self.home, 'logs'), mode=0o700, exist_ok=True)
            with open(os.path.join(self.home, 'logs', 'set-up.log'), 'a', encoding='utf-8') as f:
                f.write(f'{time.strftime("%Y-%m-%dT%H:%M:%S")} set-up: {line}\n')
        except OSError:
            pass

    @staticmethod
    def main(argv):
        if len(argv) != 1 or not os.path.isdir(argv[0]):
            sys.stderr.write('give the app\'s core folder: set-up.py <core>\n')
            return 2
        setup = SetUp(argv[0])
        try:
            setup.record.load()
        except (OSError, ValueError):
            setup.pause('Squire could not read its own record of set-up. Open Squire again to start set-up afresh.')
            return 1
        try:
            setup.run()
        except Paused as e:
            setup.pause(str(e))
            return 1
        setup.ready()
        return 0

    def run(self):
        for index, step in enumerate(STEPS):
            if index < STEPS.index('naming'):
                continue
            done = step in self.record.done
            if done and step in ('phone', 'firstConversation'):
                continue
            if done and step != 'health' and self.holds(step):
                continue
            try:
                getattr(self, 'step_' + step[0].lower() + re.sub(r'([A-Z])', lambda m: '_' + m.group(1).lower(), step[1:]))()
                if not self.holds(step):
                    raise Paused(f'Squire could not confirm the {self.plain(step)} step finished. Open Squire again.')
            except Paused:
                if done:
                    self.record.save(done=list(STEPS[:index]))
                raise
            if not done:
                self.record.save(done=list(STEPS[:index + 1]))
            self.log(f'{step} done')

    @staticmethod
    def plain(step):
        return {'naming': 'naming', 'ownerFolder': 'Squire folder', 'layDown': 'Squire install', 'backup': 'backup',
                'health': 'health check', 'phone': 'phone', 'firstConversation': 'first conversation'}[step]

    # ----------------------------------------------------------- end states

    def holds(self, step):
        if step == 'naming':
            pending = all(Persona.problem(k, self.record.data.get(k)) is None for k in Persona.LIMITS)
            kept = Persona.of(self.owner) or {}
            return pending or all(k in kept for k in Persona.LIMITS)
        if step == 'ownerFolder':
            return self.owner_folder_holds()
        if step == 'layDown':
            return self.lay_down_holds()
        if step == 'backup':
            return self.backup_holds()
        return True

    def owner_folder_holds(self):
        if not os.path.isdir(self.owner):
            return False
        config = self.read_json(os.path.join(self.home, 'squire.json'))
        if not isinstance(config, dict) or not isinstance(config.get('ownerFolder'), str) \
                or os.path.realpath(config['ownerFolder']) != os.path.realpath(self.owner):
            return False
        kept = Persona.of(self.owner) or {}
        return all(k in kept for k in Persona.LIMITS)

    def lay_down_holds(self):
        if not os.path.isdir(self.release):
            return False
        if os.path.isdir(self.app_core) and Release.digests(self.app_core) != Release.digests(self.release):
            return False
        recorded = self.read_json(os.path.join(self.home, 'core-digests.json'))
        if not isinstance(recorded, dict) or not recorded:
            return False
        for rel, digest in recorded.items():
            if Release.digest(os.path.join(self.home, 'core', rel)) != digest:
                return False
        return all(self.agent(label) is not None for label in AGENTS)

    def backup_holds(self):
        if self.agent('com.stravica.squire.backup') is None:
            return False
        if not System.own_home():
            return True
        try:
            return subprocess.run([System.command('/bin/launchctl'), 'print',
                                   f'gui/{os.getuid()}/com.stravica.squire.backup'], cwd='/', env=System.env(),
                                  stdin=subprocess.DEVNULL, capture_output=True, timeout=30).returncode == 0
        except (OSError, subprocess.SubprocessError):
            return False

    def agent(self, label):
        try:
            with open(os.path.join(self.user_home, 'Library', 'LaunchAgents', label + '.plist'), 'rb') as f:
                return plistlib.load(f)
        except Exception:
            return None

    @staticmethod
    def read_json(path):
        try:
            with open(path, encoding='utf-8') as f:
                return json.load(f)
        except (OSError, ValueError):
            return None

    # ---------------------------------------------------------------- steps

    def step_naming(self):
        values = {}
        for key, title, ask in (('squireName', TITLES['name'],
                                 'What would you like to call your Squire? A name of up to 40 characters.'),
                                ('personality', TITLES['personality'],
                                 'Describe the personality you would like your Squire to have, in up to 400 characters.')):
            text = ask
            while True:
                answer = self.windows.typed(title, text)
                if answer is None:
                    raise Paused('Set-up stopped at naming your Squire: the window closed without an answer. '
                                 'Open Squire again to carry on from there.')
                value = answer.strip()
                why = Persona.problem(key, value)
                if why is None:
                    values[key] = value
                    break
                self.log(f'{key} asked again: {why}')
                text = f'Squire cannot keep that: {why}. {ask}'
        self.record.save(**values)

    def owner_problem(self):
        """Why ~/Squire cannot be used as it is; None when it can."""
        shown = '~/Squire'
        if os.path.lexists(self.owner):
            if not os.path.isdir(self.owner):
                return f'{shown} is already a file, not a folder. Move or rename it, then open Squire again.'
            real = os.path.realpath(self.owner)
            for away in self.ASKED_AWAY:
                place = os.path.realpath(os.path.join(self.user_home, away))
                if Paths.within(real, place):
                    return (f'{shown} leads into {away.split(os.sep)[-1]}, where the Mac asks before an app may read it. '
                            f'Make {shown} a folder of its own, then open Squire again.')
            if not os.access(self.owner, os.W_OK | os.X_OK):
                return f'Squire cannot write in {shown}. Let your account write there, then open Squire again.'
            config = os.path.join(self.owner, 'squire.json')
            if os.path.lexists(config) and not isinstance(self.read_json(config), dict):
                return (f'{shown}/squire.json does not parse as Squire\'s settings. Fix or move that file, then open '
                        'Squire again.')
        return None

    def step_owner_folder(self):
        problem = self.owner_problem()
        if problem:
            raise Paused(problem)
        names = {k: self.record.data[k] for k in Persona.LIMITS if Persona.problem(k, self.record.data.get(k)) is None}
        try:
            os.makedirs(self.owner, mode=0o700, exist_ok=True)
            owner_file = os.path.join(self.owner, 'squire.json')
            owner = self.read_json(owner_file) if os.path.lexists(owner_file) else {}
            if not isinstance(owner, dict):
                raise Paused(self.owner_problem() or 'Squire could not read ~/Squire/squire.json. Open Squire again.')
            if any(owner.get(k) != v for k, v in names.items()):
                owner.update(names)
                self.write_json(owner_file, owner)
            config_file = os.path.join(self.home, 'squire.json')
            config = self.read_json(config_file) if os.path.lexists(config_file) else {}
            config = config if isinstance(config, dict) else {}
            config['ownerFolder'] = self.owner
            config.setdefault('backupFolder', os.path.join(self.user_home, self.DEFAULT_BACKUP))
            self.write_json(config_file, config)
        except OSError as e:
            raise Paused(f'Squire could not write its folder ~/Squire or its settings ({e.strerror or type(e).__name__}). '
                         'Open Squire again.')
        if self.owner_folder_holds():
            self.record.save(squireName=None, personality=None)

    @staticmethod
    def write_json(path, data):
        fd, tmp = tempfile.mkstemp(prefix='.squire-', dir=os.path.dirname(path))
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as f:
                json.dump(data, f, indent=2, ensure_ascii=False)
                f.write('\n')
            os.chmod(tmp, 0o600)
            os.replace(tmp, path)
        except OSError:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise

    def step_lay_down(self):
        if not os.path.isdir(self.app_core):
            raise Paused('Squire\'s download is damaged. Fetch Squire again, then open it.')
        try:
            Release.keep(self.app_core, self.release)
        except (OSError, ValueError) as e:
            self.log(f'release copy failed: {e}')
            raise Paused('Squire could not copy itself into its own folder. Open Squire again.')
        self.record.save(release=self.release)
        self.lay_down()

    def lay_down(self):
        script = os.path.join(self.release, 'tools', 'lay-down.py')
        try:
            r = subprocess.run([self.python, '-B', script, self.release], cwd='/', env=System.env(self.home),
                               stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=self.LAY_DOWN_WITHIN)
        except (OSError, subprocess.SubprocessError) as e:
            self.log(f'lay-down did not finish ({type(e).__name__})')
            raise Paused('Squire could not install its own parts: it did not finish in time. Open Squire again.')
        if r.returncode != 0:
            self.log(f'lay-down exited {r.returncode}: {r.stderr.strip()}')
            raise Paused('Squire could not install its own parts. Open Squire again.')

    def step_backup(self):
        if not self.backup_holds():
            self.lay_down()

    def step_health(self):
        stopped = self.server_stopped()
        end = time.monotonic() + self.RUNNER_GRACE
        while not stopped and not self.runner_running() and time.monotonic() < end:
            time.sleep(0.2)
            stopped = self.server_stopped()
        lines = self.health()
        faults = [line for line in lines if line.startswith('floor:')
                  or (line.startswith('sign-in:') and 'has ended' in line)
                  or (line.startswith('runner:') and not stopped)]
        if faults:
            raise Paused('Squire\'s health check found what set-up laid down is not right:\n' + '\n'.join(faults)
                         + '\nOpen Squire again to repair it.')
        self.ready_lines = [line for line in lines if not line.startswith(self.SET_UP_FAULTS)]

    def health(self):
        script = os.path.join(self.home, 'core', 'tools', 'health.py')
        try:
            r = subprocess.run([self.python, '-B', script], cwd='/', env=System.env(self.home),
                               stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=self.HEALTH_WITHIN)
        except (OSError, subprocess.SubprocessError) as e:
            raise Paused(f'Squire\'s health check did not finish ({type(e).__name__}). Open Squire again.')
        if r.returncode not in (0, 1):
            self.log(f'health check exited {r.returncode}: {r.stderr.strip()}')
            raise Paused('Squire\'s health check could not run. Open Squire again.')
        return [line for line in r.stdout.splitlines() if line.strip()]

    def runner_running(self):
        import fcntl

        try:
            fd = os.open(os.path.join(self.home, 'runner.lock'), os.O_RDONLY)
        except OSError:
            return False
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return True
        except OSError:
            return False
        finally:
            os.close(fd)
        return False

    def server_stopped(self):
        """The runner's reasons for no session, once the runner has stopped."""
        if self.runner_running():
            return []
        problems = (self.read_json(os.path.join(self.home, 'runner.json')) or {})
        problems = problems.get('problems') if isinstance(problems, dict) else None
        return [p for p in problems or [] if isinstance(p, str) and p.startswith('no session:')]

    def step_phone(self):
        self.windows.button(TITLES['phone'],
                            'Talk to your Squire from your phone too: install the Claude app from the App Store, and sign '
                            'in with the same Claude account you used for Squire. Your Squire then shows in the app. '
                            'You can do this later.', ('Later', 'Done'), 'Done')

    def step_first_conversation(self):
        identity = self.identity()
        end = time.monotonic() + self.SESSION_WITHIN
        while True:
            if identity is not None and identity.check(None)[0] == 'ok':
                break
            stopped = self.server_stopped()
            if stopped or time.monotonic() >= end:
                why = '\n'.join(stopped) or 'no session started within 2 minutes.'
                raise Paused('Squire\'s session did not start, so the first conversation could not begin:\n' + why
                             + '\nOpen Squire again once this is put right.')
            time.sleep(0.5)
        try:
            r = subprocess.run([System.command('/usr/bin/open'), self.ADDRESS], cwd='/', env=System.env(),
                               stdin=subprocess.DEVNULL, capture_output=True, timeout=60)
            opened = r.returncode == 0
        except (OSError, subprocess.SubprocessError):
            opened = False
        if not opened:
            raise Paused(f'Squire could not open your browser at {self.ADDRESS}. Open that address in your browser, '
                         'then open Squire again.')

    def identity(self):
        """The router's identity check, from the installed core."""
        path = os.path.join(self.home, 'core', 'tools', 'wake-up.py')
        try:
            spec = importlib.util.spec_from_file_location('squire_wake_up', path)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            return module.Identity(self.home)
        except Exception as e:
            self.log(f'the identity check could not be loaded ({type(e).__name__})')
            return None

    # ------------------------------------------------------------- windows

    def pause(self, text):
        self.log(f'paused: {text}')
        self.windows.button(TITLES['paused'], text, ('OK',))

    def ready(self):
        name = (Persona.of(self.owner) or {}).get('squireName', 'Your Squire')
        text = (f'{name} is ready. Talk to {name} at claude.ai/code in your browser, or in the Claude app on your phone. '
                f'{name} keeps running on this Mac.')
        if self.ready_lines:
            text += '\n\nThe health check also says:\n' + '\n'.join(self.ready_lines)
        self.log('ready')
        self.windows.button(TITLES['ready'], text, ('OK',))


class Release:
    """The Squire home's release folder: a copy of the app's core, checked
    file by file by digest, which every later lay-down reads."""

    SKIP = ('__pycache__',)

    @staticmethod
    def digest(path):
        try:
            with open(path, 'rb') as f:
                return hashlib.sha256(f.read()).hexdigest()
        except OSError:
            return None

    @classmethod
    def digests(cls, root):
        found = {}
        for folder, dirs, files in os.walk(root):
            dirs[:] = sorted(d for d in dirs if d not in cls.SKIP)
            for name in sorted(files):
                if name.endswith('.pyc'):
                    continue
                path = os.path.join(folder, name)
                found[os.path.relpath(path, root)] = cls.digest(path)
        return found

    @classmethod
    def keep(cls, source, release):
        wanted = cls.digests(source)
        if os.path.isdir(release) and cls.digests(release) == wanted:
            return
        parent = os.path.dirname(release)
        os.makedirs(parent, mode=0o700, exist_ok=True)
        staging = tempfile.mkdtemp(prefix='.release-', dir=parent)
        try:
            incoming = os.path.join(staging, 'core')
            shutil.copytree(source, incoming, ignore=shutil.ignore_patterns(*cls.SKIP, '*.pyc'))
            if cls.digests(incoming) != wanted:
                raise ValueError('the copy does not match the app\'s core')
            if os.path.lexists(release):
                os.rename(release, os.path.join(staging, 'previous'))
            os.rename(incoming, release)
        finally:
            shutil.rmtree(staging, ignore_errors=True)


if __name__ == '__main__':
    try:
        code = SetUp.main(sys.argv[1:])
    except Exception as e:
        sys.stderr.write(f'set-up failed ({type(e).__name__}).\n')
        code = 1
    sys.exit(code)
