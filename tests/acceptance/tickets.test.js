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
  // The outbox file's exact bytes as whole lines once, then one empty line and
  // the relay words that make the session show them inside a fenced code block.
  R.assertBlockShape(a.block, [ticket.bytes.toString('utf8')], 'the floor\'s block for the ticket');
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
  // An overlay's own path is not an offer: each fault line is the ignored form and nothing more.
  assert.ok(faultLines.every((l) => /^ignored: overlay\/\S+ \(safety floor\)$/.test(l)), 'no offer may sit on a fault\'s own line');
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
    assert.ok(!R.carriesAccountName(text, body), `${what}: the account's names must not appear in ${name}`);
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

test("a ticket's post carries the approved bytes and nothing else: one POST to the configured intake's path with Host, Content-Type application/json and Content-Length alone, no transfer encoding, and no planted detail in its path, its headers or its body", LONG, async (t) => {
  const rw = await healthyWorld(t);
  plantDetails(rw);
  plantFault(rw);
  const ticket = offered(rw);
  approve(rw, ticket);
  R.tick(rw);
  const posts = posted(rw, ticket.id);
  assert.equal(posts.length, 1, `the approved ticket must be posted once; posts: ${JSON.stringify(R.intakePosts(rw).map((p) => p.ticketId))}`);
  const p = posts[0];
  const intake = new URL(rw.intake);
  assert.deepEqual([p.method, p.server, p.path], ['POST', 'intake', intake.pathname], 'one POST to the configured intake\'s own path');
  const headers = [];
  for (let i = 0; i < p.headers.length; i += 2) headers.push([p.headers[i].toLowerCase(), p.headers[i + 1]]);
  assert.deepEqual(headers.map(([k]) => k).sort(), ['content-length', 'content-type', 'host'],
    `the post carries Host, Content-Type and Content-Length and no other header; got ${JSON.stringify(p.headers)}`);
  const h = Object.fromEntries(headers);
  assert.equal(h['content-type'], 'application/json', 'Content-Type is application/json');
  assert.equal(Number(h['content-length']), ticket.bytes.length, 'Content-Length is the approved bytes\' length');
  assert.equal(h.host, intake.host, 'Host is the configured intake\'s');
  assert.ok(p.bytes.equals(ticket.bytes), 'the body is the approved bytes exactly');
  const wire = [p.method, p.path, ...p.headers, p.bytes.toString('utf8')].join('\n');
  for (const trace of R.plantedTraces()) assert.ok(!wire.includes(trace), `the planted detail "${trace}" must not appear anywhere in the request`);
  assert.ok(!R.carriesAccountName(wire, JSON.parse(ticket.bytes.toString('utf8'))), 'the account\'s names must not appear anywhere in the request');
});

test("a person's name planted where a code of the right pattern could carry it (an error code in Squire's logs, a folder and a file in the owner's folder) never reaches a ticket: its codes come from closed sets, the name appears nowhere, and the rest of the ticket is built", LONG, async (t) => {
  const rw = await healthyWorld(t);
  const name = 'ada-lovelace';
  const logs = path.join(rw.home, 'logs');
  fs.mkdirSync(logs, { recursive: true });
  for (const log of ['runner.log', 'wake-ups.log', 'health.log', 'backup.log']) {
    fs.appendFileSync(path.join(logs, log), `${new Date().toISOString()} error ${name}: the session could not start\ncode=${name}\n`);
  }
  fs.mkdirSync(path.join(rw.owner, 'workspace', 'files', name), { recursive: true });
  fs.writeFileSync(path.join(rw.owner, 'workspace', 'files', name, `${name}.txt`), `${name}\n`);
  plantFault(rw);
  const ticket = offered(rw);
  const body = JSON.parse(ticket.bytes.toString('utf8'));
  assert.ok(R.TICKET_FIELDS.ticketId(body.ticketId) && R.TICKET_FIELDS.installId(body.installId), 'the rest of the ticket is still built');
  const a = approve(rw, ticket);
  R.tick(rw);
  assertDiagnosticsOnly(rw, ticket.bytes, {
    'the ticket': ticket.bytes.toString('utf8'), 'the preview': a.block,
    'what the intake received': R.intakePosts(rw).map((x) => x.bytes.toString('utf8')).join('\n'),
  }, 'a name where a code could carry it', [name, 'lovelace']);
});

