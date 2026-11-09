"""Squire's health check.

    /usr/bin/python3 health.py
    /usr/bin/python3 health.py --request runner|floor|sign-in
    /usr/bin/python3 health.py --perform

Names every overlay in the owner's folder that sits at the path of a core
file, one line each, as "ignored: overlay/<path> (safety floor)": in this
release every core path is a safety floor path, so the floor never reads
them. Then the session runner's lines: why it started no session at its
last check, and each Claude Code settings file it moved out of the owner's
folder, by name.

Once core is laid down in the Squire home it also names, one line each:
the result of the last known fix ("fixed: ...", "still: ..." or "could not
try: ...", printed once); a floor file changed since core was laid down,
the session runner not running and a sign-in that ends within seven days,
each with the request that asks the owner for its known fix; a sign-in that
has ended, with the way on (Squire's installer); a compaction window other
than 500000 tokens in any source Claude Code reads, or a source it cannot
read; and the nightly backup's last failure and the files it could not
copy. Exits 1 when it names anything, 0 when it names nothing.

--request is what the session asks for; the floor asks the owner for it and
never lets it run in the session. --perform is the wake-ups scheduler's,
outside the session: it makes each known fix the owner said yes to, once,
only while the yes is under 30 minutes old and its fault is still there.
"""

import fcntl
import hashlib
import json
import os
import plistlib
import pwd
import stat
import subprocess
import sys
import tempfile
import time

CORE = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
PYTHON = '/usr/bin/python3'


