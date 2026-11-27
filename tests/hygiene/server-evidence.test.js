'use strict';

// Code hygiene for the runner's reader of a server's live evidence
// (core/tools/runner.py, Evidence): a bridge pointer counts only when it names
// the server's pid, or a live process in its process group, and was written
// since the server's start; a session record counts only when it was written
// since that start; the lock's server counts only while it is the process the
// lock recorded. Driven through /usr/bin/python3 on a folder of its own.
// Bound to no criterion.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const CORE = path.join(__dirname, '..', '..', 'core');

function home(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'squire-test-evidence-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'claude-config', 'projects'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
  return dir;
}

// Runs one of Evidence's reads: pointer (pid, since), session (since), held, live.
function ask(dir, what, args = []) {
  const driver = path.join(dir, 'driver.py');
  fs.writeFileSync(driver, [
    'import json, sys',
    `sys.path.insert(0, ${JSON.stringify(path.join(CORE, 'lib'))})`,
    `sys.path.insert(0, ${JSON.stringify(path.join(CORE, 'tools'))})`,
    'from runner import Evidence',
    'what, args = sys.argv[1], json.loads(sys.argv[2])',
    'e = Evidence(sys.argv[3])',
    "out = {'pointer': lambda: e.pointer(*args), 'session': lambda: e.session_since(*args), 'held': e.held, 'live': e.live}[what]()",
    'print(json.dumps(out))',
    '',
  ].join('\n'));
  const r = spawnSync('/usr/bin/python3', ['-B', driver, what, JSON.stringify(args), dir], { encoding: 'utf8', timeout: 30000 });
  assert.equal(r.status, 0, `the driver must run; stderr: ${r.stderr}`);
  return JSON.parse(r.stdout.trim());
}

function writePointer(dir, name, record, mtime) {
  const folder = path.join(dir, 'claude-config', 'projects', name);
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, 'bridge-pointer.json');
  fs.writeFileSync(file, typeof record === 'string' ? record : JSON.stringify(record));
  if (mtime !== undefined) fs.utimesSync(file, mtime, mtime);
  return file;
}

function sleeper(t) {
  const p = spawn('/bin/sleep', ['600'], { stdio: 'ignore', detached: true });
  t.after(() => { try { process.kill(-p.pid, 'SIGKILL'); } catch (e) { /* gone */ } });
  return p;
}

test('a bridge pointer counts only when it names the server and was written since its start; another process, an earlier write and a file cut short do not', (t) => {
  const dir = home(t);
  const server = sleeper(t);
  const other = sleeper(t);
  const now = Date.now() / 1000;
  const since = now - 30;
  writePointer(dir, 'own', { sessionId: '', environmentId: 'own-environment', pid: server.pid });
  assert.equal(ask(dir, 'pointer', [server.pid, since]).environmentId, 'own-environment', 'a pointer naming the server, written since its start, is evidence');
  assert.equal(ask(dir, 'pointer', [other.pid, since]), null, 'a pointer naming the server is no evidence for another process');
  assert.equal(ask(dir, 'pointer', [server.pid, now + 60]), null, 'a pointer written before the start is no evidence');
  const cut = home(t);
  writePointer(cut, 'cut', `{"sessionId": "", "pid": ${server.pid}, "dir": `);
  assert.equal(ask(cut, 'pointer', [server.pid, since]), null, 'a pointer that cannot be read is no evidence');
  const foreign = home(t);
  writePointer(foreign, 'other', { sessionId: '', pid: other.pid });
  assert.equal(ask(foreign, 'pointer', [server.pid, since]), null, 'a pointer naming a live process outside the server\'s process group is no evidence');
  const notNumber = home(t);
  writePointer(notNumber, 'bad', { sessionId: '', pid: String(server.pid) });
  assert.equal(ask(notNumber, 'pointer', [server.pid, since]), null, 'a pointer whose pid is not a whole number is no evidence');
});

test('a session record counts only when it was written since the server started', (t) => {
  const dir = home(t);
  const now = Date.now() / 1000;
  fs.writeFileSync(path.join(dir, 'sessions', 'earlier.json'), JSON.stringify({ sessionId: 'earlier', recordedAt: now - 300 }));
  assert.equal(ask(dir, 'session', [now - 60]), false, 'a record an earlier server left is no evidence');
  fs.writeFileSync(path.join(dir, 'sessions', 'since.json'), JSON.stringify({ sessionId: 'since', recordedAt: now - 10 }));
  assert.equal(ask(dir, 'session', [now - 60]), true, 'a record written since the start is evidence');
});

test("the lock's server counts only while it is the process the lock recorded, and is live only with evidence", (t) => {
  const dir = home(t);
  const server = sleeper(t);
  const ps = spawnSync('/bin/ps', ['-o', 'lstart=', '-p', String(server.pid)], { encoding: 'utf8', env: { LC_ALL: 'C', TZ: 'UTC0', PATH: '/usr/bin:/bin' } });
  const [, mon, day, clock, year] = ps.stdout.trim().split(/\s+/);
  const month = String(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].indexOf(mon) + 1).padStart(2, '0');
  const started = `${year}-${month}-${day.padStart(2, '0')}T${clock}Z`;
  fs.writeFileSync(path.join(dir, 'runner.lock'), JSON.stringify({ runner: process.pid, pid: server.pid, startedAt: started }));
  const held = ask(dir, 'held');
  assert.ok(Array.isArray(held) && held[0] === server.pid, `the lock's server, alive and as recorded, is held; got ${JSON.stringify(held)}`);
  assert.equal(ask(dir, 'live'), null, 'with no pointer and no record, the held server is not live');
  writePointer(dir, 'own', { sessionId: '', pid: server.pid });
  assert.equal((ask(dir, 'live') || {}).pid, server.pid, 'with its own pointer written since its start, the held server is live');
  fs.writeFileSync(path.join(dir, 'runner.lock'), JSON.stringify({ runner: process.pid, pid: server.pid, startedAt: '2000-01-01T00:00:00Z' }));
  assert.equal(ask(dir, 'held'), null, 'a lock whose recorded start is not the process\'s own names no server');
});
