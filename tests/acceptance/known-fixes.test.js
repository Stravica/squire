'use strict';

// Self-fix first: the health check's known fixes (the design record's line
// 17), each checked by the health check itself. The runner not running:
// reload Squire's agents. A floor file changed: lay core down again from the
// Squire home's release folder, which set-up records in set-up.json. Not
// signed in: open Squire's installer to sign in again, a fix the owner makes.
// A moved settings file: named only.
//
// The floor keeps refusing a core change from inside the session, yes or no.
// For a fix that changes anything the health check prints the request that
// asks for it, /usr/bin/python3 <Squire home>/core/tools/health.py
// --request runner|floor; the session makes it, the floor asks the owner
// (driven here through the real floor hooks), and the owner's yes is recorded
// in the approvals ledger. The request still never runs in the session. The
// wake-ups scheduler's tick (wake-up.py --due, the agent lay-down writes)
// performs it outside the session: only a yes that is exact (its fault still
// there), fresh (under 30 minutes old) and unused; then the check runs again
// and its next run prints one plain line, "fixed: ...", "still: ..." or
// "could not try: ...". A fault not on the list is named and nothing is
// offered here. The ticket half (round 4) is at the end of this file.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const w = require('../fixtures/squire-world.js');
const s = require('../fixtures/session-world.js');
const I = require('../fixtures/installer-world.js');

const FRESH_MINUTES = 30;

function fixWorld(t) {
  const world = w.makeWorld();
  t.after(() => { s.killFakes(world); w.cleanUp(world); });
  world.system = I.makeSystemRoot(path.join(world.root, 'system'));
  // Core laid down from this repository's core, and the same core kept as the
  // Squire home's release folder, as set-up leaves it (the known fixes lay
  // core down again from there).
  s.layDownCore(world);
  world.release = path.join(world.home, 'release', 'core');
  w.copyTree(w.CORE, world.release);
  fs.writeFileSync(path.join(world.home, 'set-up.json'),
    JSON.stringify({ done: I.STEPS, added: [], release: world.release }, null, 2) + '\n');
  return world;
}

const healthScript = (world) => path.join(world.home, 'core', 'tools', 'health.py');
const requestFor = (world, which) => `${w.PYTHON} ${healthScript(world)} --request ${which}`;
const floorFile = (world) => path.join(world.home, 'core', 'hooks', 'config-change.py');
const releaseFloorFile = (world) => path.join(world.release, 'hooks', 'config-change.py');

function health(world, args = []) {
  return w.runPython(world, healthScript(world), args, { cwd: world.root, env: { SQUIRE_SYSTEM_ROOT: world.system } });
}

// One tick of the wake-ups scheduler, as its agent runs it: the outside job.
function tick(world) {
  const r = s.runDueWakeUps(world, { coreDir: fs.realpathSync(s.installedCore(world)), env: { SQUIRE_SYSTEM_ROOT: world.system } });
  assert.doesNotMatch(r.stderr, /can't open file|Traceback/, `the scheduler's run must run; got ${w.describe(r)}`);
  return r;
}

const linesWith = (r, re) => r.stdout.split('\n').filter((l) => re.test(l));
const RESULT = /^\s*(fixed|still|could not try):/i;
// The health check's fault lines naming re, leaving out the last fix's result.
const faultLines = (r, re) => linesWith(r, re).filter((l) => !RESULT.test(l));
const resultLines = (r, word) => r.stdout.split('\n').filter((l) => new RegExp(`^\\s*${word}:`, 'i').test(l));

const changeFloorFile = (world) => fs.appendFileSync(floorFile(world), '# one line more\n');
const floorFileIsRelease = (world) => fs.readFileSync(floorFile(world)).equals(fs.readFileSync(releaseFloorFile(world)));

// The session makes the request: the floor asks the owner (a block with a
// request id, never a refusal), the owner says yes, and the same request from
// the session is still refused: the change is never made from the session.
function askedThenYes(world, which, what, session = `session-fix-${which}`) {
  const call = w.tools.bash(requestFor(world, which));
  const asked = w.attempt(world, session, call);
  w.assertBlocked(asked, `${what}, before the owner's yes`);
  assert.ok(w.requestIdIn(asked.stderr), `${what}: the floor must ask the owner for the fix (a block with a request id), never refuse it outright; got ${w.describe(asked)}`);
  w.ownerSays(world, session, 'yes');
  w.assertBlocked(w.attempt(world, session, call), `${what}: after the owner's yes the session still may not make the change itself`);
}

// The world plays time passing: the one yes in the approvals ledger is made
// older by the given seconds (round 1's answer record keeps its time as "at").
function ageTheYes(world, seconds) {
  const file = w.ledgerOf(world);
  const records = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const yeses = records.filter((r) => r.type === 'answer' && r.answer === 'yes');
  assert.equal(yeses.length, 1, 'the world ages the one yes the owner gave');
  for (const r of yeses) r.at -= seconds;
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r, Object.keys(r).sort())).join('\n') + '\n');
}

