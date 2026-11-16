'use strict';

// The Squire owner sets, changes or stops a check-in by asking Squire, and
// Squire writes it where its check-ins are read (AC-702-1), through the real
// entry points: Squire's check-in command, run as the session runs a command
// once the owner has asked (a process with /usr/bin/python3 from the Squire
// home, in the product's environment), and the wake-up router's scheduler
// run (core/tools/wake-up.py --due), which reads the owner's check-ins.
// Delivery to the owner's session is AC-701-1's and is not proven here: the
// worlds hold no session, so a check-in the router reads is recorded, never
// sent.
//
// What the builder provides (none of it exists at the base head; the names
// are this file's, and a case fails at its own first assertion while they
// are absent):
//   core/tools/check-ins.py set <HH:MM> <words>
//   core/tools/check-ins.py change <HH:MM now> <HH:MM new>
//   core/tools/check-ins.py stop <HH:MM>
//   core/tools/check-ins.py every <minutes> <HH:MM first> <HH:MM last> <words>
//       each writes wakeUps in the owner's squire.json, one "HH:MM words"
//       entry per check-in in local time (the form the router reads), leaves
//       every other entry and setting as it was, exits 0 and says in a line
//       what it set. A time the router could not read, no words, a rhythm of
//       no minutes, or a change or stop of a check-in that is not there is
//       never written: it exits non-zero, says why, and the file is unchanged.
//
// Usage model for the rhythm (assumptions, none measured): each check-in is
// one message to the owner's session, a job that can wait under the plan's
// pacing (no cap is set).
//   typical  one or two a day (a morning brief, an evening wrap-up), or
//            hourly through a working morning: no word about the plan.
//   heavy    every 30 minutes through a morning, up to every 15 minutes all
//            day (96 a day): set as asked, with one plain sentence that
//            frequent check-ins use the plan faster (the sentence's wording
//            is a draft the stage-keeper rules).
// Every case runs with TZ=UTC, so the Mac's local time is UTC.
//
// The session sets a check-in only on the owner's yes, through the safety
// floor (core/hooks/pre-tool-use.py, the event on stdin, the owner's answer
// through core/hooks/user-prompt-submit.py), as the design record for the
// Rule of Two's marks has it (ADR-002 line 12): the check-in command spelt
// /usr/bin/python3 '<Squire home>/core/tools/check-ins.py' ... is asked, its
// question naming the time and the words, and a yes covers that one run;
// spelt any other way it is refused, yes or no; and an Edit of the owner's
// squire.json, where the check-ins are read, is asked. Today the floor
// refuses every program naming Squire's home. The class is open (any way to
// set a check-in); the answer for a way the floor cannot read as the one
// command is to refuse it, and for a change to the file to ask.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const w = require('../fixtures/squire-world.js');
const s = require('../fixtures/session-world.js');
const U = require('../fixtures/usage-world.js');

const script = (world) => path.join(world.home, 'core', 'tools', 'check-ins.py');
const ownerFile = (world) => path.join(world.owner, 'squire.json');
const owner = (world) => JSON.parse(fs.readFileSync(ownerFile(world), 'utf8'));
const others = (config) => { const { wakeUps, ...rest } = config; return rest; };
const PLAN_FASTER = /check-ins? (?:\w+ )?use[s]? (?:up )?(?:the|your) (?:Claude )?plan faster/i;

function checkInWorld(t) {
  const world = U.usageWorld(t);
  t.after(() => s.killFakes(world));
  return world;
}

function checkIns(world, args) {
  return w.runPython(world, script(world), args, { env: U.UTC });
}

function asked(world, args, what) {
  const r = checkIns(world, args);
  assert.equal(r.status, 0, `${what}: Squire's check-in command (core/tools/check-ins.py ${args.join(' ')}) must do it and exit 0; got ${w.describe(r)}`);
  return r;
}

