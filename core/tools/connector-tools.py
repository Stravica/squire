"""Squire's connector-tools command: the owner's own classes for the tools
of the connectors he has attached, kept as connectorTools {read, draft} in
his squire.json (in his folder). The session runs it as one command, on the
owner's yes to that run (the safety floor asks first, naming every tool):

    /usr/bin/python3 '<Squire home>/core/tools/connector-tools.py' read <tool name> [...]
    /usr/bin/python3 '<Squire home>/core/tools/connector-tools.py' draft <tool name> [...]
    /usr/bin/python3 '<Squire home>/core/tools/connector-tools.py' remove <tool name> [...]

read lets Squire read through each named tool with no ask; draft lets it
keep drafts through each with no ask; remove takes each out of both, so it is
asked again. A tool is named by its exact full name, as Claude Code names a
connector's tool (mcp__<connector>__<tool>), with no wildcard, and is in one
class at most: read and draft each take the names off the other class. It
says in one line what it set, naming the tools, and keeps every other setting
of the owner's squire.json, in its order. A name that is not one exact tool
name, or classes of another shape in the file, change nothing and say why.

Standard library only; run by /usr/bin/python3.
"""

import json
import os
import re
import sys
import tempfile

sys.dont_write_bytecode = True
CORE = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
sys.path.insert(0, os.path.join(CORE, 'lib'))

from squire import Config, SquireError  # noqa: E402


class Refused(Exception):
    """Why the command changed nothing, in words the owner can act on."""


class ConnectorClasses:
    """The owner's connector classes in his squire.json, changed by exact
    full name; every other setting of the file kept as it was."""

    KEY = 'connectorTools'
    VERBS = ('read', 'draft', 'remove')
    NAME = re.compile(r'mcp__[^\s_][^\s]*__[^\s]+')
    WILDCARDS = set('*?[]{}')
    USAGE = ('it takes read, draft or remove, then one or more connector tools by their exact full names '
             '(mcp__<connector>__<tool>)')

    def __init__(self, owner_folder):
        self.path = os.path.realpath(os.path.join(owner_folder, 'squire.json'))

    @classmethod
    def names(cls, given):
        """The names as given, each once; Refused for any that is not one
        exact full connector tool name."""
        bad = [n for n in given if not cls.NAME.fullmatch(n) or cls.WILDCARDS & set(n)
               or any(ord(c) < 32 or ord(c) == 127 for c in n)]
        if bad:
            raise Refused(f'{", ".join(json.dumps(n) for n in bad)} is not a connector tool\'s exact full name '
                          '(mcp__<connector>__<tool>, with no wildcard)')
        return list(dict.fromkeys(given))

    def load(self):
        """The file's settings, {} when there is no file yet."""
        try:
            with open(self.path, 'rb') as f:
                data = json.loads(f.read().decode('utf-8'))
        except FileNotFoundError:
            return {}
        except (OSError, ValueError, UnicodeDecodeError):
            raise Refused(f'the owner\'s squire.json ({self.path}) cannot be read as JSON')
        if not isinstance(data, dict):
            raise Refused(f'the owner\'s squire.json ({self.path}) must hold one JSON object')
        return data

    def change(self, verb, given):
        """Changes the classes; the line that says what was set."""
        if verb not in self.VERBS or not given:
            raise Refused(self.USAGE)
        names = self.names(given)
        data = self.load()
        old = data.get(self.KEY, {})
        if not isinstance(old, dict):
            raise Refused('the connector classes in the owner\'s squire.json are not a read list and a draft list '
                          'of tool names; fix or remove connectorTools there first')
        read, draft = old.get('read', []), old.get('draft', [])
        if not isinstance(read, list) or not isinstance(draft, list) \
                or not all(isinstance(n, str) for n in read + draft):
            raise Refused('the connector classes in the owner\'s squire.json are not a read list and a draft list '
                          'of tool names; fix or remove connectorTools there first')
        read = [n for n in read if n not in names] + (names if verb == 'read' else [])
        draft = [n for n in draft if n not in names] + (names if verb == 'draft' else [])
        classes = dict(old)
        classes['read'], classes['draft'] = read, draft
        data[self.KEY] = classes
        self.write(json.dumps(data, indent=2, ensure_ascii=False) + '\n')
        listed = ', '.join(names)
        if verb == 'read':
            return f'Squire now reads with no ask through {listed}, each by its exact full name.'
        if verb == 'draft':
            return f'Squire now keeps drafts with no ask through {listed}, each by its exact full name.'
        return f'Squire no longer reads or keeps drafts with no ask through {listed}; each is asked again.'

    def write(self, text):
        """The whole file at once: a reader sees the old file or the new."""
        folder = os.path.dirname(self.path)
        try:
            mode = os.stat(self.path).st_mode & 0o777
        except FileNotFoundError:
            mode = 0o600
        fd, temp = tempfile.mkstemp(prefix='.squire-json-', dir=folder)
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as f:
                f.write(text)
            os.chmod(temp, mode)
            os.replace(temp, self.path)
        except BaseException:
            try:
                os.unlink(temp)
            except OSError:
                pass
            raise


def main(argv):
    try:
        config = Config()
        print(ConnectorClasses(config.owner_folder).change(argv[0] if argv else '', argv[1:]))
        return 0
    except (Refused, SquireError) as e:
        sys.stderr.write(f'Squire\'s connector-tools command changed nothing: {e}.\n')
        return 1
    except OSError as e:
        sys.stderr.write(f'Squire\'s connector-tools command changed nothing: the owner\'s squire.json could not be '
                         f'written ({e.strerror or type(e).__name__}).\n')
        return 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
