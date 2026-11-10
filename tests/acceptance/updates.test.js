'use strict';

// Squire's updates (the design record ADR-005): signed releases only, the
// changelog first and then the owner's yes, a rollback by itself when the
// check after an install fails, the owner's folder never touched, and an
// install that cannot finish leaving Squire on one whole, checked version;
// and Claude Code changed outside Squire, noticed and checked.
//
// Every case runs an installed, healthy Squire in a test world (the release
// world): core laid down with a test key as core/release-key.pub and
// core/release.json naming the world's loopback release host and intake, the
// runner kept by the world's stand-in for launchd, and Claude Code as round
// 2's fake behind its launcher. The scheduler's tick (wake-up.py --due, the
// agent lay-down writes) is the outside job that checks weekly, installs on a
// yes and recovers; the session asks for an install through the safety floor
// (update.py --install <version>), whose block carries the version and the
// changelog, and the owner's yes is the approvals ledger's. Releases are
// signed with test keys made at run time with the Mac's own ssh-keygen; no
// case uses Stravica's key.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const w = require('../fixtures/squire-world.js');
const s = require('../fixtures/session-world.js');
const R = require('../fixtures/updates-world.js');

const NEXT = '0.2.0';
const LATER = '0.3.0';
const SESSION = 'session-update';
const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const LONG = { timeout: 600000 };

async function healthyWorld(t, opts = {}) {
  const rw = R.makeReleaseWorld(t, opts);
  await R.startSquire(rw);
  const h = R.health(rw);
  assert.equal(h.status, 0, `the world's Squire must start healthy; got ${w.describe(h)}`);
  return rw;
}

// The scheduler's weekly check stages the release: a precondition of every
// case that goes on to offer or install it.
function stage(rw, release, what = 'the weekly check') {
  const before = R.wakeUpIds(rw);
  R.tick(rw);
  assert.ok(R.staged(rw).includes(release.version),
    `${what}: the scheduler's weekly check must stage the verified release ${release.version} in the Squire home's staging folder; ` +
    `staging holds ${JSON.stringify(R.stagingFiles(rw))}; update.json: ${JSON.stringify(R.updateRecord(rw))}`);
  return R.newWakeUps(rw, before);
}

// The session asks for the install, the owner says yes, the scheduler's next
// run installs (or rolls back): the wake-ups it sent.
function installOnYes(rw, release, session = SESSION) {
  const a = R.asked(rw, session, R.updateRequest(rw, release.version), `the request to install ${release.version}`);
  R.owner(rw, session, `yes ${a.id}`);
  const before = R.wakeUpIds(rw);
  R.tick(rw);
  return { ...a, sent: R.newWakeUps(rw, before) };
}

function refusalLines(rw, version) {
  const h = R.health(rw);
  const re = new RegExp(`^update: Squire refused release ${esc(version)}: .+; nothing was changed$`);
  return { h, lines: h.stdout.split('\n').map((l) => l.trim()).filter((l) => re.test(l)) };
}

// A refused release: its download gone, nothing an update could move moved,
// and the refusal named once on the health check.
function assertRefused(rw, version, before, what) {
  const { h, lines } = refusalLines(rw, version);
  assert.equal(lines.length, 1, `${what}: the health check must name the refusal on exactly one line, ` +
    `"update: Squire refused release ${version}: <reason>; nothing was changed"; got ${w.describe(h)}`);
  assert.deepEqual(R.stagingFiles(rw), [], `${what}: the refused download must be removed from the staging folder`);
  assert.deepEqual(R.untouchedDifferences(before, R.untouched(rw)), [],
    `${what}: nothing of the installed core, the kept releases, the agents or the owner's folder may change`);
  assert.ok(!R.staged(rw).includes(version), `${what}: a refused release is never staged, so never offered`);
}

const updated = (sent, version) => sent.filter((x) => new RegExp(`Squire is updated to ${esc(version)}; all checks passed`).test(x));
const rolledBack = (sent, from, to) => sent.filter((x) => new RegExp(`Squire rolled ${esc(from)} back to ${esc(to)}`).test(x));

// ------------------------------------------------------- signed only

test('a release signed with the installed key is staged outside core and offered in one wake-up naming its version and the request that asks for it', LONG, async (t) => {
  const rw = await healthyWorld(t);
  const release = R.buildRelease(rw, { version: NEXT });
  const before = R.untouched(rw);
  const sent = stage(rw, release);
  const offers = sent.filter((x) => x.includes(NEXT) && x.includes(R.updateRequest(rw, NEXT)));
  assert.equal(offers.length, 1, `exactly one wake-up must offer ${NEXT} with the request that asks for it; sent ${JSON.stringify(sent)}`);
  assert.deepEqual(R.untouchedDifferences(before, R.untouched(rw)), [], 'staging an update must change nothing of core, the kept releases, the agents or the owner\'s folder');
  assert.ok(typeof (R.updateRecord(rw) || {}).lastCheck === 'number', 'update.json must record the check\'s time (seconds since the epoch)');
});

async function refusedRelease(t, shape, what) {
  const rw = await healthyWorld(t);
  R.buildRelease(rw, { version: NEXT, shape });
  const before = R.untouched(rw);
  const sentBefore = R.wakeUpIds(rw);
  R.tick(rw);
  assertRefused(rw, NEXT, before, what);
  assert.deepEqual(R.newWakeUps(rw, sentBefore).filter((x) => x.includes(R.updateRequest(rw, NEXT))), [], `${what}: nothing may be offered`);
}

test('a release with no signature is refused: its download removed, nothing changed, the refusal named once on the health check', LONG, (t) => refusedRelease(t, "unsigned", "a release with no signature"));
test('a release signed with another key is refused: its download removed, nothing changed, the refusal named once on the health check', LONG, (t) => refusedRelease(t, "wrongKey", "a release signed with another key"));
test('a release whose manifest was changed by one byte after signing is refused: its download removed, nothing changed, the refusal named once on the health check', LONG, (t) => refusedRelease(t, "altered", "a release whose manifest was changed by one byte after signing"));
test('a release that carries its own key and is signed by it, but not by the installed key is refused: its download removed, nothing changed, the refusal named once on the health check', LONG, (t) => refusedRelease(t, "ownKeyOnly", "a release that carries its own key and is signed by it, but not by the installed key"));

test('a signed release older than the installed one is never staged, offered or installed', LONG, async (t) => {
  const rw = await healthyWorld(t);
  R.buildRelease(rw, { version: '0.0.9' });
  const before = R.untouched(rw);
  const sentBefore = R.wakeUpIds(rw);
  R.tick(rw);
  assert.ok(typeof (R.updateRecord(rw) || {}).lastCheck === 'number', 'the weekly check must run and record its time in update.json');
  assert.deepEqual(R.staged(rw), [], 'an older release is never staged');
  assert.deepEqual(R.newWakeUps(rw, sentBefore), [], 'an older release is never offered');
  assert.deepEqual(R.untouchedDifferences(before, R.untouched(rw)), [], 'nothing may change');
});

