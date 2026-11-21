"""Squire's versions command: versions of what Squire builds for the owner,
kept on this Mac only, and an earlier one got back on request. The session
runs it as one command, the folder in quotes:

    /usr/bin/python3 '<Squire home>/core/tools/versions.py' keep '<folder>'
    /usr/bin/python3 '<Squire home>/core/tools/versions.py' list '<folder>'
    /usr/bin/python3 '<Squire home>/core/tools/versions.py' back '<folder>' <number>

keep copies the folder as it is now into a new version, numbered from 1.
list prints one line for each version kept, oldest first, each led by its
number. back first keeps, as a version of its own, any change made in the
folder since it was last kept or got back, so going back never loses work;
then it leaves the folder whole as that version was (a file added since is
gone), and every version kept so far stays, so a later one can be got back
too.

The versions are kept in the Squire home, under versions/, one place for
each folder; nothing is sent anywhere. A folder that is not there, a version
that was not kept or a verb it does not take is refused: it says why, exits 1
and changes nothing.

Standard library only; run by /usr/bin/python3.
"""

import filecmp
import hashlib
import json
import os
import shutil
import sys
import tempfile
import time

sys.dont_write_bytecode = True
CORE = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
sys.path.insert(0, os.path.join(CORE, 'lib'))

from squire import Config, SquireError  # noqa: E402

USAGE = ('Squire\'s versions command takes: keep \'<folder>\', list \'<folder>\', or back \'<folder>\' <number>')


class Refused(Exception):
    """A reason the command changed nothing, in words the owner can act on."""


class Versions:
    """The versions kept of one folder, in the Squire home: a copy of the
    folder for each version, and a record (kept.json) of each version's
    number, when it was kept and why, and the version the folder was last
    left as."""

    PLACE = 'versions'
    RECORD = 'kept.json'

    def __init__(self, home, folder):
        self.folder = os.path.realpath(folder)
        if not os.path.isdir(self.folder):
            raise Refused(f'there is no folder {folder}')
        key = hashlib.sha256(self.folder.encode('utf-8')).hexdigest()[:24]
        self.place = os.path.join(home, self.PLACE, key)
        self.record = self.read()

    def read(self):
        """The record, or a fresh one when nothing is kept yet."""
        try:
            with open(os.path.join(self.place, self.RECORD), encoding='utf-8') as f:
                record = json.load(f)
        except FileNotFoundError:
            return {'folder': self.folder, 'versions': [], 'current': None}
        except (OSError, ValueError):
            raise SquireError(f'the record of versions in {self.place} cannot be read')
        if not isinstance(record, dict) or not isinstance(record.get('versions'), list):
            raise SquireError(f'the record of versions in {self.place} is not one Squire wrote')
        return record

    def write(self):
        """The record, written whole through a file beside it."""
        fd, tmp = tempfile.mkstemp(prefix='.kept-', dir=self.place)
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as f:
                json.dump(self.record, f, indent=2)
                f.write('\n')
            os.chmod(tmp, 0o600)
            os.replace(tmp, os.path.join(self.place, self.RECORD))
        except OSError:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise

    def numbers(self):
        return [v['number'] for v in self.record['versions']]

    def copy_of(self, number):
        return os.path.join(self.place, str(number))

    def keep(self, why):
        """Keeps the folder as it is now as the next version; its number."""
        os.makedirs(self.place, mode=0o700, exist_ok=True)
        number = max(self.numbers(), default=0) + 1
        staged = tempfile.mkdtemp(prefix='.keeping-', dir=self.place)
        try:
            shutil.copytree(self.folder, os.path.join(staged, 'copy'), symlinks=True)
            os.rename(os.path.join(staged, 'copy'), self.copy_of(number))
        finally:
            shutil.rmtree(staged, ignore_errors=True)
        self.record['versions'].append({'number': number, 'at': time.time(), 'why': why})
        self.record['current'] = number
        self.write()
        return number

    def changed(self):
        """True when the folder differs from the version it was last left as
        (or, with none recorded, the newest version): a file added, gone or
        with other contents, a link pointing elsewhere."""
        current = self.record.get('current')
        if current not in self.numbers():
            current = max(self.numbers(), default=None)
        if current is None:
            return True
        return not same_tree(self.folder, self.copy_of(current))

    def back(self, number):
        """Leaves the folder whole as that version was, first keeping any
        change since it was last kept or got back; the number kept on the
        way, or None."""
        if number not in self.numbers() or not os.path.isdir(self.copy_of(number)):
            raise Refused(f'version {number} of {self.folder} was not kept; the versions kept are '
                          + (', '.join(str(n) for n in self.numbers()) or 'none yet'))
        kept = self.keep(f'kept before going back to version {number}') if self.changed() else None
        parent = os.path.dirname(self.folder)
        staged = tempfile.mkdtemp(prefix='.squire-version-', dir=parent)
        old = os.path.join(staged, 'was')
        try:
            shutil.copytree(self.copy_of(number), os.path.join(staged, 'now'), symlinks=True)
            os.rename(self.folder, old)
            try:
                os.rename(os.path.join(staged, 'now'), self.folder)
            except OSError:
                os.rename(old, self.folder)
                raise
        finally:
            shutil.rmtree(staged, ignore_errors=True)
        self.record['current'] = number
        self.write()
        return kept


