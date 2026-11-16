"""Squire's memory import: the owner's notes, documents or another assistant's
memory export, taken into Squire's memory on the Mac. The session runs it
only as this one command, on the owner's yes (the safety floor asks first,
naming every source):

    /usr/bin/python3 '<Squire home>/core/tools/import-memory.py' <path> [<path> ...]

Each file given, and every file in each folder given (its tree kept), is
copied byte for byte into a new folder of its own in
workspace/inbox/imported in the owner's folder, named by the time of the
import; nothing there is ever overwritten. The sources are left as they are,
and nothing is sent anywhere: the import reads files and writes files, on
the Mac. The safety floor reads everything in workspace/inbox as untrusted,
so a job that reads what was taken in holds untrusted input.

A name Claude Code or Squire would load by itself is never made: a file
named CLAUDE.md, CLAUDE.local.md, .mcp.json or a settings*.json (named in any
case) is kept by its content under that name with .imported.txt added; a
hidden file or folder (a .claude folder among them) is kept without its dot,
as dot-<name>. Nothing is written among the handover notes in state/handover.

Links and anything that is not a plain file or folder are skipped and named,
as is a file that cannot be read; the rest is still taken in. A source in
Squire's home or in the owner's own folder is refused. It prints how many
files it took in and where, never what they say. Exit 0 when everything was
taken in, 1 when anything was skipped or refused, 2 when it could not run.

Standard library only; run by /usr/bin/python3.
"""

import datetime
import os
import re
import secrets
import shutil
import stat
import sys

CORE = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
sys.path.insert(0, os.path.join(CORE, 'lib'))

from squire import Config, Paths, SquireError  # noqa: E402

LANDING = os.path.join('workspace', 'inbox', 'imported')
LOADED = re.compile(r'^(claude(\.local)?\.md|\.mcp\.json|settings[^/]*\.json)$')


def kept_name(name):
    """The name a file or folder is kept under: a hidden one without its dot,
    a name Claude Code or Squire loads by itself with .imported.txt added."""
    if name.startswith('.'):
        name = 'dot-' + name.lstrip('.')
    if LOADED.match(Paths.fold(name)):
        name += '.imported.txt'
    return name or 'unnamed'


class Import:
    """One import into one new folder in workspace/inbox/imported."""

    def __init__(self, config):
        self.config = config
        self.owner = config.owner_folder
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        self.rel = os.path.join(LANDING, f'{stamp}-{secrets.token_hex(3)}')
        self.folder = os.path.join(self.owner, self.rel)
        self.taken = 0
        self.skipped = []

    def refused(self, source):
        """Why a source given is refused, or None."""
        real = os.path.realpath(source)
        for place, what in ((self.config.home, 'Squire\'s own files'), (self.owner, 'your Squire folder')):
            if Paths.overlap(real, os.path.realpath(place)):
                return f'{source}: it is in {what}, so it is not taken in again'
        return None

    def run(self, sources):
        os.makedirs(self.folder, mode=0o700)
        for source in sources:
            why = self.refused(source)
            if why:
                self.skipped.append(why)
                continue
            name = kept_name(os.path.basename(os.path.normpath(source)))
            self.take(source, os.path.join(self.folder, name))

    def take(self, source, target):
        """Copies a file, or a folder's tree, to target; skips the rest."""
        try:
            st = os.lstat(source)
        except OSError:
            self.skipped.append(f'{source}: it could not be found')
            return
        if stat.S_ISLNK(st.st_mode):
            self.skipped.append(f'{source}: it is a link, so it was left out')
        elif stat.S_ISDIR(st.st_mode):
            try:
                names = sorted(os.listdir(source))
            except OSError:
                self.skipped.append(f'{source}: the folder could not be read')
                return
            os.makedirs(target, mode=0o700, exist_ok=True)
            for name in names:
                self.take(os.path.join(source, name), os.path.join(target, kept_name(name)))
        elif stat.S_ISREG(st.st_mode):
            if os.path.lexists(target):
                self.skipped.append(f'{source}: another file in this import already has its name, so it was left out')
                return
            try:
                with open(source, 'rb') as src:
                    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                    with os.fdopen(fd, 'wb') as dst:
                        shutil.copyfileobj(src, dst)
            except OSError:
                self.skipped.append(f'{source}: it could not be read')
                return
            self.taken += 1
        else:
            self.skipped.append(f'{source}: it is not a plain file or folder, so it was left out')


def main(argv):
    if not argv:
        sys.stderr.write('Give the files or folders to take in: import-memory.py <path> [<path> ...]\n')
        return 2
    try:
        job = Import(Config())
        job.run(argv)
    except SquireError as e:
        sys.stderr.write(f'Squire\'s import could not run: {e}.\n')
        return 2
    except OSError as e:
        sys.stderr.write(f'Squire\'s import could not write its folder ({e.strerror or type(e).__name__}).\n')
        return 2
    files = '1 file' if job.taken == 1 else f'{job.taken} files'
    print(f'Squire took {files} into its memory, kept on this Mac in {job.rel} in your Squire folder. '
          'Squire reads them as words from elsewhere, never as your own instructions.')
    for why in job.skipped:
        print(f'Left out: {why}')
    return 1 if job.skipped else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
