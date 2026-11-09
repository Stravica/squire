'use strict';

// Wake-ups reach only the Squire owner's own session, a failed delivery goes
// nowhere else and is recorded with its reason and retry state, and a wake-up
// never counts as the Squire owner's yes.
//
// Every case runs the router's real entry point (core/tools/wake-up.py, with
// /usr/bin/python3) in a test world. Squire's session is stood in for by a
// fake messaging inbox the world owns (tests/fixtures/fake-inbox.py), and the
// session record by a file in the Squire home in the form the design record
// names, or by the real SessionStart hook. No case reaches a real session.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const w = require('../fixtures/squire-world.js');
const s = require('../fixtures/session-world.js');

const { tools } = w;

// A world whose owner config picks no wake-ups, unless the case says so, so
// that only what the case fires is due.
function wakeWorld(t) {
  const world = w.makeWorld();
  t.after(() => { s.killFakes(world); w.cleanUp(world); });
  setOwnerWakeUps(world, []);
  return world;
}

function setOwnerWakeUps(world, wakeUps) {
  const file = path.join(world.owner, 'squire.json');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  config.wakeUps = wakeUps;
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
}

async function inbox(t, world, name, mode) {
  const box = await s.startInbox(world, name, mode);
  t.after(() => box.stop());
  return box;
}

// A session of Squire's own: a live inbox and the one record that names it.
async function ownSession(t, world, { name = 'own', mode = 'accept', sessionId = `session-${name}`, ...extra } = {}) {
  const box = await inbox(t, world, name, mode);
  const record = s.seedSessionRecord(world, { sessionId, socket: box.socket, pid: box.pid, ...extra });
  return { box, record };
}

const userContents = (box) => box.userMessages().map((m) => m.message && m.message.content);

function assertNothingSent(boxes, what) {
  for (const box of boxes) {
    assert.deepEqual(box.lines(), [], `${what}: nothing may be sent to ${box.name}; it was given ${JSON.stringify(box.lines())}`);
  }
}

function assertLogSays(world, pattern, what) {
  const log = s.wakeUpLog(world);
  assert.ok(log.some((l) => pattern.test(l)), `${what}: logs/wake-ups.log in the Squire home must say why (${pattern}); it holds ${JSON.stringify(log)}`);
}

// The one wake-up state in the Squire home.
function onlyState(world, what) {
  const states = s.wakeUpStates(world);
  assert.equal(states.length, 1, `${what}: one wake-up state must be kept in wake-ups/ in the Squire home; found ${JSON.stringify(states)}`);
  return states[0];
}

// A wake-up delivered as Claude Code takes a message on its socket: one
// connection, the record's token first, then one user line carrying the text.
function assertDeliveredTo(box, record, text, what) {
  const connections = box.connections();
  assert.equal(connections.length, 1, `${what}: the wake-up must reach ${box.name} over one connection; got ${JSON.stringify(connections)}`);
  const lines = connections[0].lines.map((l) => { try { return JSON.parse(l); } catch (e) { return l; } });
  assert.deepEqual(lines[0], { type: 'auth', token: record.token }, `${what}: the first line must be the session's token from its record; got ${JSON.stringify(lines[0])}`);
  const users = lines.filter((l) => l && l.type === 'user');
  assert.equal(users.length, 1, `${what}: exactly one user line must be posted; got ${JSON.stringify(lines)}`);
  assert.equal(users[0].message && users[0].message.role, 'user', `${what}: the line must be {"type":"user","message":{"role":"user",...}}; got ${JSON.stringify(users[0])}`);
  assert.equal(typeof users[0].message.content, 'string', `${what}: the message content must be text`);
  assert.ok(users[0].message.content.includes(text), `${what}: the message must carry the wake-up's text "${text}"; got ${JSON.stringify(users[0].message.content)}`);
  return users[0].message.content;
}

const minutesAgo = (n) => s.nowSeconds() - n * 60;

// ------------------------------------------------------- own session

test('with exactly one session record, its process alive and its socket its own, a wake-up is delivered to that session on the Claude Code line format and recorded delivered', { timeout: 60000 }, async (t) => {
  const world = wakeWorld(t);
  const { box, record } = await ownSession(t, world);
  const r = s.fireWakeUp(world, 'Time for the morning brief.');
  assert.equal(r.status, 0, `a delivered wake-up must exit 0; got ${w.describe(r)}`);
  assertDeliveredTo(box, record, 'Time for the morning brief.', 'one record, alive and its own');
  const state = onlyState(world, 'a delivered wake-up');
  assert.equal(state.state, 'delivered', `the wake-up's state must be delivered; got ${JSON.stringify(state)}`);
  assert.equal(state.session, record.sessionId, 'the state must name the session it was delivered to');
});

