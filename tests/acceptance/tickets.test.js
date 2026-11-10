'use strict';

// Squire's support tickets (the design record ADR-005, lines 15 to 19): built
// once from allow-listed diagnostics into an outbox in the Squire home, shown
// to the owner byte for byte in the safety floor's block, sent only on the
// owner's yes by the scheduler's tick (ticket.py --perform, the outside job),
// kept and retried exactly as approved when sending fails; and the install id,
// 128 random bits made at the first ticket, linked to no person.
//
// Every case runs an installed, healthy Squire in the updates world, whose
// core names the world's loopback intake; the intake records each post's
// bytes and answers as told. A fault not on the known-fixes list (an ignored
// overlay in the owner's folder) is what offers a ticket here. Personal
// details are planted where a careless diagnostic would pick them up: the
// owner's folder, the error logs, the paths, and the computer's name (the
// world's scutil and hostname); the account name is the real one the tests
// run under.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const w = require('../fixtures/squire-world.js');
const R = require('../fixtures/updates-world.js');

const SESSION = 'session-ticket';
const LONG = { timeout: 300000 };

async function healthyWorld(t, opts = {}) {
  const rw = R.makeReleaseWorld(t, opts);
  await R.startSquire(rw);
  return rw;
}

// A fault not on the known-fixes list: overlays in the owner's folder, which
// the health check names and ignores.
function plantFault(rw) {
  w.plantOverlays(rw.owner, [R.installedCore(rw)]);
}

// The health check offers a ticket for the fault on a line of its own and the
// ticket is in the outbox: its id, its bytes and the request that asks to send it.
function offered(rw, what = 'the fault not on the known-fixes list') {
  const h = R.health(rw);
  const offers = R.ticketLines(h.stdout);
  assert.ok(offers.length >= 1, `${what}: the health check must offer a support ticket on a line of its own, ` +
    '"ticket: <ticket id> is ready to send about <fault>; to send it, ask: <request>"; got ' + w.describe(h));
  const [, id, about, request] = offers[0];
  assert.equal(request, R.ticketRequest(rw, id), `${what}: the offer must name the request that asks to send it`);
  const file = R.outboxFile(rw, id);
  assert.ok(fs.existsSync(file), `${what}: the ticket must be built into the outbox (${path.relative(rw.home, file)})`);
  return { id, about, request, bytes: fs.readFileSync(file), h };
}

function approve(rw, ticket, session = SESSION) {
  const a = R.asked(rw, session, ticket.request, 'the request to send the ticket');
  R.owner(rw, session, `yes ${a.id}`);
  return a;
}

const posted = (rw, id) => R.intakePosts(rw).filter((p) => p.ticketId === id);
const waitingLines = (rw, id) => R.health(rw).stdout.split('\n').map((l) => l.trim())
  .filter((l) => new RegExp(`^ticket: ${id} is waiting to send`).test(l));

// ------------------------------------------------- preview, then a yes

test('a ticket is built once into the outbox with its digest, the floor shows its exact bytes with the install id and destination, and on the yes the intake receives exactly those bytes', LONG, async (t) => {
  const rw = await healthyWorld(t);
  plantFault(rw);
  const ticket = offered(rw);
  const state = R.outboxState(rw, ticket.id);
  assert.ok(state && state.digest === w.sha256(ticket.bytes), `the outbox must keep the ticket's digest; got ${JSON.stringify(state)}`);
  const again = offered(rw, 'a second run of the health check');
  assert.equal(again.id, ticket.id, 'the same fault names the same ticket at every later run: it is built once');
  assert.ok(again.bytes.equals(ticket.bytes), 'a later run never rebuilds the ticket\'s bytes');
  const body = JSON.parse(ticket.bytes.toString('utf8'));
  assert.equal(body.installId, R.installId(rw), 'the ticket carries the install id kept in the Squire home');
  assert.equal(body.destination, rw.intake, 'the ticket names where it is sent');
  const a = R.asked(rw, SESSION, ticket.request, 'the request to send the ticket');
  assert.ok(a.block.includes(ticket.bytes.toString('utf8')), `the floor's block must show the outbox file's exact bytes; got ${JSON.stringify(a.block)}`);
  assert.ok(a.block.includes(R.FENCE_WORDS), `the block must end with the words that make the session show its text inside a fenced code block; got ${JSON.stringify(a.block)}`);
  R.owner(rw, SESSION, `yes ${a.id}`);
  R.tick(rw);
  const posts = posted(rw, ticket.id);
  assert.equal(posts.length, 1, `the scheduler's run must post the ticket once; posts: ${JSON.stringify(R.intakePosts(rw).map((p) => p.ticketId))}`);
  assert.ok(posts[0].bytes.equals(ticket.bytes), 'the intake must receive exactly the bytes previewed, nothing else');
  assert.match(posts[0].contentType || '', /^application\/json/, 'the ticket is posted as JSON');
  assert.ok(!fs.existsSync(R.outboxFile(rw, ticket.id)), 'an answer in the 2xx range clears the ticket from the outbox');
});