class KnownFixes:
    """The faults with a known fix, how each is found, and the fix the
    scheduler makes for the owner's yes."""

    FAULTS = ('runner', 'floor', 'sign-in')
    FRESH = 1800
    LAY_DOWN_WITHIN = 300
    LAUNCHCTL_WITHIN = 30
    AGENTS = ('com.stravica.squire.runner', 'com.stravica.squire.wake-ups', 'com.stravica.squire.backup')

    def __init__(self, config):
        from squire import ClaudeSignIn

        self.config = config
        self.home = config.home
        self.results_file = os.path.join(self.home, 'fixes.json')
        self.sign_in = ClaudeSignIn(self.home)
        self.signed = None

    def request(self, fault):
        return f'{PYTHON} {os.path.join(self.home, "core", "tools", "health.py")} --request {fault}'

    def changed_floor(self):
        """The floor files that differ from the digests lay-down recorded."""
        try:
            with open(os.path.join(self.home, 'core-digests.json'), encoding='utf-8') as f:
                digests = json.load(f)
        except (OSError, ValueError):
            return ['core-digests.json']
        if not isinstance(digests, dict) or not digests:
            return ['core-digests.json']
        changed = []
        for rel, digest in sorted(digests.items()):
            try:
                with open(os.path.join(self.home, 'core', rel), 'rb') as f:
                    found = hashlib.sha256(f.read()).hexdigest()
            except OSError:
                found = None
            if found != digest:
                changed.append(f'core/{rel}')
        return changed

    def runner_running(self):
        """True when the session runner holds its lock. The lock is tried and
        let go at once, and never made."""
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

    def signed_in(self):
        if self.signed is None:
            self.signed = self.sign_in.status()
        return self.signed

    def present(self, fault):
        if fault == 'floor':
            return bool(self.changed_floor())
        if fault == 'runner':
            return not self.runner_running()
        signed, ends = self.signed_in()
        return not signed or (ends is not None and ends <= time.time() + self.sign_in.WARN_WITHIN)

    def lines(self):
        lines = [f'floor: {rel} has changed since core was laid down; ask for its fix: {self.request("floor")}'
                 for rel in self.changed_floor()]
        if not self.runner_running():
            lines.append(f'runner: Squire\'s session runner is not running; ask for its fix: {self.request("runner")}')
        signed, ends = self.signed_in()
        if not signed:
            lines.append('sign-in: Squire\'s Claude sign-in has ended, or Claude Code cannot be found; open Squire\'s '
                         'installer to sign in again')
        elif ends is not None and ends <= time.time() + self.sign_in.WARN_WITHIN:
            lines.append(f'sign-in: Squire\'s Claude sign-in ends on {self.sign_in.day(ends)}; to sign in again before '
                         f'then, ask for it: {self.request("sign-in")}')
        return lines

    def results(self):
        """The last fixes' results, printed once: the file is removed."""
        try:
            with open(self.results_file, encoding='utf-8') as f:
                results = json.load(f)
            os.unlink(self.results_file)
        except (OSError, ValueError):
            return []
        return [r for r in results if isinstance(r, str)] if isinstance(results, list) else []

    def perform(self):
        """The scheduler's step: each unused yes to a known fix is marked used
        under the ledger's lock before anything is tried, then made only when
        fresh and exact."""
        from squire import Ledger, SquireError

        now = time.time()
        try:
            with Ledger(self.config.ledger_path) as ledger:
                yeses = ledger.fix_yeses()
                for request, _ in yeses:
                    ledger.append({'type': 'use', 'request': request['id'], 'at': now})
        except SquireError as e:
            sys.stderr.write(f'health check could not read the owner\'s yeses: {e}.\n')
            return 2
        results, made = [], set()
        for request, answer in yeses:
            fault = request['item'][len('fix:'):]
            if fault not in self.FAULTS:
                results.append(f'could not try: {fault}: it is not one of the known fixes')
            elif fault in made:
                results.append(f'could not try: {fault}: its fix was already made at this run')
            elif not isinstance(answer.get('at'), (int, float)) or now - answer['at'] >= self.FRESH:
                results.append(f'could not try: {fault}: the owner\'s yes was more than 30 minutes old when the '
                               'scheduler reached it; ask for the fix again')
            elif not self.present(fault):
                results.append(f'could not try: {fault}: the fault was gone before the fix ran; nothing was changed')
            else:
                made.add(fault)
                results.append(self.make(fault))
        self.record(results)
        return 0

    def make(self, fault):
        why = {'runner': self.reload, 'floor': self.lay_down, 'sign-in': self.renew}[fault]()
        if why:
            return f'could not try: {fault}: {why}'
        self.signed = None
        what = {'runner': 'Squire\'s session runner, after its background jobs were reloaded',
                'floor': 'Squire\'s floor files, after core was laid down again from Squire\'s release folder',
                'sign-in': 'Squire\'s Claude sign-in, after the sign-in ran'}[fault]
        return f'{"still" if self.present(fault) else "fixed"}: {fault}: {what}'

    def reload(self):
        """Squire's agents loaded again, only in the account's own home."""
        from squire import System

        if not System.own_home():
            return None
        folder = os.path.join(os.path.expanduser('~'), 'Library', 'LaunchAgents')
        domain = f'gui/{os.getuid()}'
        launchctl = System.command('/bin/launchctl')
        for label in self.AGENTS:
            plist = os.path.join(folder, label + '.plist')
            try:
                loaded = subprocess.run([launchctl, 'print', f'{domain}/{label}'], cwd='/', env=System.env(),
                                        stdin=subprocess.DEVNULL, capture_output=True,
                                        timeout=self.LAUNCHCTL_WITHIN).returncode == 0
                if not loaded and os.path.isfile(plist):
                    subprocess.run([launchctl, 'bootstrap', domain, plist], cwd='/', env=System.env(),
                                   stdin=subprocess.DEVNULL, capture_output=True, timeout=self.LAUNCHCTL_WITHIN)
            except (OSError, subprocess.SubprocessError) as e:
                return f'launchd did not answer ({type(e).__name__})'
        return None

    def lay_down(self):
        """Core laid down again from the release folder set-up keeps."""
        from squire import System

        try:
            with open(os.path.join(self.home, 'set-up.json'), encoding='utf-8') as f:
                release = json.load(f).get('release')
        except (OSError, ValueError, AttributeError):
            release = None
        script = os.path.join(release, 'tools', 'lay-down.py') if isinstance(release, str) else None
        if not script or not os.path.isfile(script):
            return 'Squire\'s release folder is gone; open Squire\'s installer to lay core down again'
        try:
            r = subprocess.run([System.command(PYTHON), '-B', script, release], cwd='/', env=System.env(self.home),
                               stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=self.LAY_DOWN_WITHIN)
        except (OSError, subprocess.SubprocessError) as e:
            return f'lay-down did not finish ({type(e).__name__}); open Squire\'s installer'
        if r.returncode != 0:
            return f'lay-down failed ({(r.stderr.strip().splitlines() or ["exit " + str(r.returncode)])[-1]})'
        return None

    def renew(self):
        if not self.sign_in.claude:
            return 'Claude Code cannot be found; open Squire\'s installer'
        self.sign_in.sign_in()
        return None

    def record(self, results):
        if not results:
            return
        try:
            with open(self.results_file, encoding='utf-8') as f:
                earlier = json.load(f)
        except (OSError, ValueError):
            earlier = []
        results = [r for r in earlier if isinstance(r, str)] + results if isinstance(earlier, list) else results
        fd, tmp = tempfile.mkstemp(prefix='.fixes-', dir=self.home)
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            json.dump(results, f, indent=2)
            f.write('\n')
        os.chmod(tmp, 0o600)
        os.replace(tmp, self.results_file)