test("a changed floor file is named and its fix asked for; after the owner's yes the session still cannot make it, and the scheduler's next run lays core down again from the release and the check finds it gone", { timeout: 120000 }, (t) => {
  const world = fixWorld(t);
  changeFloorFile(world);
  const h = health(world);
  assert.ok(faultLines(h, /config-change\.py/).length >= 1, `the health check must name the changed floor file; got ${w.describe(h)}`);
  assert.ok(h.stdout.includes(requestFor(world, 'floor')), `the health check must name how to ask for its fix, ${requestFor(world, 'floor')}; got ${w.describe(h)}`);
  assert.ok(!h.stdout.includes('--fix'), `no fix command for the session to run may be printed; got ${w.describe(h)}`);
  askedThenYes(world, 'floor', 'the floor fix');
  assert.ok(!floorFileIsRelease(world), 'nothing in the session may have laid core down');
  tick(world);
  assert.ok(floorFileIsRelease(world), 'the scheduler\'s run must lay core down again from the Squire home\'s release folder');
  const after = health(world);
  assert.deepEqual(faultLines(after, /config-change\.py/), [], `after the fix the check must no longer name the floor file; got ${w.describe(after)}`);
  assert.ok(resultLines(after, 'fixed').length >= 1, `the check must say plainly that the fix worked ("fixed: ..."); got ${w.describe(after)}`);
});

test("the runner not running is named and its fix asked for; after the owner's yes the scheduler's next run reloads the agents, loads nothing outside the account's own home, and says plainly the fault is still there", { timeout: 120000 }, (t) => {
  const world = fixWorld(t);
  const h = health(world);
  assert.ok(faultLines(h, /runner/i).some((l) => /not running/i.test(l)), `the health check must name the runner not running; got ${w.describe(h)}`);
  assert.ok(h.stdout.includes(requestFor(world, 'runner')), `the health check must name how to ask for its fix, ${requestFor(world, 'runner')}; got ${w.describe(h)}`);
  askedThenYes(world, 'runner', 'the runner fix');
  // A world's agents never reach launchd, so the reload cannot bring it back.
  tick(world);
  assert.ok(!s.launchdHas('com.stravica.squire.runner'), 'the reload must load nothing into the launchd domain of whoever runs the tests');
  const after = health(world);
  assert.ok(resultLines(after, 'still').some((l) => /runner/i.test(l)), `the check must say plainly that the runner is still not running ("still: ..."); got ${w.describe(after)}`);
  assert.ok(faultLines(after, /runner/i).some((l) => /not running/i.test(l)), 'the check still names it');
});

test('a yes for one fault does not fix another: after the yes to reload the agents, a changed floor file stays changed and named', { timeout: 120000 }, (t) => {
  const world = fixWorld(t);
  changeFloorFile(world);
  askedThenYes(world, 'runner', 'the runner fix, with a floor file also changed');
  tick(world);
  assert.ok(!floorFileIsRelease(world), 'the yes to reload the agents must never lay core down');
  assert.ok(faultLines(health(world), /config-change\.py/).length >= 1, 'the changed floor file must still be named');
});

test("a yes given more than 30 minutes before the scheduler's run changes nothing and the check says it could not try",{ timeout: 120000 }, (t) => {
  const world = fixWorld(t);
  changeFloorFile(world);
  askedThenYes(world, 'floor', 'the floor fix');
  ageTheYes(world, (FRESH_MINUTES + 1) * 60);
  tick(world);
  assert.ok(!floorFileIsRelease(world), `a yes older than ${FRESH_MINUTES} minutes must never lay core down`);
  const after = health(world);
  assert.ok(resultLines(after, 'could not try').length >= 1, `the check must say the fix could not be tried ("could not try: ..."); got ${w.describe(after)}`);
  assert.ok(faultLines(after, /config-change\.py/).length >= 1, 'the changed floor file must still be named');
});

test("a second run of the scheduler after the yes was used does nothing: a floor file changed again stays changed", { timeout: 120000 }, (t) => {
  const world = fixWorld(t);
  changeFloorFile(world);
  askedThenYes(world, 'floor', 'the floor fix');
  tick(world);
  assert.ok(floorFileIsRelease(world), 'the first run after the yes must lay core down again');
  changeFloorFile(world);
  tick(world);
  assert.ok(!floorFileIsRelease(world), 'a used yes must never be used again');
  assert.ok(faultLines(health(world), /config-change\.py/).length >= 1, 'the floor file changed again must be named');
});