async function nothingPosted(t, variant, what) {
  const rw = await healthyWorld(t);
  plantFault(rw);
  const ticket = offered(rw);
  const a = R.asked(rw, SESSION, ticket.request, 'the request to send the ticket');
  if (variant === 'no') R.owner(rw, SESSION, `no ${a.id}`);
  else R.moveLedgerTime(rw, R.requestRecord(a.id), -(rw.world.config.approvalTimeoutSeconds + 60));
  R.tick(rw);
  assert.deepEqual(R.intakePosts(rw), [], `${what}: nothing may be posted`);
  assert.ok(R.setAside(rw).includes(`${ticket.id}.json`), `${what}: the ticket must be set aside (outbox/set-aside/); outbox: ${JSON.stringify(R.outboxIds(rw))}`);
  assert.ok(!R.outboxIds(rw).includes(ticket.id), `${what}: a set-aside ticket no longer waits in the outbox`);
}

test("with the owner's no nothing is posted and the ticket is set aside", LONG, (t) => nothingPosted(t, "no", "the owner's no"));
test("with no answer within the ledger's timeout nothing is posted and the ticket is set aside", LONG, (t) => nothingPosted(t, "noAnswer", "no answer within the ledger's timeout"));

test('a yes naming another request posts nothing', LONG, async (t) => {
  const rw = await healthyWorld(t);
  plantFault(rw);
  const ticket = offered(rw);
  R.asked(rw, SESSION, ticket.request, 'the request to send the ticket');
  const other = R.asked(rw, SESSION, R.fixRequest(rw, 'floor'), 'another request, a known fix');
  R.owner(rw, SESSION, `yes ${other.id}`);
  R.tick(rw);
  assert.deepEqual(R.intakePosts(rw), [], 'a yes to another request must never send the ticket');
  assert.ok(R.outboxIds(rw).includes(ticket.id), 'the ticket still waits for its own answer');
});

