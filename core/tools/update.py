"""Squire's updates: signed releases only, kept two deep, installed only from
Squire Update at the Mac, outside every agent and the session, rolled back by
themselves when the check after an install fails, and settled on one whole,
checked version when an install does not finish.

    /usr/bin/python3 -B update.py --app [--recover]
        Squire Update, as the owner opens it (its launcher in the Applications
        folder of the owner's home runs this): an unfinished install settled
        first, then the staged release checked again and shown, its version
        and changelog as the signed manifest holds them, installed only on
        Install; opened by Squire with --recover, it settles and ends
    /usr/bin/python3 -B update.py --app-install <version> <manifest digest>
        Squire Update's engine, started by its window in a session of its
        own: installs the staged release whose manifest has that SHA-256,
        held to its end
    /usr/bin/python3 -B update.py --recover
        an install that did not finish (install.json present, its lock free),
        settled: Squire stays on the new release when it is whole and checks,
        and lays the previous one down otherwise

The weekly check runs inside the scheduler's tick (wake-up.py --due), which
reads this file for it. Everything an update writes is in the Squire home
(staging/, releases/, current-release.json, update.json, install.json) and,
for the agents, Library/LaunchAgents; the owner's folder only gains the
approvals ledger's use of the owner's yes.
"""

import calendar
import fcntl
import hashlib
import http.client
import importlib.util
import io
import json
import os
import re
import shutil
import signal
import ssl
import subprocess
import sys
import tarfile
import tempfile
import time
import unicodedata
import zlib
from urllib.parse import urlsplit

CORE = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
PYTHON = '/usr/bin/python3'
sys.path.insert(0, os.path.join(CORE, 'lib'))

from squire import Config, Ledger, Paths, Process, Records, SquireError, System, Version  # noqa: E402


class Refused(Exception):
    """A release the check refuses, as one plain category."""


