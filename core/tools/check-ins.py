"""Squire's check-in command: the owner's check-ins set, moved or stopped by
asking Squire. The session runs it only as this one command, on the owner's
yes (the safety floor asks first, naming the times and the words):

    /usr/bin/python3 '<Squire home>/core/tools/check-ins.py' set <HH:MM> <words>
    /usr/bin/python3 '<Squire home>/core/tools/check-ins.py' change <HH:MM now> <HH:MM new>
    /usr/bin/python3 '<Squire home>/core/tools/check-ins.py' stop <HH:MM>
    /usr/bin/python3 '<Squire home>/core/tools/check-ins.py' every <minutes> <HH:MM first> <HH:MM last> <words>

Each writes wakeUps in the owner's squire.json, one "HH:MM words" entry per
check-in in the Mac's local time, the form the wake-up router reads: an
entry is written only when the router's own rule (WakeUpRouter.PICKED in
wake-up.py) reads it back as that time and those words. Every other entry
and setting stays as it was; the file is written whole through a file beside
it and a rename. A moved check-in keeps its place and its words. An entry
already there at the same time with the same words is not added twice.

It says in one line what it set, naming the times. A rhythm more often than
hourly is set as asked, with one plain sentence that frequent check-ins use
the plan faster. A time the router could not read, no words, words holding a
new line or a control character or starting as Squire's own wake-ups do, a
rhythm that is not a whole number of minutes from 1 to 1440, a last time
before the first, or a change or stop of a check-in that is not there (or of
two at the same time) is never written: it says why, exits 1 and the file is
unchanged.

Standard library only; run by /usr/bin/python3.
"""

import importlib.util
import json
import os
import re
import sys
import tempfile
import unicodedata

sys.dont_write_bytecode = True
CORE = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
sys.path.insert(0, os.path.join(CORE, 'lib'))

from squire import Config, SquireError  # noqa: E402

TIME = re.compile(r'^([0-9]{2}):([0-9]{2})\Z')
OFTEN = 60
PLAN = 'Frequent check-ins use your plan faster.'
WAKE_UP = 'Squire wake-up:'


class Refused(Exception):
    """Why a check-in is not written, in words the owner can act on."""


