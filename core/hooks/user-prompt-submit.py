"""Records the owner's yes or no, run by Claude Code on every message the
owner sends. Only the owner's own message answers a request.

A message that is just "yes" or "no" answers the one request open in this
job; with more than one open it answers none, and "yes <request>" or
"no <request>" answers that request only. Anything else answers nothing.
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


if __name__ == '__main__':
    try:
        OwnerAnswer.handle(sys.stdin.buffer.read())
    except Exception:
        pass
    sys.exit(0)
