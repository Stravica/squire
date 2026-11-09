'use strict';

// The nightly backup: core/tools/backup.py, run by its own launchd agent
// (com.stravica.squire.backup, 02:30 every night, never kept alive), backs
// the owner's folder (ownerFolder in squire.json) up into backupFolder (the
// iCloud Drive folder by default; a scratch folder here). The backup holds
// current/, the owner's folder as at the last run, and archive/<run time>/:
// a removed file and a changed file's earlier copy move there; nothing in the
// backup is ever deleted or overwritten. A destination that is absent, not
// writable or full gives no partial pass: the job exits non-zero, records the
// failure in backup.json in the Squire home, the health check names the
// backup and the destination, and the next run tries again in full. Real
// iCloud is a by-hand line of the journey walk and the release Verify.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const w = require('../fixtures/squire-world.js');
const s = require('../fixtures/session-world.js');

function backupWorld(t, destination) {
  const world = w.makeWorld();
  t.after(() => w.cleanUp(world));
  world.system = path.join(world.root, 'system');
  fs.mkdirSync(world.system, { recursive: true });
  s.layDownCore(world);
  world.destination = destination || path.join(world.root, 'backups', 'Squire Backup');
  fs.mkdirSync(path.dirname(world.destination), { recursive: true });
  w.writeConfig(world, { backupFolder: world.destination });
  return world;
}

const backupScript = (world) => path.join(s.installedCore(world), 'tools', 'backup.py');

function backup(world) {
  return w.runPython(world, backupScript(world), [], { cwd: '/' });
}

// The backup job with a cap on the size of any file it writes (ulimit -f, in
// 512-byte blocks): a full destination, as the job meets it.
function backupOnFullDisk(world, blocks) {
  const r = spawnSync('/bin/sh', ['-c', `ulimit -f ${blocks}; exec ${w.PYTHON} "$0"`, backupScript(world)], {
    cwd: '/', env: w.productEnv(world), encoding: 'utf8', timeout: 60000,
  });
  return { status: r.status, signal: r.signal, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error ? String(r.error.message) : '' };
}

function health(world) {
  return w.runPython(world, path.join(s.installedCore(world), 'tools', 'health.py'), [],
    { cwd: world.root, env: { SQUIRE_SYSTEM_ROOT: world.system } });
}

const backupLines = (r, destination) => r.stdout.split('\n').filter((l) => /backup/i.test(l) && l.includes(destination));

// Every file under a folder: relative path to its bytes' digest.
function filesUnder(dir) {
  const out = {};
  const visit = (abs, rel) => {
    let st;
    try { st = fs.lstatSync(abs); } catch (e) { return; }
    if (st.isDirectory()) for (const n of fs.readdirSync(abs).sort()) visit(path.join(abs, n), rel ? `${rel}/${n}` : n);
    else if (st.isFile()) out[rel] = w.sha256(fs.readFileSync(abs));
  };
  visit(dir, '');
  return out;
}

