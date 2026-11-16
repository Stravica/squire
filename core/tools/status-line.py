"""Claude Code's status line command for Squire's session, set in core's
settings (statusLine, type command) and run as the hooks are:

    /usr/bin/python3 -B "${SQUIRE_HOME}/core/tools/status-line.py"

With the status line JSON on stdin it writes the usage snapshot,
runtime/usage.json in the Squire home, whole, through a file beside it and a
rename, mode 0600, holding exactly: at (seconds since 1970, when written),
model (model.id), contextUsedPercent (context_window.used_percentage, or
null), and fiveHour and sevenDay, each {usedPercent, resetsAt} from
rate_limits.five_hour and rate_limits.seven_day, or null when that window is
absent or its used_percentage or resets_at is not a number. Nothing else: no
prompt, path, session id, token or cost. A window seen at 100% is recorded
in runtime/limits.json, once per window and reset, for the upgrade advice.

It prints at most one plain line for the status display, and always exits
0; input it cannot read as JSON changes nothing, so the snapshot only ages.
The Squire home is SQUIRE_HOME, or the default one when that is unset.
"""

import json
import os
import sys
import time

CORE = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
sys.path.insert(0, os.path.join(CORE, 'lib'))

# Each window: its key in the snapshot, its field in rate_limits and its name on the status display.
FIELDS = (('fiveHour', 'five_hour', '5-hour'), ('sevenDay', 'seven_day', 'weekly'))
LIMIT_AT = 100
KEEP = 30 * 86400


def snapshot_of(data, now):
    """The usage snapshot the status line input gives; None when the input
    is not a JSON object."""
    from squire import is_number

    if not isinstance(data, dict):
        return None
    model = data.get('model')
    model = model.get('id') if isinstance(model, dict) else None
    context = data.get('context_window')
    context = context.get('used_percentage') if isinstance(context, dict) else None
    limits = data.get('rate_limits')
    snapshot = {'at': int(now), 'model': model if isinstance(model, str) else None,
                'contextUsedPercent': context if is_number(context) else None}
    for key, field, _ in FIELDS:
        window = limits.get(field) if isinstance(limits, dict) else None
        used = window.get('used_percentage') if isinstance(window, dict) else None
        resets = window.get('resets_at') if isinstance(window, dict) else None
        snapshot[key] = {'usedPercent': min(max(used, 0), 100), 'resetsAt': resets} \
            if is_number(used) and is_number(resets) else None
    return snapshot


def note_limits(home, snapshot, now):
    """Records each window seen at 100% in runtime/limits.json, once per
    window and reset (resets within a minute of each other are one), with
    when it was first seen; records older than 30 days are dropped."""
    from squire import SAME_LIMIT, Runtime, is_number

    seen = [(key, snapshot[key]['resetsAt']) for key, _, _ in FIELDS
            if snapshot[key] and snapshot[key]['usedPercent'] >= LIMIT_AT]
    if not seen:
        return

    def change(data):
        kept = [limit for limit in (data.get('limits') if isinstance(data.get('limits'), list) else [])
                if isinstance(limit, dict) and is_number(limit.get('seenAt')) and now - limit['seenAt'] < KEEP]
        added = False
        for key, resets_at in seen:
            if not any(limit.get('window') == key and is_number(limit.get('resetsAt'))
                       and abs(limit['resetsAt'] - resets_at) <= SAME_LIMIT for limit in kept):
                kept.append({'window': key, 'resetsAt': resets_at, 'seenAt': int(now)})
                added = True
        return {'limits': kept} if added else None

    Runtime.update(home, 'limits.json', change)


def main():
    from squire import Config, Records, Runtime, percent_words

    try:
        data = json.loads(sys.stdin.buffer.read().decode('utf-8'))
    except (OSError, ValueError):
        return
    now = time.time()
    snapshot = snapshot_of(data, now)
    if snapshot is None:
        return
    home = Config.default_home()
    Records.write(Runtime.path(home, 'usage.json'), snapshot)
    note_limits(home, snapshot, now)
    shown = [f'{name} {percent_words(snapshot[key]["usedPercent"])}' for key, _, name in FIELDS if snapshot[key]]
    if shown:
        print(', '.join(shown))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
