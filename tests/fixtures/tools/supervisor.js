'use strict';

// The test world's stand-in for launchd keeping Squire's runner agent, run as
// its own process so a test can wait on a product process synchronously while
// it works. It starts the installed runner as the agent does
// (/usr/bin/python3 -B <Squire home>/core/tools/runner.py, a process group of
// its own, the world's environment), and starts it again only when launchd
// would in a world: after a lay-down (the installed core folder is a new one
// and the runner is not running), or when the test asks for a runner start
// (<state>/start appears: a login, or the Mac starting again). It never
// restarts a runner that exits by itself over the same core, as launchd's
// agent, once booted out, does not.
//
//   node supervisor.js <state folder>
//
// <state>/supervisor.json: { python, home, env }. Records, one JSON line each,
// in <state>/starts.jsonl: every runner start (pid, why, the core folder's
// inode) and every exit seen (pid, status, signal). <state>/stop, or SIGTERM,
// ends it: every runner it started is ended with its process group first.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const state = process.argv[2];
const how = JSON.parse(fs.readFileSync(path.join(state, 'supervisor.json'), 'utf8'));
const record = (rec) => fs.appendFileSync(path.join(state, 'starts.jsonl'), JSON.stringify({ at: Date.now() / 1000, ...rec }) + '\n');
const coreIno = () => { try { return fs.lstatSync(path.join(how.home, 'core')).ino; } catch (e) { return null; } };
const started = [];
let current = null;
let startedOver = null;

function start(why) {
  const out = fs.openSync(path.join(state, 'runner.out'), 'a');
  const child = spawn(how.python, ['-B', path.join(how.home, 'core', 'tools', 'runner.py')],
    { cwd: '/', env: how.env, stdio: ['ignore', out, out], detached: true });
  fs.closeSync(out);
  const run = { child, exit: null };
  child.on('exit', (status, signal) => { run.exit = { status, signal }; record({ exited: child.pid, status, signal }); });
  started.push(child.pid);
  current = run;
  startedOver = coreIno();
  record({ started: child.pid, why, coreIno: startedOver });
}

function endAll() {
  for (const pid of started) {
    try { process.kill(-pid, 'SIGKILL'); } catch (e) { /* gone */ }
  }
  process.exit(0);
}

process.on('SIGTERM', endAll);
start('first start');
let changedAt = null;
setInterval(() => {
  if (fs.existsSync(path.join(state, 'stop'))) endAll();
  const running = current && !current.exit;
  const asked = path.join(state, 'start');
  if (fs.existsSync(asked)) {
    fs.rmSync(asked, { force: true });
    if (!running) start('a runner start');
    return;
  }
  const ino = coreIno();
  if (!running && ino !== null && ino !== startedOver) {
    changedAt = changedAt || Date.now();
    if (Date.now() - changedAt >= 500) { changedAt = null; start('after a lay-down'); }
  } else changedAt = null;
}, 200);