class Releases:
    """The releases a Squire home knows: the installed core's release.json
    (its version and addresses) and key, current-release.json, the kept
    releases under releases/ and the staged one under staging/; and the check
    a release must pass, fail closed: its archive's listing, its signature
    with the installed key, its manifest's four fields, its files against
    the manifest's digests, and its own release.json naming the manifest's
    version."""

    NAMESPACE = 'squire-release'
    VERIFY_WITHIN = 30
    FIELDS = {'version', 'files', 'changelog', 'claudeCodeTested'}
    DIGEST = re.compile(r'^[0-9a-f]{64}$')
    MAX_BYTES = 50 * 1024 * 1024
    MAX_ENTRIES = 2000
    TOP = ('manifest.json', 'manifest.json.sig')

    def __init__(self, home):
        self.home = home
        self.core = os.path.join(home, 'core')
        self.key = os.path.join(self.core, 'release-key.pub')
        self.staging = os.path.join(home, 'staging')
        self.kept = os.path.join(home, 'releases')
        self.app_release = os.path.join(home, 'release', 'core')
        self.current_file = os.path.join(home, 'current-release.json')
        self.update_file = os.path.join(home, 'update.json')

    def config(self):
        data = Records.read(os.path.join(self.core, 'release.json'))
        return data if isinstance(data, dict) else {}

    def current(self):
        data = Records.read(self.current_file)
        return data if isinstance(data, dict) and Version.of(data.get('current')) else None

    def installed(self):
        """The installed version: current-release.json first, then the
        installed core's release.json."""
        record = self.current()
        if record:
            return record['current']
        version = self.config().get('version')
        return version if Version.of(version) else None

    def record(self):
        data = Records.read(self.update_file)
        return data if isinstance(data, dict) else {}

    def note(self, **fields):
        """update.json with these fields changed, the rest kept."""
        record = self.record()
        for key in ('version', 'reason'):
            if 'outcome' in fields:
                record.pop(key, None)
        record.update({k: v for k, v in fields.items() if v is not None})
        Records.write(self.update_file, record)

    def staged(self):
        """The newest version waiting in staging/, or None."""
        try:
            names = [n for n in os.listdir(self.staging) if Version.of(n) and os.path.isdir(os.path.join(self.staging, n))]
        except OSError:
            return None
        return max(names, key=Version.of) if names else None

    @staticmethod
    def plain(address, folder=False):
        """An https address, or http on 127.0.0.1, with no user, password,
        query or fragment (and, for a folder, ending in a slash)."""
        if not isinstance(address, str):
            return False
        try:
            parts = urlsplit(address)
            parts.port
        except ValueError:
            return False
        if '@' in parts.netloc or parts.query or parts.fragment or '?' in address or '#' in address:
            return False
        if parts.scheme == 'https':
            plain = bool(parts.hostname)
        elif parts.scheme == 'http':
            plain = parts.hostname == '127.0.0.1'
        else:
            return False
        return plain and (parts.path.endswith('/') if folder else bool(parts.path))

    @staticmethod
    def digests(root):
        """Every file under root, by its path relative to root, to its SHA-256."""
        found = {}
        for folder, dirs, files in os.walk(root):
            dirs.sort()
            for name in sorted(files):
                path = os.path.join(folder, name)
                try:
                    with open(path, 'rb') as f:
                        found[os.path.relpath(path, root)] = hashlib.sha256(f.read()).hexdigest()
                except OSError:
                    found[os.path.relpath(path, root)] = None
        return found

    # ------------------------------------------------------------ the check

    def unpack(self, archive, into):
        """Checks the archive on its listing, then extracts its files into the
        new folder into; nothing is extracted from an archive the listing
        refuses."""
        try:
            with open(archive, 'rb') as f:
                raw = f.read(self.MAX_BYTES + 1)
        except OSError:
            raise Refused('its archive cannot be read')
        if len(raw) > self.MAX_BYTES:
            raise Refused('its archive is too large')
        inflate = zlib.decompressobj(wbits=31)
        try:
            data = inflate.decompress(raw, self.MAX_BYTES + 1)
        except zlib.error:
            raise Refused('its archive does not unpack')
        if len(data) > self.MAX_BYTES or inflate.unconsumed_tail:
            raise Refused('its archive is too large')
        if not inflate.eof:
            raise Refused('its archive does not unpack')
        if inflate.unused_data:
            raise Refused('its archive holds bytes after its end')
        try:
            tar = tarfile.open(fileobj=io.BytesIO(data), mode='r:')
            members = tar.getmembers()
        except (tarfile.TarError, EOFError, OSError, ValueError, UnicodeError):
            raise Refused('its archive does not unpack')
        self.listing(members)
        os.makedirs(into, mode=0o700)
        for member in members:
            target = os.path.join(into, *member.name.split('/'))
            if member.isdir():
                os.makedirs(target, mode=0o755, exist_ok=True)
                continue
            os.makedirs(os.path.dirname(target), mode=0o755, exist_ok=True)
            source = tar.extractfile(member)
            with open(target, 'xb') as f:
                shutil.copyfileobj(source, f)
            os.chmod(target, 0o644)

    def listing(self, members):
        """Only core/, manifest.json and manifest.json.sig, each entry a plain
        file or folder at one plain path inside the archive, unique once case
        is folded and Unicode normalised, every folder the parent of a file."""
        if len(members) > self.MAX_ENTRIES:
            raise Refused('its archive holds too many entries')
        if sum(m.size for m in members if m.isreg()) > self.MAX_BYTES:
            raise Refused('its archive is too large')
        seen, files, folders = set(), [], []
        for member in members:
            name = member.name
            if not (member.isreg() or member.isdir()):
                raise Refused('its archive holds an entry that is not a plain file or folder')
            parts = name.split('/')
            if name.startswith('/') or any(p in ('', '.', '..') for p in parts):
                raise Refused('its archive holds a path that leaves it')
            if any(p.startswith('._') for p in parts):
                raise Refused('its archive holds an AppleDouble entry')
            if member.isdir():
                inside = parts[0] == 'core'
            else:
                inside = name in self.TOP or (parts[0] == 'core' and len(parts) > 1)
            if not inside:
                raise Refused('its archive holds an entry outside core/, manifest.json and manifest.json.sig')
            key = Paths.fold(unicodedata.normalize('NFC', name))
            if key in seen:
                raise Refused('its archive holds two entries at one path')
            seen.add(key)
            (folders if member.isdir() else files).append(name)
        for folder in folders:
            if not any(f.startswith(folder + '/') for f in files):
                raise Refused('its archive holds a folder with no file in it')
        if 'manifest.json' not in files:
            raise Refused('its archive holds no manifest')

    def verify(self, folder, key, work):
        """True when ssh-keygen -Y verify passes the folder's manifest.json
        against manifest.json.sig with this key alone, bounded."""
        sig = os.path.join(folder, 'manifest.json.sig')
        try:
            with open(key, encoding='utf-8') as f:
                words = f.read().split()
            with open(os.path.join(folder, 'manifest.json'), 'rb') as f:
                manifest = f.read()
        except (OSError, UnicodeDecodeError):
            return False
        if len(words) < 2 or not os.path.isfile(sig):
            return False
        os.makedirs(work, mode=0o700, exist_ok=True)
        scratch = tempfile.mkdtemp(prefix='.verify-', dir=work)
        try:
            allowed = os.path.join(scratch, 'allowed_signers')
            with open(allowed, 'w', encoding='utf-8') as f:
                f.write(f'{self.NAMESPACE} namespaces="{self.NAMESPACE}" {words[0]} {words[1]}\n')
            r = subprocess.run([System.command('/usr/bin/ssh-keygen'), '-Y', 'verify', '-f', allowed, '-I', self.NAMESPACE,
                                '-n', self.NAMESPACE, '-s', sig], input=manifest, cwd='/', env=System.env(),
                               capture_output=True, timeout=self.VERIFY_WITHIN)
            return r.returncode == 0
        except (OSError, subprocess.SubprocessError, ValueError):
            return False
        finally:
            shutil.rmtree(scratch, ignore_errors=True)

    @staticmethod
    def floor_files():
        """The floor files the installed core's lay-down records the digests
        of (LayDown.FLOOR_FILES), each of which a release must carry."""
        try:
            spec = importlib.util.spec_from_file_location('squire_lay_down', os.path.join(CORE, 'tools', 'lay-down.py'))
            lay_down = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(lay_down)
            return tuple(lay_down.LayDown.FLOOR_FILES)
        except Exception:
            raise Refused('its floor files cannot be checked')

    def manifest(self, data, version=None):
        """The manifest's four fields, each of its type, listing every floor
        file; refused otherwise."""
        try:
            manifest = json.loads(data.decode('utf-8'))
        except (UnicodeDecodeError, ValueError):
            raise Refused('its manifest cannot be read')
        if not isinstance(manifest, dict) or set(manifest) != self.FIELDS:
            raise Refused('its manifest cannot be read')
        if not Version.of(manifest['version']) or not Version.of(manifest['claudeCodeTested']):
            raise Refused('its version is not a version')
        if version is not None and manifest['version'] != version:
            raise Refused('its manifest names another version')
        files = manifest['files']
        if not isinstance(files, dict) or not files:
            raise Refused('its manifest cannot be read')
        seen = set()
        for rel, digest in files.items():
            plain = unicodedata.normalize('NFC', rel) == rel and not rel.startswith('/') \
                and all(p not in ('', '.', '..') for p in rel.split('/'))
            if not plain or not isinstance(digest, str) or not self.DIGEST.match(digest) or Paths.fold(rel) in seen:
                raise Refused('its manifest cannot be read')
            seen.add(Paths.fold(rel))
        if any(rel not in files for rel in self.floor_files()):
            raise Refused('it is missing a floor file')
        changelog = manifest['changelog']
        if not isinstance(changelog, str) or not 1 <= len(changelog) <= 4000 \
                or any(unicodedata.category(c) == 'Cc' and c != '\n' for c in changelog) \
                or any(line.strip().startswith('```') for line in changelog.split('\n')):
            raise Refused('its changelog cannot be shown')
        return manifest

    def check(self, folder, key, version=None, work=None):
        """A release folder (core/, manifest.json, manifest.json.sig) checked
        whole: (manifest, its bytes); refused otherwise."""
        if not self.verify(folder, key, work or self.home):
            raise Refused('its signature does not check with the key Squire trusts')
        try:
            with open(os.path.join(folder, 'manifest.json'), 'rb') as f:
                data = f.read()
        except OSError:
            raise Refused('its manifest cannot be read')
        manifest = self.manifest(data, version)
        if self.digests(os.path.join(folder, 'core')) != manifest['files']:
            raise Refused('its files do not match its manifest')
        own = Records.read(os.path.join(folder, 'core', 'release.json'))
        own = own.get('version') if isinstance(own, dict) else None
        if not Version.of(own):
            raise Refused('the version its release.json names is not a version')
        if own != manifest['version']:
            raise Refused('its release.json names another version than its manifest')
        return manifest, data