test('a yes for a fault already gone changes nothing and the check says it could not try', { timeout: 120000 }, (t) => {
  const world = fixWorld(t);
  changeFloorFile(world);
  askedThenYes(world, 'floor', 'the floor fix');
  fs.copyFileSync(releaseFloorFile(world), floorFile(world));
  const core = fs.realpathSync(s.installedCore(world));
  const before = w.snapshot(core);
  tick(world);
  assert.deepEqual(w.snapshotDifferences(before, w.snapshot(core)), [], 'with the fault gone, the scheduler\'s run must lay nothing down');
  const after = health(world);
  assert.ok(resultLines(after, 'could not try').length >= 1, `the check must say the fix could not be tried ("could not try: ..."); got ${w.describe(after)}`);
});

test("after set-up the app moved and then deleted, the floor fix still lays core down from the Squire home's release folder, and with that folder gone it says it could not try and to open Squire's installer", { timeout: 360000 }, async (t) => {
  const iw = I.makeInstallerWorld(t);
  const run = await I.runApp(iw);
  assert.deepEqual(I.doneSteps(iw), I.STEPS, `set-up must finish; got ${I.describeRun(run)}`);
  const record = I.readRecord(iw);
  assert.ok(typeof record.release === 'string' && path.resolve(record.release).startsWith(iw.squireHome + path.sep),
    `set-up.json's release must name a folder in the Squire home; got ${JSON.stringify(record.release)}`);
  const moved = `${iw.app}-moved`;
  fs.renameSync(iw.app, moved);
  fs.rmSync(moved, { recursive: true, force: true });
  const world = { root: iw.root, home: iw.squireHome, owner: iw.ownerFolder, userHome: iw.userHome, tmp: iw.world.tmp,
    transcript: iw.world.transcript, core: w.CORE, system: iw.system, release: record.release };
  changeFloorFile(world);
  askedThenYes(world, 'floor', 'the floor fix with the app deleted', 'session-fix-app-gone');
  tick(world);
  assert.ok(floorFileIsRelease(world), 'with the downloaded app deleted, the fix must lay core down from the Squire home\'s release folder');
  fs.rmSync(record.release, { recursive: true, force: true });
  changeFloorFile(world);
  askedThenYes(world, 'floor', 'the floor fix with the release folder gone', 'session-fix-release-gone');
  tick(world);
  const after = health(world);
  const lines = resultLines(after, 'could not try');
  assert.ok(lines.some((l) => /installer/i.test(l)), `with the release folder gone the fix must say it could not try and to open Squire's installer; got ${w.describe(after)}`);
  assert.ok(faultLines(after, /config-change\.py/).length >= 1, 'the changed floor file must still be named');
});

test("not signed in is named with the way on, opening Squire's installer to sign in again, and no command is offered for it",{ timeout: 120000 }, (t) => {
  const world = fixWorld(t);
  s.installFakeClaudeCode(world, { signedIn: false });
  const h = health(world);
  const lines = linesWith(h, /sign in again/i);
  assert.ok(lines.length >= 1 && lines.every((l) => /installer/i.test(l)), `the health check must say to open Squire's installer to sign in again; got ${w.describe(h)}`);
  assert.ok(lines.every((l) => !l.includes('--fix') && !l.includes('--request')), 'no command is offered or asked for the sign-in once it has ended: it is the owner\'s to make');
});

