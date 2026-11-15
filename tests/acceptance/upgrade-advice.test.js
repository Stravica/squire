'use strict';

// When an upgrade would really help, Squire says so once and leaves the
// choice to the owner (AC-1301-3), through the real entry points: Claude
// Code's status line command as core's settings set it (it sees each usage
// window reach its limit), the prompt hook (core/hooks/user-prompt-submit.py)
// on the owner's messages and on Squire's own wake-ups. The design record for
// plan awareness and the heavy-job gate (ADR-006 line 7) fixes the trigger,
// the words read here ("/upgrade", "Your call") and runtime/advice.json; the
// rest of the wording is the builder's.
//
// Usage model for the trigger (assumptions, none measured; ADR-006's
// consequences):
//   typical  a Pro owner who reaches a five-hour limit now and then, never
//            three in a week: two limits in a week, mostly the owner's own
//            requests. No advice.
//   heavy    an owner running big jobs most days: three five-hour limits in a
//            week, or the weekly limit once in a month, mostly the owner's own
//            requests. The advice once, then quiet for 30 days.
//   background
//            limits reached mostly by Squire's own work (wake-ups): no advice,
//            whatever the count.
// "Mostly" is more than half of the messages Squire took in over the period;
// a message framed "Squire wake-up:" is Squire's own, not requested.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const w = require('../fixtures/squire-world.js');
const U = require('../fixtures/usage-world.js');

const ADVICE = /\/upgrade/;

function adviceWorld(t) {
  const world = U.usageWorld(t);
  fs.writeFileSync(path.join(world.owner, 'squire.json'),
    JSON.stringify({ squireName: 'Juniper', personality: 'Warm, brief and dry', claudePlan: 'Pro' }, null, 2) + '\n');
  return world;
}

// The status line command sees the windows at these readings.
function usageSeen(world, { five, fiveReset, week = 50, weekReset = U.now() + 3 * U.DAY }) {
  const r = U.runStatusLine(world, U.statusInput(world, {
    rateLimits: { fiveHour: { used: five, resetsAt: fiveReset }, sevenDay: { used: week, resetsAt: weekReset } },
  }));
  assert.equal(r.status, 0, `the status line command must exit 0; got ${w.describe(r)}`);
}

// Three five-hour limits in the last week: two days ago, a day ago and now.
function threeFiveHourLimits(world) {
  const now = U.now();
  usageSeen(world, { five: 100, fiveReset: now - 2 * U.DAY + 3600 });
  usageSeen(world, { five: 100, fiveReset: now - U.DAY + 3600 });
  usageSeen(world, { five: 100, fiveReset: now + 3600 });
}

function ownerAsks(world, session, count) {
  for (let i = 1; i <= count; i += 1) w.ownerSays(world, session, `Please draft the reply to letter ${i}`);
}

function wakeUps(world, session, count) {
  for (let i = 1; i <= count; i += 1) U.wakeUp(world, session, `Check-in ${i}`);
}

test('upgrade advice comes once, when the trigger is met and never before it, changes nothing about the plan, and is not given again after a no', { timeout: 120000 }, (t) => {
  // Heavy, five-hour: mostly the owner's own requests, then the limits one by one.
  const world = adviceWorld(t);
  const s = 'job-busy';
  const plan = fs.readFileSync(path.join(world.owner, 'squire.json'));
  ownerAsks(world, s, 6);
  wakeUps(world, s, 1);
  const now = U.now();
  usageSeen(world, { five: 100, fiveReset: now - 2 * U.DAY + 3600 });
  usageSeen(world, { five: 100, fiveReset: now - U.DAY + 3600 });
  const early = w.ownerSays(world, s, 'What is next on the list?');
  assert.doesNotMatch(early.stdout, ADVICE, `two five-hour limits in a week is before the trigger: no advice; got ${w.describe(early)}`);
  usageSeen(world, { five: 100, fiveReset: now + 3600 });
  const advice = w.ownerSays(world, s, 'And after that?');
  assert.match(advice.stdout, ADVICE, `the third five-hour limit in a week, mostly requested work: the advice names /upgrade; got ${w.describe(advice)}`);
  assert.match(advice.stdout, /your call/i, `the advice leaves the choice to the owner ("Your call"); got ${w.describe(advice)}`);
  assert.match(advice.stdout, /Squire's own code/, `the advice is Squire's own note, not a message from anyone; got ${w.describe(advice)}`);
  const next = w.ownerSays(world, s, 'Fine, carry on with the letters');
  assert.doesNotMatch(next.stdout, ADVICE, `the advice is given once; got ${w.describe(next)}`);
  const no = w.ownerSays(world, s, 'no');
  assert.doesNotMatch(no.stdout, ADVICE, `after a no there is no advice; got ${w.describe(no)}`);
  usageSeen(world, { five: 100, fiveReset: now + 6 * 3600 });
  const later = w.ownerSays(world, s, 'One more letter, please');
  assert.doesNotMatch(later.stdout, ADVICE, `after a no the advice is not given again within the month, even at a fourth limit; got ${w.describe(later)}`);
  assert.deepEqual(fs.readFileSync(path.join(world.owner, 'squire.json')), plan, 'the advice changes nothing about the plan the owner declared');

  // Heavy, weekly: one weekly limit in the month, mostly the owner's own requests.
  const weekly = adviceWorld(t);
  ownerAsks(weekly, 'job-week', 5);
  usageSeen(weekly, { five: 60, fiveReset: U.now() + 3600, week: 100, weekReset: U.now() + 2 * U.DAY });
  const onWeek = w.ownerSays(weekly, 'job-week', 'What is next on the list?');
  assert.match(onWeek.stdout, ADVICE, `one weekly limit in a month, mostly requested work: the advice; got ${w.describe(onWeek)}`);
});

test('upgrade advice: limits reached mostly by Squire\'s own background work give none, and after advice Squire stays quiet for 30 days, then may give it again', { timeout: 120000 }, (t) => {
  // Background: one request from the owner, six wake-ups.
  const background = adviceWorld(t);
  ownerAsks(background, 'job-quiet', 1);
  wakeUps(background, 'job-quiet', 6);
  threeFiveHourLimits(background);
  const none = w.ownerSays(background, 'job-quiet', 'Anything for me today?');
  assert.doesNotMatch(none.stdout, ADVICE, `limits reached mostly by Squire's own wake-ups do not count as requested work: no advice; got ${w.describe(none)}`);

  const givenDaysAgo = (world, days) => {
    fs.mkdirSync(U.runtimeDir(world), { recursive: true });
    fs.writeFileSync(path.join(U.runtimeDir(world), 'advice.json'), JSON.stringify({ givenAt: U.now() - days * U.DAY }) + '\n');
  };

  // Advice given 29 days ago: still within the month, quiet.
  const recent = adviceWorld(t);
  givenDaysAgo(recent, 29);
  ownerAsks(recent, 'job-recent', 6);
  threeFiveHourLimits(recent);
  const quiet = w.ownerSays(recent, 'job-recent', 'What is next on the list?');
  assert.doesNotMatch(quiet.stdout, ADVICE, `advice given 29 days ago: quiet for the month; got ${w.describe(quiet)}`);

  // Advice given 31 days ago: the month is over, the trigger is met again.
  const past = adviceWorld(t);
  givenDaysAgo(past, 31);
  ownerAsks(past, 'job-past', 6);
  threeFiveHourLimits(past);
  const again = w.ownerSays(past, 'job-past', 'What is next on the list?');
  assert.match(again.stdout, ADVICE, `advice given 31 days ago and the trigger met again: the advice once more; got ${w.describe(again)}`);
});