const pad = (n) => String(n).padStart(2, '0');
const hhmm = (minutes) => { const m = ((minutes % 1440) + 1440) % 1440; return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`; };

test("a check-in the owner asks for is set in their squire.json in the form the check-ins are read from, nothing else in it changes, and the scheduler's run reads it", { timeout: 60000 }, (t) => {
  const world = checkInWorld(t);
  const before = owner(world);
  // Typical: a morning brief and an evening wrap-up.
  const r = asked(world, ['set', '07:30', 'Morning brief'], 'a check-in at 07:30');
  assert.ok(r.stdout.includes('07:30'), `Squire says what it set, naming the time; got ${w.describe(r)}`);
  asked(world, ['set', '17:00', 'Wrap up the day'], 'a check-in at 17:00');
  const after = owner(world);
  assert.deepEqual(after.wakeUps, [...before.wakeUps, '07:30 Morning brief', '17:00 Wrap up the day'],
    `the check-ins are kept in wakeUps as "HH:MM words", beside the ones already there; got ${JSON.stringify(after.wakeUps)}`);
  assert.deepEqual(others(after), others(before), 'nothing else in the owner\'s squire.json may change');

  // One set for three hours ago is read by the scheduler's run: with no
  // session in the world it is recorded missed with its time and words.
  const now = new Date();
  const due = hhmm(now.getUTCHours() * 60 + now.getUTCMinutes() - 180);
  asked(world, ['set', due, 'Look over the orders.'], `a check-in at ${due}`);
  const ran = s.runDueWakeUps(world, { env: U.UTC });
  assert.equal(ran.status, 0, `the scheduler's run must exit 0; got ${w.describe(ran)}`);
  const states = s.wakeUpStates(world);
  const read = states.find((x) => x.text === 'Look over the orders.');
  assert.ok(read && read.due === due, `the router must read the check-in set by asking (a state with due ${due} and its words); got ${JSON.stringify(states)}`);
});

test('a check-in the owner asks to move is changed, and one they ask to stop is removed, and the rest stay as they were', { timeout: 60000 }, (t) => {
  const world = checkInWorld(t);
  const before = owner(world);
  assert.ok(before.wakeUps.includes('08:00 morning brief'), 'the owner starts with a check-in at 08:00');
  asked(world, ['set', '17:00', 'Wrap up the day'], 'a check-in at 17:00');
  const moved = asked(world, ['change', '08:00', '09:15'], 'moving the 08:00 check-in to 09:15');
  assert.ok(moved.stdout.includes('09:15'), `Squire says what it changed, naming the new time; got ${w.describe(moved)}`);
  let now = owner(world);
  assert.ok(now.wakeUps.includes('09:15 morning brief') && !now.wakeUps.some((e) => e.startsWith('08:00')),
    `the check-in moves to 09:15 with its words, and none is left at 08:00; got ${JSON.stringify(now.wakeUps)}`);
  asked(world, ['stop', '09:15'], 'stopping the 09:15 check-in');
  now = owner(world);
  assert.deepEqual(now.wakeUps, ['17:00 Wrap up the day'], `only the stopped check-in goes; got ${JSON.stringify(now.wakeUps)}`);
  assert.deepEqual(others(now), others(before), 'nothing else in the owner\'s squire.json may change');
});

test('a rhythm more often than hourly is set as asked, with one plain sentence that frequent check-ins use the plan faster; hourly or slower carries no such sentence', { timeout: 60000 }, (t) => {
  const world = checkInWorld(t);
  const start = owner(world).wakeUps;
  // Typical: hourly through a working morning.
  const hourly = asked(world, ['every', '60', '09:00', '12:00', 'Tidy the inbox'], 'hourly from 09:00 to 12:00');
  assert.doesNotMatch(hourly.stdout, /plan/i, `an hourly rhythm needs no word about the plan; got ${w.describe(hourly)}`);
  assert.deepEqual(owner(world).wakeUps, [...start, ...['09:00', '10:00', '11:00', '12:00'].map((x) => `${x} Tidy the inbox`)],
    `hourly from 09:00 to 12:00 is four check-ins; got ${JSON.stringify(owner(world).wakeUps)}`);

  // Heavy: every 30 minutes through a morning.
  const half = asked(world, ['every', '30', '09:00', '11:00', 'Check the oven'], 'every 30 minutes from 09:00 to 11:00');
  assert.match(half.stdout, PLAN_FASTER, `a rhythm more often than hourly is set with one plain sentence that frequent check-ins use the plan faster; got ${w.describe(half)}`);
  assert.equal((half.stdout.match(/plan/gi) || []).length, 1, `one sentence about the plan, no more; got ${w.describe(half)}`);
  const oven = owner(world).wakeUps.filter((e) => e.endsWith(' Check the oven'));
  assert.deepEqual(oven, ['09:00', '09:30', '10:00', '10:30', '11:00'].map((x) => `${x} Check the oven`),
    `every 30 minutes from 09:00 to 11:00 is set as asked; got ${JSON.stringify(oven)}`);

  // Heavy: every 15 minutes all day, 96 check-ins: no cap.
  const quarter = asked(world, ['every', '15', '00:00', '23:45', 'Glance at the orders'], 'every 15 minutes all day');
  assert.match(quarter.stdout, PLAN_FASTER, `every 15 minutes is set with the sentence about the plan; got ${w.describe(quarter)}`);
  const glance = owner(world).wakeUps.filter((e) => e.endsWith(' Glance at the orders'));
  assert.equal(glance.length, 96, `every 15 minutes all day is 96 check-ins, set as asked with no cap; got ${glance.length}`);
});