test('a signed release carrying a new key installs on a yes, and the next release is checked with the new key only', LONG, async (t) => {
  const rw = await healthyWorld(t);
  const rotate = R.buildRelease(rw, { version: NEXT, shape: 'newKey' });
  stage(rw, rotate, 'the release carrying a new key');
  const { sent } = installOnYes(rw, rotate);
  assert.equal(updated(sent, NEXT).length, 1, `the install must finish and say so in one wake-up; sent ${JSON.stringify(sent)}`);
  assert.equal(fs.readFileSync(path.join(R.installedCore(rw), 'release-key.pub'), 'utf8'), rw.keys.two.text, 'the installed core must now trust the new key');
  // A later release signed with the old key is refused; signed with the new one, it is staged.
  R.buildRelease(rw, { version: LATER, signWith: 'one', carryKey: 'two' });
  R.moveRecordTimes(path.join(rw.home, 'update.json'), -8 * 86400, ['lastCheck']);
  const before = R.untouched(rw);
  R.tick(rw);
  assertRefused(rw, LATER, before, 'a release signed with the key the installed core no longer trusts');
  const next = R.buildRelease(rw, { version: '0.3.1', signWith: 'two', carryKey: 'two' });
  R.moveRecordTimes(path.join(rw.home, 'update.json'), -8 * 86400, ['lastCheck']);
  stage(rw, next, 'a release signed with the new key');
});

// ------------------------------- the re-run guard, the first design fact

// Squire set up by its own app at the installed version, then updated by a
// signed release on the owner's yes.
async function appUpdated(t) {
  const rw = await R.makeInstalledApp(t);
  const release = R.buildRelease(rw, { version: NEXT });
  stage(rw, release);
  const { sent } = installOnYes(rw, release);
  assert.equal(updated(sent, NEXT).length, 1, `the signed update must install; sent ${JSON.stringify(sent)}`);
  return { rw, release };
}

test('after a signed update, opening an app older than the installed release never lays its core down: the installed release stays, the sign-in repair still runs, and "Squire: set-up paused" says the installed Squire is newer', LONG, async (t) => {
  const { rw, release } = await appUpdated(t);
  // The sign-in has ended: opening the app is the way to sign in again.
  const claudeJson = path.join(rw.home, 'claude-config', '.claude.json');
  const state = R.readJson(claudeJson) || {};
  delete state.oauthAccount;
  fs.writeFileSync(claudeJson, JSON.stringify(state, null, 2));
  const run = await R.runAppAgain(rw);
  assert.ok(R.coreIs(rw, release), 'an older app must never lay its core down over the signed release');
  assert.equal((R.currentRelease(rw) || {}).current, NEXT, 'the installed release must stay the current one');
  const paused = run.dialogs.filter((d) => d.title === 'Squire: set-up paused');
  assert.ok(paused.some((d) => /newer/i.test(d.text || '')), `"Squire: set-up paused" must say the Squire already installed is newer than this app; windows: ${JSON.stringify(run.dialogs.map((d) => d.title))}`);
  assert.ok(run.dialogs.every((d) => d.title), 'no window beyond set-up\'s own is added');
  const signedIn = R.readJson(claudeJson) || {};
  assert.ok(signedIn.oauthAccount, 'the rest of the re-run proceeds: the sign-in repair signs Squire in again');
});

test('after a signed update, opening a newer app (a fresh download) lays its core down as set-up always has', LONG, async (t) => {
  const { rw } = await appUpdated(t);
  R.makeCore(rw, rw.appCore, { version: LATER });
  fs.appendFileSync(path.join(rw.appCore, 'tools', 'backup.py'), '# a fresh download\n');
  const run = await R.runAppAgain(rw);
  assert.ok(R.coreIs(rw, rw.appCore), `a newer app's core must be laid down; windows: ${JSON.stringify(run.dialogs.map((d) => d.title))}`);
});

test("after a signed update, the floor fix lays down the current kept release, never the app's core", LONG, async (t) => {
  const { rw, release } = await appUpdated(t);
  const floorFile = path.join(R.installedCore(rw), 'hooks', 'config-change.py');
  fs.appendFileSync(floorFile, '# one line more\n');
  const a = R.asked(rw, SESSION, R.fixRequest(rw, 'floor'), 'the floor fix');
  R.owner(rw, SESSION, `yes ${a.id}`);
  R.tick(rw);
  assert.ok(fs.readFileSync(floorFile).equals(fs.readFileSync(path.join(release.core, 'hooks', 'config-change.py'))),
    'the floor fix must lay down the current kept release, the signed update, never the app\'s older core');
});

// The files of a core folder, by relative path, as one comparable list.
const filesList = (dir) => Object.entries(w.treeOf(dir)).map(([k, v]) => `${k} ${v.sha256}`);

test("a home the round 3 app laid down takes its first update after the round 4 app's re-run: the re-run lays the release record and the key down with its core and names its release unverified, and the signed update installs on a yes, keeping the app's release with no manifest or signature made up for it", LONG, async (t) => {
  const rw = await R.makeInstalledApp(t);
  await R.layRound3Home(rw);
  assert.equal(R.currentRelease(rw), null, 'a home the round 3 app laid down has no current-release.json');
  const run = await R.runAppAgain(rw);
  assert.ok(R.coreIs(rw, rw.appCore), `the round 4 app's re-run must lay its core down, release.json and release-key.pub with it; windows: ${JSON.stringify(run.dialogs.map((d) => d.title))}`);
  assert.deepEqual(R.currentRelease(rw), { current: R.INSTALLED, previous: null, verified: false },
    `the round 4 app's re-run must write current-release.json naming its own release, unverified; got ${JSON.stringify(R.currentRelease(rw))}`);
  const healthy = await s.waitFor(() => R.health(rw).status === 0, 60000, 500);
  assert.ok(healthy, `Squire must be healthy after the re-run; health: ${w.describe(R.health(rw))}`);
  const release = R.buildRelease(rw, { version: NEXT });
  stage(rw, release, 'the first weekly check after the re-run');
  const { sent } = installOnYes(rw, release);
  assert.equal(updated(sent, NEXT).length, 1, `the first update must install on the owner's yes and say so in one wake-up; sent ${JSON.stringify(sent)}`);
  assert.ok(R.coreIs(rw, release), 'the installed core must be the signed release\'s, file for file');
  assert.deepEqual(R.currentRelease(rw), { current: NEXT, previous: R.INSTALLED, verified: true },
    `current-release.json must name the signed release, verified, and the app's release as the previous one; got ${JSON.stringify(R.currentRelease(rw))}`);
  assert.deepEqual(R.keptReleases(rw), [R.INSTALLED, NEXT], 'the app\'s release and the signed one are kept');
  assert.deepEqual(fs.readdirSync(path.join(rw.home, 'releases', R.INSTALLED)).sort(), ['core'],
    'the app\'s release is kept as its core alone: no manifest and no signature are made up for it');
  assert.deepEqual(filesList(path.join(rw.home, 'releases', R.INSTALLED, 'core')), filesList(rw.appCore),
    'the kept release is the app\'s core, file for file');
});