test("a moved settings file and a fault not on the list are named, and no fix is offered on either one's line (a ticket offer has a line of its own)", { timeout: 120000 }, (t) => {
  // A regression guard: the health check named both, with no fix, at the
  // round's base; it stays so the known fixes never grow onto the owner's
  // own files or onto faults Squire cannot fix.
  const world = fixWorld(t);
  const moved = path.join(world.home, 'moved-settings', 'settings.local.json');
  fs.mkdirSync(path.dirname(moved), { recursive: true });
  fs.writeFileSync(moved, '{"hooks": {}}\n');
  w.plantOverlays(world.owner, [w.CORE]);
  const h = health(world);
  const movedLines = linesWith(h, /settings\.local\.json/);
  const overlayLines = linesWith(h, /^ignored: overlay\//);
  assert.ok(movedLines.length >= 1, `the health check must name the moved settings file; got ${w.describe(h)}`);
  assert.ok(overlayLines.length >= 1, `the health check must name the ignored overlays; got ${w.describe(h)}`);
  for (const l of [...movedLines, ...overlayLines]) assert.ok(!l.includes('--fix') && !l.includes('--request'), `nothing may be offered for: ${l}`);
  assert.ok(!/--(fix|request) (?!runner\b|floor\b|sign-in\b)/.test(h.stdout), `no fix beyond the known list may be offered; got ${w.describe(h)}`);
});

// The ticket half (round 4, the design record ADR-005 line 15): a known fix's
// result decides whether a support ticket is offered. "fixed" offers none;
// "still" offers one, on a line of its own, and the result stays printed at
// every run of the health check, read by the session or by the owner, until
// the owner answers the ticket's request; "could not try" offers none and
// asks for the fix again. A yes timed after now is no yes (ADR-005 line 9).

const { ticketLines } = require('../fixtures/updates-world.js');

test('a fix that worked offers no support ticket: after "fixed" the health check offers nothing to send', { timeout: 120000 }, (t) => {
  // A regression guard: no ticket was offered at the round's base; it stays
  // so a fixed fault never sends anything. Regression evidence, bound to no
  // criterion: the "still" case beside it is the rule's bound red half.
  const world = fixWorld(t);
  changeFloorFile(world);
  askedThenYes(world, 'floor', 'the floor fix');
  tick(world);
  const after = health(world);
  assert.ok(resultLines(after, 'fixed').length >= 1, `the check must say the fix worked; got ${w.describe(after)}`);
  assert.deepEqual(ticketLines(after.stdout), [], `a fix that worked must offer no ticket; got ${w.describe(after)}`);
});

test('a fix that did not work offers a support ticket on a line of its own, and its "still" result is printed again at the next run, whoever runs the check', { timeout: 120000 }, (t) => {
  const world = fixWorld(t);
  askedThenYes(world, 'runner', 'the runner fix');
  tick(world);
  const bySession = health(world);
  assert.ok(resultLines(bySession, 'still').some((l) => /runner/i.test(l)), `the check must say the runner is still not running; got ${w.describe(bySession)}`);
  const offers = ticketLines(bySession.stdout);
  assert.equal(offers.length, 1, `a fix that did not work must offer one support ticket, on a line of its own; got ${w.describe(bySession)}`);
  assert.ok(resultLines(bySession, 'still').every((l) => !l.includes('ticket')), 'the offer never sits on the result\'s own line');
  const byOwner = health(world);
  assert.ok(resultLines(byOwner, 'still').some((l) => /runner/i.test(l)), `a read never consumes the result: the next run prints it again; got ${w.describe(byOwner)}`);
  assert.deepEqual(ticketLines(byOwner.stdout).map((m) => m[1]), [offers[0][1]], 'the next run offers the same ticket');
});

test('a fix that could not be tried offers no support ticket and asks for the fix again', { timeout: 120000 }, (t) => {
  // A regression guard for the "could not try" half: no ticket was offered at
  // the round's base, and the request was named again. Regression evidence,
  // bound to no criterion: the "yes timed after now" case is the bound red half.
  const world = fixWorld(t);
  changeFloorFile(world);
  askedThenYes(world, 'floor', 'the floor fix');
  ageTheYes(world, (FRESH_MINUTES + 1) * 60);
  tick(world);
  const after = health(world);
  assert.ok(resultLines(after, 'could not try').length >= 1, `the check must say the fix could not be tried; got ${w.describe(after)}`);
  assert.deepEqual(ticketLines(after.stdout), [], `a fix that could not be tried offers no ticket; got ${w.describe(after)}`);
  assert.ok(after.stdout.includes(requestFor(world, 'floor')), `the check must ask for the fix again; got ${w.describe(after)}`);
});

test("a yes timed after now changes nothing: the check says it could not try, and the session's request is asked again", { timeout: 120000 }, (t) => {
  const world = fixWorld(t);
  changeFloorFile(world);
  askedThenYes(world, 'floor', 'the floor fix');
  ageTheYes(world, -3600);
  tick(world);
  assert.ok(!floorFileIsRelease(world), 'a yes timed an hour after now must never lay core down');
  const after = health(world);
  assert.ok(resultLines(after, 'could not try').length >= 1, `the check must say the fix could not be tried; got ${w.describe(after)}`);
  const again = w.attempt(world, 'session-fix-again', w.tools.bash(requestFor(world, 'floor')));
  w.assertBlocked(again, 'the fix asked again');
  assert.ok(w.requestIdIn(again.stderr), `the floor must ask the owner again (a block with a request id); got ${w.describe(again)}`);
});