def same_tree(a, b):
    """True when two folders hold the same names, the same kinds of entry,
    the same bytes and the same link targets, all the way down."""
    try:
        names_a, names_b = sorted(os.listdir(a)), sorted(os.listdir(b))
    except OSError:
        return False
    if names_a != names_b:
        return False
    for name in names_a:
        pa, pb = os.path.join(a, name), os.path.join(b, name)
        if os.path.islink(pa) or os.path.islink(pb):
            if not (os.path.islink(pa) and os.path.islink(pb)) or os.readlink(pa) != os.readlink(pb):
                return False
        elif os.path.isdir(pa) or os.path.isdir(pb):
            if not (os.path.isdir(pa) and os.path.isdir(pb)) or not same_tree(pa, pb):
                return False
        elif not (os.path.isfile(pa) and os.path.isfile(pb)) or not filecmp.cmp(pa, pb, shallow=False):
            return False
    return True


def run(config, argv):
    """What the command says, in one or more lines."""
    if len(argv) == 2 and argv[0] in ('keep', 'list'):
        verb, folder = argv
    elif len(argv) == 3 and argv[0] == 'back':
        verb, folder, number = argv
    else:
        raise Refused(USAGE)
    versions = Versions(config.home, folder)
    if verb == 'keep':
        return f'Kept version {versions.keep("kept")} of {versions.folder}, on this Mac.'
    if verb == 'list':
        if not versions.record['versions']:
            return f'No versions of {versions.folder} are kept yet.'
        lines = []
        for v in versions.record['versions']:
            when = time.strftime('%Y-%m-%d %H:%M', time.localtime(v.get('at', 0)))
            now = ' (the folder is as this version)' if v['number'] == versions.record.get('current') else ''
            lines.append(f'{v["number"]}  {when}  {v.get("why", "kept")}{now}')
        return '\n'.join(lines)
    if not number.isdigit() or not number.isascii():
        raise Refused(f'{number} is not a version number')
    kept = versions.back(int(number))
    first = f'Kept the changes since the last keep as version {kept}, then ' if kept else ''
    return f'{first}{"p" if kept else "P"}ut {versions.folder} back as it was at version {int(number)}.'


def main(argv):
    try:
        print(run(Config(), argv))
        return 0
    except Refused as e:
        sys.stderr.write(f'Squire did not change any versions: {e}.\n')
        return 1
    except SquireError as e:
        sys.stderr.write(f'Squire did not change any versions: {e}.\n')
        return 2
    except Exception as e:
        sys.stderr.write(f'Squire did not change any versions: the command failed ({type(e).__name__}).\n')
        return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
