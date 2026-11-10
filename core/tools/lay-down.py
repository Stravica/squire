"""Lays Squire's core down from a release folder, replacing the installed
core whole. Run by the installer or an update, never by the session.

    /usr/bin/python3 lay-down.py <release-dir>

The core goes to <Squire home>/core as a copy. The owner's folder is never
touched. A release lacking any floor entry point, a release that is or lies
in the Squire home (other than the release folders the Squire home keeps:
release/core, which set-up keeps, and releases/<version>/core, an update's
kept releases), and a layout where the owner's folder and the Squire home
overlap are refused with exit 1 and a reason, and nothing changes.

Once core is down it writes the settings of Claude Code's config folder for
Squire's session (claude-config/settings.json) from core's settings and the
Squire's name and personality from the owner's squire.json into its
CLAUDE.md, records the SHA-256 digests of core's settings and the four floor
hooks in core-digests.json in the Squire home, and writes the session
runner's, the wake-up scheduler's and the nightly backup's launchd agents
into Library/LaunchAgents under the home folder it is given. It loads them
only when that folder is the account's own home folder, as the account
database names it.
"""

import hashlib
import json
import os
import plistlib
import pwd
import shutil
import subprocess
import sys
import tempfile

CORE = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))


class LayDown:
    ENTRY_POINTS = ('hooks/pre-tool-use.py', 'hooks/user-prompt-submit.py', 'tools/secret.py', 'tools/lay-down.py')
    FLOOR_FILES = ('settings.json', 'hooks/pre-tool-use.py', 'hooks/user-prompt-submit.py', 'hooks/session-start.py',
                   'hooks/config-change.py', 'release.json', 'release-key.pub', 'tools/update.py', 'tools/ticket.py')
    PYTHON = '/usr/bin/python3'
    RUNNER = 'com.stravica.squire.runner'
    WAKE_UPS = 'com.stravica.squire.wake-ups'
    BACKUP = 'com.stravica.squire.backup'

    @staticmethod
    def main(argv):
        sys.path.insert(0, os.path.join(CORE, 'lib'))
        from squire import Config, Paths, Persona, SquireError

        try:
            if len(argv) != 1:
                raise SquireError('give one release folder: lay-down.py <release-dir>')
            config = Config()
            home = os.path.realpath(config.home)
            release = os.path.realpath(argv[0])
            if not os.path.isdir(release):
                raise SquireError(f'the release {argv[0]} is not a folder')
            missing = [p for p in LayDown.ENTRY_POINTS if not os.path.isfile(os.path.join(release, p))]
            if missing:
                raise SquireError(f'the release {argv[0]} lacks {", ".join(missing)}')
            if Paths.overlap(release, home) and not LayDown.kept(release, home):
                raise SquireError(f'the release {argv[0]} and the Squire home {home} overlap')
            if Paths.overlap(config.owner_folder, home):
                raise SquireError(f'the owner\'s folder {config.owner_folder} and the Squire home {home} overlap')
            LayDown.replace(release, home)
        except SquireError as e:
            sys.stderr.write(f'lay-down refused: {e}. Nothing was changed.\n')
            return 1
        try:
            LayDown.settle(home)
            Persona.write(home, config.owner_folder)
            LayDown.agents(home)
        except (OSError, SquireError) as e:
            sys.stderr.write(f'lay-down laid core down, then failed: {e}. Lay core down again.\n')
            return 1
        return 0

    @staticmethod
    def kept(release, home):
        """True for a release folder the Squire home keeps: release/core, or
        releases/<version>/core."""
        if release == os.path.join(home, 'release', 'core'):
            return True
        parent, name = os.path.split(release)
        return name == 'core' and os.path.dirname(parent) == os.path.join(home, 'releases') \
            and os.path.basename(parent) not in ('', '.', '..')

    @staticmethod
    def write(path, data, mode=0o600):
        """Writes path whole, through a file beside it."""
        fd, tmp = tempfile.mkstemp(prefix='.lay-down-', dir=os.path.dirname(path))
        with os.fdopen(fd, 'wb') as f:
            f.write(data)
        os.chmod(tmp, mode)
        os.replace(tmp, path)

    @staticmethod
    def settle(home):
        """The config folder's settings from core's, and the floor's digests."""
        core = os.path.join(home, 'core')
        config = os.path.join(home, 'claude-config')
        os.makedirs(config, mode=0o700, exist_ok=True)
        with open(os.path.join(core, 'settings.json'), 'rb') as f:
            LayDown.write(os.path.join(config, 'settings.json'), f.read())
        digests = {}
        for rel in LayDown.FLOOR_FILES:
            try:
                with open(os.path.join(core, rel), 'rb') as f:
                    digests[rel] = hashlib.sha256(f.read()).hexdigest()
            except FileNotFoundError:
                pass
        LayDown.write(os.path.join(home, 'core-digests.json'), (json.dumps(digests, indent=2) + '\n').encode('utf-8'))

    @staticmethod
    def agents(home):
        """The runner's, the wake-up scheduler's and the nightly backup's
        launchd agents, loaded only for the account's own home folder."""
        from squire import SquireError

        user_home = os.path.expanduser('~')
        folder = os.path.join(user_home, 'Library', 'LaunchAgents')
        os.makedirs(folder, exist_ok=True)
        tools = os.path.join(home, 'core', 'tools')
        env = {'SQUIRE_HOME': home}
        agents = {
            LayDown.RUNNER: {'Label': LayDown.RUNNER, 'EnvironmentVariables': env,
                             'ProgramArguments': [LayDown.PYTHON, '-B', os.path.join(tools, 'runner.py')],
                             'RunAtLoad': True, 'KeepAlive': True},
            LayDown.WAKE_UPS: {'Label': LayDown.WAKE_UPS, 'EnvironmentVariables': env,
                               'ProgramArguments': [LayDown.PYTHON, '-B', os.path.join(tools, 'wake-up.py'), '--due'],
                               'StartInterval': 60},
            LayDown.BACKUP: {'Label': LayDown.BACKUP, 'EnvironmentVariables': env,
                             'ProgramArguments': [LayDown.PYTHON, '-B', os.path.join(tools, 'backup.py')],
                             'StartCalendarInterval': {'Hour': 2, 'Minute': 30}},
        }
        for label, agent in agents.items():
            LayDown.write(os.path.join(folder, label + '.plist'), plistlib.dumps(agent), 0o644)
        own = pwd.getpwuid(os.getuid()).pw_dir
        if os.path.realpath(user_home) != os.path.realpath(own):
            return
        domain = f'gui/{os.getuid()}'
        for label in agents:
            subprocess.run(['/bin/launchctl', 'bootout', f'{domain}/{label}'], stdin=subprocess.DEVNULL,
                           capture_output=True)
            r = subprocess.run(['/bin/launchctl', 'bootstrap', domain, os.path.join(folder, label + '.plist')],
                               stdin=subprocess.DEVNULL, capture_output=True, text=True)
            if r.returncode != 0:
                raise SquireError(f'launchd did not load {label} ({r.stderr.strip() or r.returncode})')

    @staticmethod
    def replace(release, home):
        """Copies the release beside the installed core, then swaps it in."""
        from squire import SquireError

        staging = tempfile.mkdtemp(prefix='.lay-down-', dir=home)
        incoming, previous = os.path.join(staging, 'core'), os.path.join(staging, 'previous')
        installed = os.path.join(home, 'core')
        try:
            shutil.copytree(release, incoming, symlinks=False)
            if os.path.lexists(installed):
                os.rename(installed, previous)
            os.rename(incoming, installed)
        except OSError as e:
            if os.path.lexists(previous) and not os.path.lexists(installed):
                os.rename(previous, installed)
            raise SquireError(f'the copy failed ({e.strerror or type(e).__name__})')
        finally:
            shutil.rmtree(staging, ignore_errors=True)


if __name__ == '__main__':
    try:
        code = LayDown.main(sys.argv[1:])
    except Exception as e:
        sys.stderr.write(f'lay-down failed ({type(e).__name__}). Nothing was changed.\n')
        code = 1
    sys.exit(code)
