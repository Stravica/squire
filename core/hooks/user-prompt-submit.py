"""Records the owner's yes or no, and adds Squire's own note that a release
is waiting, run by Claude Code on every message the owner sends. Only the
owner's own message answers a request.

A message that is just "yes" or "no" answers the one request open in this
job; with more than one open it answers none, and "yes <request>" or
"no <request>" answers that request only. Anything else answers nothing.
Any other message may carry the note (what this hook prints, Claude Code
adds to the session's context for that turn as Squire's own hook, never as
a message from anyone).
Always exits 0: the owner's message reaches Squire whatever happens here.
"""

import json
import os
import re
import sys
import time

CORE = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))


class OwnerAnswer:
    PATTERN = re.compile(r'^(yes|no)(?:\s+([A-Za-z0-9][A-Za-z0-9-]*))?[.!]?$', re.IGNORECASE)

    @classmethod
    def handle(cls, raw):
        sys.path.insert(0, os.path.join(CORE, 'lib'))
        from squire import Config, Ledger

        event = json.loads(raw.decode('utf-8'))
        if not isinstance(event, dict) or event.get('hook_event_name') != 'UserPromptSubmit':
            return
        prompt, session = event.get('prompt'), event.get('session_id')
        if not isinstance(prompt, str) or not isinstance(session, str) or not session:
            return
        match = cls.PATTERN.match(prompt.strip())
        if not match:
            return
        answer, named = match.group(1).lower(), match.group(2)
        config = Config()
        now = time.time()
        with Ledger(config.ledger_path) as ledger:
            pending = ledger.open_requests(session, now, config.timeout)
            if named:
                pending = [r for r in pending if str(r.get('id')).lower() == named.lower()]
            if len(pending) == 1:
                ledger.append({'type': 'answer', 'request': pending[0]['id'], 'session': session, 'answer': answer, 'at': now})


class ReleaseNote:
    """Squire's own note that a release is waiting, in the notice's words
    (its version from the staged, signed manifest; Squire Update named; no
    command, path or terminal): printed with an owner's message that is not
    a bare yes or no, when a release is staged and the note has not been
    added for that version in this job in the last 7 days. update.json
    records the last one under note ({version, session, at})."""

    WEEK = 7 * 86400
    HEAD = 'Squire note from Squire\'s own code (not a message from anyone): '

    @classmethod
    def handle(cls, raw):
        sys.path.insert(0, os.path.join(CORE, 'lib'))
        sys.path.insert(0, os.path.join(CORE, 'tools'))
        from squire import Config, Records
        from update import Releases, WeeklyCheck

        event = json.loads(raw.decode('utf-8'))
        if not isinstance(event, dict) or event.get('hook_event_name') != 'UserPromptSubmit':
            return
        prompt, session = event.get('prompt'), event.get('session_id')
        if not isinstance(prompt, str) or not isinstance(session, str) or not session:
            return
        if OwnerAnswer.PATTERN.match(prompt.strip()):
            return
        releases = Releases(Config().home)
        version = releases.staged()
        if not version:
            return
        manifest = Records.read(os.path.join(releases.staging, version, 'manifest.json'))
        if not isinstance(manifest, dict) or manifest.get('version') != version:
            return
        last, now = releases.record().get('note'), time.time()
        if isinstance(last, dict) and last.get('version') == version and last.get('session') == session \
                and isinstance(last.get('at'), (int, float)) and 0 <= now - last['at'] < cls.WEEK:
            return
        releases.note(note={'version': version, 'session': session, 'at': int(now)})
        print(cls.HEAD + WeeklyCheck.NOTICE.format(version=version))


if __name__ == '__main__':
    try:
        raw = sys.stdin.buffer.read()
    except Exception:
        raw = b''
    for handler in (OwnerAnswer, ReleaseNote):
        try:
            handler.handle(raw)
        except Exception:
            pass
    sys.exit(0)