class Fetch:
    """One GET from the release host: no header but Host, no redirect
    followed, 30 seconds to connect and for each read, 10 minutes in all."""

    WITHIN = 30
    DOWNLOAD_WITHIN = 600
    FAILURES = (OSError, http.client.HTTPException, ValueError)

    @classmethod
    def get(cls, url, into=None, limit=65536):
        parts = urlsplit(url)
        if parts.scheme == 'https':
            conn = http.client.HTTPSConnection(parts.hostname, parts.port, timeout=cls.WITHIN,
                                               context=ssl.create_default_context())
        else:
            conn = http.client.HTTPConnection(parts.hostname, parts.port, timeout=cls.WITHIN)
        end = time.monotonic() + cls.DOWNLOAD_WITHIN
        try:
            conn.putrequest('GET', parts.path, skip_accept_encoding=True)
            conn.endheaders()
            answer = conn.getresponse()
            if answer.status != 200:
                raise OSError(f'the host answered {answer.status}')
            length = answer.getheader('Content-Length')
            chunks, got = [], 0
            while True:
                if time.monotonic() > end:
                    raise OSError('the download passed its bound')
                chunk = answer.read(65536)
                if not chunk:
                    break
                got += len(chunk)
                if got > limit:
                    raise OSError('the answer is too large')
                if into is None:
                    chunks.append(chunk)
                else:
                    into.write(chunk)
            if length is not None and got != int(length):
                raise OSError('the answer was cut short')
            return b''.join(chunks)
        finally:
            conn.close()


class HealthLines:
    """The health check's lines, run from the installed core, and the faults
    among them: the closed set that holds an update back and fails an
    install's check (floor, agents, sign-in, runner, release). A line the
    install cannot classify counts as a fault."""

    WITHIN = 120
    FAULTS = (('floor:', 'floor'), ('agents:', 'agents'), ('sign-in:', 'sign-in'), ('runner:', 'runner'),
              ('release:', 'release'), ('no session:', 'runner'))
    OTHERS = ('ignored:', 'moved:', 'backup:', 'compaction window:', 'cannot confirm the compaction window:', 'update:',
              'ticket:', 'fixed:', 'still:', 'could not try:', 'config:')

    @classmethod
    def run(cls, home):
        """The lines, or None when the check could not run."""
        try:
            r = subprocess.run([System.command(PYTHON), '-B', os.path.join(home, 'core', 'tools', 'health.py')], cwd='/',
                               env=System.env(home), stdin=subprocess.DEVNULL, capture_output=True, text=True,
                               timeout=cls.WITHIN)
        except (OSError, subprocess.SubprocessError):
            return None
        if r.returncode not in (0, 1):
            return None
        return [line.strip() for line in r.stdout.splitlines() if line.strip()]

    @staticmethod
    def read(config):
        """The installed health check's lines read in this process, the
        support ticket offers left out (the weekly check reads faults, it
        builds no ticket), or None when the check could not run."""
        try:
            spec = importlib.util.spec_from_file_location(
                'squire_health', os.path.join(config.home, 'core', 'tools', 'health.py'))
            health = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(health)
            return [line.strip() for line in health.HealthCheck.lines(config, offers=False) if line.strip()]
        except Exception:
            return None

    @classmethod
    def faults(cls, lines):
        codes = []
        for line in lines:
            code = next((c for prefix, c in cls.FAULTS if line.startswith(prefix)), None)
            if code is None and not line.startswith(cls.OTHERS):
                code = 'unknown'
            if code and code not in codes:
                codes.append(code)
        return codes


class WeeklyCheck:
    """The scheduler's weekly check: when update.json records no check in the
    last 7 days and the health check names no fault, latest.json is fetched
    from the release host; a newer release, other than one a rollback holds
    out, is downloaded into staging/, checked and staged, and one wake-up
    offers it with the request that asks for it."""

    WEEK = 7 * 86400
    ARCHIVE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]*\Z')

    def __init__(self, config, send):
        self.config = config
        self.home = config.home
        self.releases = Releases(config.home)
        self.send = send

    def due(self, now):
        last = self.releases.record().get('lastCheck')
        recent = isinstance(last, int) and not isinstance(last, bool) and last <= now and now - last < self.WEEK
        return not recent

    def run(self, now):
        now = int(now)
        if not self.releases.installed() or not self.due(now):
            return
        lines = HealthLines.read(self.config)
        if lines is None or HealthLines.faults(lines):
            return
        self.check(now)

    def check(self, now):
        releases = self.releases
        host = releases.config().get('releaseHost')
        if not Releases.plain(host, folder=True):
            return releases.note(lastCheck=now, outcome='could not check')
        try:
            served = Fetch.get(host + 'latest.json')
        except Fetch.FAILURES:
            return releases.note(lastCheck=now, outcome='could not check')
        # What the host served and the check cannot read is a refusal, never "could not check".
        try:
            latest = json.loads(served.decode('utf-8'))
        except (ValueError, RecursionError):
            latest = None
        if not isinstance(latest, dict):
            return releases.note(lastCheck=now, outcome='refused', reason='its latest.json cannot be read')
        version, archive = latest.get('version'), latest.get('archive')
        if not Version.of(version):
            # Nothing the release host served is kept: a value that is not a version is never recorded.
            return releases.note(lastCheck=now, outcome='refused', reason='its version is not a version')
        if not isinstance(archive, str) or not self.ARCHIVE.match(archive):
            return releases.note(lastCheck=now, outcome='refused', version=version,
                                 reason='its archive name is not a plain file name')
        installed = releases.installed()
        if Version.of(version) <= Version.of(installed):
            return releases.note(lastCheck=now, outcome='nothing newer')
        if version == releases.record().get('heldOut'):
            return releases.note(lastCheck=now, outcome='held out', version=version)
        if releases.staged() == version:
            releases.note(lastCheck=now, outcome='staged', version=version)
            return self.offer(version, now)
        os.makedirs(releases.staging, mode=0o700, exist_ok=True)
        fd, download = tempfile.mkstemp(prefix='.download-', dir=releases.staging)
        unpacked = tempfile.mkdtemp(prefix='.unpack-', dir=releases.staging)
        os.rmdir(unpacked)
        try:
            try:
                with os.fdopen(fd, 'wb') as f:
                    Fetch.get(host + archive, into=f, limit=Releases.MAX_BYTES)
            except Fetch.FAILURES:
                return releases.note(lastCheck=now, outcome='could not check')
            try:
                releases.unpack(download, unpacked)
                releases.check(unpacked, releases.key, version, work=releases.staging)
            except (Refused, OSError) as e:
                reason = str(e) if isinstance(e, Refused) else 'its archive does not unpack'
                return releases.note(lastCheck=now, outcome='refused', version=version, reason=reason)
            for name in os.listdir(releases.staging):
                if Version.of(name):
                    shutil.rmtree(os.path.join(releases.staging, name), ignore_errors=True)
            os.rename(unpacked, os.path.join(releases.staging, version))
        finally:
            for leftover in (download, unpacked):
                if os.path.isdir(leftover):
                    shutil.rmtree(leftover, ignore_errors=True)
                elif os.path.lexists(leftover):
                    os.unlink(leftover)
        releases.note(lastCheck=now, outcome='staged', version=version)
        self.offer(version, now)

    def offer(self, version, now):
        request = f'{PYTHON} {os.path.join(self.home, "core", "tools", "update.py")} --install {version}'
        self.send(f'Squire release {version} is ready to install. To install it, ask: {request}',
                  f'update-{version}-{now}')