test("after a newer app's lay-down over an updated home, the installed key stays the one the installed release trusted: a release signed with the newer app's key is refused, and the next release signed with the kept key is staged", LONG, async (t) => {
  const { rw } = await appUpdated(t);
  R.makeCore(rw, rw.appCore, { version: LATER, key: rw.keys.two.pub });
  fs.appendFileSync(path.join(rw.appCore, 'tools', 'backup.py'), '# a fresh download\n');
  const run = await R.runAppAgain(rw);
  const installedKey = path.join(R.installedCore(rw), 'release-key.pub');
  assert.equal(fs.readFileSync(path.join(R.installedCore(rw), 'release.json'), 'utf8'), fs.readFileSync(path.join(rw.appCore, 'release.json'), 'utf8'),
    `the newer app must lay its core down; windows: ${JSON.stringify(run.dialogs.map((d) => d.title))}`);
  assert.equal(fs.readFileSync(installedKey, 'utf8'), rw.keys.one.text, 'a newer app never replaces the installed release key');
  assert.deepEqual(R.currentRelease(rw), { current: LATER, previous: NEXT, verified: false },
    `current-release.json must name the newer app's release, unverified, and the release it replaced as the previous one; got ${JSON.stringify(R.currentRelease(rw))}`);
  const healthy = await s.waitFor(() => R.health(rw).status === 0, 60000, 500);
  assert.ok(healthy, `Squire must be healthy after the newer app's lay-down; health: ${w.describe(R.health(rw))}`);
  R.buildRelease(rw, { version: '0.4.0', signWith: 'two', carryKey: 'two' });
  R.moveRecordTimes(path.join(rw.home, 'update.json'), -8 * 86400, ['lastCheck']);
  const before = R.untouched(rw);
  R.tick(rw);
  assertRefused(rw, '0.4.0', before, 'a release signed with the newer app\'s key, which the installed core does not trust');
  const next = R.buildRelease(rw, { version: '0.4.1', signWith: 'one', carryKey: 'one' });
  R.moveRecordTimes(path.join(rw.home, 'update.json'), -8 * 86400, ['lastCheck']);
  stage(rw, next, 'a release signed with the kept key');
});

// ------------------------------------------- what the check cannot decide

async function refusedUnchecked(t, shape, what) {
  const rw = await healthyWorld(t);
  R.buildRelease(rw, { version: NEXT, shape });
  const before = R.untouched(rw);
  R.tick(rw);
  assertRefused(rw, NEXT, before, what);
}

test('a release whose manifest does not parse is refused as an unsigned one is: download removed, nothing changed, named once on the health check', LONG, (t) => refusedUnchecked(t, "badManifest", "a release whose manifest does not parse"));
test('a release whose manifest carries a field the check does not know is refused as an unsigned one is: download removed, nothing changed, named once on the health check', LONG, (t) => refusedUnchecked(t, "unknownField", "a release whose manifest carries a field the check does not know"));
test('a release whose version is not three whole numbers is refused as an unsigned one is: download removed, nothing changed, named once on the health check', LONG, (t) => refusedUnchecked(t, "badVersion", "a release whose version is not three whole numbers"));
test('a release holding a file its manifest does not list is refused as an unsigned one is: download removed, nothing changed, named once on the health check', LONG, (t) => refusedUnchecked(t, "unlisted", "a release holding a file its manifest does not list"));
test('a release missing a file its manifest lists is refused as an unsigned one is: download removed, nothing changed, named once on the health check', LONG, (t) => refusedUnchecked(t, "missing", "a release missing a file its manifest lists"));
test('a release whose archive does not unpack is refused as an unsigned one is: download removed, nothing changed, named once on the health check', LONG, (t) => refusedUnchecked(t, "notAnArchive", "a release whose archive does not unpack"));

test("a signed release whose archive holds any entry that is not a plain file or folder at one plain, unique path inside it is refused on its listing, and nothing of it is ever extracted: absolute and dot-segment paths, duplicates, case-folded and Unicode-equivalent twins, symbolic and hard links inside core or out, an AppleDouble entry, a folder holding no listed file, bytes after the gzip stream", LONG, async (t) => {
  const rw = await healthyWorld(t);
  let patch = 0;
  for (const shape of Object.keys(R.ARCHIVE_SHAPES)) {
    patch += 1;
    const version = `0.2.${patch}`;
    if (patch > 1) R.moveRecordTimes(path.join(rw.home, 'update.json'), -8 * 86400, ['lastCheck']);
    const release = R.buildArchiveRelease(rw, { version, shape });
    const what = `an archive holding ${release.what}`;
    const before = R.untouched(rw);
    const changed = await R.tickWatching(rw);
    assertRefused(rw, version, before, what);
    const extracted = changed.filter((p) => p.startsWith('staging/') && (p.includes(R.MARKER) || /(^|\/)(core|manifest\.json(\.sig)?)(\/|$)/.test(p.slice('staging/'.length))));
    assert.deepEqual(extracted, [], `${what}: nothing of it may be extracted inside the staging folder; the Squire home saw ${JSON.stringify(changed)}`);
    assert.deepEqual(R.markersOutside(rw), [], `${what}: nothing of it may reach anywhere outside the staging folder`);
    assert.ok(fs.readFileSync(release.victim).equals(release.victimBytes) && fs.statSync(release.victim).nlink === 1,
      `${what}: a file outside the release is never linked to or written`);
  }
});

async function refusedWithSshKeygen(t, sshKeygen, what) {
  const rw = await healthyWorld(t, { mac: { sshKeygen } });
  R.buildRelease(rw, { version: NEXT });
  const before = R.untouched(rw);
  const started = Date.now();
  R.tick(rw);
  assert.ok(Date.now() - started < 120000, `${what}: the check must end within its bound`);
  assertRefused(rw, NEXT, before, `a signed release ${what}`);
}

test('a correctly signed release checked with no ssh-keygen on the Mac is refused, never installed: nothing changed, named once on the health check', LONG, (t) => refusedWithSshKeygen(t, "none", "with no ssh-keygen on the Mac"));
test('a correctly signed release checked with an ssh-keygen that fails is refused, never installed: nothing changed, named once on the health check', LONG, (t) => refusedWithSshKeygen(t, "fails", "with an ssh-keygen that fails"));
test('a correctly signed release checked with an ssh-keygen that never answers (bounded at 30 seconds) is refused, never installed: nothing changed, named once on the health check', LONG, (t) => refusedWithSshKeygen(t, "hangs", "with an ssh-keygen that never answers (bounded at 30 seconds)"));

// ------------------------------------------- the changelog, then a yes

test('the weekly check runs once a week: a second run of the scheduler fetches nothing and offers nothing again', LONG, async (t) => {
  const rw = await healthyWorld(t);
  const release = R.buildRelease(rw, { version: NEXT });
  const first = stage(rw, release);
  assert.equal(first.filter((x) => x.includes(NEXT)).length, 1, `the first check must offer ${NEXT} in one wake-up; sent ${JSON.stringify(first)}`);
  const fetches = R.latestFetches(rw).length;
  const before = R.wakeUpIds(rw);
  R.tick(rw);
  R.tick(rw);
  assert.equal(R.latestFetches(rw).length, fetches, 'a check within the week must not run again');
  assert.deepEqual(R.newWakeUps(rw, before), [], 'a staged release is mentioned at most once a week');
});