test("a configured intake that is not a plain address (here one carrying a person's name as its user) builds no ticket: nothing is offered or posted, and a health line names Squire's config without the address", LONG, async (t) => {
  const rw = await healthyWorld(t, { intake: (x) => x.intake.replace('http://', 'http://ada.lovelace@') });
  plantFault(rw);
  const h = R.health(rw);
  assert.deepEqual(R.ticketLines(h.stdout), [], `no ticket may be offered; got ${w.describe(h)}`);
  assert.deepEqual(R.outboxIds(rw), [], 'no ticket may be built');
  const config = h.stdout.split('\n').map((l) => l.trim()).filter((l) => /release\.json/.test(l) && !l.startsWith('ignored: overlay/'));
  assert.ok(config.length >= 1, `a health line must name Squire's config, core/release.json; got ${w.describe(h)}`);
  assert.ok(config.every((l) => !/lovelace/i.test(l)), 'the line names the config, never the address it holds');
  R.tick(rw);
  assert.deepEqual(R.hostRequests(rw).filter((r) => r.method === 'POST'), [], 'nothing may be posted');
});

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
  R.assertBlockShape(a.block, [changed.toString('utf8')], 'the new preview shows the changed bytes');
  R.owner(rw, `${SESSION}-again`, `yes ${a.id}`);
  older(rw, ticket.id, 300);
  R.tick(rw);
  const posts = posted(rw, ticket.id);
  assert.equal(posts.length, 2, 'after another yes the changed ticket is sent');
  assert.ok(posts[1].bytes.equals(changed), 'what is sent is exactly the changed bytes the owner said yes to');
});

// ------------------------------------------------- one yes, one set of bytes

// The world changes a waiting ticket's file and, with it, the digest in its
// state record, so the two still agree with each other: only the digest the
// floor recorded with the request can tell.
function changeTicket(rw, ticket) {
  const changed = Buffer.from(ticket.bytes.toString('utf8').replace(/"createdAt":\s*(\d+)/, (m, n) => m.replace(n, String(Number(n) + 1))));
  assert.ok(!changed.equals(ticket.bytes), 'the world changes the waiting ticket\'s file');
  fs.writeFileSync(R.outboxFile(rw, ticket.id), changed);
  const stateFile = path.join(rw.home, 'outbox', `${ticket.id}.state.json`);
  const state = R.readJson(stateFile);
  assert.ok(state, 'the world changes the ticket\'s state record, which must be there');
  fs.writeFileSync(stateFile, JSON.stringify({ ...state, digest: w.sha256(changed) }) + '\n');
  return changed;
}

test("an approved ticket whose file and the digest in its state record are changed together after the yes is never sent: the yes holds the digest the floor recorded with the request", LONG, async (t) => {
  const rw = await healthyWorld(t);
  plantFault(rw);
  const ticket = offered(rw);
  approve(rw, ticket);
  const changed = changeTicket(rw, ticket);
  R.tick(rw);
  assert.deepEqual(R.intakePosts(rw), [], 'a ticket changed after the yes, its state record with it, must never be sent');
  const a = R.asked(rw, `${SESSION}-again`, ticket.request, 'the request to send the changed ticket');
  R.assertBlockShape(a.block, [changed.toString('utf8')], 'the changed ticket waits for a yes to its own preview');
});

test("a ticket changed between its preview and the owner's yes is never sent on that yes: the yes approves only the bytes its block showed", LONG, async (t) => {
  const rw = await healthyWorld(t);
  plantFault(rw);
  const ticket = offered(rw);
  const a = R.asked(rw, SESSION, ticket.request, 'the request to send the ticket');
  changeTicket(rw, ticket);
  R.owner(rw, SESSION, `yes ${a.id}`);
  R.tick(rw);
  assert.deepEqual(R.intakePosts(rw), [], 'bytes the owner was not shown must never be sent on the yes to the preview before them');
});

test("a ticket whose configured intake changed after the yes is sent nowhere: neither to the address its preview showed nor to the new one", LONG, async (t) => {
  const rw = await healthyWorld(t);
  plantFault(rw);
  const ticket = offered(rw);
  approve(rw, ticket);
  const releaseJson = path.join(R.installedCore(rw), 'release.json');
  const config = R.readJson(releaseJson);
  assert.ok(config && config.intake === rw.intake, 'the world changes the intake the installed core names, which must be the world\'s');
  fs.writeFileSync(releaseJson, JSON.stringify({ ...config, intake: rw.intake.replace(/\/tickets$/, '/elsewhere') }, null, 2) + '\n');
  R.tick(rw);
  assert.deepEqual(R.hostRequests(rw).filter((r) => r.method === 'POST'), [], 'nothing may be posted anywhere once the intake changed after the yes');
});

