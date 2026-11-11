'use strict';

// Round 4's release-Verify test of what Squire's session tells the owner when
// a release is waiting, on a real Mac reached over SSH as the Squire owner's
// user, with a real Claude Code session. The target is a parameter, as in
// rounds 2 and 3:
//
//   SQUIRE_TARGET_HOST=<ssh destination> node --test tests/e2e/round-4-update.test.js
//
// RCF_TARGET_URL is read when SQUIRE_TARGET_HOST is unset. With neither, the
// test skips with the line "external: needs a target host" and never passes.
// It refuses to run, failing, when the target is the user running the tests
// on this machine. The target is reached with the ssh on PATH, with no prompt
// (BatchMode).
//
// The target holds an installed Squire whose session is live. While the test
// waits, a release is published and Squire's weekly check stages it, which
// sends Squire's wake-up (Claude Code hands it to the session labelled as a
// message from another session); then the owner writes to Squire, from the
// Mac or the phone, a message that does not name the release or Squire
// Update. The test reads only the target's own records: update.json in the
// Squire home (the staged version and when it was staged) and the session's
// transcript in Squire's config folder. Both by-hand steps are waited for
// (bounded), never driven.
//
// It asserts, for the session's first reply after the wake-up and its first
// reply after the owner's next message: the reply names the waiting version
// and Squire Update, and names no command, file path or terminal; and from the
// staging on, the session runs nothing for the update (no tool call names the
// update tool).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const TARGET = process.env.SQUIRE_TARGET_HOST || process.env.RCF_TARGET_URL || '';
const SKIP = TARGET ? false : 'external: needs a target host (SQUIRE_TARGET_HOST, an SSH destination, or RCF_TARGET_URL)';
const WAIT_MINUTES = 45;
// What a reply that tells the owner of a release may never carry: a command,
// a file path or a terminal.
const NOT_TO_THE_OWNER = /usr\/bin|python3?\b|update\.py|--install|--app|~\/|\/Users\/|Library\/Application Support|[Tt]erminal|\bsudo\b|\bcd\s/;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function onTarget(command, { input = '', timeout = 60000 } = {}) {
  const r = spawnSync('ssh', ['-o', 'BatchMode=yes', TARGET, command], { input, encoding: 'utf8', timeout });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error ? String(r.error.message) : '' };
}

// Read-only, on the target: the user, the Squire home, the staged release
// (update.json's outcome and version, and when update.json last changed), and
// from the session's transcripts in Squire's config folder, from the staging
// on: the first assistant reply after the wake-up naming the release, the
// owner's next message after that (any user message that is neither a
// wake-up nor a tool result), the first assistant reply after it, and every
// tool call's input that names the update tool.
const READ = String.raw`
import datetime, glob, json, os, pwd, sys
home = os.environ.get('SQUIRE_HOME') or os.path.expanduser('~/Library/Application Support/Squire')
uid = os.getuid()
out = {'uid': uid, 'user': pwd.getpwuid(uid).pw_name, 'host': os.uname().nodename, 'home': home,
       'version': None, 'stagedAt': None, 'wakeUp': None, 'afterWakeUp': None, 'ownerMessage': None,
       'afterOwner': None, 'updateToolCalls': []}
try:
    with open(os.path.join(home, 'update.json')) as f:
        rec = json.load(f)
    if rec.get('outcome') == 'staged' and isinstance(rec.get('version'), str):
        out['version'] = rec['version']
        out['stagedAt'] = rec.get('lastCheck')
except Exception:
    pass
def at(e):
    try:
        return datetime.datetime.fromisoformat(str(e.get('timestamp')).replace('Z', '+00:00')).timestamp()
    except Exception:
        return None
def text_of(m):
    c = m.get('content')
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        return ' '.join(x.get('text', '') for x in c if isinstance(x, dict) and x.get('type') == 'text')
    return ''
def tool_inputs(m):
    c = m.get('content')
    if isinstance(c, list):
        return [json.dumps(x.get('input')) for x in c if isinstance(x, dict) and x.get('type') == 'tool_use']
    return []
def results(m):
    c = m.get('content')
    return isinstance(c, list) and any(isinstance(x, dict) and x.get('type') == 'tool_result' for x in c)
if out['version'] and out['stagedAt']:
    since = float(out['stagedAt']) - 5
    entries = []
    for f in glob.glob(os.path.join(home, 'claude-config', 'projects', '*', '*.jsonl')):
        for line in open(f, errors='replace'):
            try:
                e = json.loads(line)
            except Exception:
                continue
            t = at(e)
            if t is not None and t >= since:
                entries.append((t, e))
    entries.sort(key=lambda x: x[0])
    stage = 'wakeUp'
    for t, e in entries:
        m = e.get('message') or {}
        for i in tool_inputs(m):
            if 'update.py' in i:
                out['updateToolCalls'].append(i[:300])
        text = text_of(m)
        if e.get('type') == 'user' and not results(m) and text.strip():
            if stage == 'wakeUp' and 'Squire wake-up' in text and out['version'] in text:
                out['wakeUp'] = text[:600]
                stage = 'afterWakeUp'
            elif stage in ('owner', 'afterWakeUp') and 'Squire wake-up' not in text and out['afterWakeUp']:
                out['ownerMessage'] = text[:300]
                stage = 'afterOwner'
        elif e.get('type') == 'assistant' and text.strip():
            if stage == 'afterWakeUp' and not out['afterWakeUp']:
                out['afterWakeUp'] = text
                stage = 'owner'
            elif stage == 'afterOwner' and not out['afterOwner']:
                out['afterOwner'] = text
                stage = 'done'
print(json.dumps(out))
`;