test("the floor's block for an install carries the version and the changelog exactly as the release's manifest has them, and the owner's fresh, exact yes installs that release", LONG, async (t) => {
  const rw = await healthyWorld(t);
  const release = R.buildRelease(rw, { version: NEXT });
  stage(rw, release);
  const a = R.asked(rw, SESSION, R.updateRequest(rw, NEXT), 'the request to install');
  // The version and the changelog exactly as the manifest has them, each as
  // whole lines once, then one empty line and the relay words that make the
  // session show the text byte for byte inside a fenced code block.
  R.assertBlockShape(a.block, [NEXT, release.changelog], 'the floor\'s block for the install');
  R.owner(rw, SESSION, `yes ${a.id}`);
  const before = R.wakeUpIds(rw);
  R.tick(rw);
  const sent = R.newWakeUps(rw, before);
  assert.equal(updated(sent, NEXT).length, 1, `the install must finish and say so in one wake-up; sent ${JSON.stringify(sent)}`);
  assert.ok(R.coreIs(rw, release), 'the installed core must be the release\'s core, file for file');
  assert.equal((R.currentRelease(rw) || {}).current, NEXT, 'current-release.json must name the installed release');
  const kept = R.readJson(path.join(rw.home, 'releases', NEXT, 'manifest.json'));
  assert.ok(kept, 'the installed release\'s manifest must be kept with it');
  R.assertBlockShape(a.block, [kept.changelog], 'the changelog shown must be the installed release\'s, byte for byte');
  assert.deepEqual(R.keptReleases(rw), [R.INSTALLED, NEXT], 'the current release and the previous one are kept');
});

async function notInstalled(t, variant, what) {
  const rw = await healthyWorld(t);
  const release = R.buildRelease(rw, { version: NEXT });
  stage(rw, release);
  const a = R.asked(rw, SESSION, R.updateRequest(rw, NEXT), 'the request to install');
  if (variant === 'no') R.owner(rw, SESSION, `no ${a.id}`);
  if (['stale', 'future', 'otherVersion'].includes(variant)) R.owner(rw, SESSION, `yes ${a.id}`);
  if (variant === 'stale') R.moveLedgerTime(rw, R.yesFor(a.id), -31 * 60);
  if (variant === 'future') R.moveLedgerTime(rw, R.yesFor(a.id), 3600);
  if (variant === 'otherVersion') {
    R.buildRelease(rw, { version: '0.2.1' });
    R.moveRecordTimes(path.join(rw.home, 'update.json'), -8 * 86400, ['lastCheck']);
  }
  const before = R.untouched(rw);
  R.tick(rw);
  assert.deepEqual(R.untouchedDifferences(before, R.untouched(rw)), [], `${what}: nothing of core, the kept releases, the agents or the owner's folder may change`);
  assert.ok(R.coreIs(rw, rw.appCore), `${what}: the installed core must still be the installed release's`);
  if (variant === 'future' || variant === 'stale') {
    const again = R.asked(rw, `${SESSION}-again`, R.updateRequest(rw, NEXT), `${what}: the request asked again`);
    R.assertBlockShape(again.block, [NEXT, release.changelog], `${what}: the request asked again, with the version and the changelog`);
  }
  if (variant === 'otherVersion') {
    assert.ok(R.staged(rw).includes('0.2.1') && !R.staged(rw).includes(NEXT), `the newer verified release must replace the staged one; staging holds ${JSON.stringify(R.staged(rw))}`);
  }
}

test("nothing is installed with no answer from the owner: core's digests and the kept releases stay as they are", LONG, (t) => notInstalled(t, "none", "with no answer from the owner"));
test("nothing is installed with the owner's no: core's digests and the kept releases stay as they are", LONG, (t) => notInstalled(t, "no", "with the owner's no"));
test("nothing is installed with a yes given more than 30 minutes before the run: core's digests and the kept releases stay as they are", LONG, (t) => notInstalled(t, "stale", "with a yes given more than 30 minutes before the run"));
test("nothing is installed with a yes timed after now: core's digests and the kept releases stay as they are", LONG, (t) => notInstalled(t, "future", "with a yes timed after now"));
test("nothing is installed with a yes for a version no longer the staged one: core's digests and the kept releases stay as they are", LONG, (t) => notInstalled(t, "otherVersion", "with a yes for a version no longer the staged one"));

// The staged release changed after the offer, before the owner's yes is acted
// on: a staged file alone, or a staged file and the staged manifest's digest
// for it together, so that only the signature, checked again, can tell.
async function stagedChanged(t, how, what) {
  const rw = await healthyWorld(t);
  const release = R.buildRelease(rw, { version: NEXT });
  stage(rw, release);
  const a = R.asked(rw, SESSION, R.updateRequest(rw, NEXT), 'the request to install');
  R.owner(rw, SESSION, `yes ${a.id}`);
  const dir = path.join(rw.home, 'staging', NEXT);
  const file = path.join(dir, 'core', 'tools', 'backup.py');
  assert.ok(fs.existsSync(file), `the world changes a staged file, which must be there; staging holds ${JSON.stringify(R.stagingFiles(rw))}`);
  fs.appendFileSync(file, '# changed after the offer\n');
  if (how === 'manifest') {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    manifest.files['tools/backup.py'] = w.sha256(fs.readFileSync(file));
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  }
  const before = R.untouched(rw);
  const sentBefore = R.wakeUpIds(rw);
  R.tick(rw);
  const sent = R.newWakeUps(rw, sentBefore);
  assert.deepEqual(updated(sent, NEXT), [], `${what}: nothing may be installed on the owner's yes; sent ${JSON.stringify(sent)}`);
  assert.ok(R.coreIs(rw, rw.appCore), `${what}: the installed core must still be the installed release's`);
  const moved = R.untouchedDifferences(before, R.untouched(rw)).filter((d) => !d.includes(R.LEDGER));
  assert.deepEqual(moved, [], `${what}: nothing of core, the kept releases or the agents may change, nor the owner's folder beyond the yes's use`);
  const { h, lines } = refusalLines(rw, NEXT);
  assert.equal(lines.length, 1, `${what}: the health check must name the refusal on exactly one line, "update: Squire refused release ${NEXT}: <reason>; nothing was changed"; got ${w.describe(h)}`);
  assert.ok(!R.staged(rw).includes(NEXT), `${what}: the changed staging is removed, so it is never offered again`);
}

test("a staged file changed after the offer is found when the staged release is checked again before the install: on the owner's fresh, exact yes nothing is installed, nothing moves, and the refusal is named on the health check", LONG, (t) => stagedChanged(t, 'file', 'a staged file changed after the offer'));
test("a staged file and the staged manifest's digest for it, changed together after the offer, are found by the signature checked again before the install: on the owner's fresh, exact yes nothing is installed, nothing moves, and the refusal is named on the health check", LONG, (t) => stagedChanged(t, 'manifest', 'a staged file and its digest in the staged manifest changed after the offer'));

test('while the health check names a fault no update is staged or offered, and once it is gone the next run stages and offers it', LONG, async (t) => {
  const rw = await healthyWorld(t);
  const release = R.buildRelease(rw, { version: NEXT });
  const floorFile = path.join(R.installedCore(rw), 'hooks', 'config-change.py');
  const kept = fs.readFileSync(floorFile);
  fs.appendFileSync(floorFile, '# one line more\n');
  assert.notEqual(R.health(rw).status, 0, 'the world plants a fault the health check names');
  const before = R.wakeUpIds(rw);
  R.tick(rw);
  assert.deepEqual(R.staged(rw), [], 'no update may be staged over a fault');
  assert.deepEqual(R.newWakeUps(rw, before).filter((x) => x.includes(R.updateRequest(rw, NEXT))), [], 'no update may be offered over a fault');
  fs.writeFileSync(floorFile, kept);
  const sent = stage(rw, release, 'the first run after the fault is gone');
  assert.equal(sent.filter((x) => x.includes(R.updateRequest(rw, NEXT))).length, 1, `the release must be offered once the fault is gone; sent ${JSON.stringify(sent)}`);
});