async function redirected(t, mode, what) {
  const rw = await healthyWorld(t);
  plantFault(rw);
  const ticket = offered(rw);
  approve(rw, ticket);
  if (mode === 'redirectOther') assert.ok(rw.otherIntake, 'the world\'s other intake must be listening on the IPv6 loopback address');
  R.standIns(rw, { intake: mode });
  R.tick(rw);
  const tried = posted(rw, ticket.id).filter((p) => p.server === 'intake' && p.path === new URL(rw.intake).pathname);
  assert.equal(tried.length, 1, `${what}: the scheduler's run must try the configured intake once`);
  const elsewhere = R.hostRequests(rw).filter((r) => r.server === 'other' || r.path.startsWith('/tickets/moved'));
  assert.deepEqual(elsewhere, [], `${what}: a redirect is never followed: nothing may reach the place it points at`);
  assert.ok(fs.existsSync(R.outboxFile(rw, ticket.id)), `${what}: a redirect is a send failure: the ticket stays in the outbox`);
  assert.equal(waitingLines(rw, ticket.id).length, 1, `${what}: a health line must say the ticket is waiting to send`);
}

test("an approved ticket whose post is answered by a redirect is never sent where it points: the redirect is a send failure, and the ticket stays waiting", LONG, (t) => redirected(t, 'redirect', 'a redirect to another place on the intake'));
test("an approved ticket is cleared only by an answer in the 2xx range from the configured intake: a redirect to another host that would answer 201 is never followed, and the ticket stays waiting", LONG, (t) => redirected(t, 'redirectOther', 'a redirect to another host'));

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

// ------------------------------------------------- the request, exactly

test('a request to send a waiting ticket whose ticket id ends in a newline inside its quoted word is refused outright by the safety floor: no request is raised for the owner, the refusal names the floor, the same after a yes, and nothing is posted', LONG, async (t) => {
  const rw = await healthyWorld(t);
  plantFault(rw);
  const ticket = offered(rw);
  // The request as offered, its last word the ticket id quoted with a final newline.
  const command = `${ticket.request.slice(0, ticket.request.length - ticket.id.length)}'${ticket.id}\n'`;
  const session = `${SESSION}-newline`;
  const what = 'a send request whose ticket id ends in a newline';
  for (const when of ['with no yes', 'even after the owner said yes']) {
    if (when !== 'with no yes') R.owner(rw, session, 'yes');
    const r = w.attempt(rw.world, session, w.tools.bash(command), { env: R.env(rw), coreDir: R.installedCore(rw) });
    w.assertBlocked(r, `${what}, ${when}`);
    assert.equal(w.requestIdIn(r.stderr), null, `${what}, ${when}: refused outright, never asked of the owner; got ${w.describe(r)}`);
    assert.match(r.stderr, /floor/i, `${what}, ${when}: the refusal must name the safety floor; got ${w.describe(r)}`);
  }
  R.tick(rw);
  assert.deepEqual(posted(rw, ticket.id), [], `${what}: nothing may be posted`);
});

// ------------------------------------------------- the install id, kept

test('an install id found readable by others is kept, for its user only, when the next ticket is built: the same id, its file at 0600, on that ticket and every later one', LONG, async (t) => {
  const rw = await healthyWorld(t);
  plantFault(rw);
  const first = offered(rw);
  const id = R.installId(rw);
  assert.match(id || '', /^[0-9a-f]{32}$/, 'the first ticket makes the install id');
  const file = path.join(rw.home, 'install-id');
  // The world opens the install id to others, as a copy or a restore could leave it.
  fs.chmodSync(file, 0o644);
  approve(rw, first);
  R.tick(rw);
  // The fault gone and back: the next ticket from the same home.
  fs.rmSync(path.join(rw.owner, 'overlay'), { recursive: true, force: true });
  R.health(rw);
  plantFault(rw);
  const second = offered(rw, 'the fault back after the first ticket was sent');
  assert.notEqual(second.id, first.id, 'a fault back after its ticket was sent builds a new ticket');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'once the next ticket is built, the install id is readable by its user only');
  assert.equal(R.installId(rw), id, 'the install id is kept, never made again: the same on every ticket from one Squire home');
  assert.equal(JSON.parse(second.bytes).installId, id, 'the next ticket carries the same install id');
});

