'use strict';

// The guided first conversation on a target Mac (AC-601-3), a release-Verify
// test: it runs only against a target, a Mac with a signed Squire release
// installed for a new owner, reached over SSH as the Squire owner's user.
// The target is a parameter:
//
//   SQUIRE_TARGET_HOST=<ssh destination> node --test tests/e2e/first-conversation.test.js
//
// RCF_TARGET_URL is read when SQUIRE_TARGET_HOST is unset (an ssh:// URL is
// an SSH destination). With neither, the test skips with the line
// "external: needs a target host" and never passes. It refuses to run,
// failing, when the target is the user running the tests on this machine.
//
// The walk is by hand, as the release Verify walks it: the person verifying
// starts Squire for the first time and begins the guided first conversation,
// pauses it part-way by ending the session, starts Squire again and finishes
// it, then asks Squire "Teach me how approvals work". The test waits for the
// walk (at most WALK_MINUTES) and reads, read-only, on the target:
//   - the owner's folder (ownerFolder in the Squire home's squire.json)
//     holds a profile (operator/profile.md), a house style
//     (reference/house-style.md) and a learning log
//     (operator/learning-log.md), each not empty and written during the walk;
//   - the first conversation's record in the owner's folder
//     (state/first-conversation.json, the builder's: pausedAt, resumedAt and
//     finishedAt, seconds since 1970) says it paused, was picked up later
//     and finished, in that order, during the walk;
//   - the session's transcript (Claude Code's projects folder under the
//     Squire home's claude-config) holds the owner's teach-me words and a
//     reply after them. Whether the reply teaches in plain words is read by
//     the person walking it against the house style.
// Nothing is written on the target.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const TARGET = process.env.SQUIRE_TARGET_HOST || process.env.RCF_TARGET_URL || '';
const TARGET_SQUIRE_HOME = process.env.SQUIRE_TARGET_SQUIRE_HOME || '';
const SKIP = TARGET ? false : 'external: needs a target host (SQUIRE_TARGET_HOST, an SSH destination, or RCF_TARGET_URL)';
const WALK_MINUTES = 30;
const TEACH = 'Teach me how approvals work';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function onTarget(command, { input = '', timeout = 60000 } = {}) {
  const exported = TARGET_SQUIRE_HOME ? `export SQUIRE_HOME=${JSON.stringify(TARGET_SQUIRE_HOME)}; ` : '';
  const r = spawnSync('ssh', ['-o', 'BatchMode=yes', TARGET.replace(/^ssh:\/\//, ''), exported + command], { input, encoding: 'utf8', timeout });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error ? String(r.error.message) : '' };
}

// Read-only: what the walk has left on the target, as JSON.
const LOOK = String.raw`
import glob, json, os, pwd, sys, time
home = os.environ.get('SQUIRE_HOME') or os.path.expanduser('~/Library/Application Support/Squire')
uid = os.getuid()
out = {'user': pwd.getpwuid(uid).pw_name, 'host': os.uname().nodename, 'now': time.time()}
try:
    owner = json.load(open(os.path.join(home, 'squire.json'))).get('ownerFolder')
except Exception:
    owner = None
out['ownerFolder'] = bool(owner)
files = {}
for rel in ('operator/profile.md', 'reference/house-style.md', 'operator/learning-log.md'):
    p = os.path.join(owner or '/nonexistent', rel)
    try:
        st = os.stat(p)
        files[rel] = {'size': st.st_size, 'mtime': st.st_mtime}
    except OSError:
        files[rel] = None
out['files'] = files
try:
    out['record'] = json.load(open(os.path.join(owner or '/nonexistent', 'state', 'first-conversation.json')))
except Exception:
    out['record'] = None
taught = []
for f in glob.glob(os.path.join(home, 'claude-config', 'projects', '*', '*.jsonl')):
    asked_at = None
    try:
        lines = open(f, errors='replace').read().splitlines()
    except OSError:
        continue
    for line in lines:
        try:
            e = json.loads(line)
        except ValueError:
            continue
        msg = e.get('message') or {}
        text = msg.get('content')
        if isinstance(text, list):
            text = ' '.join(c.get('text', '') for c in text if isinstance(c, dict))
        if e.get('type') == 'user' and isinstance(text, str) and sys.argv[1].lower() in text.lower():
            asked_at = e.get('timestamp')
        elif e.get('type') == 'assistant' and asked_at and isinstance(text, str) and text.strip():
            taught.append({'askedAt': asked_at, 'replyChars': len(text)})
            asked_at = None
out['taught'] = taught
print(json.dumps(out))
`;

function look() {
  const r = onTarget(`/usr/bin/python3 - ${JSON.stringify(TEACH)}`, { input: LOOK });
  assert.equal(r.status, 0, `reading the target must work; got exit ${r.status}: ${r.stderr.slice(0, 400)} ${r.error}`);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

test("on a signed release, the guided first conversation keeps a profile, a house style and a learning log in the owner's folder, can pause and pick up later, and teaches when asked", { skip: SKIP, timeout: (WALK_MINUTES + 5) * 60000 }, async (t) => {
  if (!TARGET) { t.skip('external: needs a target host'); return; }
  const first = look();
  assert.ok(!(first.user === os.userInfo().username && first.host === os.hostname()),
    'the target must not be the user running the tests on this machine');
  const began = first.now;
  t.diagnostic(`walk the first conversation now: begin it, pause it by ending the session, start Squire again and finish it, then ask "${TEACH}"; waiting up to ${WALK_MINUTES} minutes`);
  const end = Date.now() + WALK_MINUTES * 60000;
  let seen = first;
  const written = (f) => Boolean(f && f.size > 0 && f.mtime >= began);
  const walked = (x) => {
    const r = x.record || {};
    return Object.values(x.files).every(written) && typeof r.pausedAt === 'number' && typeof r.resumedAt === 'number'
      && typeof r.finishedAt === 'number' && x.taught.length > 0;
  };
  while (Date.now() < end) {
    seen = look();
    if (walked(seen)) break;
    await sleep(15000);
  }
  assert.ok(seen.ownerFolder, 'the Squire home must name the owner\'s folder');
  for (const [rel, f] of Object.entries(seen.files)) {
    assert.ok(written(f), `${rel} must be kept in the owner's folder, not empty, written during the first conversation; got ${JSON.stringify(f)}`);
  }
  const r = seen.record || {};
  assert.ok(typeof r.pausedAt === 'number' && typeof r.resumedAt === 'number' && typeof r.finishedAt === 'number',
    `the first conversation's record must say when it paused, was picked up and finished; got ${JSON.stringify(seen.record)}`);
  assert.ok(began <= r.pausedAt && r.pausedAt < r.resumedAt && r.resumedAt <= r.finishedAt,
    `the first conversation paused, was picked up later and finished, in that order, during the walk; got ${JSON.stringify(r)}`);
  assert.ok(seen.taught.length > 0, `asked "${TEACH}", Squire must answer; no reply after those words in the session's transcript`);
});