class Install:
    """The scheduler's install, from the installed (previous) release's own
    code, under an exclusive lock on install.lock held for its whole life.
    install.json names the two versions, this process and the step reached,
    written durably before each step: record, keep, stop, lay, switch,
    reload, check, clear. A failed check rolls the previous release back."""

    STEPS = ('record', 'keep', 'stop', 'lay', 'switch', 'reload', 'check', 'clear')
    FRESH = 1800
    RUNNER_WITHIN = 30
    SESSION_WITHIN = 120
    LAY_DOWN_WITHIN = 300
    LAUNCHCTL_WITHIN = 30
    AGENTS = ('com.stravica.squire.runner', 'com.stravica.squire.wake-ups', 'com.stravica.squire.backup')

    def __init__(self, config):
        self.config = config
        self.home = config.home
        self.releases = Releases(config.home)
        self.record_file = os.path.join(self.home, 'install.json')
        self.lock_file = os.path.join(self.home, 'install.lock')
        self.started = None
        self.stopped = []
        # The router is this release's own, read now: the core is replaced under this process.
        spec = importlib.util.spec_from_file_location('squire_wake_up', os.path.join(CORE, 'tools', 'wake-up.py'))
        self.router_module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.router_module)
        self.router = self.router_module.WakeUpRouter(config)

    # ------------------------------------------------------------ outside

    @staticmethod
    def lock_free(home):
        """True when no install holds install.lock (tried and let go at once)."""
        try:
            fd = os.open(os.path.join(home, 'install.lock'), os.O_RDONLY)
        except OSError:
            return True
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            return False
        finally:
            os.close(fd)
        return True

    @classmethod
    def unfinished(cls, home):
        return os.path.lexists(os.path.join(home, 'install.json')) and cls.lock_free(home)

    @classmethod
    def pending(cls, config, now):
        """True when the ledger holds the owner's fresh yes, not yet used, to
        install the staged version. One read under a shared lock."""
        version = Releases(config.home).staged()
        if not version:
            return False
        return bool([1 for request, answer in Ledger.yeses_in(config.ledger_path, 'update:')
                     if request['item'].split(':')[1:2] == [version] and cls.fresh(answer, now)])

    @classmethod
    def fresh(cls, answer, now):
        at = answer.get('at')
        return isinstance(at, (int, float)) and not isinstance(at, bool) and at <= now and now - at < cls.FRESH

    def lock(self):
        fd = os.open(self.lock_file, os.O_RDWR | os.O_CREAT, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            os.close(fd)
            return None
        return fd

    def send(self, text, kind):
        now = time.time()
        state = {'id': f'{kind}-{int(now * 1000)}-{os.urandom(3).hex()}', 'text': text, 'session': None, 'attempts': [],
                 'state': 'retrying'}
        try:
            self.router.attempt(state, now)
        except SquireError:
            pass

    # ------------------------------------------------------------- perform

    def perform(self):
        if self.lock() is None:
            return 0
        if os.path.lexists(self.record_file):
            return Recovery(self).settle()
        version = self.releases.staged()
        if not version:
            return 0
        digest = self.approved(version, time.time())
        if digest is None:
            return 0
        folder = os.path.join(self.releases.staging, version)
        try:
            manifest, data = self.releases.check(folder, self.releases.key, version, work=self.releases.staging)
        except Refused as e:
            shutil.rmtree(folder, ignore_errors=True)
            self.releases.note(outcome='refused', version=version, reason=str(e))
            return 1
        if hashlib.sha256(data).hexdigest() != digest:
            return 0
        return self.install(version, manifest)

    def approved(self, version, now):
        """The owner's fresh yes, not yet used, to install this version:
        marked used under the ledger's lock, and the staged manifest's digest
        its request recorded returned; None when there is none."""
        try:
            with Ledger(self.config.ledger_path) as ledger:
                for request, answer in ledger.yeses('update:'):
                    parts = request['item'].split(':')
                    if len(parts) != 3 or parts[1] != version or not self.fresh(answer, now):
                        continue
                    ledger.append({'type': 'use', 'request': request['id'], 'at': int(now)})
                    return parts[2]
        except SquireError:
            return None
        return None

    def install(self, version, manifest):
        releases = self.releases
        previous = releases.installed()
        if not previous:
            return 1
        before = releases.current()
        self.started = self.start_time()
        try:
            self.step(previous, version, 'record')
            self.step(previous, version, 'keep')
            self.keep(version, manifest)
            previous_files = self.keep_previous(previous)
        except (OSError, Refused):
            self.remove_record()
            return 1
        shutil.rmtree(os.path.join(releases.staging, version), ignore_errors=True)
        self.step(previous, version, 'stop')
        self.stop()
        self.step(previous, version, 'lay')
        laid = self.lay(os.path.join(releases.kept, version, 'core'))
        if laid:
            self.step(previous, version, 'switch')
            Records.write(releases.current_file, {'current': version, 'previous': previous, 'verified': True}, durable=True)
            self.step(previous, version, 'reload')
            self.reload()
            self.step(previous, version, 'check')
        if laid and self.check(manifest['files']):
            self.step(previous, version, 'clear')
            self.clear(version, previous)
            self.send(f'Squire is updated to {version}; all checks passed', 'update')
            self.remove_record()
            return 0
        self.rollback(version, previous, before, previous_files)
        return 1

    def start_time(self):
        started = Process.started_at(os.getpid())
        try:
            return calendar.timegm(time.strptime(started, '%Y-%m-%dT%H:%M:%SZ'))
        except (TypeError, ValueError):
            return int(time.time())

    def step(self, previous, version, step):
        Records.write(self.record_file, {'previous': previous, 'next': version, 'pid': os.getpid(),
                                         'started': self.started, 'step': step}, durable=True)

    def remove_record(self):
        try:
            os.unlink(self.record_file)
            Records.sync_folder(self.home)
        except OSError:
            pass

    def keep(self, version, manifest):
        """The staged release copied whole into releases/<version>/ under a
        temporary name, checked by digest, then renamed."""
        target = os.path.join(self.releases.kept, version)
        os.makedirs(self.releases.kept, mode=0o700, exist_ok=True)
        temp = tempfile.mkdtemp(prefix=f'.{version}-', dir=self.releases.kept)
        try:
            for name in ('core', 'manifest.json', 'manifest.json.sig'):
                source = os.path.join(self.releases.staging, version, name)
                if os.path.isdir(source):
                    shutil.copytree(source, os.path.join(temp, name))
                else:
                    shutil.copyfile(source, os.path.join(temp, name))
            if Releases.digests(os.path.join(temp, 'core')) != manifest['files']:
                raise Refused('its copy does not match its manifest')
            if os.path.lexists(target):
                shutil.rmtree(target)
            os.rename(temp, target)
        finally:
            shutil.rmtree(temp, ignore_errors=True)

    def keep_previous(self, previous):
        """The previous release's files: from releases/<previous>/, or, at the
        first update, the app's release set-up keeps (release/core), copied
        there as core/ alone, checked by digest."""
        target = os.path.join(self.releases.kept, previous)
        if os.path.isdir(os.path.join(target, 'core')):
            return self.files_of(previous)
        source = self.releases.app_release
        wanted = Releases.digests(source)
        if not wanted:
            raise Refused('the previous release is not kept')
        temp = tempfile.mkdtemp(prefix=f'.{previous}-', dir=self.releases.kept)
        try:
            shutil.copytree(source, os.path.join(temp, 'core'))
            if Releases.digests(os.path.join(temp, 'core')) != wanted:
                raise Refused('its copy does not match the release set-up kept')
            os.rename(temp, target)
        finally:
            shutil.rmtree(temp, ignore_errors=True)
        return wanted

    def files_of(self, version):
        """What a kept release's core must hold: its signed manifest's files,
        or, for the app's release (no manifest), the release set-up keeps."""
        manifest = Records.read(os.path.join(self.releases.kept, version, 'manifest.json'))
        if isinstance(manifest, dict) and isinstance(manifest.get('files'), dict):
            return manifest['files']
        return Releases.digests(self.releases.app_release)

    # ------------------------------------------------------- the steps

    def launchctl(self, *args):
        try:
            return subprocess.run([System.command('/bin/launchctl'), *args], cwd='/', env=System.env(),
                                  stdin=subprocess.DEVNULL, capture_output=True,
                                  timeout=self.LAUNCHCTL_WITHIN).returncode == 0
        except (OSError, subprocess.SubprocessError):
            return False

    def runner_running(self):
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

    def stop(self):
        """The agents booted out (the account's own home only), then the
        runner holding its lock and its server's process group ended, waiting
        at most 30 seconds for the lock to be free."""
        if System.own_home():
            for label in self.AGENTS:
                self.launchctl('bootout', f'gui/{os.getuid()}/{label}')
        try:
            with open(os.path.join(self.home, 'runner.lock'), encoding='utf-8') as f:
                held = json.loads(f.read() or '{}')
        except (OSError, ValueError):
            held = {}
        held = held if isinstance(held, dict) else {}
        runner = (held.get('runner'), held.get('runnerStartedAt'))
        server = (held.get('pid'), held.get('startedAt'))
        live = [p for p in (runner, server) if isinstance(p[1], str) and Process.started_at(p[0]) == p[1]]
        self.stopped += live
        if server in live:
            self.signal(server[0], signal.SIGTERM, group=True)
        if runner in live:
            self.signal(runner[0], signal.SIGTERM)
        end = time.monotonic() + self.RUNNER_WITHIN
        while self.runner_running() and time.monotonic() < end:
            time.sleep(0.2)
        for pid, started in live:
            if Process.started_at(pid) == started:
                self.signal(pid, signal.SIGKILL, group=(pid, started) == server)
        if server in live:
            self.signal(server[0], signal.SIGKILL, group=True)

    @staticmethod
    def signal(pid, signum, group=False):
        try:
            (os.killpg if group else os.kill)(pid, signum)
        except OSError:
            pass

    def lay(self, folder):
        """lay-down from a kept release's core, with that release's own lay-down."""
        try:
            r = subprocess.run([System.command(PYTHON), '-B', os.path.join(folder, 'tools', 'lay-down.py'), folder],
                               cwd='/', env=System.env(self.home), stdin=subprocess.DEVNULL, capture_output=True,
                               text=True, timeout=self.LAY_DOWN_WITHIN)
        except (OSError, subprocess.SubprocessError):
            return False
        return r.returncode == 0

    def reload(self):
        """The agents loaded again, the account's own home only."""
        if not System.own_home():
            return
        folder = os.path.join(os.path.expanduser('~'), 'Library', 'LaunchAgents')
        for label in self.AGENTS:
            plist = os.path.join(folder, label + '.plist')
            if not self.launchctl('print', f'gui/{os.getuid()}/{label}') and os.path.isfile(plist):
                self.launchctl('bootstrap', f'gui/{os.getuid()}', plist)

    def check(self, files):
        """The check after a lay-down: the runner holding its lock within 30
        seconds, one live session within 2 minutes, the health check naming no
        fault (floor, agents, sign-in, runner, release, a server stopped
        before a session) and no line it cannot classify, every installed core
        file against the release's files, and no process of the previous
        release still running."""
        end = time.monotonic() + self.RUNNER_WITHIN
        while not self.runner_running():
            if time.monotonic() >= end:
                return False
            time.sleep(0.25)
        identity = self.router_module.Identity(self.home)
        end = time.monotonic() + self.SESSION_WITHIN
        while identity.check(None)[0] != 'ok':
            if time.monotonic() >= end:
                return False
            time.sleep(0.5)
        lines = HealthLines.run(self.home)
        if lines is None or HealthLines.faults(lines):
            return False
        if Releases.digests(self.releases.core) != files:
            return False
        return not any(Process.started_at(pid) == started for pid, started in self.stopped)

    def clear(self, version, previous):
        """The release before the previous one removed: two are kept."""
        try:
            names = os.listdir(self.releases.kept)
        except OSError:
            return
        for name in names:
            if name not in (version, previous):
                shutil.rmtree(os.path.join(self.releases.kept, name), ignore_errors=True)

    def recheck(self, version, key_version):
        """A kept release checked again before it is laid down: against its
        signed manifest with the key installed when it was staged (the release
        before it), or, for the app's release, against the release set-up
        keeps. Its files, or None when it fails."""
        folder = os.path.join(self.releases.kept, version)
        if os.path.isfile(os.path.join(folder, 'manifest.json')):
            key = os.path.join(self.releases.kept, str(key_version), 'core', 'release-key.pub')
            if not key_version or not os.path.isfile(key):
                key = os.path.join(self.releases.app_release, 'release-key.pub')
            try:
                return self.releases.check(folder, key, version)[0]['files']
            except Refused:
                return None
        files = Releases.digests(self.releases.app_release)
        return files if files and Releases.digests(os.path.join(folder, 'core')) == files else None

    def mark_failed(self, version, previous, on):
        """The mark the owner sees with no session: update.json's record of a
        rollback that did not end checked, printed by the health check while
        Squire stays on that release."""
        self.releases.note(rollbackFailed={'from': version, 'to': previous, 'on': on})

    def rollback(self, version, previous, before, previous_files=None):
        """The previous release laid down again, checked first; returns the
        version Squire is on. The rolled-back version is held out of the
        weekly check's offer (update.json's heldOut) until a newer one is
        published."""
        try:
            self.releases.note(heldOut=version)
        except OSError:
            pass
        key_version = (before or {}).get('previous') if (before or {}).get('current') == previous else None
        files = self.recheck(previous, key_version)
        if files is None or (previous_files is not None and files != previous_files):
            self.mark_failed(version, previous, on=version)
            self.remove_record()
            return version
        self.stop()
        if not self.lay(os.path.join(self.releases.kept, previous, 'core')):
            self.mark_failed(version, previous, on=version)
            self.remove_record()
            return version
        Records.write(self.releases.current_file, before or {'current': previous, 'previous': None, 'verified': False},
                      durable=True)
        self.reload()
        if self.check(files):
            self.send(f'Squire rolled {version} back to {previous}; all checks passed', 'rollback')
        else:
            self.mark_failed(version, previous, on=previous)
            self.send(f'Squire rolled {version} back to {previous}, and the check after the rollback failed too; the '
                      'health check offers a support ticket', 'rollback')
        self.remove_record()
        return previous


class Recovery:
    """An install that did not finish: install.json present and its lock
    free. A record that cannot be read is set aside, never adopted, and
    Squire settles by current-release.json. Either way Squire ends on one
    whole, checked version and one wake-up says which."""

    def __init__(self, install):
        self.install = install
        self.releases = install.releases

    def run(self):
        if self.install.lock() is None:
            return 0
        if not os.path.lexists(self.install.record_file):
            return 0
        self.settle()
        return 0

    def readable(self, record):
        kept = self.releases.kept
        return isinstance(record, dict) and Version.of(record.get('previous')) and Version.of(record.get('next')) \
            and record.get('step') in Install.STEPS and isinstance(record.get('pid'), int) \
            and isinstance(record.get('started'), int) and os.path.isdir(os.path.join(kept, record['next'], 'core'))

    def settle(self):
        """The version Squire is on once the install is settled, told in one
        wake-up, the record gone."""
        record = Records.read(self.install.record_file)
        if self.readable(record):
            on = self.adopt(record['previous'], record['next'])
        else:
            aside = os.path.join(self.install.home, f'install-set-aside-{int(time.time() * 1000)}-{os.getpid()}.json')
            try:
                os.rename(self.install.record_file, aside)
            except OSError:
                pass
            on = self.by_current()
        self.install.send(f'Squire\'s update did not finish; Squire is on {on}', 'recovery')
        self.install.remove_record()
        return on

    def whole(self, version, key):
        """The kept release's files when it, its signed manifest and the
        installed core all match; None otherwise."""
        folder = os.path.join(self.releases.kept, version)
        try:
            files = self.releases.check(folder, key, version)[0]['files']
        except Refused:
            return None
        return files if Releases.digests(self.releases.core) == files else None

    def adopt(self, previous, version):
        key = os.path.join(self.releases.kept, previous, 'core', 'release-key.pub')
        if not os.path.isfile(key):
            key = os.path.join(self.releases.app_release, 'release-key.pub')
        files = self.whole(version, key)
        if files is not None:
            current = self.releases.current() or {}
            if current.get('current') != version:
                Records.write(self.releases.current_file, {'current': version, 'previous': previous, 'verified': True},
                              durable=True)
            if self.install.check(files):
                return version
            return self.install.rollback(version, previous, {'current': previous, 'previous': None, 'verified': False})
        if Releases.digests(self.releases.core) == self.install.files_of(previous):
            current = self.releases.current() or {}
            if current.get('current') not in (None, previous):
                Records.write(self.releases.current_file, {'current': previous, 'previous': None, 'verified': False},
                              durable=True)
            return previous
        return self.install.rollback(version, previous, {'current': previous, 'previous': None, 'verified': False})

    def by_current(self):
        version = self.releases.installed()
        current = self.releases.current() or {}
        folder = os.path.join(self.releases.kept, str(version))
        if os.path.isfile(os.path.join(folder, 'manifest.json')):
            key = os.path.join(self.releases.kept, str(current.get('previous')), 'core', 'release-key.pub')
            if not os.path.isfile(key):
                key = self.releases.key
            files = self.whole(version, key)
        else:
            files = Releases.digests(self.releases.app_release)
            files = files if files and Releases.digests(self.releases.core) == files else None
        if files is not None and self.install.check(files):
            return version
        previous = current.get('previous')
        if Version.of(previous) and os.path.isdir(os.path.join(self.releases.kept, previous, 'core')):
            return self.install.rollback(version, previous, {'current': previous, 'previous': None, 'verified': False})
        return version


class SquireUpdate:
    """Squire Update, the app the owner opens at the Mac (update.py --app),
    one at a time (update-app.lock in the Squire home). An install that did
    not finish is settled first, here, outside every agent. Then the staged
    release is checked again and shown in one window, its version and its
    changelog exactly as the signed manifest holds them; nothing changes
    before Install. Install starts the engine (update.py --app-install
    <version> <manifest digest>) in a session of its own, so neither the
    agents it stops nor the owner closing the window can end it, and the
    engine installs only the release the window showed. Opened by Squire with
    --recover, it settles the install that did not finish and ends."""

    TITLE = 'Squire Update'
    WINDOW_WITHIN = 3600
    POLL = 1.0
    # The engine's exit: installed, not installed (rolled back, or nothing
    # changed), the release changed since it was shown, refused when checked
    # again, another install holding install.lock.
    INSTALLED, NOT_INSTALLED, CHANGED, REFUSED, BUSY = 0, 1, 3, 4, 5
    DIGEST = re.compile(r'^[0-9a-f]{64}\Z')

    def __init__(self, config):
        self.config = config
        self.home = config.home
        self.releases = Releases(config.home)
        self.held = None

    # ------------------------------------------------------------ windows

    def window(self, text, buttons=('OK',), title=None, wait=True):
        """One window drawn by the Mac's osascript, its last button the
        default: the button chosen, or None when it was closed or not
        answered. With wait False it is left on screen and returned."""
        names = ', '.join(f'"{b}"' for b in buttons)
        argv = [System.command('/usr/bin/osascript'), '-e', 'on run argv', '-e',
                f'display dialog (item 2 of argv) with title (item 1 of argv) buttons {{{names}}} '
                f'default button "{buttons[-1]}"', '-e', 'end run', title or self.TITLE, text]
        if not wait:
            try:
                return subprocess.Popen(argv, cwd='/', env=System.env(), stdin=subprocess.DEVNULL,
                                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            except OSError:
                return None
        try:
            r = subprocess.run(argv, cwd='/', env=System.env(), stdin=subprocess.DEVNULL, capture_output=True, text=True,
                               timeout=self.WINDOW_WITHIN)
        except (OSError, subprocess.SubprocessError):
            return None
        said = r.stdout.strip()
        chosen = said[len('button returned:'):] if said.startswith('button returned:') else None
        return chosen if r.returncode == 0 and chosen in buttons else None

    @staticmethod
    def close(shown):
        """A window left on screen, taken away."""
        if shown is None:
            return
        if shown.poll() is None:
            shown.terminate()
        try:
            shown.wait(10)
        except subprocess.TimeoutExpired:
            shown.kill()
            shown.wait()

    def log(self, text):
        """One line in the Squire home's log of Squire Update."""
        try:
            os.makedirs(os.path.join(self.home, 'logs'), mode=0o700, exist_ok=True)
            with open(os.path.join(self.home, 'logs', 'update.log'), 'a', encoding='utf-8') as f:
                f.write(f'{time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())} Squire Update: {text}\n')
        except OSError:
            pass

    def installing(self):
        record = Records.read(os.path.join(self.home, 'install.json'))
        version = record.get('next') if isinstance(record, dict) else None
        if Version.of(version):
            return f'Squire Update is installing Squire {version} now. It tells you when it is done.'
        return 'Squire Update is installing an update to Squire now. It tells you when it is done.'

    # ------------------------------------------------------------ the app

    def lock(self):
        try:
            fd = os.open(os.path.join(self.home, 'update-app.lock'), os.O_RDWR | os.O_CREAT, 0o600)
        except OSError:
            return None
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            os.close(fd)
            return None
        return fd

    def open(self, recover=False):
        self.held = self.lock()
        if self.held is None:
            busy = not Install.lock_free(self.home)
            self.window(self.installing() if busy else 'Squire Update is already open. Look for its window.')
            return 0
        if not Install.lock_free(self.home):
            self.window(self.installing())
            return 0
        if Install.unfinished(self.home):
            self.finish()
        if recover:
            return 0
        return self.offer()

    def finish(self):
        """The install that did not finish, settled with lay-downs allowed:
        Squire Update runs outside every agent. Its agents are loaded first,
        so the check after it can run."""
        install = Install(self.config)
        fd = install.lock()
        if fd is None:
            self.window(self.installing())
            return
        record = Records.read(install.record_file)
        record = record if isinstance(record, dict) else {}
        shown = self.window('Squire Update is finishing an update that was interrupted. This takes up to three minutes.',
                            wait=False)
        try:
            install.reload()
            on = Recovery(install).settle()
        finally:
            os.close(fd)
            self.close(shown)
        mark = self.releases.record().get('rollbackFailed')
        if not Version.of(on):
            return
        if on == record.get('next'):
            self.window(f'Squire is on {on}. The interrupted update finished and all checks passed.')
        elif isinstance(mark, dict) and mark.get('on') == on:
            self.window(f'Squire is on {on}, and it did not pass its checks. Ask Squire in the chat to send a support '
                        'ticket.')
        elif on == record.get('previous'):
            self.window(f'Squire is back on {on}. The interrupted update did not finish, so Squire Update put the '
                        'previous version back.')
        else:
            self.window(f'Squire is on {on}. The interrupted update did not finish.')

    def offer(self):
        releases = self.releases
        version, installed = releases.staged(), releases.installed()
        if not version:
            self.window(f'Squire is up to date ({installed}). There is nothing to install.' if installed
                        else 'Squire is up to date. There is nothing to install.')
            return 0
        lines = HealthLines.read(self.config)
        if lines is None or HealthLines.faults(lines):
            self.window('Squire must fix a problem before it can update. Ask Squire about it in the chat, then open '
                        'Squire Update again.')
            return 0
        folder = os.path.join(releases.staging, version)
        try:
            manifest, data = releases.check(folder, releases.key, version, work=releases.staging)
        except Refused as e:
            shutil.rmtree(folder, ignore_errors=True)
            releases.note(outcome='refused', version=version, reason=str(e))
            self.window(self.refused(version))
            return 0
        version = manifest['version']
        answer = self.window(f'What\'s new:\n{manifest["changelog"]}\n\nInstalling takes about three minutes. Squire is '
                             'unavailable while it installs.', buttons=('Not now', 'Install'),
                             title=f'{self.TITLE}: Squire {version}')
        try:
            releases.note(lastShown=int(time.time()))
        except OSError:
            pass
        if answer != 'Install':
            return 0
        # The click is recorded in update.json and the Squire home's log only.
        try:
            releases.note(chosen={'version': version, 'at': int(time.time())})
        except OSError:
            pass
        self.log(f'Install chosen for release {version}')
        return self.install(version, hashlib.sha256(data).hexdigest())

    def install(self, version, digest):
        """The engine started in a session of its own, then the window that
        says it is installing; the outcome once the engine ends."""
        try:
            engine = subprocess.Popen([System.command(PYTHON), '-B', os.path.join(CORE, 'tools', 'update.py'),
                                       '--app-install', version, digest], cwd='/', env=System.env(self.home),
                                      stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                      start_new_session=True)
        except OSError:
            self.window(f'Squire Update could not start installing Squire {version}. Nothing was changed.')
            return 1
        shown = self.window(f'Installing Squire {version}. You can keep working. Do not log out or shut the Mac down '
                            'until this says it is done.', buttons=('Hide',), wait=False)
        while engine.poll() is None:
            time.sleep(self.POLL)
        self.close(shown)
        self.window(self.outcome(version, engine.returncode))
        return 0

    @staticmethod
    def refused(version):
        return (f'Squire Update did not install release {version}: it is not signed by Stravica, or it changed after '
                'Squire checked it. Nothing was changed.')

    def outcome(self, version, code):
        releases = self.releases
        if code == self.INSTALLED:
            return f'Squire is updated to {version}. All checks passed.'
        if code == self.CHANGED:
            return (f'Squire Update did not install {version}: it changed while this window was open. Nothing was '
                    'changed. Open Squire Update again to see it as it is now.')
        if code == self.REFUSED:
            return self.refused(version)
        if code == self.BUSY:
            return self.installing()
        record, installed = releases.record(), releases.installed()
        mark = record.get('rollbackFailed')
        if isinstance(mark, dict) and mark.get('from') == version and Version.of(mark.get('to')):
            return (f'Squire {version} did not pass its checks, and {mark["to"]} did not pass them again either. Ask '
                    'Squire in the chat to send a support ticket.')
        if record.get('heldOut') == version and Version.of(installed) and installed != version:
            return (f'Squire {version} did not pass its checks, so Squire Update put {installed} back. All checks '
                    'passed. Nothing in your Squire folder changed.')
        if os.path.lexists(os.path.join(self.home, 'install.json')):
            return f'Squire Update did not finish installing {version}. Open Squire Update again to finish it.'
        return f'Squire Update could not install {version}. Squire is still on {installed}.'

    # ------------------------------------------------------------ the engine

    def engine(self, version, digest):
        """update.py --app-install: under install.lock for its whole life, an
        unfinished install settled first, the staged release checked again,
        its manifest's SHA-256 the one the window showed, then the install."""
        if not Version.of(version) or not self.DIGEST.match(digest):
            return 2
        install = Install(self.config)
        self.held = install.lock()
        if self.held is None:
            return self.BUSY
        if os.path.lexists(install.record_file):
            install.reload()
            Recovery(install).settle()
            return self.CHANGED
        releases = install.releases
        folder = os.path.join(releases.staging, version)
        if releases.staged() != version:
            return self.CHANGED
        try:
            manifest, data = releases.check(folder, releases.key, version, work=releases.staging)
        except Refused as e:
            shutil.rmtree(folder, ignore_errors=True)
            releases.note(outcome='refused', version=version, reason=str(e))
            return self.REFUSED
        if hashlib.sha256(data).hexdigest() != digest:
            return self.CHANGED
        code = install.install(version, manifest)
        if code == self.INSTALLED:
            releases.note(installed={'version': version, 'at': int(time.time()), 'by': self.TITLE})
            self.log(f'release {version} installed')
        return code


def main(argv):
    try:
        config = Config()
    except SquireError as e:
        sys.stderr.write(f'update: {e}.\n')
        return 2
    if argv in (['--app'], ['--app', '--recover']):
        return SquireUpdate(config).open(recover=argv == ['--app', '--recover'])
    if len(argv) == 3 and argv[0] == '--app-install':
        return SquireUpdate(config).engine(argv[1], argv[2])
    if argv == ['--recover']:
        return Recovery(Install(config)).run()
    sys.stderr.write('update.py takes --app, --app-install <version> <manifest digest> or --recover\n')
    return 2


if __name__ == '__main__':
    try:
        code = main(sys.argv[1:])
    except Exception as e:
        sys.stderr.write(f'update failed ({type(e).__name__}).\n')
        code = 1
    sys.exit(code)