test("a fault not on the known-fixes list offers a ticket on a line of its own; the fault's own line carries no offer", LONG, async (t) => {
  const rw = await healthyWorld(t);
  plantFault(rw);
  const ticket = offered(rw);
  const faultLines = ticket.h.stdout.split('\n').filter((l) => /^ignored: overlay\//.test(l.trim()));
  assert.ok(faultLines.length >= 1, `the overlays must still be named; got ${w.describe(ticket.h)}`);
  assert.ok(faultLines.every((l) => !l.includes('ticket') && !l.includes('--send')), 'no offer may sit on a fault\'s own line');
});

// ------------------------------------------------- diagnostics only

function plantDetails(rw) {
  const P = R.PLANTED;
  const o = rw.owner;
  fs.writeFileSync(path.join(o, 'operator', 'profile.md'), `# ${P.fullName}\n\nEmail ${P.email}, phone ${P.phone}, card ${P.card}.\n`);
  fs.writeFileSync(path.join(o, 'workspace', 'files', `${P.fullName} ${P.phone}.txt`), `${P.email}\n`);
  const logs = path.join(rw.home, 'logs');
  fs.mkdirSync(logs, { recursive: true });
  for (const name of ['runner.log', 'wake-ups.log', 'health.log', 'backup.log']) {
    fs.appendFileSync(path.join(logs, name), `${new Date().toISOString()} error: could not reach ${P.email} at ${path.join(o, 'workspace', 'files', `${P.fullName} ${P.phone}.txt`)} (card ${P.card})\n`);
  }
}

// Only allow-listed fields, each value inside its set or pattern, the
// destination the intake's address; and no planted detail anywhere.
function assertDiagnosticsOnly(rw, bytes, places, what, extra = []) {
  const body = JSON.parse(bytes.toString('utf8'));
  for (const [k, v] of Object.entries(body)) {
    assert.ok(k in R.TICKET_FIELDS, `${what}: the ticket may carry only allow-listed fields; it carries ${k}`);
    if (k === 'destination') assert.equal(v, rw.intake, `${what}: the destination is the intake's address`);
    else assert.ok(R.TICKET_FIELDS[k](v), `${what}: ${k}'s value must be inside its set or pattern; got ${JSON.stringify(v)}`);
  }
  for (const [name, text] of Object.entries(places)) {
    for (const trace of R.plantedTraces(extra)) {
      assert.ok(!text.includes(trace), `${what}: the planted detail "${trace}" must not appear in ${name}`);
    }
    assert.ok(!R.carriesAccountName(text), `${what}: the account's names must not appear in ${name}`);
  }
}

test("personal details planted in the owner's folder, the error logs, the paths, the computer's name and the account never reach a ticket, its preview or the intake", LONG, async (t) => {
  const rw = await healthyWorld(t);
  plantDetails(rw);
  plantFault(rw);
  const ticket = offered(rw);
  const a = approve(rw, ticket);
  R.tick(rw);
  const posts = posted(rw, ticket.id);
  assert.equal(posts.length, 1, 'the approved ticket must be posted');
  assertDiagnosticsOnly(rw, ticket.bytes, {
    'the ticket': ticket.bytes.toString('utf8'), 'the preview': a.block,
    'what the intake received': R.intakePosts(rw).map((p) => p.bytes.toString('utf8')).join('\n'),
  }, 'planted details');
});

async function fieldLeftOut(t, variant, field, what, setUp, planted) {
  const rw = await healthyWorld(t, setUp || {});
  if (variant === 'claude') R.setVersionAnswer(rw, `2.1.319 build for ${R.PLANTED.email}`);
  plantFault(rw);
  const ticket = offered(rw);
  const body = JSON.parse(ticket.bytes.toString('utf8'));
  assert.ok(!(field in body), `${what}: the field ${field} must be dropped; got ${JSON.stringify(body[field])}`);
  assert.ok(R.TICKET_FIELDS.ticketId(body.ticketId) && R.TICKET_FIELDS.installId(body.installId), `${what}: the rest of the ticket is still built`);
  const a = approve(rw, ticket);
  R.tick(rw);
  assertDiagnosticsOnly(rw, ticket.bytes, {
    'the ticket': ticket.bytes.toString('utf8'), 'the preview': a.block,
    'what the intake received': R.intakePosts(rw).map((p) => p.bytes.toString('utf8')).join('\n'),
  }, what, planted);
}

test('with a Mac model outside the known set, the ticket leaves out macModelClass and keeps the rest, and the value reaches neither the preview nor the intake', LONG, (t) => fieldLeftOut(t, "model", "macModelClass", "a Mac model outside the known set", {"mac":{"model":"Ada Lovelace's Mac (ada.lovelace@example.net)"}}, []));
test('with a macOS version that is not whole numbers and dots, the ticket leaves out macOSVersion and keeps the rest, and the value reaches neither the preview nor the intake', LONG, (t) => fieldLeftOut(t, "macOS", "macOSVersion", "a macOS version that is not whole numbers and dots", {"mac":{"macOSVersion":"26.3.1 (Ada Lovelace)"}}, []));
test('with a Claude Code version answer that is not a version, the ticket leaves out claudeCodeVersion and keeps the rest, and the value reaches neither the preview nor the intake', LONG, (t) => fieldLeftOut(t, "claude", "claudeCodeVersion", "a Claude Code version answer that is not a version", null, ["build for ada.lovelace"]));
test('with a macOS version inside its pattern that the privacy patterns read as a card number, the ticket leaves out macOSVersion and keeps the rest, and the value reaches neither the preview nor the intake', LONG, (t) => fieldLeftOut(t, "card", "macOSVersion", "a macOS version inside its pattern that the privacy patterns read as a card number", {"mac":{"macOSVersion":"4111.1111.1111.1111"}}, ["4111.1111.1111.1111","4111111111111111"]));

// ------------------------------------------------- kept and retried

// The world plays time passing for the ticket's attempts.
const older = (rw, id, seconds) => R.moveRecordTimes(path.join(rw.home, 'outbox', `${id}.state.json`), -seconds, ['at']);

test('an approved ticket whose send fails is kept with a health line saying it waits, retried with a growing wait carrying the same bytes and id, and cleared by an answer in the 2xx range; the intake files it once', LONG, async (t) => {
  const rw = await healthyWorld(t);
  plantFault(rw);
  const ticket = offered(rw);
  approve(rw, ticket);
  R.standIns(rw, { intake: 'fail' });
  R.tick(rw);
  assert.equal(posted(rw, ticket.id).length, 1, 'the first run must try to send it');
  assert.ok(fs.existsSync(R.outboxFile(rw, ticket.id)), 'a failed send keeps the ticket in the outbox');
  assert.equal(waitingLines(rw, ticket.id).length, 1, `a health line must say the ticket is waiting to send; got ${JSON.stringify(R.health(rw).stdout)}`);
  R.tick(rw);
  assert.equal(posted(rw, ticket.id).length, 1, 'no second attempt within a minute of the first');
  older(rw, ticket.id, 61);
  R.tick(rw);
  assert.equal(posted(rw, ticket.id).length, 2, 'a second attempt a minute after the first');
  older(rw, ticket.id, 61);
  R.tick(rw);
  assert.equal(posted(rw, ticket.id).length, 2, 'the wait grows: no third attempt a minute after the second');
  older(rw, ticket.id, 60);
  R.tick(rw);
  assert.equal(posted(rw, ticket.id).length, 3, 'a third attempt two minutes after the second');
  R.standIns(rw, { intake: 'ok' });
  older(rw, ticket.id, 300);
  R.tick(rw);
  const posts = posted(rw, ticket.id);
  assert.equal(posts.length, 4, 'a fourth attempt once the wait has passed');
  assert.ok(posts.every((p) => p.bytes.equals(ticket.bytes)), 'every attempt carries exactly the approved bytes and the same ticket id');
  assert.equal(posts.filter((p) => p.filedAs === 'new').length, 1, 'the intake files it once');
  assert.ok(!fs.existsSync(R.outboxFile(rw, ticket.id)), 'the 2xx answer clears it from the outbox');
  assert.deepEqual(waitingLines(rw, ticket.id), [], 'nothing waits once it is sent');
});

async function keptAndSentAgain(t, intake, what) {
  const rw = await healthyWorld(t);
  plantFault(rw);
  const ticket = offered(rw);
  approve(rw, ticket);
  R.standIns(rw, { intake });
  R.tick(rw);
  assert.ok(fs.existsSync(R.outboxFile(rw, ticket.id)), `${what}: the ticket must stay in the outbox`);
  assert.equal(waitingLines(rw, ticket.id).length, 1, `${what}: a health line must say it is waiting to send`);
  R.standIns(rw, { intake: 'ok' });
  older(rw, ticket.id, 300);
  R.tick(rw);
  const posts = posted(rw, ticket.id);
  assert.ok(posts.length >= 1 && posts.every((p) => p.bytes.equals(ticket.bytes)), `${what}: every attempt carries exactly the approved bytes`);
  assert.equal(posts.filter((p) => p.filedAs === 'new').length, 1, `${what}: the intake files it once`);
  assert.ok(!fs.existsSync(R.outboxFile(rw, ticket.id)), `${what}: an answer in the 2xx range clears it`);
}

test('with the intake offline, the approved ticket is kept and shown as waiting, then sent again with the same id and filed once', LONG, (t) => keptAndSentAgain(t, "offline", "the intake offline"));
test('with the answer coming after the bound (30 seconds), the approved ticket is kept and shown as waiting, then sent again with the same id and filed once', LONG, (t) => keptAndSentAgain(t, "late", "the answer coming after the bound (30 seconds)"));

test('a ticket file changed after the yes is never sent, and is sent as changed only after another yes to the changed bytes', LONG, async (t) => {
  const rw = await healthyWorld(t);
  plantFault(rw);
  const ticket = offered(rw);
  approve(rw, ticket);
  R.standIns(rw, { intake: 'fail' });
  R.tick(rw);
  assert.equal(posted(rw, ticket.id).length, 1, 'the first run must try to send it');
  const changed = Buffer.from(ticket.bytes.toString('utf8').replace(/"createdAt":\s*(\d+)/, (m, n) => m.replace(n, String(Number(n) + 1))));
  assert.ok(!changed.equals(ticket.bytes), 'the world changes the waiting ticket\'s file');
  fs.writeFileSync(R.outboxFile(rw, ticket.id), changed);
  R.standIns(rw, { intake: 'ok' });
  older(rw, ticket.id, 300);
  R.tick(rw);
  assert.equal(posted(rw, ticket.id).length, 1, 'a file changed after the yes must never be sent');
  const a = R.asked(rw, `${SESSION}-again`, ticket.request, 'the request to send the changed ticket');
  assert.ok(a.block.includes(changed.toString('utf8')), 'the new preview shows the changed bytes');
  R.owner(rw, `${SESSION}-again`, `yes ${a.id}`);
  older(rw, ticket.id, 300);
  R.tick(rw);
  const posts = posted(rw, ticket.id);
  assert.equal(posts.length, 2, 'after another yes the changed ticket is sent');
  assert.ok(posts[1].bytes.equals(changed), 'what is sent is exactly the changed bytes the owner said yes to');
});

// ------------------------------------------------- the install id

test('the install id is made at the first ticket: 32 lower-case hex digits kept in the Squire home for its user only, the same on every ticket from that home', LONG, async (t) => {
  const rw = await healthyWorld(t);
  assert.equal(R.installId(rw), null, 'no install id before the first ticket');
  plantFault(rw);
  const first = offered(rw);
  const id = R.installId(rw);
  assert.match(id || '', /^[0-9a-f]{32}$/, 'the install id is 128 bits written as 32 lower-case hex digits');
  assert.equal(fs.statSync(path.join(rw.home, 'install-id')).mode & 0o777, 0o600, 'the install id is readable by its user only');
  assert.equal(JSON.parse(first.bytes).installId, id, 'the ticket carries it');
  approve(rw, first);
  R.tick(rw);
  // The fault gone and back: a second ticket from the same home.
  fs.rmSync(path.join(rw.owner, 'overlay'), { recursive: true, force: true });
  R.health(rw);
  plantFault(rw);
  const second = offered(rw, 'the fault back after the first ticket was sent');
  assert.notEqual(second.id, first.id, 'a fault back after its ticket was sent builds a new ticket');
  assert.equal(JSON.parse(second.bytes).installId, id, 'every ticket from one Squire home carries the same install id');
});

test('two Squire homes have different install ids, made from nothing about the owner, the Mac or the account, and nothing is posted anywhere but the tickets', LONG, async (t) => {
  const ids = [];
  for (const n of [1, 2]) {
    const rw = await healthyWorld(t);
    plantDetails(rw);
    plantFault(rw);
    const ticket = offered(rw);
    approve(rw, ticket);
    R.tick(rw);
    ids.push(R.installId(rw));
    const others = R.hostRequests(rw).filter((r) => !(r.method === 'POST' && r.path.startsWith('/tickets')) && !(r.method === 'GET' && r.path.startsWith('/releases/')));
    assert.deepEqual(others, [], `world ${n}: nothing may be registered or sent anywhere but the ticket itself`);
    assert.ok(R.intakePosts(rw).every((p) => JSON.parse(p.bytes.toString('utf8')).ticketId), `world ${n}: every post is a ticket`);
    for (const trace of R.plantedTraces()) assert.ok(!ids[ids.length - 1].includes(trace.toLowerCase()), `world ${n}: the install id carries nothing planted`);
    assert.ok(!R.carriesAccountName(ids[ids.length - 1]), `world ${n}: the install id carries nothing of the account`);
  }
  assert.match(ids[0] || '', /^[0-9a-f]{32}$/, 'the first home has an install id');
  assert.match(ids[1] || '', /^[0-9a-f]{32}$/, 'the second home has an install id');
  assert.notEqual(ids[0], ids[1], 'two Squire homes never share an install id');
});
