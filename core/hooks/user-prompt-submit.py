"""Records the owner's yes or no, and adds Squire's own notes (a release is
waiting; the weekly allowance; the upgrade advice; the handover note and the
/clear prompt), run by Claude Code on every message the owner sends. Only
the owner's own message answers a request.

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


class UsageNotes:
    """Squire's own notes from the plan's usage and the conversation's
    length, each a line of its own starting with the release note's head,
    added to an owner's message that is not a bare yes or no (never to a
    "Squire wake-up:" message, Squire's own background work):

    - the weekly line, when the weekly window is above 70% in a known usage
      snapshot: on the first such message of the local day, once a day;
    - the upgrade advice, once its trigger is met (squire.advice_due), then
      quiet for 30 days from when it was given, whatever the answer; it is
      recorded in runtime/advice.json before it is printed;
    - the handover ask, when this conversation's own context is at or above
      70% or after the session's second compaction, on each message until
      the note is saved
      at state/handover/<session id>.md in the owner's folder; it names what
      the note holds and never mentions /clear;
    - the /clear prompt, once that note is saved and not empty, once per
      start of the session (a restart or a compaction brings it back), until
      a /clear picks the note up.

    Every message is counted in runtime/messages.json, its time and whether
    it is the owner's own, never its text; counts older than 30 days go."""

    WAKE_UP = 'Squire wake-up:'
    SESSION = re.compile(r'^[A-Za-z0-9-]+\Z')
    KEEP = 30 * 86400
    WEEKLY = ('the weekly allowance of the owner\'s Claude plan is at {percent}, and it resets {when}. Tell the owner, '
              'and suggest lighter work for routine jobs until then.')
    ADVICE = ('tell the owner plainly that a bigger Claude plan would help: the plan\'s limits have been reached often '
              'lately, mostly on their own requests. Squire has changed nothing. End with these words: "Your call. '
              'Type /upgrade if you want to look."')
    ASK = ('this conversation is getting long. Save your handover note now with the Write tool, as a new file, at '
           '{path}: the work in progress, what is done, what is next, and where things are, so that nothing is lost.')
    CLEAR = ('the handover note is saved at {path}, so nothing will be lost. At this natural pause, ask the owner to '
             'type /clear when they are ready: the fresh conversation picks the work up from the note.')

    @classmethod
    def handle(cls, raw):
        sys.path.insert(0, os.path.join(CORE, 'lib'))
        from squire import Config, paced_windows, percent_words, read_usage, reset_words

        event = json.loads(raw.decode('utf-8'))
        if not isinstance(event, dict) or event.get('hook_event_name') != 'UserPromptSubmit':
            return
        prompt, session = event.get('prompt'), event.get('session_id')
        if not isinstance(prompt, str) or not isinstance(session, str) or not session:
            return
        config, now = Config(), time.time()
        own = not prompt.lstrip().startswith(cls.WAKE_UP)
        messages = cls.count(config.home, now, own)
        if not own or OwnerAnswer.PATTERN.match(prompt.strip()):
            return
        usage = read_usage(config.home, now)
        notes = []
        weekly = next((window for key, _, window in paced_windows(usage) if key == 'sevenDay'), None)
        if weekly and cls.first_today(config.home, now):
            notes.append(cls.WEEKLY.format(percent=percent_words(weekly['usedPercent']),
                                           when=reset_words(weekly['resetsAt'], now)))
        if cls.advice(config.home, now, messages):
            notes.append(cls.ADVICE)
        handover = cls.handover(config, session, usage)
        if handover:
            notes.append(handover)
        for note in notes:
            print(ReleaseNote.HEAD + note)

    @classmethod
    def count(cls, home, now, own):
        """Counts this message; every message counted in the last 30 days."""
        from squire import Runtime, is_number

        def change(data):
            old = data.get('messages') if isinstance(data.get('messages'), list) else []
            kept = [m for m in old if isinstance(m, dict) and is_number(m.get('at')) and 0 <= now - m['at'] < cls.KEEP]
            return {'messages': kept + [{'at': int(now), 'own': own}]}

        return Runtime.update(home, 'messages.json', change)['messages']

    @staticmethod
    def first_today(home, now):
        """True once a local day: the weekly line's record holds the day."""
        from squire import Runtime

        day = time.strftime('%Y-%m-%d', time.localtime(now))
        return Runtime.update(home, 'weekly-note.json', lambda data: None if data.get('day') == day else {'day': day}) \
            is not None

    @staticmethod
    def advice(home, now, messages):
        """True when the advice is due now; it is then recorded as given. A
        record whose givenAt cannot be read, or lies ahead, reads as given
        now and is written again."""
        from squire import Runtime, advice_due, is_number

        path = Runtime.path(home, 'advice.json')
        limits = Runtime.read(home, 'limits.json').get('limits')
        limits = limits if isinstance(limits, list) else []
        given = []

        def change(data):
            present = os.path.lexists(path)
            at = data.get('givenAt') if present else None
            if present and (not is_number(at) or at > now + 60):
                return {'givenAt': int(now)}
            if not advice_due(limits, messages, at, now):
                return None
            given.append(now)
            return {'givenAt': int(now)}

        Runtime.update(home, 'advice.json', change)
        return bool(given)

    @classmethod
    def handover(cls, config, session, usage):
        """The handover ask or the /clear prompt due for this session, or None.
        The ask reads this conversation's own context reading only
        (squire.context_of); the usage windows stay the account's."""
        from squire import Runtime, context_of, handover_due

        if not cls.SESSION.match(session):
            return None
        note = os.path.join(config.owner_folder, 'state', 'handover', session + '.md')
        state = Runtime.read(config.home, 'handover.json')
        picked = state.get('pickedUp') if isinstance(state.get('pickedUp'), list) else []
        if note in picked:
            return None
        try:
            saved = os.path.isfile(note) and os.path.getsize(note) > 0
        except OSError:
            saved = False
        if not saved:
            sessions = state.get('sessions') if isinstance(state.get('sessions'), dict) else {}
            mine = sessions.get(session) if isinstance(sessions.get(session), dict) else {}
            compactions = mine.get('compactions') if isinstance(mine.get('compactions'), int) else 0
            context = context_of(config.home, session, usage, time.time())
            return cls.ASK.format(path=note) if handover_due(context, compactions) else None

        def change(data):
            sessions = data.get('sessions') if isinstance(data.get('sessions'), dict) else {}
            mine = dict(sessions.get(session)) if isinstance(sessions.get(session), dict) else {}
            if mine.get('clearPeriod') == mine.get('period', 0):
                return None
            mine['clearPeriod'] = mine.get('period', 0)
            sessions[session] = mine
            return {**data, 'sessions': sessions}

        return cls.CLEAR.format(path=note) if Runtime.update(config.home, 'handover.json', change) else None


if __name__ == '__main__':
    try:
        raw = sys.stdin.buffer.read()
    except Exception:
        raw = b''
    for handler in (OwnerAnswer, ReleaseNote, UsageNotes):
        try:
            handler.handle(raw)
        except Exception:
            pass
    sys.exit(0)
