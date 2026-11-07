"""Squire's secret helper: the owner's passwords and keys live in the Mac's
Keychain, are fetched at the moment a tool needs them, and are never shown.

    secret.py run <name> --as <VAR> -- <command> [args...]
    secret.py set <name>        (the secret on stdin, one line)

run fetches the secret <name> from the Keychain that squire.json names and
runs the command with the secret in the environment variable <VAR>, passing
the command's output on with every trace of the secret hidden. When the
Keychain is not set up, locked, missing or lacks the secret, it stops,
says what to do and runs nothing. A secret is a generic password item with
service "squire" and the secret's name as its account.
"""

import base64
import ctypes
import os
import subprocess
import sys
from urllib.parse import quote_from_bytes

CORE = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
SECURITY = '/usr/bin/security'


class SecretHelper:
    SERVICE = 'squire'
    HIDDEN = b'[secret hidden]'
    NO_SUCH_KEYCHAIN = -25294
    ITEM_NOT_FOUND = 44
    USAGE = 'use: secret.py run <name> --as <VAR> -- <command> [args...], or secret.py set <name> with the secret on stdin'

    def __init__(self, config):
        from squire import SquireError

        if not config.keychain:
            raise SquireError(f'Squire\'s Keychain is not set up: {config.path} names no keychain. '
                              'Finish setting up Squire so it names the owner\'s Keychain, then try again')
        self.keychain = config.keychain

    @classmethod
    def main(cls, argv, stdin):
        sys.path.insert(0, os.path.join(CORE, 'lib'))
        from squire import Config, SquireError

        try:
            if argv[:1] == ['set']:
                if len(argv) != 2 or not argv[1]:
                    raise SquireError('set takes only the secret\'s name: the secret itself goes on stdin, '
                                      'never on the command line. Nothing was stored')
                return cls(Config()).set(argv[1], stdin)
            if argv[:1] == ['run'] and len(argv) >= 6 and argv[1] and argv[2] == '--as' \
                    and argv[3].isidentifier() and argv[4] == '--':
                return cls(Config()).run(argv[1], argv[3], argv[5:])
            raise SquireError(cls.USAGE)
        except SquireError as e:
            sys.stderr.write(f'secret helper: {e}.\n')
            return 1

    def run(self, name, variable, command):
        from squire import SquireError

        self.check('Nothing was run')
        secret = self.fetch(name)
        env = dict(os.environb)
        env[variable.encode()] = secret
        try:
            done = subprocess.run(command, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        except OSError as e:
            raise SquireError(f'{command[0]} could not be run ({e.strerror or type(e).__name__})')
        sys.stdout.buffer.write(self.hide(done.stdout, secret))
        sys.stdout.flush()
        sys.stderr.buffer.write(self.hide(done.stderr, secret))
        sys.stderr.flush()
        return done.returncode if done.returncode >= 0 else 128 - done.returncode

    def set(self, name, stdin):
        from squire import SquireError

        line = stdin.readline()
        value = line[:-1] if line.endswith(b'\n') else line
        if not value:
            raise SquireError('no secret was given on stdin, and an empty line is not a secret. Nothing was stored')
        self.check('Nothing was stored')
        done = subprocess.run([SECURITY, 'add-generic-password', '-U', '-s', self.SERVICE, '-a', name, '-w', value, self.keychain],
                              stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)
        if done.returncode != 0:
            raise SquireError(f'the Keychain {self.keychain} did not store the secret {name} '
                              f'(security exited {done.returncode}). Nothing was stored')
        print(f'Stored the secret {name} in the Keychain.')
        return 0

    def check(self, outcome):
        """Stops, with directions, unless the Keychain is there and unlocked.
        Asked of the Security framework, so a locked Keychain never prompts."""
        from squire import SquireError

        security = ctypes.cdll.LoadLibrary('/System/Library/Frameworks/Security.framework/Security')
        foundation = ctypes.cdll.LoadLibrary('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
        ref, status = ctypes.c_void_p(), ctypes.c_uint32()
        error = security.SecKeychainOpen(self.keychain.encode('utf-8'), ctypes.byref(ref))
        if not error:
            error = security.SecKeychainGetStatus(ref, ctypes.byref(status))
        if ref.value:
            foundation.CFRelease(ref)
        if error == self.NO_SUCH_KEYCHAIN:
            raise SquireError(f'the Keychain {self.keychain} that squire.json names is not there. '
                              f'Restore it, or set Squire up again with the owner\'s Keychain. {outcome}')
        if error:
            raise SquireError(f'the Keychain {self.keychain} cannot be opened (error {error}). {outcome}')
        if not status.value & 1:
            raise SquireError(f'the Keychain {self.keychain} is locked. Unlock it (log in to the Mac again, or unlock it '
                              f'in Keychain Access), then try again. {outcome}')

    def fetch(self, name):
        from squire import SquireError

        done = subprocess.run([SECURITY, 'find-generic-password', '-s', self.SERVICE, '-a', name, '-w', self.keychain],
                              stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)
        if done.returncode == self.ITEM_NOT_FOUND:
            raise SquireError(f'the Keychain has no secret called {name}. The owner can store it with '
                              f'"secret.py set {name}", the secret on stdin. Nothing was run')
        secret = done.stdout[:-1] if done.stdout.endswith(b'\n') else done.stdout
        if done.returncode != 0 or not secret:
            raise SquireError(f'the Keychain {self.keychain} could not give the secret {name} '
                              f'(security exited {done.returncode}). Nothing was run')
        return secret

    @classmethod
    def hide(cls, data, secret):
        """The output with the secret hidden as text, base64, lower and upper
        hex and percent-encoded."""
        forms = {secret, base64.b64encode(secret), secret.hex().encode(), secret.hex().upper().encode(),
                 quote_from_bytes(secret, safe="-_.!~*'()").encode()}
        for form in sorted(forms, key=len, reverse=True):
            data = data.replace(form, cls.HIDDEN)
        return data


if __name__ == '__main__':
    try:
        code = SecretHelper.main(sys.argv[1:], sys.stdin.buffer)
    except Exception as e:
        sys.stderr.write(f'secret helper failed ({type(e).__name__}).\n')
        code = 1
    sys.exit(code)