// Something at the install id's path that cannot be read as the id, with a
// fault that offers a ticket: the health check names it in one plain line of
// its own and the rest of the check runs; what stands there is never
// replaced by a new id, and no ticket carries any id but the home's one.
async function installIdUnreadable(t, what, plant) {
  const rw = await healthyWorld(t);
  const file = path.join(rw.home, 'install-id');
  const { id, unchanged } = plant(file);
  plantFault(rw);
  const h = R.health(rw);
  const lines = h.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  const naming = lines.filter((l) => /install[ -]?id/i.test(l));
  assert.equal(naming.length, 1, `${what}: the health check must name the install id on one line of its own; got ${w.describe(h)}`);
  assert.ok(!/^(ignored|ticket):/.test(naming[0]) && !naming[0].includes('overlay/'),
    `${what}: the install id's line is a line of its own, not a fault's or an offer's; got ${JSON.stringify(naming[0])}`);
  assert.doesNotMatch(naming[0], /Traceback|Errno|Exception|\b[A-Z][A-Za-z]*Error\b/, `${what}: the install id's line is in plain words; got ${JSON.stringify(naming[0])}`);
  assert.ok(lines.some((l) => /^ignored: overlay\//.test(l)), `${what}: the rest of the health check runs: the fault is still named; got ${w.describe(h)}`);
  assert.equal(h.status, 1, `${what}: the health check runs to its end, naming what it found; got ${w.describe(h)}`);
  unchanged();
  for (const ticketId of R.outboxIds(rw)) {
    const body = JSON.parse(fs.readFileSync(R.outboxFile(rw, ticketId), 'utf8'));
    assert.ok(!('installId' in body) || body.installId === id,
      `${what}: a ticket never carries a second install id; ${ticketId} carries ${JSON.stringify(body.installId)}, the home's is ${JSON.stringify(id)}`);
  }
}

test("a folder in place of the install id's file is named by the health check in one plain line of its own, the rest of the check runs, the folder is never replaced by a new id, and no ticket carries an install id", LONG, (t) => installIdUnreadable(t, 'a folder at the install id\'s path', (file) => {
  fs.mkdirSync(file);
  fs.writeFileSync(path.join(file, 'kept.txt'), 'left by a restore\n');
  const ino = fs.lstatSync(file).ino;
  return {
    id: null,
    unchanged: () => {
      const st = fs.lstatSync(file);
      assert.ok(st.isDirectory() && st.ino === ino, 'the folder at the install id\'s path stays where it is: no new id is made in its place');
      assert.deepEqual(fs.readdirSync(file), ['kept.txt'], 'nothing is written into the folder');
    },
  };
}));

test("an install id file that cannot be read is named by the health check in one plain line of its own, the rest of the check runs, the id is never made again, and no ticket carries a second id", LONG, (t) => installIdUnreadable(t, 'an install id that cannot be read', (file) => {
  const id = require('node:crypto').randomBytes(16).toString('hex');
  fs.writeFileSync(file, `${id}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o000);
  t.after(() => { try { fs.chmodSync(file, 0o600); } catch (e) { /* gone */ } });
  const ino = fs.lstatSync(file).ino;
  return {
    id,
    unchanged: () => {
      const st = fs.lstatSync(file);
      assert.ok(st.isFile() && st.ino === ino, 'the install id\'s file stays where it is: the id is never made again');
      fs.chmodSync(file, 0o600);
      assert.equal(fs.readFileSync(file, 'utf8').trim(), id, 'the install id\'s file still holds the home\'s one id');
    },
  };
}));

// ------------------------------------------------- a clock read ahead

test('an approved ticket whose last attempt is dated ahead of the clock is retried at the next run as due now, with the same bytes and id, and its record keeps no attempt after now; once the intake answers it is cleared and filed once', LONG, async (t) => {
  const rw = await healthyWorld(t);
  plantFault(rw);
  const ticket = offered(rw);
  approve(rw, ticket);
  R.standIns(rw, { intake: 'fail' });
  R.tick(rw);
  assert.equal(posted(rw, ticket.id).length, 1, 'the first run must try to send it');
  // A clock read ahead: the attempt recorded an hour after now.
  R.moveRecordTimes(path.join(rw.home, 'outbox', `${ticket.id}.state.json`), 3600, ['at']);
  R.tick(rw);
  const ended = Math.floor(R.nowSeconds());
  assert.equal(posted(rw, ticket.id).length, 2, 'an attempt dated ahead of the clock never holds the retry off: the next run retries it as due now');
  const state = R.outboxState(rw, ticket.id) || {};
  const ahead = (state.attempts || []).filter((x) => !(x && typeof x.at === 'number' && x.at <= ended));
  assert.deepEqual(ahead, [], `once the run ends no attempt in the ticket's record may be dated after now; record: ${JSON.stringify(state)}`);
  R.standIns(rw, { intake: 'ok' });
  older(rw, ticket.id, 300);
  R.tick(rw);
  const posts = posted(rw, ticket.id);
  assert.equal(posts.length, 3, 'a third attempt once the wait has passed and the intake answers');
  assert.ok(posts.every((p) => p.bytes.equals(ticket.bytes)), 'every attempt carries exactly the approved bytes and the same ticket id');
  assert.equal(posts.filter((p) => p.filedAs === 'new').length, 1, 'the intake files it once');
  assert.ok(!fs.existsSync(R.outboxFile(rw, ticket.id)), 'the 2xx answer clears it from the outbox');
});

// ------------------------------------------------- the session's route to a ticket

// What the session loads (claude-config/CLAUDE.md in the Squire home) and the
// route's properties it must hold, shared with the updates cases.
const { sessionLoads, assertSessionKnowsRoute } = R;

// The session's own run of a command, through the safety floor as Claude
// Code runs it: it must go ahead without asking the owner.
function assertRunsFree(rw, command, what) {
  const r = w.attempt(rw.world, SESSION, w.tools.bash(command), { env: R.env(rw), coreDir: R.installedCore(rw) });
  w.assertAllowed(r, what);
  assert.equal(w.requestIdIn(`${r.stderr}\n${r.stdout}`), null, `${what}: it runs without asking the owner; got ${w.describe(r)}`);
}
const healthCheck = (rw) => `${w.PYTHON} ${path.join(R.installedCore(rw), 'tools', 'health.py')}`;

test("what Squire's session loads, written at lay-down and again before the runner starts the session, names Squire's health check and the ticket route, tells the session what to say when no ticket is offered and to show the owner no command, path or tool name, and keeps the updates line", LONG, async (t) => {
  const rw = R.makeReleaseWorld(t);
  const laid = sessionLoads(rw);
  await R.startSquire(rw);
  assertSessionKnowsRoute(laid, 'after lay-down');
  assertSessionKnowsRoute(sessionLoads(rw), 'after the runner starts the session');
});

const PERSONA = { squireName: 'Pip', personality: 'Calm and brief, with a dry wit; checks before acting.' };

test("with the owner's squire.json unreadable (closed to its user, or not parsing), what Squire's session loads, written again at lay-down, names Squire's health check and the ticket route, and keeps the Squire's name and personality as last written", LONG, async (t) => {
  for (const [what, spoil] of [
    ['squire.json closed to its user', (file) => fs.chmodSync(file, 0o000)],
    ['squire.json not parsing', (file) => fs.writeFileSync(file, '{"squireName": "Pip", "personality": \n')],
  ]) {
    const rw = R.makeReleaseWorld(t, { persona: PERSONA });
    const file = path.join(rw.home, 'claude-config', 'CLAUDE.md');
    const laid = sessionLoads(rw);
    assert.ok(laid.includes(PERSONA.squireName) && laid.includes(PERSONA.personality),
      `${what}: lay-down writes the Squire's name and personality into what the session loads; it loads ${JSON.stringify(laid)}`);
    // What a release from before the routes left: the same block with its
    // name and personality lines only, the updates and route lines taken out.
    const earlier = laid.split('\n').filter((l) => l.startsWith('<!--') || l.includes(PERSONA.squireName) || l.includes(PERSONA.personality));
    fs.writeFileSync(file, earlier.join('\n') + '\n');
    assert.doesNotMatch(sessionLoads(rw), /health check/i, `${what}: the block an earlier release left names no health check`);
    // The owner's squire.json can no longer be read; an update's lay-down runs.
    spoil(path.join(rw.owner, 'squire.json'));
    const again = w.layDown(rw.world, rw.appCore, { env: R.env(rw) });
    assert.equal(again.status, 0, `${what}: lay-down lays core down; got ${w.describe(again)}`);
    const now = sessionLoads(rw);
    assertSessionKnowsRoute(now, `${what}, after lay-down`);
    assert.ok(now.includes(PERSONA.squireName), `${what}: the Squire's name as last written is kept; the session loads ${JSON.stringify(now)}`);
    assert.ok(now.includes(PERSONA.personality), `${what}: the Squire's personality as last written is kept; the session loads ${JSON.stringify(now)}`);
  }
});

test("when the owner asks for the support ticket the health check offers, the session's route reaches it: the floor lets the session run the health check without asking, the check offers the outbox ticket on its own line, the session's request to send it is blocked with the ticket's bytes as one line of JSON for the fence, and what the session loads names that route", LONG, async (t) => {
  const rw = await healthyWorld(t);
  plantFault(rw);
  assertRunsFree(rw, healthCheck(rw), 'the session\'s run of the health check');
  const ticket = offered(rw, 'the session\'s run of the health check');
  const bytes = ticket.bytes.toString('utf8');
  assert.ok(bytes.endsWith('\n') && !bytes.slice(0, -1).includes('\n'), `the outbox ticket's bytes are one line; got ${JSON.stringify(bytes)}`);
  const body = JSON.parse(bytes);
  assert.ok(body && typeof body === 'object' && !Array.isArray(body) && body.ticketId === ticket.id, `the one line is the ticket as one JSON object; got ${JSON.stringify(bytes)}`);
  assert.doesNotMatch(bytes, /usr\/bin|python|\.py\b|~\/|\/Users\/|Library\/Application Support/, 'the ticket the owner is shown carries no command or path');
  const a = R.asked(rw, SESSION, ticket.request, 'the session\'s request to send the ticket the check offered');
  R.assertBlockShape(a.block, [bytes], 'the floor\'s block for the session to show in a fence');
  assertSessionKnowsRoute(sessionLoads(rw), 'with a ticket offered');
});

test("when the owner asks for a support ticket and none is offered, the floor lets the session run the health check without asking, the check offers no ticket and nothing waits in the outbox, and what the session loads tells the session what to say when there is nothing to send", LONG, async (t) => {
  const rw = await healthyWorld(t);
  assertRunsFree(rw, healthCheck(rw), 'the session\'s run of the health check');
  const h = R.health(rw);
  assert.equal(h.status, 0, `the check finds nothing wrong; got ${w.describe(h)}`);
  assert.deepEqual(R.ticketLines(h.stdout), [], `the check offers no ticket; got ${w.describe(h)}`);
  assert.deepEqual(R.outboxIds(rw), [], 'nothing waits in the outbox');
  assertSessionKnowsRoute(sessionLoads(rw), 'with no ticket offered');
});

test("the health check Squire's session loads, run exactly as written in a Squire home whose path holds a space, runs without asking the owner, and the same check unquoted is asked", LONG, async (t) => {
  const rw = await R.makeInstalledApp(t);
  assert.match(rw.home, / /, `the Squire home the app sets up must hold a space in its path; got ${JSON.stringify(rw.home)}`);
  const loaded = sessionLoads(rw);
  const named = [...loaded.matchAll(/`([^`\n]*health\.py[^`\n]*)`/g)].map((m) => m[1]);
  assert.equal(named.length, 1, `what the session loads must name one command for Squire's health check; named ${JSON.stringify(named)}; the session loads ${JSON.stringify(loaded)}`);
  const [command] = named;
  assert.match(command, /'[^']* [^']*health\.py'/, `the command the session loads names the check by its path in the Squire home, which holds a space; got ${JSON.stringify(command)}`);
  const as = { env: R.env(rw), coreDir: R.installedCore(rw) };
  const free = w.attempt(rw.world, SESSION, w.tools.bash(command), as);
  w.assertAllowed(free, 'the session\'s run of the health check exactly as written in what it loads');
  assert.equal(w.requestIdIn(`${free.stderr}\n${free.stdout}`), null, `the session's run of the health check exactly as written runs without asking the owner; got ${w.describe(free)}`);
  const unquoted = command.replace(/'/g, '');
  const asked = w.attempt(rw.world, SESSION, w.tools.bash(unquoted), as);
  assert.notEqual(w.requestIdIn(`${asked.stderr}\n${asked.stdout}`), null, `the same check with its quotes removed splits at the space, so the floor asks the owner; got ${w.describe(asked)}`);
});
