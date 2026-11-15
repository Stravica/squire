'use strict';

// Before a big job, Squire warns the owner and waits for their yes
// (AC-1302-1), through the real entry points: lay-down (what the session
// loads), the safety floor (core/hooks/pre-tool-use.py) for the job's start,
// the owner's answer through core/hooks/user-prompt-submit.py, and the job
// command itself once the floor lets it run. The design record for plan
// awareness and the heavy-job gate (ADR-006 line 6) fixes the one command a
// big job starts through (core/tools/heavy-job.py research|app|site|media),
// the words that name each kind of job and "big job", and the second yes above
// 90%; the rest of the wording is the builder's.
//
// Usage model for the second yes (assumptions, none measured; ADR-006's
// consequences):
//   typical  five-hour 30 to 60%, weekly 20 to 50%: one yes starts a big job.
//            Cases use five-hour 30% and weekly 40%, and 60% and 50%.
//   heavy    a day of big jobs: a window above 90%. Cases use five-hour 92%
//            (weekly 50%) and weekly 91% (five-hour 20%): a second yes.
//
// The class is open (any job big enough to be heavy, any way to start one):
// the four kinds are instances; the gate decides it by the one command the
// session is told to use and by refusing the command spelt any other way.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const w = require('../fixtures/squire-world.js');
const s = require('../fixtures/session-world.js');
const U = require('../fixtures/usage-world.js');

function calmUsage(world, five = 30, week = 40) {
  U.writeSnapshot(world, {
    fiveHour: { used: five, resetsAt: U.onMinute(U.now() + 3 * 3600) },
    sevenDay: { used: week, resetsAt: U.onMinute(U.now() + 4 * U.DAY) },
  });
}

test("a big job of each kind (deep research, building an app, building a site, video and audio work) is warned of and starts only on the owner's yes for that job, and no other way of starting it gets round the gate", { timeout: 120000 }, (t) => {
  const world = U.usageWorld(t, { core: false });
  const laid = w.layDown(world, w.CORE);
  assert.equal(laid.status, 0, `laying down core must succeed; got ${w.describe(laid)}`);
  calmUsage(world);

  for (const kind of Object.keys(U.HEAVY)) {
    const job = `job-${kind}`;
    const first = w.attempt(world, job, U.heavyJob(world, kind), { env: U.UTC });
    w.assertBlocked(first, `${kind}: a big job with no yes`);
    assert.match(first.stderr, /big job/i, `${kind}: the floor warns the owner first that this is a big job; got ${w.describe(first)}`);
    assert.match(first.stderr, U.HEAVY[kind], `${kind}: the warning names the job in plain words; got ${w.describe(first)}`);
    const id = w.requestIdIn(first.stderr);
    assert.ok(id, `${kind}: the warning names the request the owner answers; got ${w.describe(first)}`);
    w.ownerSays(world, job, `yes ${id}`, { env: U.UTC });
    const other = kind === 'research' ? 'app' : 'research';
    w.assertBlocked(w.attempt(world, job, U.heavyJob(world, other), { env: U.UTC }),
      `a yes to ${kind} does not start ${other}`);
    w.assertAllowed(w.attempt(world, job, U.heavyJob(world, kind), { env: U.UTC }), `${kind} once the owner said yes to it`);
    const ran = w.runPython(world, U.heavyJobScript(world), [kind], { env: U.UTC });
    assert.equal(ran.status, 0, `${kind}: the job command, let through, runs and exits 0; got ${w.describe(ran)}`);
    assert.match(ran.stdout, /started/i, `${kind}: the job command says the job has started on the owner's yes; got ${w.describe(ran)}`);
    w.assertBlocked(w.attempt(world, job, U.heavyJob(world, kind), { env: U.UTC }), `${kind} again: a yes covers one start`);
  }

  // What the session loads tells it to start every big job through the command.
  const loaded = fs.readFileSync(path.join(s.configDir(world), 'CLAUDE.md'), 'utf8');
  assert.ok(loaded.includes(U.heavyJobScript(world)),
    `what the session loads must name the big-job command by its path in the Squire home; got ${JSON.stringify(loaded.slice(0, 400))}`);

  // Any other way of starting it is refused: the owner's yes does not lift it.
  const script = U.heavyJobScript(world);
  const around = {
    'inside a shell': `/bin/zsh -c "/usr/bin/python3 '${script}' research"`,
    'chained after another command': `echo starting && /usr/bin/python3 '${script}' research`,
    'from inside core': `cd '${path.dirname(script)}' && /usr/bin/python3 heavy-job.py research`,
  };
  for (const [how, command] of Object.entries(around)) {
    const job = `job-around-${how.replace(/\s+/g, '-')}`;
    const r = w.attempt(world, job, w.tools.bash(command), { env: U.UTC });
    w.assertBlocked(r, `a big job started ${how}, with no yes`);
    U.sayYesTo(world, job, r, { env: U.UTC });
    w.assertBlocked(w.attempt(world, job, w.tools.bash(command), { env: U.UTC }), `a big job started ${how}: refused, even after a yes`);
  }
});

test('above 90% in either usage window a big job starts only on a second yes; below it one yes starts it', { timeout: 60000 }, (t) => {
  const heavy = { 'the five-hour window at 92%': [92, 50], 'the weekly window at 91%': [20, 91] };
  for (const [what, [five, week]] of Object.entries(heavy)) {
    const world = U.usageWorld(t);
    calmUsage(world, five, week);
    const job = 'job-heavy';
    const first = w.attempt(world, job, U.heavyJob(world, 'media'), { env: U.UTC });
    w.assertBlocked(first, `${what}: a big job with no yes`);
    const firstId = U.sayYesTo(world, job, first, { env: U.UTC });
    const second = w.attempt(world, job, U.heavyJob(world, 'media'), { env: U.UTC });
    w.assertBlocked(second, `${what}: after the first yes the big job still waits`);
    assert.match(second.stderr, /second yes/i, `${what}: above 90% the floor asks for a second yes; got ${w.describe(second)}`);
    const secondId = w.requestIdIn(second.stderr);
    assert.ok(secondId && secondId !== firstId, `${what}: the second yes is its own request; got ${w.describe(second)}`);
    w.ownerSays(world, job, `yes ${secondId}`, { env: U.UTC });
    w.assertAllowed(w.attempt(world, job, U.heavyJob(world, 'media'), { env: U.UTC }), `${what}: the big job once both yeses are given`);
  }

  // Typical: five-hour 60%, weekly 50%: one yes.
  const world = U.usageWorld(t);
  calmUsage(world, 60, 50);
  const first = w.attempt(world, 'job-calm', U.heavyJob(world, 'media'), { env: U.UTC });
  w.assertBlocked(first, 'below 90%: a big job with no yes');
  U.sayYesTo(world, 'job-calm', first, { env: U.UTC });
  w.assertAllowed(w.attempt(world, 'job-calm', U.heavyJob(world, 'media'), { env: U.UTC }), 'below 90%: one yes starts the big job');
});
