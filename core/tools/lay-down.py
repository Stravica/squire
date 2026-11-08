"""Lays Squire's core down from a release folder, replacing the installed
core whole. Run by the installer or an update, never by the session.

    /usr/bin/python3 lay-down.py <release-dir>

The core goes to <Squire home>/core as a copy. The owner's folder is never
touched. A release lacking any floor entry point, a release that is or lies
in the Squire home, and a layout where the owner's folder and the Squire
home overlap are refused with exit 1 and a reason, and nothing changes.
"""

import os
import shutil
import sys
import tempfile

CORE = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))


class LayDown:
    ENTRY_POINTS = ('hooks/pre-tool-use.py', 'hooks/user-prompt-submit.py', 'tools/secret.py', 'tools/lay-down.py')

    @staticmethod
    def main(argv):
        sys.path.insert(0, os.path.join(CORE, 'lib'))
        from squire import Config, Paths, SquireError

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
            if Paths.overlap(release, home):
                raise SquireError(f'the release {argv[0]} and the Squire home {home} overlap')
            if Paths.overlap(config.owner_folder, home):
                raise SquireError(f'the owner\'s folder {config.owner_folder} and the Squire home {home} overlap')
            LayDown.replace(release, home)
        except SquireError as e:
            sys.stderr.write(f'lay-down refused: {e}. Nothing was changed.\n')
            return 1
        return 0

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
