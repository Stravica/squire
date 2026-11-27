'use strict';

// Squire's updates on today's Claude Code: the check after an install (and
// after a rollback) needs a live server, judged by the runner's evidence, and
// a clean health check, never a session, since Claude Code 2.1.332 makes no
// session until the Squire owner sends a first message, at first set-up and
// again after every restart of its server; an install's lay-down waits out
// launchd's teardown of the agents it booted out; a failed lay-down, the
// rollback and a failed check each say why, in update.log and in the mark
// the owner sees with no session; and the window after a failed rollback
// gives a way to support that works with no session.
//
// Every case runs an installed Squire in the release world
// (tests/fixtures/updates-world.js) with Claude Code under both measured
// profiles, the 2.1.332 world first; where a case says so, under the world's
// model of launchd (tests/fixtures/tools/launchd.js), with a teardown lag
// after each bootout.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const w = require('../fixtures/squire-world.js');
const s = require('../fixtures/session-world.js');
const R = require('../fixtures/updates-world.js');
const L = require('../fixtures/tools/launchd.js');

const NEXT = '0.2.0';
const LONG = { timeout: 1200000 };
const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const updated = (sent, version) => sent.filter((x) => new RegExp(`Squire is updated to ${esc(version)}; all checks passed`).test(x));
const rolledBack = (sent) => sent.filter((x) => /Squire rolled /.test(x));
const updateLog = (rw) => { try { return fs.readFileSync(path.join(rw.home, 'logs', 'update.log'), 'utf8'); } catch (e) { return ''; } };
const LAUNCHD_WORDS = 'Bootstrap failed: 5: Input/output error';

async function world(t, profile, opts = {}) {
  const rw = R.makeReleaseWorld(t, { profile, ...opts });
  await R.startSquire(rw, { client: Boolean(opts.client) });
  return rw;
}

function stage(rw, release) {
  R.tick(rw);
  assert.ok(R.staged(rw).includes(release.version), `the weekly check must stage ${release.version}; staging holds ${JSON.stringify(R.stagingFiles(rw))}; update.json: ${JSON.stringify(R.updateRecord(rw))}`);
}

const both = (fn) => Promise.all(s.PROFILES.map((profile) => fn(profile)));

test('an update from Squire Update under Claude Code 2.1.332 with no client connected installs, and its check passes on a live server and a clean health check with no session, with no rollback; under 2.1.319 the same', LONG, async (t) => {
  await both(async (profile) => {
    const rw = await world(t, profile);
    const release = R.buildRelease(rw, { version: NEXT });
    stage(rw, release);
    const { sent } = await R.installAtMac(rw, release);
    assert.equal(updated(sent, NEXT).length, 1, `${profile}: the install must pass its check on a live server and a clean health check, no session needed, and say so; sent ${JSON.stringify(sent)}; update.log: ${JSON.stringify(updateLog(rw))}`);
    assert.deepEqual(rolledBack(sent), [], `${profile}: nothing is rolled back`);
    assert.ok(R.coreIs(rw, release), `${profile}: the installed core is the release's, file for file`);
    assert.equal((R.updateRecord(rw) || {}).rollbackFailed, undefined, `${profile}: no rollback is marked`);
  });
});

test("an update from Squire Update after the owner's session existed passes its check on a live server and a clean health check with no session needed: under 2.1.332 the server started again makes no session until the owner writes again; under 2.1.319 the session comes back", LONG, async (t) => {
  await both(async (profile) => {
    const rw = await world(t, profile, { client: true });
    const before = s.sessionRecords(rw.world);
    assert.equal(before.length, 1, `${profile}: the owner's session must exist before the install`);
    const release = R.buildRelease(rw, { version: NEXT });
    stage(rw, release);
    const { sent } = await R.installAtMac(rw, release);
    assert.equal(updated(sent, NEXT).length, 1, `${profile}: the install must pass its check on a live server and a clean health check, never waiting for a session; sent ${JSON.stringify(sent)}; update.log: ${JSON.stringify(updateLog(rw))}`);
    assert.deepEqual(rolledBack(sent), [], `${profile}: nothing is rolled back`);
    assert.ok(R.coreIs(rw, release), `${profile}: the installed core is the release's`);
    const live = await s.waitFor(() => R.liveServer(rw) || (profile === '2.1.319' && s.sessionRecords(rw.world).find((r) => !w.processGone(r.pid))), 30000, 250);
    assert.ok(live, `${profile}: after the install Squire's server is live again`);
  });
});