// ------------------------------------------------------- the rollback

test('a signed release whose runner exits at once installs on a yes, is rolled back by itself, and one wake-up names both versions; the previous version runs and a second run reinstalls nothing', LONG, async (t) => {
  const rw = await healthyWorld(t);
  const bad = R.buildRelease(rw, { version: NEXT, shape: 'runnerExits' });
  stage(rw, bad);
  const { sent } = installOnYes(rw, bad);
  assert.equal(rolledBack(sent, NEXT, R.INSTALLED).length, 1, `one wake-up must say Squire rolled ${NEXT} back to ${R.INSTALLED}; sent ${JSON.stringify(sent)}`);
  assert.ok(R.coreIs(rw, rw.appCore), 'the previous release\'s core must be laid down again, file for file');
  assert.equal((R.currentRelease(rw) || {}).current, R.INSTALLED, 'current-release.json must name the previous release');
  const healthy = await s.waitFor(() => R.health(rw).status === 0, 30000, 500);
  assert.ok(healthy, `the previous version must be running, every floor file at its digest; health: ${w.describe(R.health(rw))}`);
  const before = R.wakeUpIds(rw);
  R.tick(rw);
  assert.ok(R.coreIs(rw, rw.appCore), 'the used yes must never install the rolled-back release again');
  assert.deepEqual(R.newWakeUps(rw, before).filter((x) => x.includes(NEXT)), [], 'the rolled-back release stays out of the offer until a newer one is published');
});

test('when the check after a rollback fails too, a health line names both versions and a support ticket is offered', LONG, async (t) => {
  const rw = await healthyWorld(t);
  const bad = R.buildRelease(rw, { version: NEXT, shape: 'runnerExitsAndSignsOut' });
  stage(rw, bad);
  const { sent } = installOnYes(rw, bad);
  // No session works now (the sign-in has ended), so the owner hears of it in
  // two ways: the one wake-up naming both versions, kept by the router until a
  // session can take it ("sent" is durably queued), and the health line, a
  // mark the owner sees with no session. The install record goes after both.
  assert.equal(sent.filter((x) => x.includes(NEXT) && x.includes(R.INSTALLED)).length, 1,
    `one wake-up naming both versions must be kept for the owner though no session can take it; sent ${JSON.stringify(sent)}`);
  assert.ok(!fs.existsSync(R.installRecordFile(rw)), 'the install record goes once the message and the mark are written');
  const h = R.health(rw);
  const both = h.stdout.split('\n').filter((l) => l.includes(NEXT) && l.includes(R.INSTALLED));
  assert.ok(both.length >= 1, `a health line must name both versions; got ${w.describe(h)}`);
  assert.ok(R.ticketLines(h.stdout).length >= 1, `the health check must offer a support ticket on its own line; got ${w.describe(h)}`);
  R.tick(rw);
  const later = R.health(rw);
  assert.ok(later.stdout.split('\n').some((l) => l.includes(NEXT) && l.includes(R.INSTALLED)), `the mark stands at the next run of the health check; got ${w.describe(later)}`);
});

test("a kept previous release changed before a rollback is never laid down: the rollback checks it again and lays nothing down, a health line names both versions, and a support ticket is offered", LONG, async (t) => {
  const rw = await healthyWorld(t);
  const good = R.buildRelease(rw, { version: NEXT });
  stage(rw, good);
  const first = installOnYes(rw, good);
  assert.equal(updated(first.sent, NEXT).length, 1, `the first signed update must install; sent ${JSON.stringify(first.sent)}`);
  const bad = R.buildRelease(rw, { version: LATER, shape: 'runnerExits' });
  R.moveRecordTimes(path.join(rw.home, 'update.json'), -8 * 86400, ['lastCheck']);
  stage(rw, bad, 'the next weekly check');
  const kept = path.join(rw.home, 'releases', NEXT, 'core', 'tools', 'backup.py');
  assert.ok(fs.existsSync(kept), 'the world changes a file of the kept previous release, which must be there');
  fs.appendFileSync(kept, '# changed while kept\n');
  const changed = fs.readFileSync(kept);
  const { sent } = installOnYes(rw, bad, `${SESSION}-later`);
  assert.deepEqual(rolledBack(sent, LATER, NEXT), [], `the changed previous release must never be laid down; sent ${JSON.stringify(sent)}`);
  assert.ok(R.coreIs(rw, bad), 'nothing is laid down over the new release: the installed core is still the new release\'s, file for file');
  assert.ok(!fs.readFileSync(path.join(R.installedCore(rw), 'tools', 'backup.py')).equals(changed), 'the changed file never reaches the installed core');
  const h = R.health(rw);
  assert.ok(h.stdout.split('\n').some((l) => l.includes(LATER) && l.includes(NEXT)), `a health line must name both versions; got ${w.describe(h)}`);
  assert.ok(R.ticketLines(h.stdout).length >= 1, `the health check must offer a support ticket on its own line; got ${w.describe(h)}`);
});

// ------------------------------------------------ the owner's folder

async function folderAcrossInstall(t, shape, planting = null) {
  const rw = await healthyWorld(t);
  if (planting) planting(rw);
  const release = R.buildRelease(rw, { version: NEXT, shape });
  stage(rw, release);
  const a = R.asked(rw, SESSION, R.updateRequest(rw, NEXT), 'the request to install');
  R.owner(rw, SESSION, `yes ${a.id}`);
  // The hash brackets the install with the session stopped.
  R.stopSquire(rw);
  const before = R.ownerHash(rw.owner, { except: [R.LEDGER] });
  const ledgerBefore = R.ledgerRecords(rw);
  await R.startSquire(rw);
  const sentBefore = R.wakeUpIds(rw);
  R.tick(rw);
  const sent = R.newWakeUps(rw, sentBefore);
  R.stopSquire(rw);
  return { rw, a, before, ledgerBefore, sent, after: R.ownerHash(rw.owner, { except: [R.LEDGER] }), ledgerAfter: R.ledgerRecords(rw) };
}

function assertOneUse(ledgerBefore, ledgerAfter, id, what) {
  assert.deepEqual(ledgerAfter.slice(0, ledgerBefore.length), ledgerBefore, `${what}: the approvals ledger keeps every record it held`);
  const added = ledgerAfter.slice(ledgerBefore.length);
  assert.equal(added.length, 1, `${what}: the ledger may gain exactly one line, the use of the owner's yes; gained ${JSON.stringify(added)}`);
  assert.equal(added[0].type, 'use', `${what}: the one line is the yes used`);
  assert.equal(added[0].request, id, `${what}: the one line uses the yes for that install`);
}

test("the owner's folder hashes the same before a signed install and after it, apart from the one recorded use of the owner's yes in the approvals ledger", LONG, async (t) => {
  const r = await folderAcrossInstall(t, 'good');
  assert.equal(updated(r.sent, NEXT).length, 1, `the install must finish; sent ${JSON.stringify(r.sent)}`);
  assert.deepEqual(R.hashDifferences(r.before, r.after), [], 'every entry of the owner\'s folder must be the same: path, type, permissions, bytes and link target');
  assertOneUse(r.ledgerBefore, r.ledgerAfter, r.a.id, 'across the install');
});