function assertRan(r, what) {
  assert.doesNotMatch(r.stderr, /can't open file|Traceback/, `${what}: the backup job must run; got ${w.describe(r)}`);
  assert.equal(r.status, 0, `${what}: the backup must succeed; got ${w.describe(r)}`);
}

// A destination the job cannot use: no partial pass, the failure recorded,
// the health check naming the backup and the destination; then, with the
// destination usable again, the next run succeeds in full and the line goes.
function assertNoPartialPassThenRecovers(world, run, repair, what) {
  const r = run();
  assert.doesNotMatch(r.stderr, /can't open file|Traceback/, `${what}: the backup job must run; got ${w.describe(r)}`);
  assert.notEqual(r.status, 0, `${what}: the backup must not pass; got ${w.describe(r)}`);
  const recordFile = path.join(world.home, 'backup.json');
  assert.ok(fs.existsSync(recordFile), `${what}: the run must be recorded in backup.json in the Squire home`);
  assert.match(fs.readFileSync(recordFile, 'utf8'), /fail/i, `${what}: backup.json must record the run as failed`);
  const h = health(world);
  assert.ok(backupLines(h, world.destination).length >= 1, `${what}: the health check must name the backup and ${world.destination}; got ${w.describe(h)}`);
  repair();
  assertRan(backup(world), `${what}, the next run`);
  const owner = filesUnder(world.owner);
  const current = filesUnder(path.join(world.destination, 'current'));
  for (const [rel, digest] of Object.entries(owner)) assert.equal(current[rel], digest, `${what}, the next run: current/${rel} must be backed up in full`);
  assert.deepEqual(backupLines(health(world), world.destination), [], `${what}: after a run that succeeds, the health check must no longer name the backup`);
}

test('lay-down writes the backup job\'s agent: the backup program every night at 02:30, never kept alive, and its load reaches no real launchd domain', { timeout: 60000 }, (t) => {
  const world = backupWorld(t);
  const agent = s.launchAgents(world).find((a) => a.plist.Label === 'com.stravica.squire.backup');
  assert.ok(agent, `lay-down must write com.stravica.squire.backup.plist under the home's Library/LaunchAgents; found ${s.launchAgents(world).map((a) => a.plist.Label).join(', ')}`);
  assert.deepEqual(agent.plist.ProgramArguments, [w.PYTHON, '-B', backupScript(world)], 'the agent runs the installed backup program with /usr/bin/python3');
  assert.deepEqual(agent.plist.StartCalendarInterval, { Hour: 2, Minute: 30 }, 'the agent runs every night at 02:30');
  assert.ok(!agent.plist.KeepAlive, 'the backup agent is never kept alive');
  assert.equal((agent.plist.EnvironmentVariables || {}).SQUIRE_HOME, world.home, 'the agent names the Squire home');
  assert.ok(!s.launchdHas('com.stravica.squire.backup'), 'a world\'s lay-down must load nothing into the launchd domain of whoever runs the tests');
});

test('the backup copies an added file, and a file removed from the owner\'s folder stays in the backup', { timeout: 60000 }, (t) => {
  const world = backupWorld(t);
  assertRan(backup(world), 'the first run');
  const current = path.join(world.destination, 'current');
  for (const [rel, digest] of Object.entries(filesUnder(world.owner))) {
    assert.equal(filesUnder(current)[rel], digest, `current/${rel} must hold the owner's file`);
  }
  const added = path.join(world.owner, 'letters', 'plumber.md');
  fs.mkdirSync(path.dirname(added), { recursive: true });
  fs.writeFileSync(added, 'Dear Mr Hale, about Thursday.\n');
  assertRan(backup(world), 'the run after a file was added');
  assert.equal(fs.readFileSync(path.join(current, 'letters', 'plumber.md'), 'utf8'), 'Dear Mr Hale, about Thursday.\n', 'the added file must be backed up');
  fs.rmSync(added);
  assertRan(backup(world), 'the run after the file was removed');
  const kept = Object.entries(filesUnder(world.destination)).filter(([rel]) => rel.endsWith('letters/plumber.md'));
  assert.ok(kept.some(([rel, digest]) => rel.startsWith('archive/') && digest === w.sha256('Dear Mr Hale, about Thursday.\n')),
    `the removed file must stay in the backup, in the run's archive folder; found ${kept.map(([rel]) => rel).join(', ') || 'nothing'}`);
});

test('a changed file\'s earlier copy moves to the dated archive, and nothing in the backup is ever overwritten or deleted', { timeout: 60000 }, (t) => {
  const world = backupWorld(t);
  const file = path.join(world.owner, 'shopping.md');
  const versions = ['Eggs\n', 'Eggs\nFlour\n', 'Eggs\nFlour\nLemons\n'];
  let before = {};
  for (const [i, text] of versions.entries()) {
    fs.writeFileSync(file, text);
    assertRan(backup(world), `run ${i + 1}`);
    const after = filesUnder(world.destination);
    const digests = new Set(Object.values(after));
    for (const [rel, digest] of Object.entries(before)) {
      assert.ok(digests.has(digest), `run ${i + 1}: ${rel}'s earlier bytes must still be in the backup (never overwritten or deleted)`);
    }
    before = after;
  }
  assert.equal(fs.readFileSync(path.join(world.destination, 'current', 'shopping.md'), 'utf8'), versions[2], 'current/ holds the latest copy');
  const archived = Object.entries(before).filter(([rel]) => /^archive\/[^/]+\/shopping\.md$/.test(rel)).map(([, d]) => d);
  for (const v of versions.slice(0, 2)) {
    assert.ok(archived.includes(w.sha256(v)), `the earlier copy ${JSON.stringify(v)} must be in a dated archive folder`);
  }
  const runs = new Set(Object.keys(before).filter((rel) => rel.startsWith('archive/')).map((rel) => rel.split('/')[1]));
  assert.ok(runs.size >= 2, 'each run that moved an earlier copy has its own archive folder');
});

test('an absent backup destination gives no partial pass: the failure is recorded, the health check names the backup and the destination, and the next run succeeds', { timeout: 60000 }, (t) => {
  const world = backupWorld(t, null);
  const absent = path.join(world.root, 'not-mounted', 'Squire Backup');
  world.destination = absent;
  w.writeConfig(world, { backupFolder: absent });
  assertNoPartialPassThenRecovers(world, () => backup(world), () => fs.mkdirSync(path.dirname(absent), { recursive: true }), 'an absent destination');
});

test('a backup destination that cannot be written gives no partial pass: the failure is recorded, the health check names it, and the next run succeeds', { timeout: 60000 }, (t) => {
  const world = backupWorld(t);
  fs.mkdirSync(world.destination, { recursive: true });
  fs.chmodSync(world.destination, 0o555);
  t.after(() => { try { fs.chmodSync(world.destination, 0o755); } catch (e) { /* gone */ } });
  assertNoPartialPassThenRecovers(world, () => backup(world), () => fs.chmodSync(world.destination, 0o755), 'a destination that cannot be written');
});

test('a full backup destination gives no partial pass: the failure is recorded, the health check names it, and the next run succeeds', { timeout: 60000 }, (t) => {
  const world = backupWorld(t);
  fs.writeFileSync(path.join(world.owner, 'scan.pdf'), Buffer.alloc(256 * 1024, 7));
  assertNoPartialPassThenRecovers(world, () => backupOnFullDisk(world, 64), () => {}, 'a full destination');
});