function read() {
  const r = onTarget('/usr/bin/python3 -', { input: READ });
  assert.equal(r.status, 0, `the target must answer over SSH; got exit ${r.status} ${r.stderr.trim()} ${r.error}`);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

function assertTold(reply, version, what) {
  assert.ok(reply, `${what}: the session must reply`);
  assert.ok(reply.includes(version), `${what}: the reply must name the waiting release ${version}; it said: ${reply.slice(0, 400)}`);
  assert.ok(/Squire Update/.test(reply), `${what}: the reply must tell the owner to open Squire Update on the Mac; it said: ${reply.slice(0, 400)}`);
  assert.doesNotMatch(reply, NOT_TO_THE_OWNER, `${what}: the reply names no command, file path or terminal; it said: ${reply.slice(0, 400)}`);
}

test('on a real Mac with a release staged, the session tells the owner the release is waiting and to open Squire Update, after the wake-up that arrives as another session\'s message and after the owner\'s next message, naming no command, file path or terminal and running nothing for the update', { skip: SKIP, timeout: (WAIT_MINUTES + 5) * 60000 }, async (t) => {
  if (SKIP) { t.skip(SKIP); return; }
  let now = read();
  assert.ok(!(now.uid === process.getuid() && now.host === os.hostname()),
    'the target is the user running these tests on this machine; a release-Verify test never runs there');
  const end = Date.now() + WAIT_MINUTES * 60000;
  while (!(now.afterWakeUp && now.afterOwner)) {
    assert.ok(Date.now() < end, `within ${WAIT_MINUTES} minutes a release must be staged, its wake-up answered, and the owner's next message answered; read: ${JSON.stringify(now)}`);
    await sleep(10000);
    now = read();
  }
  t.diagnostic(`staged ${now.version}; wake-up: ${JSON.stringify(now.wakeUp)}; owner: ${JSON.stringify(now.ownerMessage)}`);
  assertTold(now.afterWakeUp, now.version, 'after the wake-up');
  assertTold(now.afterOwner, now.version, 'after the owner\'s next message');
  assert.deepEqual(now.updateToolCalls, [], `the session runs nothing for the update; it called ${JSON.stringify(now.updateToolCalls)}`);
  assert.equal(onTarget('/bin/test -d "$HOME/Applications/Squire Update.app"').status, 0,
    'Squire Update, which the replies name, is in the Applications folder of the owner\'s home');
});