test('with no session record nothing is sent, even to a live session in the world, the log says there is no record, and the retry reaches the one Squire session once there is one', { timeout: 60000 }, async (t) => {
  const world = wakeWorld(t);
  const stray = await inbox(t, world, 'Squire');
  s.fireWakeUp(world, 'Time for the morning brief.');
  assertNothingSent([stray], 'no record');
  assertLogSays(world, /no record/i, 'no record');
  let state = onlyState(world, 'no record');
  assert.equal(state.state, 'retrying', `no record is a failed delivery: the wake-up must wait for a retry (retrying); got ${JSON.stringify(state)}`);
  assert.equal(state.session, null, `a wake-up whose first attempt found no record is aimed at no session (session null); got ${JSON.stringify(state)}`);
  assert.equal(state.attempts.length, 1, `one attempt must be recorded; got ${JSON.stringify(state.attempts)}`);
  assert.equal(state.attempts[0].outcome, 'failed', `the attempt's outcome must be failed; got ${JSON.stringify(state.attempts[0])}`);
  assert.match(state.attempts[0].reason || '', /no record/i, `the attempt must say there was no record; got ${JSON.stringify(state.attempts[0])}`);

  // One session of Squire's own appears; the scheduler's next run retries.
  const { box, record } = await ownSession(t, world);
  s.seedWakeUp(world, { ...state, attempts: state.attempts.map((a) => ({ ...a, at: minutesAgo(2) })) });
  const r = s.runDueWakeUps(world);
  assert.equal(r.status, 0, `the scheduler's run must exit 0; got ${w.describe(r)}`);
  assertDeliveredTo(box, record, 'Time for the morning brief.', 'the retry once one session of Squire own is there');
  assertNothingSent([stray], 'the retry: the session with no record');
  state = s.wakeUpStates(world).find((x) => x.id === state.id);
  assert.equal(state.state, 'delivered', `the retried wake-up must be recorded delivered; got ${JSON.stringify(state)}`);
  assert.equal(state.attempts.length, 2, `the retry must be recorded as a second attempt; got ${JSON.stringify(state.attempts)}`);
});

test('with more than one session record nothing is sent to either and the log says there is more than one', { timeout: 60000 }, async (t) => {
  const world = wakeWorld(t);
  const a = await ownSession(t, world, { name: 'one' });
  const b = await ownSession(t, world, { name: 'two' });
  s.fireWakeUp(world, 'Time for the morning brief.');
  assertNothingSent([a.box, b.box], 'two records');
  assertLogSays(world, /more than one/i, 'two records');
  assert.equal(onlyState(world, 'two records').state, 'not sent', 'a wake-up with two records must be recorded not sent');
});

// A failed attempt the router recorded: the wake-up waits for a retry.
function assertRetrying(state, sessionId, reason, what) {
  assert.equal(state.state, 'retrying', `${what}: a failed delivery must wait for a retry (retrying); got ${JSON.stringify(state)}`);
  assert.equal(state.session, sessionId, `${what}: the state must name the session it was aimed at; got ${JSON.stringify(state)}`);
  assert.equal(state.attempts.length, 1, `${what}: one attempt must be recorded; got ${JSON.stringify(state.attempts)}`);
  assert.equal(state.attempts[0].outcome, 'failed', `${what}: the attempt's outcome must be failed; got ${JSON.stringify(state.attempts[0])}`);
  assert.match(state.attempts[0].reason || '', reason, `${what}: the attempt must say why (${reason}); got ${JSON.stringify(state.attempts[0])}`);
}

test('with one record whose process is gone nothing is sent, even though a session listens on its socket, the log says the process is gone, and the retry reaches the session once it is back under the same id', { timeout: 60000 }, async (t) => {
  const world = wakeWorld(t);
  const { box } = await ownSession(t, world, { pid: s.deadPid() });
  s.fireWakeUp(world, 'Time for the morning brief.');
  assertNothingSent([box], 'a record whose process is gone');
  assertLogSays(world, /gone/i, 'a record whose process is gone');
  let state = onlyState(world, 'a record whose process is gone');
  assertRetrying(state, 'session-own', /gone/i, 'a record whose process is gone');

  // The session back under the same id, as a restart resumes it: a new
  // process and socket, its record replacing the old one.
  await box.stop();
  const back = await ownSession(t, world, { name: 'back', sessionId: 'session-own', source: 'resume' });
  s.seedWakeUp(world, { ...state, attempts: state.attempts.map((a) => ({ ...a, at: minutesAgo(2) })) });
  const r = s.runDueWakeUps(world);
  assert.equal(r.status, 0, `the scheduler's run must exit 0; got ${w.describe(r)}`);
  assertDeliveredTo(back.box, back.record, 'Time for the morning brief.', 'the retry with the session back under the same id');
  state = s.wakeUpStates(world).find((x) => x.id === state.id);
  assert.equal(state.state, 'delivered', `the retried wake-up must be recorded delivered; got ${JSON.stringify(state)}`);
  assert.equal(state.attempts.length, 2, `the retry must be recorded as a second attempt; got ${JSON.stringify(state.attempts)}`);
});

