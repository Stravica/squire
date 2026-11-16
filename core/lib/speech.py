"""Squire's speech helper, built on the owner's Mac: the one function that
builds it, which set-up calls once core is laid down, and Squire's
transcription calls on first use whenever the built helper is absent or the
digest kept beside it is not the Swift source's.

Only the Swift source ships, in core (core/lib/speech-helper.swift, covered by
the signed manifest like every file in core). The helper is built with
Apple's command line tools (swiftc, through xcrun of the active developer
folder xcode-select names), with an Info.plist of its own embedded so the
Mac's speech service sees one stable identity, into the Squire home's
state/speech-helper/, the source's digest kept beside it. Never into the
installed core, and never into the owner's folder.

Below macOS 26, without the command line tools, or when the build fails,
nothing is built and the reason is given: Squire's transcription then gives
the outcome of a Mac that cannot recognise speech on the Mac itself, and
sends nothing anywhere. Nothing is downloaded or installed for it.

Standard library only; run by /usr/bin/python3.
"""

import glob
import hashlib
import os
import plistlib
import re
import shutil
import subprocess
import tempfile

from squire import System

CORE = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
SOURCE = os.path.join(CORE, 'lib', 'speech-helper.swift')


class SpeechHelper:
    """Builds, finds and names Squire's speech helper in the Squire home."""

    FOLDER = os.path.join('state', 'speech-helper')
    BINARY = 'speech-helper'
    DIGEST = 'source.sha256'
    IDENTIFIER = 'com.stravica.squire.speech-helper'
    LOWEST = 26
    ASK_WITHIN = 30
    BUILD_WITHIN = 600

    @classmethod
    def folder(cls, home):
        return os.path.join(home, cls.FOLDER)

    @staticmethod
    def digest():
        """The Swift source's SHA-256, or None when it cannot be read."""
        try:
            with open(SOURCE, 'rb') as f:
                return hashlib.sha256(f.read()).hexdigest()
        except OSError:
            return None

    @classmethod
    def ready(cls, home):
        """The built helper's path when it is there, can be run, and was built
        from the source core holds now; else None."""
        folder = cls.folder(home)
        binary = os.path.join(folder, cls.BINARY)
        try:
            with open(os.path.join(folder, cls.DIGEST), encoding='ascii') as f:
                kept = f.read(128).strip()
        except (OSError, ValueError):
            return None
        source = cls.digest()
        if not source or kept != source or not os.path.isfile(binary) or not os.access(binary, os.X_OK):
            return None
        return binary

    @classmethod
    def ask(cls, argv):
        """A command of the Mac's own: (exit code, stdout), or (None, '')."""
        try:
            r = subprocess.run(argv, cwd='/', env=System.env(), stdin=subprocess.DEVNULL, capture_output=True,
                               text=True, timeout=cls.ASK_WITHIN)
        except (OSError, subprocess.SubprocessError, ValueError):
            return None, ''
        return r.returncode, r.stdout.strip()

    @classmethod
    def why_not(cls):
        """(the swiftc to build with, the SDK or None, None), or (None, None,
        the reason it cannot be built on this Mac)."""
        code, version = cls.ask([System.command('/usr/bin/sw_vers'), '-productVersion'])
        major = re.match(r'^(\d+)', version or '')
        if code != 0 or not major:
            return None, None, 'Squire could not read this Mac\'s version of macOS'
        if int(major.group(1)) < cls.LOWEST:
            return None, None, f'this Mac runs macOS {version}, and recognising speech on the Mac itself needs ' \
                               f'macOS {cls.LOWEST} or later'
        code, developer = cls.ask([System.command('/usr/bin/xcode-select'), '-p'])
        if code != 0 or not developer or not os.path.isdir(developer):
            return None, None, 'Apple\'s command line tools are not on this Mac'
        code, swiftc = cls.ask([System.command('/usr/bin/xcrun'), '--find', 'swiftc'])
        if code != 0 or not swiftc or not os.path.isfile(swiftc):
            return None, None, 'Apple\'s command line tools on this Mac have no Swift compiler'
        # The newest macOS 26 SDK the tools carry, when they carry one.
        sdks = sorted(glob.glob(os.path.join(developer, 'SDKs', f'MacOSX{cls.LOWEST}*.sdk')))
        return swiftc, (sdks[-1] if sdks else None), None

    @classmethod
    def build(cls, home):
        """(the built helper's path, None), or (None, the reason it could not
        be built). The build happens in a folder of its own beside the
        helper's and is moved into place whole, the source's digest written
        last."""
        source = cls.digest()
        if not source:
            return None, 'Squire\'s speech helper source is missing from its core'
        swiftc, sdk, reason = cls.why_not()
        if reason:
            return None, reason
        folder = cls.folder(home)
        try:
            os.makedirs(folder, mode=0o700, exist_ok=True)
            work = tempfile.mkdtemp(prefix='.build-', dir=folder)
        except OSError as e:
            return None, f'Squire could not make a folder for its speech helper ({e.strerror or type(e).__name__})'
        try:
            info = os.path.join(work, 'Info.plist')
            with open(info, 'wb') as f:
                plistlib.dump({'CFBundleIdentifier': cls.IDENTIFIER, 'CFBundleName': 'Squire speech helper',
                               'CFBundleVersion': source[:12],
                               'NSSpeechRecognitionUsageDescription':
                                   'Squire turns your own recordings into text on this Mac; nothing leaves it.'}, f)
            built = os.path.join(work, cls.BINARY)
            argv = [swiftc, '-O', '-parse-as-library', '-module-cache-path', os.path.join(work, 'cache')]
            if sdk:
                argv += ['-sdk', sdk]
            argv += [SOURCE, '-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__info_plist',
                     '-Xlinker', info, '-o', built]
            try:
                r = subprocess.run(argv, cwd=work, env=System.env(), stdin=subprocess.DEVNULL, capture_output=True,
                                   text=True, timeout=cls.BUILD_WITHIN)
            except (OSError, subprocess.SubprocessError) as e:
                return None, f'Squire\'s speech helper could not be built on this Mac ({type(e).__name__})'
            if r.returncode != 0 or not os.path.isfile(built):
                return None, 'Squire\'s speech helper could not be built on this Mac with its command line tools'
            target = os.path.join(folder, cls.BINARY)
            try:
                os.chmod(built, 0o700)
                try:
                    os.unlink(os.path.join(folder, cls.DIGEST))
                except FileNotFoundError:
                    pass
                os.replace(built, target)
                with open(os.path.join(work, cls.DIGEST), 'w', encoding='ascii') as f:
                    f.write(source + '\n')
                os.replace(os.path.join(work, cls.DIGEST), os.path.join(folder, cls.DIGEST))
            except OSError as e:
                return None, f'Squire could not keep its speech helper ({e.strerror or type(e).__name__})'
            return target, None
        finally:
            shutil.rmtree(work, ignore_errors=True)

    @classmethod
    def find(cls, home):
        """The helper built from the current source, built now when it is
        absent or older: (path, None) or (None, reason)."""
        ready = cls.ready(home)
        if ready:
            return ready, None
        return cls.build(home)