class CompactionWindow:
    """Claude Code's auto-compact window for Squire's session, read from
    every source the health check knows: core's settings and the config
    folder's (top level and per model), the runner's agent's environment,
    and the Mac's managed settings, drop-ins and managed preferences under
    the system root. Only 500000 passes; a per-model window at or above the
    model's own (core/model-windows.json) changes nothing for it."""

    WINDOW = 500000
    KEY = 'autoCompactWindow'
    VARIABLE = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW'

    def __init__(self, home):
        from squire import System

        self.home = home
        self.root = System.root()
        self.user = pwd.getpwuid(os.getuid()).pw_name
        try:
            with open(os.path.join(CORE, 'model-windows.json'), encoding='utf-8') as f:
                windows = json.load(f)
        except (OSError, ValueError):
            windows = {}
        self.windows = windows if isinstance(windows, dict) else {}

    def cannot(self, path, why):
        return f'cannot confirm the compaction window: {path} {why}'

    def lines(self):
        lines = []
        for path in (os.path.join(self.home, 'core', 'settings.json'), os.path.join(self.home, 'claude-config', 'settings.json')):
            lines += self.json_source(path, required=True)
        lines += self.runner_agent()
        managed = os.path.join(self.root + '/Library', 'Application Support', 'ClaudeCode')
        lines += self.json_source(os.path.join(managed, 'managed-settings.json'))
        drop_ins = os.path.join(managed, 'managed-settings.d')
        if os.path.lexists(drop_ins):
            try:
                names = sorted(n for n in os.listdir(drop_ins) if n.endswith('.json') and not n.startswith('.'))
            except OSError:
                return lines + [self.cannot(drop_ins, 'cannot be listed')]
            for name in names:
                path = os.path.join(drop_ins, name)
                # A drop-in the check cannot reach (a link into a folder it may
                # not search, or one that leads nowhere) is named, never skipped.
                try:
                    regular = stat.S_ISREG(os.stat(path).st_mode)
                except OSError:
                    lines.append(self.cannot(path, 'cannot be reached'))
                    continue
                if regular:
                    lines += self.json_source(path)
        preferences = os.path.join(self.root + '/Library', 'Managed Preferences')
        lines += self.plist_source(os.path.join(preferences, 'com.anthropic.claudecode.plist'))
        per_user = os.path.join(preferences, self.user, 'com.anthropic.claudecode.plist')
        if os.path.lexists(per_user):
            lines.append(self.cannot(per_user, 'can set the window for this user, and the health check does not read it'))
        return lines

    def json_source(self, path, required=False):
        try:
            with open(path, encoding='utf-8') as f:
                text = f.read()
        except FileNotFoundError:
            return [self.cannot(path, 'is missing')] if required else []
        except (OSError, ValueError):
            return [self.cannot(path, 'exists but cannot be read')]
        try:
            data = json.loads(text)
        except ValueError:
            return [self.cannot(path, 'does not parse as JSON')]
        return self.settings(path, data)

    def plist_source(self, path):
        if not os.path.lexists(path):
            return []
        try:
            with open(path, 'rb') as f:
                data = plistlib.load(f)
        except OSError:
            return [self.cannot(path, 'exists but cannot be read')]
        except Exception:
            return [self.cannot(path, 'does not parse as a property list')]
        return self.settings(path, data)

    def settings(self, path, data):
        if not isinstance(data, dict):
            return [self.cannot(path, 'does not hold one object')]
        lines = []
        if self.KEY in data and not self.passes(data[self.KEY]):
            lines.append(f'compaction window: {path} sets {self.KEY} to {json.dumps(data[self.KEY])}, not {self.WINDOW}')
        models = data.get('modelSettings')
        if models is None:
            return lines
        if not isinstance(models, dict):
            return lines + [self.cannot(path, 'holds modelSettings that is not an object')]
        for model, entry in sorted(models.items()):
            if not isinstance(entry, dict):
                lines.append(self.cannot(path, f'holds modelSettings for {model} that is not an object'))
            elif self.KEY in entry and not self.passes(entry[self.KEY], model):
                lines.append(f'compaction window: {path} sets {model}\'s {self.KEY} to {json.dumps(entry[self.KEY])}, '
                             f'not {self.WINDOW}')
        return lines

    def passes(self, value, model=None):
        if isinstance(value, bool) or not isinstance(value, int):
            return False
        if value == self.WINDOW:
            return True
        own = self.windows.get(model)
        return isinstance(own, int) and not isinstance(own, bool) and own < self.WINDOW and value >= own

    def runner_agent(self):
        path = os.path.join(os.path.expanduser('~'), 'Library', 'LaunchAgents', 'com.stravica.squire.runner.plist')
        if not os.path.lexists(path):
            return []
        try:
            with open(path, 'rb') as f:
                agent = plistlib.load(f)
        except OSError:
            return [self.cannot(path, 'exists but cannot be read')]
        except Exception:
            return [self.cannot(path, 'does not parse as a property list')]
        env = agent.get('EnvironmentVariables') if isinstance(agent, dict) else None
        if isinstance(env, dict) and self.VARIABLE in env and env[self.VARIABLE] != str(self.WINDOW):
            return [f'compaction window: the runner\'s agent {path} sets {self.VARIABLE} to {env[self.VARIABLE]}, '
                    f'not {self.WINDOW}']
        return []