test('with one record whose process id is alive and listening on its socket but started at another time, nothing is sent, the log says the process is gone and the wake-up waits to be retried', { timeout: 60000 }, async (t) => {
  const world = wakeWorld(t);
  const box = await inbox(t, world, 'own');
  const started = s.startTimeOf(box.pid);
  assert.ok(started, 'premise: the start of the session process can be read');
  const anotherTime = new Date(Date.parse(started) - 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  s.seedSessionRecord(world, { sessionId: 'session-own', socket: box.socket, pid: box.pid, pidStartedAt: anotherTime });
  s.fireWakeUp(world, 'Time for the morning brief.');
  assertNothingSent([box], 'a record whose process id now belongs to a process started at another time');
  assertLogSays(world, /gone/i, 'a record whose process id was reused');
  assertRetrying(onlyState(world, 'a record whose process id was reused'), 'session-own', /gone/i, 'a record whose process id was reused');
});

test('with one stale record, whose socket path now holds a different socket, nothing is sent and the log says the record is stale', { timeout: 60000 }, async (t) => {
  const world = wakeWorld(t);
  const box = await inbox(t, world, 'own');
  const inode = fs.statSync(box.socket).ino;
  s.seedSessionRecord(world, { sessionId: 'session-stale', socket: box.socket, pid: box.pid, socketInode: inode + 1 });
  s.fireWakeUp(world, 'Time for the morning brief.');
  assertNothingSent([box], 'a stale record');
  assertLogSays(world, /stale/i, 'a stale record');
});

test('with one record whose socket and owner are its own but whose process is not the one listening on that socket, the router writes nothing on the connection, records the wake-up not sent and the log says the record is stale', { timeout: 60000 }, async (t) => {
  const world = wakeWorld(t);
  const own = await inbox(t, world, 'own');
  // Another live process the test started, recorded with its own start.
  const other = await inbox(t, world, 'other');
  s.seedSessionRecord(world, { sessionId: 'session-own', socket: own.socket, pid: other.pid });
  s.fireWakeUp(world, 'Time for the morning brief.');
  assertNothingSent([own, other], 'a record whose process is not the socket listener (not even the auth line)');
  assertLogSays(world, /stale/i, 'a record whose process is not the socket listener');
  assert.equal(onlyState(world, 'a record whose process is not the socket listener').state, 'not sent',
    'a stale record is an identity failure: the wake-up must be recorded not sent');
});

test('never by name: a record calling itself Squire whose identity fails is not delivered to', { timeout: 60000 }, async (t) => {
  const world = wakeWorld(t);
  const box = await inbox(t, world, 'Squire');
  s.seedSessionRecord(world, { sessionId: 'Squire', name: 'Squire', title: 'Squire', socket: box.socket, pid: s.deadPid() });
  s.fireWakeUp(world, 'Time for the morning brief.');
  assertNothingSent([box], 'a record named Squire whose process is gone');
  assertLogSays(world, /gone/i, 'a record named Squire whose process is gone');
});

test('after a clear or a restart the SessionStart hook leaves one record, that of the new session, and a wake-up reaches that session and not the old one', { timeout: 60000 }, async (t) => {
  const world = wakeWorld(t);
  // A session from before a crash, whose process is gone.
  const crashed = await inbox(t, world, 'old');
  s.seedSessionRecord(world, { sessionId: 'session-before-crash', socket: crashed.socket, pid: s.deadPid() });
  // One session process, which runs the SessionStart hook: before a /clear
  // it listens on one socket.
  const session = await inbox(t, world, 'pre');
  const beforeSocket = session.socket;
  let r = await s.recordSessionFromInbox(world, session, { sessionId: 'session-before-clear' });
  assert.equal(r.status, 0, `the SessionStart hook must let the session start; got ${w.describe(r)}`);
  // The same process after /clear: a new id, a new socket and a new token.
  const afterSocket = path.join(world.root, 's', 'new.sock');
  r = await s.recordSessionFromInbox(world, session, { sessionId: 'session-after-clear', source: 'clear', bind: afterSocket });
  assert.equal(r.status, 0, `the SessionStart hook must let the cleared session start; got ${w.describe(r)}`);
  const records = s.sessionRecords(world).map((x) => x.sessionId);
  assert.deepEqual(records, ['session-after-clear'], `only the new session's record may be left; found ${JSON.stringify(records)}`);
  s.fireWakeUp(world, 'Time for the morning brief.');
  const cleared = { name: 'the session after a clear', connections: () => session.connectionsOn(afterSocket) };
  assertDeliveredTo(cleared, { token: r.token }, 'Time for the morning brief.', 'the session after a clear');
  assert.deepEqual(session.connectionsOn(beforeSocket), [], `nothing may reach the socket from before the clear; it was given ${JSON.stringify(session.connectionsOn(beforeSocket))}`);
  assertNothingSent([crashed], 'the session from before the crash');
});

test('a wake-up the Squire owner picked is delivered by the scheduler run once its time has come today, once only, and one not yet due is not', { timeout: 240000 }, async (t) => {
  const world = wakeWorld(t);
  // Clear of midnight, so that a minute ago is still today.
  const minuteOfDay = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
  await s.waitFor(() => minuteOfDay() >= 2, 150000, 1000);
  const hhmm = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  const now = minuteOfDay();
  const picked = [`${hhmm(now - 1)} Look over the orders.`];
  const later = now + 60 <= 23 * 60 + 59 ? `${hhmm(now + 60)} Not yet.` : null;
  if (later) picked.push(later);
  setOwnerWakeUps(world, picked);
  const { box, record } = await ownSession(t, world);

  let r = s.runDueWakeUps(world);
  assert.equal(r.status, 0, `the scheduler's run must exit 0; got ${w.describe(r)}`);
  assertDeliveredTo(box, record, 'Look over the orders.', 'a picked wake-up whose time has come');
  r = s.runDueWakeUps(world);
  assert.equal(r.status, 0, `a second scheduler run must exit 0; got ${w.describe(r)}`);
  assert.equal(box.connections().length, 1, `a picked wake-up goes once a day; the second run sent it again: ${JSON.stringify(box.connections())}`);
  if (later) assert.ok(!userContents(box).some((c) => c.includes('Not yet.')), 'a picked wake-up not yet due must not be sent');
});

// The late window. The router's local time is its process's, TZ when set:
// each case runs it in a whole-hour fixed-offset zone (Etc/GMT-N is N hours
// east of UTC, the sign reversed) chosen from the current UTC hour so that
// the local hour is the one the case needs, and never waits for the clock.
const pad = (n) => String(n).padStart(2, '0');
const hhmm = (minutes) => { const m = ((minutes % 1440) + 1440) % 1440; return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`; };
function zoneWithLocalHour(hour, at) {
  let offset = (((hour - new Date(at).getUTCHours()) % 24) + 24) % 24;
  if (offset > 14) offset -= 24;
  return { tz: offset === 0 ? 'Etc/GMT' : offset > 0 ? `Etc/GMT-${offset}` : `Etc/GMT+${-offset}`, offset };
}
const localMinuteOfDay = (offset, at = Date.now()) => { const d = new Date(at + offset * 3600000); return d.getUTCHours() * 60 + d.getUTCMinutes(); };

// A picked wake-up delivered with its due time and the local minute of the
// run in its framing.
function assertFramedLate(content, due, minutesOfRun, what) {
  assert.ok(content.startsWith('Squire wake-up:'), `${what}: the content must start "Squire wake-up:"; got ${JSON.stringify(content)}`);
  assert.ok(content.includes(`due ${hhmm(due)}`), `${what}: the framing must hold its due time (due ${hhmm(due)}); got ${JSON.stringify(content)}`);
  assert.ok(minutesOfRun.some((m) => content.includes(`delivered ${hhmm(m)}`)),
    `${what}: the framing must hold the local time it was delivered (delivered ${minutesOfRun.map(hhmm).join(' or ')}); got ${JSON.stringify(content)}`);
}

function assertMissed(world, state, due, what) {
  assert.ok(state, `${what}: a state must be kept in wake-ups/ in the Squire home; found ${JSON.stringify(s.wakeUpStates(world))}`);
  assert.equal(state.state, 'missed', `${what}: the state must be missed; got ${JSON.stringify(state)}`);
  assert.equal(state.attempts.length, 1, `${what}: one attempt must be recorded; got ${JSON.stringify(state.attempts)}`);
  assert.equal(state.attempts[0].outcome, 'missed', `${what}: the attempt's outcome must be missed; got ${JSON.stringify(state.attempts[0])}`);
  assert.ok((state.attempts[0].reason || '').includes(hhmm(due)), `${what}: the attempt's reason must name its due time ${hhmm(due)}; got ${JSON.stringify(state.attempts[0])}`);
}

test('a picked wake-up whose time passed while the Mac slept, less than two hours ago, is delivered once with its due time and its delivery time in the framing', { timeout: 60000 }, async (t) => {
  const world = wakeWorld(t);
  const at = Date.now();
  const { tz, offset } = zoneWithLocalHour(12, at);
  const due = localMinuteOfDay(offset, at) - 90;
  setOwnerWakeUps(world, [`${hhmm(due)} Look over the orders.`]);
  const { box, record } = await ownSession(t, world);
  const before = localMinuteOfDay(offset);
  let r = s.runDueWakeUps(world, { env: { TZ: tz } });
  const after = localMinuteOfDay(offset);
  assert.equal(r.status, 0, `the scheduler's run must exit 0; got ${w.describe(r)}`);
  const content = assertDeliveredTo(box, record, 'Look over the orders.', 'a picked wake-up 90 minutes late');
  assertFramedLate(content, due, [before, after], 'a picked wake-up 90 minutes late');
  assert.equal(onlyState(world, 'a picked wake-up 90 minutes late').state, 'delivered', 'the wake-up must be recorded delivered');
  r = s.runDueWakeUps(world, { env: { TZ: tz } });
  assert.equal(box.connections().length, 1, `a picked wake-up goes once per due date; the second run sent it again: ${JSON.stringify(box.connections())}`);
});

test('a picked wake-up two hours or more past its time is recorded missed, never sent, and the log says missed', { timeout: 60000 }, async (t) => {
  const world = wakeWorld(t);
  const at = Date.now();
  const { tz, offset } = zoneWithLocalHour(12, at);
  const due = localMinuteOfDay(offset, at) - 150;
  setOwnerWakeUps(world, [`${hhmm(due)} Look over the orders.`]);
  const { box } = await ownSession(t, world);
  s.runDueWakeUps(world, { env: { TZ: tz } });
  assertNothingSent([box], 'a picked wake-up 150 minutes late');
  assertMissed(world, s.wakeUpStates(world)[0], due, 'a picked wake-up 150 minutes late');
  assertLogSays(world, /missed/i, 'a picked wake-up 150 minutes late');
  s.runDueWakeUps(world, { env: { TZ: tz } });
  assertNothingSent([box], 'a missed wake-up at the next run');
  assert.equal(onlyState(world, 'a missed wake-up at the next run').attempts.length, 1, 'a missed wake-up is never tried again that due date');
});

test('just after midnight a wake-up picked for the evening before goes when it is under two hours late, and one more than two hours late is missed', { timeout: 60000 }, async (t) => {
  const world = wakeWorld(t);
  const at = Date.now();
  const { tz, offset } = zoneWithLocalHour(0, at);
  const now = localMinuteOfDay(offset, at);
  const dueSoon = now - 75;
  const dueLong = now - 150;
  setOwnerWakeUps(world, [`${hhmm(dueSoon)} Check the oven.`, `${hhmm(dueLong)} Close the till.`]);
  const { box, record } = await ownSession(t, world);
  const before = localMinuteOfDay(offset);
  const r = s.runDueWakeUps(world, { env: { TZ: tz } });
  const after = localMinuteOfDay(offset);
  assert.equal(r.status, 0, `the scheduler's run must exit 0; got ${w.describe(r)}`);
  const content = assertDeliveredTo(box, record, 'Check the oven.', 'a wake-up picked for the evening before, 75 minutes late');
  assertFramedLate(content, dueSoon, [before, after], 'a wake-up picked for the evening before, 75 minutes late');
  assert.ok(!userContents(box).some((c) => c.includes('Close the till.')), 'a wake-up 150 minutes late must not be sent');
  const states = s.wakeUpStates(world);
  assert.equal((states.find((x) => (x.text || '').includes('Check the oven.')) || {}).state, 'delivered',
    `the wake-up 75 minutes late must be recorded delivered; got ${JSON.stringify(states)}`);
  assertMissed(world, states.find((x) => (x.text || '').includes('Close the till.')), dueLong, 'a wake-up picked for the evening before, 150 minutes late');
});

// ------------------------------------------------------ delivery failures

// One failed delivery: nothing delivered anywhere, the failure recorded with
// its reason and its retry state, the log saying why, and no other channel
// used (no Claude Code started, no other session in the world written to).
async function assertFailedDelivery(t, world, { mode, socket, reason, what }) {
  const fake = s.installFakeClaudeCode(world);
  const box = await inbox(t, world, 'own', mode);
  const decoy = await inbox(t, world, 'decoy');
  const record = s.seedSessionRecord(world, { sessionId: 'session-own', socket: socket || box.socket, pid: box.pid });
  const r = s.fireWakeUp(world, 'Time for the morning brief.');
  assert.ok(r.status !== null, `${what}: the router must finish; got ${w.describe(r)}`);
  assert.deepEqual(box.userMessages(), [], `${what}: nothing may be delivered; the session was given ${JSON.stringify(box.lines())}`);
  assertNothingSent([decoy], `${what}: no other session`);
  assert.deepEqual(fake.calls(), [], `${what}: no other route: Claude Code must not be started; it ran ${JSON.stringify(fake.calls().map((c) => c.argv))}`);
  const state = onlyState(world, what);
  assert.equal(state.session, record.sessionId, `${what}: the state must name the session it was aimed at`);
  assert.equal(state.state, 'retrying', `${what}: the retry state must say a retry is due (retrying); got ${JSON.stringify(state)}`);
  assert.equal(state.attempts.length, 1, `${what}: one attempt must be recorded; got ${JSON.stringify(state.attempts)}`);
  assert.equal(state.attempts[0].outcome, 'failed', `${what}: the attempt's outcome must be failed; got ${JSON.stringify(state.attempts[0])}`);
  assert.match(state.attempts[0].reason || '', reason, `${what}: the attempt must say why (${reason}); got ${JSON.stringify(state.attempts[0])}`);
  assertLogSays(world, reason, what);
}

test('a missing socket is a failed delivery: delivered nowhere else, recorded with its reason and its retry state', { timeout: 60000 }, async (t) => {
  const world = wakeWorld(t);
  await assertFailedDelivery(t, world, { mode: 'accept', socket: path.join(world.root, 's', 'gone.sock'), reason: /missing/i, what: 'a missing socket' });
});

test('a refused connection is a failed delivery: delivered nowhere else, recorded with its reason and its retry state', { timeout: 60000 }, async (t) => {
  const world = wakeWorld(t);
  await assertFailedDelivery(t, world, { mode: 'refuse', reason: /refused/i, what: 'a refused connection' });
});

test('a rejected token is a failed delivery: delivered nowhere else, recorded with its reason and its retry state', { timeout: 60000 }, async (t) => {
  const world = wakeWorld(t);
  await assertFailedDelivery(t, world, { mode: 'reject-token', reason: /token/i, what: 'a rejected token' });
});

test('a timeout before the line is written is a failed delivery: delivered nowhere else, recorded with its reason and its retry state', { timeout: 90000 }, async (t) => {
  const world = wakeWorld(t);
  await assertFailedDelivery(t, world, { mode: 'stall', reason: /time/i, what: 'a timeout before the line is written' });
});

test('with one record whose process is gone and whose socket is gone too, the failed attempt names the process gone, not the missing socket', { timeout: 60000 }, async (t) => {
  const world = wakeWorld(t);
  s.seedSessionRecord(world, { sessionId: 'session-own', socket: path.join(world.root, 's', 'gone.sock'), pid: s.deadPid(), socketInode: 1 });
  s.fireWakeUp(world, 'Time for the morning brief.');
  const state = onlyState(world, 'a record whose process and socket are both gone');
  assertRetrying(state, 'session-own', /gone/i, 'a record whose process and socket are both gone');
  assert.doesNotMatch(state.attempts[0].reason, /missing/i, `the process is checked before the socket: the reason must be the process gone, not the missing socket; got ${JSON.stringify(state.attempts[0])}`);
  assertLogSays(world, /gone/i, 'a record whose process and socket are both gone');
});

test('when the wake-up state cannot be written nothing is sent, the router exits non-zero and the log says the state could not be written', { timeout: 60000 }, async (t) => {
  const world = w.makeWorld();
  const states = s.wakeUpsDir(world);
  // Registered first so it runs before the world is cleaned up.
  t.after(() => { try { fs.chmodSync(states, 0o700); } catch (e) { /* not made */ } });
  t.after(() => { s.killFakes(world); w.cleanUp(world); });
  setOwnerWakeUps(world, []);
  const { box } = await ownSession(t, world);
  fs.mkdirSync(states, { recursive: true });
  fs.chmodSync(states, 0o500);
  const r = s.fireWakeUp(world, 'Time for the morning brief.');
  assertNothingSent([box], 'a wake-up whose state cannot be written');
  assert.ok(r.status !== 0, `the router must exit non-zero when it cannot write the state; got ${w.describe(r)}`);
  assertLogSays(world, /could not be written/i, 'a wake-up whose state cannot be written');
});

test('a line written but not acknowledged within the deadline is recorded unknown and never retried', { timeout: 90000 }, async (t) => {
  const world = wakeWorld(t);
  const { box } = await ownSession(t, world, { mode: 'silent' });
  const started = Date.now();
  s.fireWakeUp(world, 'Time for the morning brief.');
  assert.ok(Date.now() - started < 30000, `the router must give up waiting within its deadline; it took ${Date.now() - started} ms`);
  assert.equal(box.userMessages().length, 1, `the line must have been written once; the session was given ${JSON.stringify(box.lines())}`);
  let state = onlyState(world, 'an unacknowledged line');
  assert.equal(state.state, 'unknown', `the outcome must be recorded unknown; got ${JSON.stringify(state)}`);
  assertLogSays(world, /unknown/i, 'an unacknowledged line');

  // Seen later by the scheduler, with a session that would take it: never retried.
  const id = state.id;
  s.seedWakeUp(world, { ...state, attempts: state.attempts.map((a) => ({ ...a, at: minutesAgo(5) })) });
  await box.stop();
  for (const f of fs.readdirSync(s.sessionsDir(world))) fs.rmSync(path.join(s.sessionsDir(world), f));
  const fresh = await ownSession(t, world, { name: 'fresh', sessionId: state.session });
  s.runDueWakeUps(world);
  assertNothingSent([fresh.box], 'an unknown wake-up seen by the scheduler');
  state = s.wakeUpStates(world).find((x) => x.id === id);
  assert.equal(state.state, 'unknown', `an unknown wake-up must stay unknown; got ${JSON.stringify(state)}`);
  assert.equal(state.attempts.length, 1, `an unknown wake-up must never be retried; got ${JSON.stringify(state.attempts)}`);
});

// A wake-up seeded with past failed attempts, aimed at session-own.
function seedFailed(world, id, ages, reason = 'refused connection') {
  return s.seedWakeUp(world, {
    id, text: 'Time for the morning brief.', session: 'session-own', state: 'retrying',
    attempts: ages.map((age) => ({ at: minutesAgo(age), outcome: 'failed', reason })),
  });
}

test('typical: a wake-up that failed once is retried by the scheduler run with the session back, re-checked and delivered', { timeout: 60000 }, async (t) => {
  const world = wakeWorld(t);
  seedFailed(world, 'wake-typical', [2]);
  const { box, record } = await ownSession(t, world, { sessionId: 'session-own' });
  const r = s.runDueWakeUps(world);
  assert.equal(r.status, 0, `the scheduler's run must exit 0; got ${w.describe(r)}`);
  assertDeliveredTo(box, record, 'Time for the morning brief.', 'a retry with the session back');
  const state = s.wakeUpStates(world).find((x) => x.id === 'wake-typical');
  assert.equal(state.state, 'delivered', `the retried wake-up must be recorded delivered; got ${JSON.stringify(state)}`);
  assert.equal(state.attempts.length, 2, `the retry must be recorded as a second attempt; got ${JSON.stringify(state.attempts)}`);
});

test('heavy: after three failed attempts the third retry inside ten minutes is delivered, and there is never a fourth retry or one after ten minutes', { timeout: 90000 }, async (t) => {
  const world = wakeWorld(t);
  // The first attempt and two retries failed: the session refused them.
  seedFailed(world, 'wake-third-retry', [9, 7, 5]);
  const { box, record } = await ownSession(t, world, { sessionId: 'session-own' });
  s.runDueWakeUps(world);
  assertDeliveredTo(box, record, 'Time for the morning brief.', 'the third retry, inside ten minutes');
  let state = s.wakeUpStates(world).find((x) => x.id === 'wake-third-retry');
  assert.equal(state.attempts.length, 4, `the third retry must be the fourth attempt; got ${JSON.stringify(state.attempts)}`);

  // Three retries already spent: no fourth, with the session there to take it.
  fs.rmSync(path.join(s.wakeUpsDir(world), 'wake-third-retry.json'));
  seedFailed(world, 'wake-spent', [8, 6, 4, 2]);
  s.runDueWakeUps(world);
  assert.equal(box.connections().length, 1, `a wake-up whose three retries are spent must not be sent again; the session was given ${JSON.stringify(box.connections())}`);
  state = s.wakeUpStates(world).find((x) => x.id === 'wake-spent');
  assert.equal(state.attempts.length, 4, `no fourth retry may be recorded; got ${JSON.stringify(state.attempts)}`);
  assert.equal(state.state, 'failed', `a wake-up whose retries are spent must be recorded failed; got ${JSON.stringify(state)}`);

  // Ten minutes past the first attempt: no retry at all.
  fs.rmSync(path.join(s.wakeUpsDir(world), 'wake-spent.json'));
  seedFailed(world, 'wake-late', [11]);
  s.runDueWakeUps(world);
  assert.equal(box.connections().length, 1, `a wake-up first tried more than ten minutes ago must not be retried; the session was given ${JSON.stringify(box.connections())}`);
  state = s.wakeUpStates(world).find((x) => x.id === 'wake-late');
  assert.equal(state.attempts.length, 1, `no retry may be recorded after ten minutes; got ${JSON.stringify(state.attempts)}`);
  assert.equal(state.state, 'failed', `a wake-up past its ten minutes must be recorded failed; got ${JSON.stringify(state)}`);
});

test('after three failed attempts with no session the last retry fails, the wake-up is recorded failed with four attempts and its log line names every reason', { timeout: 60000 }, async (t) => {
  const world = wakeWorld(t);
  s.seedWakeUp(world, {
    id: 'wake-last-retry', text: 'Time for the morning brief.', session: 'session-own', state: 'retrying',
    attempts: [
      { at: minutesAgo(7), outcome: 'failed', reason: 'process gone' },
      { at: minutesAgo(5), outcome: 'failed', reason: 'missing socket' },
      { at: minutesAgo(3), outcome: 'failed', reason: 'no record' },
    ],
  });
  s.runDueWakeUps(world);
  const state = s.wakeUpStates(world).find((x) => x.id === 'wake-last-retry');
  assert.equal(state.attempts.length, 4, `the last retry must be recorded as a fourth attempt; got ${JSON.stringify(state.attempts)}`);
  assert.equal(state.attempts[3].outcome, 'failed', `the last retry, with no session, must fail; got ${JSON.stringify(state.attempts[3])}`);
  assert.match(state.attempts[3].reason || '', /no record/i, `the last retry must say there was no record; got ${JSON.stringify(state.attempts[3])}`);
  assert.equal(state.state, 'failed', `after the last retry fails the wake-up must be recorded failed; got ${JSON.stringify(state)}`);
  const log = s.wakeUpLog(world);
  assert.ok(log.some((l) => /gone/i.test(l) && /missing/i.test(l) && /no record/i.test(l)),
    `the failed wake-up's log line must name every attempt's reason (process gone, missing socket, no record); the log holds ${JSON.stringify(log)}`);
});

test('a retry re-runs the identity check: with the record now naming a different session, or two records, the retry is not delivered and the log says why', { timeout: 60000 }, async (t) => {
  const world = wakeWorld(t);
  seedFailed(world, 'wake-changed', [2]);
  const other = await ownSession(t, world, { name: 'other', sessionId: 'session-new' });
  s.runDueWakeUps(world);
  assertNothingSent([other.box], 'a retry after the record changed to a new session');
  assertLogSays(world, /changed/i, 'a retry after the record changed to a new session');
  let state = s.wakeUpStates(world).find((x) => x.id === 'wake-changed');
  assert.notEqual(state.state, 'delivered', `the retry must not be recorded delivered; got ${JSON.stringify(state)}`);

  // Two records, one of them the session the wake-up was aimed at.
  fs.rmSync(path.join(s.wakeUpsDir(world), 'wake-changed.json'));
  seedFailed(world, 'wake-two', [2]);
  const own = await ownSession(t, world, { name: 'own', sessionId: 'session-own' });
  s.runDueWakeUps(world);
  assertNothingSent([other.box, own.box], 'a retry with two records');
  assertLogSays(world, /more than one/i, 'a retry with two records');
  state = s.wakeUpStates(world).find((x) => x.id === 'wake-two');
  assert.notEqual(state.state, 'delivered', `the retry must not be recorded delivered; got ${JSON.stringify(state)}`);
});

// ----------------------------------------- a wake-up never counts as a yes

test('a wake-up whose text is yes, Yes with the request id, or no, delivered to the session and taken as its prompt, never answers the open request', { timeout: 90000 }, async (t) => {
  const world = wakeWorld(t);
  const sessionId = 'session-asked';
  const send = tools.gmailSend('someone@example.com', 'Saturday', 'The cake is ready.');
  const asked = w.attempt(world, sessionId, send);
  w.assertBlocked(asked, 'a send before any wake-up');
  const requestId = w.requestIdIn(asked.stderr);
  assert.ok(requestId, `a send must be asked with a request id; got ${w.describe(asked)}`);
  const { box, record } = await ownSession(t, world, { sessionId });

  const answersBefore = () => fs.readFileSync(w.ledgerOf(world), 'utf8').split('\n').filter(Boolean)
    .map((l) => JSON.parse(l)).filter((e) => e.type === 'answer');
  const before = answersBefore().length;
  let delivered = 0;
  for (const text of ['yes', `Yes ${requestId}`, 'no']) {
    const r = s.fireWakeUp(world, text);
    assert.equal(r.status, 0, `the wake-up "${text}" must be delivered (exit 0); got ${w.describe(r)}`);
    delivered += 1;
    const contents = userContents(box);
    assert.equal(contents.length, delivered, `the wake-up "${text}" must reach the session as one message; it holds ${JSON.stringify(contents)}`);
    const content = contents[contents.length - 1];
    assert.equal(box.connections()[delivered - 1].lines.map((l) => JSON.parse(l))[0].token, record.token, 'each wake-up must carry the session\'s token');
    // Claude Code hands the posted content, unwrapped, to the prompt hook.
    w.ownerSays(world, sessionId, content);
    assert.equal(answersBefore().length, before, `the wake-up "${text}" (posted as ${JSON.stringify(content)}) must not answer the request; the ledger records an answer`);
    const again = w.attempt(world, sessionId, send);
    w.assertBlocked(again, `the send after the wake-up "${text}"`);
    assert.ok(w.requestIdIn(again.stderr), `the send must still be asked after the wake-up "${text}"; got ${w.describe(again)}`);
  }
});
