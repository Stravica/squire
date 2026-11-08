"""Refuses a change to Claude Code's settings during Squire's session, run by
Claude Code at every ConfigChange from core's settings.

A change from the project or local settings in the owner's folder, or from
the user settings in Squire's own config folder, could switch the floor off,
so it is refused (exit 2, the reason on stderr). An event it cannot read is
refused too.
"""

import json
import sys


class ConfigChange:
    REFUSED = ('project_settings', 'local_settings', 'user_settings')
    REASON = ('Squire\'s safety floor: Claude Code\'s settings may not change during Squire\'s session '
              '({source}{file}). Squire\'s session takes its settings from Squire\'s core only.')

    @classmethod
    def decide(cls, raw):
        try:
            event = json.loads(raw.decode('utf-8'))
        except ValueError:
            event = None
        if not isinstance(event, dict):
            return 2, 'Squire\'s safety floor could not read this settings change, so it is refused.'
        source = event.get('source')
        if source in cls.REFUSED:
            file = event.get('file_path')
            return 2, cls.REASON.format(source=source, file=f': {file}' if isinstance(file, str) and file else '')
        return 0, ''


if __name__ == '__main__':
    try:
        code, message = ConfigChange.decide(sys.stdin.buffer.read())
    except Exception as e:
        code, message = 2, f'Squire\'s safety floor failed ({type(e).__name__}), so this settings change is refused.'
    if message:
        sys.stderr.write(message + '\n')
    sys.exit(code)