test('a time the check-ins cannot be read at, no words, a rhythm of no minutes, or a change or stop of a check-in that is not there is never written: Squire says why and the settings are unchanged', { timeout: 60000 }, (t) => {
  const world = checkInWorld(t);
  const bytes = fs.readFileSync(ownerFile(world));
  const rows = {
    'an hour past 23': ['set', '24:00', 'Late check'],
    'a minute past 59': ['set', '07:60', 'Odd check'],
    'a time with a dot': ['set', '7.30', 'Morning brief'],
    'a time with one digit for the minutes': ['set', '07:5', 'Morning brief'],
    'no words': ['set', '07:30', '   '],
    'words with a new line': ['set', '07:30', 'Morning\nbrief'],
    'a rhythm of no minutes': ['every', '0', '09:00', '10:00', 'Check the oven'],
    'a change of a check-in that is not there': ['change', '06:00', '07:00'],
    'a stop of a check-in that is not there': ['stop', '06:00'],
  };
  for (const [what, args] of Object.entries(rows)) {
    const r = checkIns(world, args);
    assert.doesNotMatch(r.stderr, /can't open file|Traceback \(most recent call last\)/,
      `${what}: Squire's check-in command (core/tools/check-ins.py) must read it and say why it refuses, not fail; got ${w.describe(r)}`);
    assert.ok(r.status !== 0 && r.status !== null, `${what}: Squire's check-in command must refuse it (a non-zero exit); got ${w.describe(r)}`);
    assert.ok((r.stdout + r.stderr).trim().length > 0, `${what}: Squire says why; got ${w.describe(r)}`);
    assert.deepEqual(fs.readFileSync(ownerFile(world)), bytes, `${what}: the owner's squire.json must be unchanged`);
  }
});

test("the session sets a check-in only on the owner's yes: the check-in command is asked first, naming the time and the words; spelt any other way it is refused, yes or no; and an Edit of the owner's squire.json is asked", { timeout: 60000 }, (t) => {
  const world = checkInWorld(t);
  const command = `/usr/bin/python3 '${script(world)}' set 07:30 'Morning brief'`;
  const job = 'job-check-in';
  const first = w.attempt(world, job, w.tools.bash(command), { env: U.UTC });
  w.assertBlocked(first, 'the session setting a check-in with no yes');
  const id = w.requestIdIn(first.stderr);
  assert.ok(id, `the check-in command spelt as the floor asks is asked (a request the owner answers), not refused; got ${w.describe(first)}`);
  assert.ok(first.stderr.includes('07:30') && first.stderr.includes('Morning brief'),
    `the question names the check-in's time and words; got ${w.describe(first)}`);
  w.ownerSays(world, job, `yes ${id}`, { env: U.UTC });
  w.assertAllowed(w.attempt(world, job, w.tools.bash(command), { env: U.UTC }), 'the check-in once the owner said yes to it');
  w.assertBlocked(w.attempt(world, job, w.tools.bash(command), { env: U.UTC }), 'the same check-in again: a yes covers one run');

  // Any other way of running it is refused: the owner's yes does not lift it.
  const tools = path.dirname(script(world));
  const around = {
    'inside a shell': `/bin/zsh -c "/usr/bin/python3 '${script(world)}' set 07:30 'Morning brief'"`,
    'chained after another command': `echo setting && /usr/bin/python3 '${script(world)}' set 07:30 'Morning brief'`,
    'from inside core': `cd '${tools}' && /usr/bin/python3 check-ins.py set 07:30 'Morning brief'`,
  };
  for (const [how, spelt] of Object.entries(around)) {
    const other = `job-check-in-${how.replace(/\s+/g, '-')}`;
    const r = w.attempt(world, other, w.tools.bash(spelt), { env: U.UTC });
    w.assertBlocked(r, `a check-in set ${how}, with no yes`);
    U.sayYesTo(world, other, r, { env: U.UTC });
    w.assertBlocked(w.attempt(world, other, w.tools.bash(spelt), { env: U.UTC }), `a check-in set ${how}: refused, even after a yes`);
  }

  // Changing the file the check-ins are read from is asked.
  const edit = w.tools.edit(ownerFile(world), '08:00 morning brief', '06:00 morning brief');
  const asked = w.attempt(world, 'job-edit', edit, { env: U.UTC });
  w.assertBlocked(asked, 'an Edit of the owner\'s squire.json with no yes');
  assert.ok(w.requestIdIn(asked.stderr), `an Edit of the owner's squire.json is asked (a request the owner answers); got ${w.describe(asked)}`);
});