test(`after an install that fails its check and a rollback whose check fails too, Squire Update's closing window gives a way to support that works with no session (a web address or an email address), never only "ask Squire in the chat"`, LONG, async (t) => {
  await both(async (profile) => {
    const rw = await world(t, profile);
    const bad = R.buildRelease(rw, { version: NEXT, shape: 'runnerExitsAndSignsOut' });
    stage(rw, bad);
    const r = await R.installAtMac(rw, bad);
    const closing = r.windows.filter((x) => /did not pass/i.test(x.text || ''));
    assert.ok(closing.length >= 1, `${profile}: Squire Update must say the update and the return did not pass their checks; windows: ${JSON.stringify(r.windows.map((x) => x.text))}`);
    const route = /(?:https?:\/\/[^\s"]+|[\w.+-]+@[\w-]+(?:\.[\w-]+)+)/;
    assert.ok(closing.some((x) => route.test(x.text || '')),
      `${profile}: with no session there is no chat, so the window must also give a way to support that works without one (a web address or an email address); it said: ${JSON.stringify(closing.map((x) => x.text))}`);
  });
});

test('an install whose lay-down meets launchd still tearing down the agents it booted out (bootstrap failing for 3 seconds after each bootout) waits and tries again, and installs with every agent loaded', LONG, async (t) => {
  await both(async (profile) => {
    const rw = await world(t, profile, { launchd: 'model' });
    const release = R.buildRelease(rw, { version: NEXT });
    stage(rw, release);
    const lag = L.control(rw.launchdState, { control: 'lag', ms: 3000 });
    assert.equal(lag.code, 0, `the world's launchd must take the lag; got ${JSON.stringify(lag)}`);
    const { sent } = await R.installAtMac(rw, release);
    assert.equal(updated(sent, NEXT).length, 1, `${profile}: within the bound, a bootstrap refused during the teardown must be waited for and tried again, and the install pass; sent ${JSON.stringify(sent)}; update.log: ${JSON.stringify(updateLog(rw))}; ` +
      `refused bootstraps: ${JSON.stringify(R.launchdCalls(rw).filter((c) => c.argv[0] === 'bootstrap' && c.code !== 0).length)}`);
    assert.ok(R.coreIs(rw, release), `${profile}: the installed core is the release's`);
    assert.ok(await s.waitFor(() => R.agentsLoaded(rw).length === R.AGENT_LABELS.length, 30000, 500), `${profile}: every agent is loaded after the install; loaded ${JSON.stringify(R.agentsLoaded(rw))}`);
  });
});

test("an install whose lay-down meets a launchd teardown longer than the bound fails its lay, and update.log names the agent's label and launchd's own words", LONG, async (t) => {
  await both(async (profile) => {
    const rw = await world(t, profile, { launchd: 'model' });
    const release = R.buildRelease(rw, { version: NEXT });
    stage(rw, release);
    L.control(rw.launchdState, { control: 'lag', ms: 45000 });
    const { sent } = await R.installAtMac(rw, release, 'Install', { within: 900000 });
    L.control(rw.launchdState, { control: 'lag', ms: 0 });
    assert.equal(updated(sent, NEXT).length, 0, `${profile}: a teardown longer than the bound must fail the lay`);
    const lines = updateLog(rw).split('\n').filter((l) => /com\.stravica\.squire\.[a-z-]+/.test(l) && l.includes(LAUNCHD_WORDS));
    assert.ok(lines.length >= 1, `${profile}: update.log must name the agent launchd would not load and launchd's own words ("${LAUNCHD_WORDS}"); update.log: ${JSON.stringify(updateLog(rw))}`);
  });
});

test('a failed lay-down, the rollback after it and a failed check each leave a line in update.log naming the reason, and the mark the owner sees with no session carries the reason', LONG, async (t) => {
  await both(async (profile) => {
    // A lay-down that fails for a reason of its own: Squire's Claude Code
    // config folder, which every lay-down writes, cannot be written, for the
    // install and for the rollback after it.
    const rw = await world(t, profile, { launchd: 'model' });
    const release = R.buildRelease(rw, { version: NEXT });
    stage(rw, release);
    const config = path.join(rw.home, 'claude-config');
    fs.chmodSync(config, 0o500);
    t.after(() => { try { fs.chmodSync(config, 0o700); } catch (e) { /* gone */ } });
    await R.installAtMac(rw, release);
    fs.chmodSync(config, 0o700);
    // Lay-down's reason, as the system gives it: the folder it could not write.
    const names = (l) => /Permission denied/.test(l) && l.includes('claude-config');
    const log = updateLog(rw);
    assert.ok(log.split('\n').some((l) => /lay/i.test(l) && names(l)), `${profile}: update.log must have a line for the failed lay-down naming its reason (permission denied on claude-config); update.log: ${JSON.stringify(log)}`);
    assert.ok(log.split('\n').some((l) => /roll/i.test(l) && l.includes(NEXT) && l.includes(R.INSTALLED)), `${profile}: update.log must have a line for the rollback naming both versions; update.log: ${JSON.stringify(log)}`);
    const mark = (R.updateRecord(rw) || {}).rollbackFailed;
    assert.ok(mark && typeof mark.reason === 'string' && names(mark.reason), `${profile}: the mark the owner sees with no session (update.json's rollbackFailed) must carry the reason; got ${JSON.stringify(mark)}`);
  });
  await both(async (profile) => {
    // A check that fails: the new release's runner exits at once.
    const rw = await world(t, profile);
    const bad = R.buildRelease(rw, { version: NEXT, shape: 'runnerExits' });
    stage(rw, bad);
    await R.installAtMac(rw, bad);
    const log = updateLog(rw);
    assert.ok(log.split('\n').some((l) => /check/i.test(l) && l.includes(NEXT) && /runner/i.test(l)), `${profile}: update.log must have a line for the failed check naming which part failed (the runner); update.log: ${JSON.stringify(log)}`);
  });
});