def picked_rule():
    """The wake-up router's own rule for an "HH:MM words" entry."""
    spec = importlib.util.spec_from_file_location('squire_wake_up', os.path.join(CORE, 'tools', 'wake-up.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.WakeUpRouter.PICKED


class CheckIns:
    """The owner's check-ins as wakeUps in their squire.json."""

    def __init__(self, config):
        self.path = os.path.join(config.owner_folder, 'squire.json')
        self.rule = picked_rule()
        try:
            with open(self.path, encoding='utf-8') as f:
                self.data = json.load(f)
        except FileNotFoundError:
            raise Refused('your squire.json, where Squire reads your check-ins, is not there')
        except (OSError, ValueError):
            raise Refused('your squire.json, where Squire reads your check-ins, cannot be read')
        if not isinstance(self.data, dict):
            raise Refused('your squire.json, where Squire reads your check-ins, is not as Squire wrote it')
        entries = self.data.get('wakeUps', [])
        if not isinstance(entries, list):
            raise Refused('the check-ins in your squire.json are not a list Squire can change')
        self.entries = list(entries)

    def at(self, hhmm):
        """The places of the entries at this time."""
        found = []
        for i, entry in enumerate(self.entries):
            match = self.rule.match(entry.strip()) if isinstance(entry, str) else None
            if match and f'{match.group(1)}:{match.group(2)}' == hhmm:
                found.append(i)
        return found

    def entry(self, hhmm, words):
        """The "HH:MM words" entry, only when the router reads it back as
        exactly that time and those words."""
        if not isinstance(hhmm, str) or not TIME.match(hhmm):
            raise Refused(f'"{hhmm}" is not a time Squire can read: give it as HH:MM, from 00:00 to 23:59')
        words = words.strip()
        if not words:
            raise Refused('a check-in needs a few words saying what it is for')
        if any(unicodedata.category(c) in ('Cc', 'Cf', 'Zl', 'Zp') for c in words):
            raise Refused('the words of a check-in must be one line, with no new line or control character')
        if words.startswith(WAKE_UP):
            raise Refused(f'the words of a check-in cannot start with "{WAKE_UP}", which marks Squire\'s own wake-ups')
        entry = f'{hhmm} {words}'
        match = self.rule.match(entry)
        if not match or f'{match.group(1)}:{match.group(2)}' != hhmm or match.group(3) != words:
            raise Refused(f'"{hhmm}" is not a time Squire can read: give it as HH:MM, from 00:00 to 23:59')
        return entry

    def add(self, entry):
        """True when the entry was added; False when it was there already."""
        if entry in (e.strip() for e in self.entries if isinstance(e, str)):
            return False
        self.entries.append(entry)
        return True

    def write(self):
        data = dict(self.data)
        data['wakeUps'] = self.entries
        folder = os.path.dirname(self.path)
        try:
            mode = os.stat(self.path).st_mode & 0o777
            fd, tmp = tempfile.mkstemp(prefix='.squire.json-', dir=folder)
            with os.fdopen(fd, 'w', encoding='utf-8') as f:
                json.dump(data, f, indent=2, ensure_ascii=False)
                f.write('\n')
            os.chmod(tmp, mode)
            os.replace(tmp, self.path)
        except OSError as e:
            raise Refused(f'your squire.json could not be written ({e.strerror or type(e).__name__})')


def minutes_of(hhmm):
    return int(hhmm[:2]) * 60 + int(hhmm[3:])


def run(config, argv):
    """The line to say; raises Refused."""
    verb, args = (argv[0], argv[1:]) if argv else ('', [])
    if verb == 'set' and len(args) == 2:
        book = CheckIns(config)
        entry = book.entry(args[0], args[1])
        if not book.add(entry):
            return f'There is already a check-in at {args[0]} with those words, so nothing changed.'
        book.write()
        return f'Set a check-in at {args[0]}.'
    if verb == 'change' and len(args) == 2:
        book = CheckIns(config)
        book.entry(args[1], 'check')
        places = book.at(args[0]) if TIME.match(args[0]) else []
        if not places:
            raise Refused(f'there is no check-in at {args[0]} to move')
        if len(places) > 1:
            raise Refused(f'there are {len(places)} check-ins at {args[0]}; say which one to move by stopping it and '
                          'setting it again')
        words = book.rule.match(book.entries[places[0]].strip()).group(3)
        book.entries[places[0]] = book.entry(args[1], words)
        book.write()
        return f'Moved the check-in at {args[0]} to {args[1]}.'
    if verb == 'stop' and len(args) == 1:
        book = CheckIns(config)
        places = book.at(args[0]) if TIME.match(args[0]) else []
        if not places:
            raise Refused(f'there is no check-in at {args[0]} to stop')
        if len(places) > 1:
            raise Refused(f'there are {len(places)} check-ins at {args[0]}; Squire stops one only when it is clear '
                          'which')
        del book.entries[places[0]]
        book.write()
        return f'Stopped the check-in at {args[0]}.'
    if verb == 'every' and len(args) == 4:
        every, first, last, words = args
        if not every.isdigit() or not 1 <= int(every) <= 1440:
            raise Refused(f'"{every}" is not a rhythm Squire can keep: give the minutes between check-ins as a whole '
                          'number from 1 to 1440')
        book = CheckIns(config)
        book.entry(first, words)
        book.entry(last, words)
        start, end, step = minutes_of(first), minutes_of(last), int(every)
        if end < start:
            raise Refused(f'the last check-in ({last}) is before the first ({first})')
        times = ['%02d:%02d' % divmod(m, 60) for m in range(start, end + 1, step)]
        added = sum(1 for hhmm in times if book.add(book.entry(hhmm, words)))
        book.write()
        line = f'Set {added} check-in{"" if added == 1 else "s"} every {step} minutes from {first} to {times[-1]}.'
        return line + (f' {PLAN}' if step < OFTEN else '')
    raise Refused('Squire\'s check-in command takes: set HH:MM words, change HH:MM HH:MM, stop HH:MM, or every '
                  'minutes HH:MM HH:MM words')


def main(argv):
    try:
        print(run(Config(), argv))
        return 0
    except Refused as e:
        sys.stderr.write(f'Squire did not change your check-ins: {e}.\n')
        return 1
    except SquireError as e:
        sys.stderr.write(f'Squire did not change your check-ins: {e}.\n')
        return 2
    except Exception as e:
        sys.stderr.write(f'Squire did not change your check-ins: the command failed ({type(e).__name__}).\n')
        return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