test("the owner's folder hashes the same before an install that is rolled back and after the rollback, apart from the one recorded use of the owner's yes", LONG, async (t) => {
  const r = await folderAcrossInstall(t, 'runnerExits');
  assert.equal(rolledBack(r.sent, NEXT, R.INSTALLED).length, 1, `the install must be rolled back; sent ${JSON.stringify(r.sent)}`);
  assert.deepEqual(R.hashDifferences(r.before, r.after), [], 'every entry of the owner\'s folder must be the same after the rollback');
  assertOneUse(r.ledgerBefore, r.ledgerAfter, r.a.id, 'across the install and the rollback');
});

test("whatever the owner's folder holds (a file no one may read, a file only its owner may read, a link to nothing, a link outside it, an empty folder, a closed folder, a named pipe), an install and a rollback leave every entry as it was", LONG, async (t) => {
  const plant = (rw) => {
    const o = rw.owner;
    fs.writeFileSync(path.join(o, 'workspace', 'files', 'locked.txt'), 'no one may read this\n');
    fs.chmodSync(path.join(o, 'workspace', 'files', 'locked.txt'), 0o000);
    fs.writeFileSync(path.join(o, 'workspace', 'files', 'mine.txt'), 'only the owner may read this\n');
    fs.chmodSync(path.join(o, 'workspace', 'files', 'mine.txt'), 0o600);
    fs.symlinkSync(path.join(o, 'nowhere', 'at-all'), path.join(o, 'workspace', 'dangling'));
    fs.symlinkSync(path.join(rw.root, 'transcript.jsonl'), path.join(o, 'workspace', 'outside'));
    fs.mkdirSync(path.join(o, 'workspace', 'empty'));
    fs.mkdirSync(path.join(o, 'workspace', 'closed'));
    fs.writeFileSync(path.join(o, 'workspace', 'closed', 'inside.txt'), 'inside a closed folder\n');
    fs.chmodSync(path.join(o, 'workspace', 'closed'), 0o000);
    const r = require('node:child_process').spawnSync('/usr/bin/mkfifo', [path.join(o, 'workspace', 'pipe')]);
    assert.equal(r.status, 0, 'the world makes a named pipe in the owner\'s folder');
  };
  const r = await folderAcrossInstall(t, 'runnerExits', plant);
  fs.chmodSync(path.join(r.rw.owner, 'workspace', 'closed'), 0o755);
  assert.equal(rolledBack(r.sent, NEXT, R.INSTALLED).length, 1, `the install must be rolled back; sent ${JSON.stringify(r.sent)}`);
  assert.deepEqual(R.hashDifferences(r.before, r.after), [], 'every entry, whatever its kind or permissions, must be the same');
  assertOneUse(r.ledgerBefore, r.ledgerAfter, r.a.id, 'across the install and the rollback');
});

// ------------------------------------- an install that does not finish

test('after a signed install no process of the previous release is left running: its runner, its server and its session are gone', LONG, async (t) => {
  const rw = await healthyWorld(t);
  const release = R.buildRelease(rw, { version: NEXT });
  stage(rw, release);
  const oldRunners = R.runnerStarts(rw).map((x) => x.started);
  const oldSessions = rw.inner.sessions().map((x) => x.pid);
  const oldServers = rw.inner.serverCalls().map((x) => x.pid);
  const { sent } = installOnYes(rw, release);
  assert.equal(updated(sent, NEXT).length, 1, `the install must finish; sent ${JSON.stringify(sent)}`);
  for (const pid of [...oldRunners, ...oldSessions, ...oldServers]) {
    assert.ok(w.processGone(pid), `process ${pid} of the previous release must not be running after the install`);
  }
});

const ON = /did not finish.*Squire is on (\d+\.\d+\.\d+)/;

// Kills the install at a step, then a runner start (launchd at login) and a
// scheduler run; returns what Squire is on and what it said.
async function interrupted(t, step) {
  const rw = await healthyWorld(t);
  const release = R.buildRelease(rw, { version: NEXT });
  stage(rw, release);
  const a = R.asked(rw, SESSION, R.updateRequest(rw, NEXT), 'the request to install');
  R.owner(rw, SESSION, `yes ${a.id}`);
  const before = R.ownerHash(rw.owner, { except: [R.LEDGER] });
  const seen = await R.killInstallAt(rw, step);
  assert.equal(seen, step, `the install must be killed at exactly its step "${step}" (install.json naming it, written before the step starts); the record named ${JSON.stringify(seen)}; install.json: ${JSON.stringify(R.readJson(R.installRecordFile(rw)))}`);
  const sentBefore = R.wakeUpIds(rw);
  // The Mac starts again: everything Squire ran is gone, and launchd starts
  // the runner at login; then the scheduler runs.
  R.stopSquire(rw);
  R.launchSquire(rw);
  const done = () => !fs.existsSync(R.installRecordFile(rw)) && R.newWakeUps(rw, sentBefore).some((x) => ON.test(x));
  await s.waitFor(done, 60000, 250);
  R.tick(rw);
  const recovered = await s.waitFor(done, 120000, 250);
  const sent = R.newWakeUps(rw, sentBefore);
  return { rw, release, seen, recovered, sent, before };
}

function assertWhole(r, allowed, what) {
  const { rw, release, sent } = r;
  assert.ok(r.recovered, `${what}: at the next runner start the unfinished install must be noticed, its record removed and the owner told which version Squire is on; sent ${JSON.stringify(sent)}`);
  const which = sent.filter((x) => ON.test(x));
  assert.equal(which.length, 1, `${what}: exactly one wake-up must say which version Squire is on; sent ${JSON.stringify(sent)}`);
  const on = ON.exec(which[0])[1];
  assert.ok(allowed.includes(on), `${what}: Squire must be on ${allowed.join(' or ')}; it says ${on}`);
  assert.ok(R.coreIs(rw, on === NEXT ? release : rw.appCore), `${what}: the installed core must be the whole of ${on}, file for file`);
  assert.equal((R.currentRelease(rw) || {}).current || R.INSTALLED, on, `${what}: current-release.json must name ${on}`);
  assert.ok(!fs.existsSync(R.installRecordFile(rw)), `${what}: the install record must be gone`);
  assert.deepEqual(R.hashDifferences(r.before, R.ownerHash(rw.owner, { except: [R.LEDGER] })), [], `${what}: the owner's folder must be unchanged`);
}

test("an install killed part way through its lay-down leaves Squire on one whole version, says which in one wake-up, and leaves the owner's folder unchanged", LONG, async (t) => {
  const r = await interrupted(t, 'lay');
  assertWhole(r, [R.INSTALLED, NEXT], `killed at "${r.seen}"`);
});

// Killed at exactly its step: before the switch Squire is on the previous
// release, during the lay-down on either, from the switch on the new one.
async function killedAtStep(t, step) {
  const early = ['record', 'keep', 'stop'].includes(step);
  const allowed = step === 'lay' ? [R.INSTALLED, NEXT] : (early ? [R.INSTALLED] : [NEXT]);
  const r = await interrupted(t, step);
  assertWhole(r, allowed, `killed at "${step}"`);
  const healthy = await s.waitFor(() => R.health(r.rw).status === 0, 60000, 500);
  assert.ok(healthy, `killed at "${step}": Squire must be healthy after the recovery; health: ${w.describe(R.health(r.rw))}`);
}