class BackupLines:
    """The nightly backup's last run, from backup.json in the Squire home: a
    failure, naming the destination and why, and each file it could not
    copy."""

    @staticmethod
    def lines(home):
        try:
            with open(os.path.join(home, 'backup.json'), encoding='utf-8') as f:
                last = json.load(f).get('lastRun')
        except FileNotFoundError:
            return []
        except (OSError, ValueError, AttributeError):
            return ['backup: the record of the nightly backup (backup.json in the Squire home) cannot be read']
        if not isinstance(last, dict):
            return []
        destination = last.get('destination')
        lines = []
        if last.get('result') == 'failed':
            lines.append(f'backup: the nightly backup to {destination} failed: {last.get("reason")}; its next run '
                         'tries again in full')
        for rel in last.get('notCopied') or []:
            if isinstance(rel, str):
                lines.append(f'backup: {rel} in the owner\'s folder could not be copied to {destination} at the last '
                             'run; the backup keeps its last copy of it')
        return lines


class HealthCheck:
    @staticmethod
    def main(argv):
        sys.path.insert(0, os.path.join(CORE, 'lib'))
        from squire import Config, SquireError

        try:
            config = Config()
        except SquireError as e:
            sys.stderr.write(f'health check could not run: {e}.\n')
            return 2
        if argv[:1] == ['--request']:
            if len(argv) != 2 or argv[1] not in KnownFixes.FAULTS:
                sys.stderr.write('ask for one known fix: health.py --request runner|floor|sign-in\n')
                return 2
            print(f'The fix for {argv[1]} is asked for in Squire\'s session: the safety floor asks the owner, and '
                  'Squire\'s scheduler makes it outside the session. Nothing was changed here.')
            return 0
        if argv == ['--perform']:
            return KnownFixes(config).perform()
        if argv:
            sys.stderr.write('health.py takes no arguments, --request <fix> or --perform\n')
            return 2
        installed = os.path.isdir(os.path.join(config.home, 'core'))
        fixes = KnownFixes(config) if installed else None
        lines = fixes.results() if installed else []
        lines += [f'ignored: overlay/{rel} (safety floor)' for rel in HealthCheck.ignored_overlays(CORE, config.owner_folder)]
        lines += HealthCheck.runner_lines(config.home)
        if installed:
            lines += fixes.lines()
            lines += CompactionWindow(config.home).lines()
            lines += BackupLines.lines(config.home)
        for line in lines:
            print(line)
        return 1 if lines else 0

    @staticmethod
    def ignored_overlays(core, owner):
        overlay = os.path.join(owner, 'overlay')
        found = []
        for folder, _, files in os.walk(core):
            for name in files:
                rel = os.path.relpath(os.path.join(folder, name), core)
                if os.path.lexists(os.path.join(overlay, rel)):
                    found.append(rel)
        return sorted(found)

    @staticmethod
    def runner_lines(home):
        """What the runner left for the owner: its last check's problems, and
        the settings files it moved."""
        lines = []
        try:
            with open(os.path.join(home, 'runner.json'), encoding='utf-8') as f:
                problems = json.load(f).get('problems')
            lines += [p for p in problems if isinstance(p, str)]
        except (OSError, ValueError, AttributeError, TypeError):
            pass
        moved = os.path.join(home, 'moved-settings')
        for folder, _, files in sorted(os.walk(moved)):
            for name in sorted(files):
                lines.append(f'moved: the Claude Code settings file .claude/{name} was in the owner\'s folder, where it '
                             f'could switch the safety floor off; it is kept at {os.path.join(folder, name)}')
        return lines


if __name__ == '__main__':
    try:
        code = HealthCheck.main(sys.argv[1:])
    except Exception as e:
        sys.stderr.write(f'health check failed ({type(e).__name__}).\n')
        code = 2
    sys.exit(code)
