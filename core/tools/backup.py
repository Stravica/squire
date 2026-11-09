"""Squire's nightly backup, run by its own launchd agent at 02:30.

    /usr/bin/python3 -B backup.py

Backs the owner's folder (ownerFolder in the Squire home's squire.json) up
into backupFolder (the iCloud Drive folder "Squire Backup" by default). The
backup holds current/, the owner's folder as at the last run, and
archive/<run time>/: a file removed from the owner's folder, and a changed
file's earlier copy, move there. Nothing in the backup is ever deleted or
overwritten. Links are copied as links, never followed.

A destination that is absent, not writable or full, or an owner's folder
that cannot be listed, is a failed run: nothing is counted done, the job
exits 1, and backup.json in the Squire home records the failure for the
health check; the next run tries again in full. A file it cannot read, or
one that changes while it is copied, is named in backup.json's notCopied and
current/ keeps its last copy of it; the run still passes.
"""

import errno
import fcntl
import json
import os
import stat
import sys
import tempfile
import time

CORE = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))


class BackupFailed(Exception):
    pass


class Backup:
    FULL = {errno.EFBIG, errno.ENOSPC, errno.EDQUOT}
    PARTIAL = '.squire-partial-'

    def __init__(self, config):
        self.config = config
        self.home = config.home
        self.owner = config.owner_folder
        self.destination = config.data.get('backupFolder')
        self.not_copied = []
        self.archive = None
        self.run_name = time.strftime('%Y-%m-%dT%H%M%SZ', time.gmtime())

    @staticmethod
    def main():
        sys.path.insert(0, os.path.join(CORE, 'lib'))
        from squire import Config, Paths, SquireError

        try:
            config = Config()
        except SquireError as e:
            sys.stderr.write(f'backup could not run: {e}.\n')
            return 2
        try:
            lock = open(os.path.join(config.home, 'backup.lock'), 'a')
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            sys.stderr.write('backup: another backup is running, or its lock cannot be taken; this run did nothing.\n')
            return 1
        backup = Backup(config)
        try:
            backup.check(Paths)
            backup.run()
        except BackupFailed as e:
            backup.record('failed', str(e))
            sys.stderr.write(f'backup failed: {e}.\n')
            return 1
        backup.record('passed', '')
        return 0

    def why(self, e, where):
        if e.errno in self.FULL:
            return f'the destination is full ({where})'
        if e.errno in (errno.EACCES, errno.EPERM, errno.EROFS):
            return f'the destination is not writable ({where})'
        if e.errno == errno.ENOENT:
            return f'the destination is absent ({where})'
        return f'the destination failed ({e.strerror or type(e).__name__}: {where})'

    def check(self, paths):
        """The destination and the owner's folder, before anything is copied."""
        destination = self.destination
        if not isinstance(destination, str) or not os.path.isabs(destination):
            raise BackupFailed('backupFolder in the Squire home\'s squire.json is not an absolute path')
        for other, name in ((self.owner, 'the owner\'s folder'), (self.home, 'the Squire home')):
            if paths.overlap(os.path.realpath(destination), os.path.realpath(other)):
                raise BackupFailed(f'the backup folder {destination} overlaps {name}')
        if os.path.islink(destination) or (os.path.lexists(destination) and not os.path.isdir(destination)):
            raise BackupFailed(f'the destination {destination} is not a folder')
        if not os.path.isdir(destination):
            if not os.path.isdir(os.path.dirname(destination)):
                raise BackupFailed(f'the destination {destination} is absent (its folder {os.path.dirname(destination)} '
                                   'is not there)')
            try:
                os.mkdir(destination, 0o700)
            except OSError as e:
                raise BackupFailed(self.why(e, destination))
        try:
            os.listdir(self.owner)
        except OSError as e:
            raise BackupFailed(f'the owner\'s folder {self.owner} cannot be listed ({e.strerror or type(e).__name__})')
        self.current = os.path.join(destination, 'current')
        try:
            os.makedirs(self.current, mode=0o700, exist_ok=True)
        except OSError as e:
            raise BackupFailed(self.why(e, self.current))
        self.clean(self.current)

    def clean(self, folder):
        """Half-written copies left by a run that was stopped."""
        for parent, dirs, files in os.walk(folder):
            for name in files:
                if name.startswith(self.PARTIAL):
                    try:
                        os.unlink(os.path.join(parent, name))
                    except OSError:
                        pass

    def run(self):
        self.copy_tree(self.owner, self.current, '')

    def archive_for(self, rel):
        """The place in this run's archive folder for rel, made when first used."""
        if self.archive is None:
            base = os.path.join(self.destination, 'archive')
            os.makedirs(base, mode=0o700, exist_ok=True)
            name, n = self.run_name, 1
            while True:
                try:
                    os.mkdir(os.path.join(base, name), 0o700)
                    break
                except FileExistsError:
                    n += 1
                    name = f'{self.run_name}-{n}'
            self.archive = os.path.join(base, name)
        target = os.path.join(self.archive, rel)
        os.makedirs(os.path.dirname(target), mode=0o700, exist_ok=True)
        return target

    def keep(self, current, rel):
        """Moves current's copy of rel into the archive."""
        try:
            os.rename(current, self.archive_for(rel))
        except OSError as e:
            raise BackupFailed(self.why(e, current))

    def copy_tree(self, source, target, rel):
        try:
            names = sorted(os.listdir(source))
        except OSError:
            if rel:
                self.not_copied.append(rel)
                return
            raise BackupFailed(f'the owner\'s folder {source} cannot be listed')
        try:
            os.makedirs(target, mode=0o700, exist_ok=True)
            present = set(os.listdir(target))
        except OSError as e:
            raise BackupFailed(self.why(e, target))
        for name in names:
            self.copy_entry(os.path.join(source, name), os.path.join(target, name), os.path.join(rel, name) if rel else name)
        for name in sorted(present - set(names)):
            if not name.startswith(self.PARTIAL):
                self.keep(os.path.join(target, name), os.path.join(rel, name) if rel else name)

    def copy_entry(self, source, target, rel):
        try:
            st = os.lstat(source)
        except OSError:
            self.not_copied.append(rel)
            return
        try:
            there = os.lstat(target)
        except FileNotFoundError:
            there = None
        except OSError as e:
            raise BackupFailed(self.why(e, target))
        if stat.S_ISDIR(st.st_mode):
            if there is not None and not stat.S_ISDIR(there.st_mode):
                self.keep(target, rel)
            self.copy_tree(source, target, rel)
        elif stat.S_ISLNK(st.st_mode):
            try:
                link = os.readlink(source)
            except OSError:
                self.not_copied.append(rel)
                return
            if there is not None and stat.S_ISLNK(there.st_mode) and os.readlink(target) == link:
                return
            if there is not None:
                self.keep(target, rel)
            try:
                os.symlink(link, target)
            except OSError as e:
                raise BackupFailed(self.why(e, target))
        elif stat.S_ISREG(st.st_mode):
            if there is not None and stat.S_ISREG(there.st_mode) and there.st_size == st.st_size \
                    and there.st_mtime_ns == st.st_mtime_ns and stat.S_IMODE(there.st_mode) == stat.S_IMODE(st.st_mode):
                return
            self.copy_file(source, target, rel, st, there)
        else:
            self.not_copied.append(rel)

    def copy_file(self, source, target, rel, st, there):
        """Copies through a partial file beside the target. A read that fails,
        or a source that changed while it was read, is not copied; a write
        that fails fails the run."""
        try:
            src = os.open(source, os.O_RDONLY | os.O_NOFOLLOW)
        except OSError:
            self.not_copied.append(rel)
            return
        try:
            out, tmp = tempfile.mkstemp(prefix=self.PARTIAL, dir=os.path.dirname(target))
        except OSError as e:
            os.close(src)
            raise BackupFailed(self.why(e, os.path.dirname(target)))
        copied = False
        try:
            copied = self.pour(src, out, target)
            if copied:
                now = os.fstat(src)
                copied = (now.st_size, now.st_mtime_ns, now.st_ino) == (st.st_size, st.st_mtime_ns, st.st_ino)
            if copied:
                os.fchmod(out, stat.S_IMODE(st.st_mode))
                os.utime(tmp, ns=(st.st_atime_ns, st.st_mtime_ns))
        except OSError as e:
            os.close(src)
            os.close(out)
            self.discard(tmp)
            raise BackupFailed(self.why(e, target))
        except BackupFailed:
            os.close(src)
            os.close(out)
            self.discard(tmp)
            raise
        os.close(src)
        try:
            os.close(out)
        except OSError as e:
            self.discard(tmp)
            raise BackupFailed(self.why(e, target))
        if not copied:
            self.discard(tmp)
            self.not_copied.append(rel)
            return
        if there is not None:
            self.keep(target, rel)
        try:
            os.rename(tmp, target)
        except OSError as e:
            self.discard(tmp)
            raise BackupFailed(self.why(e, target))

    def pour(self, src, out, target):
        """Every byte of src into out: False when a read fails."""
        while True:
            try:
                chunk = os.read(src, 1 << 16)
            except OSError:
                return False
            if not chunk:
                return True
            view = memoryview(chunk)
            while view:
                try:
                    written = os.write(out, view)
                except OSError as e:
                    raise BackupFailed(self.why(e, target))
                view = view[written:]

    @staticmethod
    def discard(path):
        try:
            os.unlink(path)
        except OSError:
            pass

    def record(self, result, reason):
        data = {'lastRun': {'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'result': result,
                            'destination': self.destination, 'reason': reason, 'notCopied': self.not_copied}}
        try:
            fd, tmp = tempfile.mkstemp(prefix='.backup-', dir=self.home)
            with os.fdopen(fd, 'w', encoding='utf-8') as f:
                json.dump(data, f, indent=2)
                f.write('\n')
            os.chmod(tmp, 0o600)
            os.replace(tmp, os.path.join(self.home, 'backup.json'))
        except OSError as e:
            sys.stderr.write(f'backup: its record could not be written ({e.strerror}).\n')


if __name__ == '__main__':
    try:
        code = Backup.main()
    except Exception as e:
        sys.stderr.write(f'backup failed ({type(e).__name__}).\n')
        code = 1
    sys.exit(code)