test('an install killed at its step "record" is found unfinished at the next runner start: Squire is on 0.1.0, whole and checked, and one wake-up says which', LONG, (t) => killedAtStep(t, "record"));
test('an install killed at its step "keep" is found unfinished at the next runner start: Squire is on 0.1.0, whole and checked, and one wake-up says which', LONG, (t) => killedAtStep(t, "keep"));
test('an install killed at its step "stop" is found unfinished at the next runner start: Squire is on 0.1.0, whole and checked, and one wake-up says which', LONG, (t) => killedAtStep(t, "stop"));
test('an install killed at its step "lay" is found unfinished at the next runner start: Squire is on 0.1.0 or 0.2.0, whole and checked, and one wake-up says which', LONG, (t) => killedAtStep(t, "lay"));
test('an install killed at its step "switch" is found unfinished at the next runner start: Squire is on 0.2.0, whole and checked, and one wake-up says which', LONG, (t) => killedAtStep(t, "switch"));
test('an install killed at its step "reload" is found unfinished at the next runner start: Squire is on 0.2.0, whole and checked, and one wake-up says which', LONG, (t) => killedAtStep(t, "reload"));
test('an install killed at its step "check" is found unfinished at the next runner start: Squire is on 0.2.0, whole and checked, and one wake-up says which', LONG, (t) => killedAtStep(t, "check"));
test('an install killed at its step "clear" is found unfinished at the next runner start: Squire is on 0.2.0, whole and checked, and one wake-up says which', LONG, (t) => killedAtStep(t, "clear"));

test("an install holds its lock for its whole life: a second scheduler run while it is held at a step, finding a record that names an install process already gone, neither installs nor recovers, and the install finishes as one", LONG, async (t) => {
  const rw = await healthyWorld(t);
  const release = R.buildRelease(rw, { version: NEXT });
  stage(rw, release);
  const a = R.asked(rw, SESSION, R.updateRequest(rw, NEXT), 'the request to install');
  R.owner(rw, SESSION, `yes ${a.id}`);
  const sentBefore = R.wakeUpIds(rw);
  const held = await R.stopInstallAt(rw, 'reload', { hold: true });
  t.after(() => held.kill());
  assert.equal(held.seen, 'reload', `the install must be held at exactly its step "reload"; the record named ${JSON.stringify(held.seen)}`);
  // The record alone would now say the install is gone: it names a process that has ended.
  const record = R.readJson(R.installRecordFile(rw));
  fs.writeFileSync(R.installRecordFile(rw), JSON.stringify({ ...record, pid: s.deadPid() }) + '\n');
  const second = R.tick(rw, { timeout: 120000 });
  assert.equal(second.signal, null, `a second scheduler run must end by itself, never wait on a held install; got ${w.describe(second)}`);
  assert.deepEqual(R.newWakeUps(rw, sentBefore).filter((x) => ON.test(x)), [], 'a second run must never recover an install whose lock is held');
  assert.ok(R.coreIs(rw, release), 'a second run must leave the held install\'s core as it was: the new release\'s');
  held.resume();
  await s.waitFor(() => held.run.exited(), 300000, 500);
  const sent = R.newWakeUps(rw, sentBefore);
  assert.equal(updated(sent, NEXT).length, 1, `the install must finish as one and say so once; sent ${JSON.stringify(sent)}`);
  assert.deepEqual(sent.filter((x) => ON.test(x)), [], 'no wake-up may say the update did not finish');
  assert.ok(R.coreIs(rw, release), 'the installed core must be the new release\'s, file for file');
  assert.equal((R.currentRelease(rw) || {}).current, NEXT, 'current-release.json must name the new release');
  assert.ok(!fs.existsSync(R.installRecordFile(rw)), 'the install record must be gone');
});

test("an install record Squire cannot read (not JSON, cut short, naming a step there is not, naming releases that are not kept) is set aside, never adopted: Squire stays on the release current-release.json names, whole and checked, and one wake-up says which", LONG, async (t) => {
  const rw = await healthyWorld(t);
  const release = R.buildRelease(rw, { version: NEXT });
  stage(rw, release);
  const { sent } = installOnYes(rw, release);
  assert.equal(updated(sent, NEXT).length, 1, `the signed update must install; sent ${JSON.stringify(sent)}`);
  const good = { previous: R.INSTALLED, next: NEXT, pid: s.deadPid(), started: Math.floor(R.nowSeconds()) - 60, step: 'lay' };
  const records = {
    'that is not JSON': 'this is not an install record\n',
    'cut short': JSON.stringify(good).slice(0, 30),
    'naming a step there is not': JSON.stringify({ ...good, step: 'unpack' }) + '\n',
    'naming releases that are not kept': JSON.stringify({ ...good, previous: '0.0.7', next: '0.9.9' }) + '\n',
  };
  for (const [what, text] of Object.entries(records)) {
    const before = R.wakeUpIds(rw);
    fs.writeFileSync(R.installRecordFile(rw), text);
    R.tick(rw);
    const said = R.newWakeUps(rw, before).filter((x) => ON.test(x));
    assert.ok(!fs.existsSync(R.installRecordFile(rw)), `an install record ${what} must be set aside: install.json is no longer there`);
    assert.equal(said.length, 1, `an install record ${what}: exactly one wake-up must say which version Squire is on; sent ${JSON.stringify(R.newWakeUps(rw, before))}`);
    assert.equal(ON.exec(said[0])[1], NEXT, `an install record ${what}: Squire stays on ${NEXT}, the release current-release.json names`);
    assert.ok(R.coreIs(rw, release), `an install record ${what}: the installed core must still be the whole of ${NEXT}, file for file`);
    assert.equal((R.currentRelease(rw) || {}).current, NEXT, `an install record ${what}: current-release.json must still name ${NEXT}`);
    assert.deepEqual(R.keptReleases(rw), [R.INSTALLED, NEXT], `an install record ${what}: the kept releases stay as they are`);
  }
  const healthy = await s.waitFor(() => R.health(rw).status === 0, 60000, 500);
  assert.ok(healthy, `Squire must be healthy after setting the records aside; health: ${w.describe(R.health(rw))}`);
});

async function downloadNeverReaches(t, archive, what) {
  const rw = await healthyWorld(t);
  R.buildRelease(rw, { version: NEXT });
  R.standIns(rw, { archive });
  const before = R.untouched(rw);
  const sentBefore = R.wakeUpIds(rw);
  R.tick(rw);
  const record = R.updateRecord(rw) || {};
  assert.ok(typeof record.lastCheck === 'number', `${what}: update.json must record the check's time; got ${JSON.stringify(record)}`);
  assert.ok(/could not check/.test(JSON.stringify(record)), `${what}: update.json must record that Squire could not check; got ${JSON.stringify(record)}`);
  assert.deepEqual(R.stagingFiles(rw), [], `${what}: nothing of the download may be left in the staging folder`);
  assert.deepEqual(R.untouchedDifferences(before, R.untouched(rw)), [], `${what}: nothing of core, the kept releases, the agents or the owner's folder may change`);
  assert.deepEqual(R.newWakeUps(rw, sentBefore).filter((x) => x.includes(NEXT)), [], `${what}: nothing may be offered`);
}

test('a download that fails never reaches core: nothing is staged or changed, and the check is recorded as could not check', LONG, (t) => downloadNeverReaches(t, "fail", "a download that fails"));
test('a download that stops part way and never ends (bounded) never reaches core: nothing is staged or changed, and the check is recorded as could not check', LONG, (t) => downloadNeverReaches(t, "hang", "a download that stops part way and never ends (bounded)"));
test('a download cut short never reaches core: nothing is staged or changed, and the check is recorded as could not check', LONG, (t) => downloadNeverReaches(t, "cut", "a download cut short"));

// ------------------------------------- Claude Code changed outside Squire

const CHANGED = /Claude Code changed outside Squire/;
const DOWNGRADE = /(downgrade|older version of Claude Code|install Claude Code \d|claude install \d)/i;

function assertNoDowngrade(rw, texts, what) {
  const h = R.health(rw);
  assert.ok(![...texts, h.stdout].some((x) => DOWNGRADE.test(x)), `${what}: no Claude Code downgrade may ever be offered; got ${JSON.stringify(texts)} and ${JSON.stringify(h.stdout)}`);
}

test("Claude Code's version changed outside Squire is noticed at the scheduler's next run, checked, and reported in one wake-up with the health check's result, once", LONG, async (t) => {
  const rw = await healthyWorld(t);
  R.setVersionAnswer(rw, '2.1.400');
  const before = R.wakeUpIds(rw);
  R.tick(rw);
  const sent = R.newWakeUps(rw, before).filter((x) => CHANGED.test(x));
  assert.equal(sent.length, 1, `one wake-up must say Claude Code changed outside Squire; sent ${JSON.stringify(R.newWakeUps(rw, before))}`);
  assert.ok(sent[0].includes('2.1.400'), `the wake-up must name the version Claude Code is now; got ${JSON.stringify(sent[0])}`);
  assert.ok(/all checks passed|health check/i.test(sent[0]), `the wake-up must carry the health check's result; got ${JSON.stringify(sent[0])}`);
  const again = R.wakeUpIds(rw);
  R.tick(rw);
  assert.deepEqual(R.newWakeUps(rw, again).filter((x) => CHANGED.test(x)), [], 'the same change is never reported twice');
  assertNoDowngrade(rw, sent, 'a newer Claude Code');
});

async function claudeCodeChanged(t, change, what) {
  const rw = await healthyWorld(t);
  if (change === 'target') R.setLauncherTarget(rw, '2.1.319-b');
  if (change === 'versionFails') R.setVersionAnswer(rw, { fail: true });
  if (change === 'versionHangs') R.setVersionAnswer(rw, { hang: true });
  if (change === 'targetGone') R.setLauncherTarget(rw, null);
  if (change === 'older') R.setVersionAnswer(rw, '2.1.200');
  if (change === 'sameTarget') R.setLauncherTarget(rw, R.CLAUDE_CODE, { replace: true });
  if (change === 'relinked') {
    R.setLauncherTarget(rw, '2.1.319-b');
    R.setLauncherTarget(rw, R.CLAUDE_CODE);
  }
  const before = R.wakeUpIds(rw);
  R.tick(rw);
  const sent = R.newWakeUps(rw, before).filter((x) => CHANGED.test(x));
  assert.equal(sent.length, 1, `${what}: one wake-up must say Claude Code changed outside Squire, with the health check's result; sent ${JSON.stringify(R.newWakeUps(rw, before))}`);
  assertNoDowngrade(rw, sent, what);
}

test("when the launcher now points at another file, with the same version answer, the scheduler's next run counts it a change: it runs the health check and sends its result in one wake-up, and offers no Claude Code downgrade", LONG, (t) => claudeCodeChanged(t, "target", "the launcher now points at another file, with the same version answer"));
test("when claude --version fails, the scheduler's next run counts it a change: it runs the health check and sends its result in one wake-up, and offers no Claude Code downgrade", LONG, (t) => claudeCodeChanged(t, "versionFails", "claude --version fails"));
test("when claude --version never answers (bounded), the scheduler's next run counts it a change: it runs the health check and sends its result in one wake-up, and offers no Claude Code downgrade", LONG, (t) => claudeCodeChanged(t, "versionHangs", "claude --version never answers (bounded)"));
test("when the launcher points at nothing, the scheduler's next run counts it a change: it runs the health check and sends its result in one wake-up, and offers no Claude Code downgrade", LONG, (t) => claudeCodeChanged(t, "targetGone", "the launcher points at nothing"));
test("when Claude Code is now an older version, the scheduler's next run counts it a change: it runs the health check and sends its result in one wake-up, and offers no Claude Code downgrade", LONG, (t) => claudeCodeChanged(t, "older", "Claude Code is now an older version"));

test("when the file the launcher points at is replaced at the same path, with the same version answer, the scheduler's next run counts it a change: it runs the health check and sends its result in one wake-up, and offers no Claude Code downgrade", LONG, (t) => claudeCodeChanged(t, "sameTarget", "the file the launcher points at replaced at the same path, with the same version answer"));
test("when the launcher is pointed elsewhere and back between two runs of the scheduler, the next run counts it a change: it runs the health check and sends its result in one wake-up, and offers no Claude Code downgrade", LONG, (t) => claudeCodeChanged(t, "relinked", "the launcher pointed elsewhere and back between two runs"));

test("a change to Claude Code made while Squire was stopped is reported once after Squire starts again: the runner's start keeps the record it had, and the change is reported in one wake-up with the health check's result", LONG, async (t) => {
  const rw = await healthyWorld(t);
  R.stopSquire(rw);
  R.setVersionAnswer(rw, '2.1.400');
  const before = R.wakeUpIds(rw);
  await R.startSquire(rw);
  R.tick(rw);
  const sent = R.newWakeUps(rw, before).filter((x) => CHANGED.test(x));
  assert.equal(sent.length, 1, `one wake-up must say Claude Code changed outside Squire while Squire was stopped; sent ${JSON.stringify(R.newWakeUps(rw, before))}`);
  assert.ok(sent[0].includes('2.1.400'), `the wake-up must name the version Claude Code is now; got ${JSON.stringify(sent[0])}`);
  const again = R.wakeUpIds(rw);
  R.tick(rw);
  assert.deepEqual(R.newWakeUps(rw, again).filter((x) => CHANGED.test(x)), [], 'the same change is never reported twice');
  assertNoDowngrade(rw, sent, 'a change made while Squire was stopped');
});

test("when Claude Code changed and Squire's sign-in no longer answers, the one wake-up carries the known fix it offers, signing in again", LONG, async (t) => {
  const rw = await healthyWorld(t);
  R.setVersionAnswer(rw, '2.1.400');
  rw.inner.set({ signedIn: false });
  const before = R.wakeUpIds(rw);
  R.tick(rw);
  const sent = R.newWakeUps(rw, before).filter((x) => CHANGED.test(x));
  assert.equal(sent.length, 1, `one wake-up must say Claude Code changed outside Squire; sent ${JSON.stringify(R.newWakeUps(rw, before))}`);
  assert.ok(/sign in again/i.test(sent[0]), `the wake-up must carry the known fix the health check offers, signing in again; got ${JSON.stringify(sent[0])}`);
  assertNoDowngrade(rw, sent, 'Claude Code changed and signed out');
});
