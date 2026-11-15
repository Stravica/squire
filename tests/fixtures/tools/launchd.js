'use strict';

// The test world's model of launchd, for the cases that need to see what
// launchd does to a job's process group: a daemon per world, and a stand-in
// launchctl at <system root>/bin/launchctl (the world's SQUIRE_SYSTEM_ROOT, the
// design record's route to the Mac's own commands) that hands each call to
// the daemon and prints its answer. Nothing here imports or copies product
// logic. What it models, as man launchd.plist and the walk's reads describe it:
//
//   bootstrap gui/<uid> <plist>   reads the plist (plistlib's XML form, read
//                                 with the Mac's own plutil) and loads the job:
//                                 RunAtLoad starts its program at once, as the
//                                 leader of a new process group; KeepAlive
//                                 starts it again when it exits; StartInterval
//                                 starts it on the interval when the world asks
//                                 for intervals, and otherwise only when the
//                                 test fires it. Exit 0, or 5 when the label is
//                                 already loaded.
//   bootout gui/<uid>/<label>     unloads the job and ends it: SIGTERM to its
//                                 process group, SIGKILL to the group 2 seconds
//                                 later (launchd's ExitTimeOut is 20 seconds;
//                                 shorter here), or to its main process alone
//                                 when the plist sets AbandonProcessGroup. It
//                                 answers once the job is gone. Exit 0, or 113
//                                 when the label is not loaded.
//   print gui/<uid>/<label>       exit 0 when loaded, 113 when not.
//   any other verb                exit 64, logged, so a new product call
//                                 cannot slip past the model.
//
// When a job's main process exits, the rest of its process group is ended the
// same way (unless AbandonProcessGroup). A booted-out job is never started
// again by the model itself. The test drives two things launchd does on its
// own: a login (every plist in the world's Library/LaunchAgents bootstrapped)
// and a log-out (every job ended with its group and unloaded), and it can
// fire a loaded job now, as its StartInterval would.
//
//   node launchd.js <state folder>                     the daemon
//   node launchd.js --client <state folder> <json>     one control message
//
// <state>/launchd.json: { uid, env, agents, intervals }: the uid the domain is
// named by, the environment every job starts in (the plist's
// EnvironmentVariables over it), the world's LaunchAgents folder, and whether
// StartInterval runs by itself. The daemon listens on the IPv4 loopback at a
// port the system picks and writes it to <state>/port. Records, one JSON line
// each: <state>/calls.jsonl (every launchctl call: its arguments, the caller's
// process and process group, the job's group when the call names a running
// job, and the exit code) and <state>/events.jsonl (every job start, exit and
// group ended). SIGTERM ends the daemon: every job it started is ended with
// its process group first. Nothing here ever calls the Mac's own launchctl.

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');

const KILL_AFTER_MS = 2000;
const KEEP_ALIVE_AFTER_MS = 1000;

// ------------------------------------------------------------- the client

// The stand-in launchctl's source: hands its arguments to the world's daemon
// and prints the answer. With no daemon it refuses (exit 64), never falling
// through to the Mac's own launchctl.
function launchctlScript(state) {
  return `#!${process.execPath}
'use strict';
const fs = require('fs');
const net = require('net');
const state = ${JSON.stringify(state)};
const argv = process.argv.slice(2);
let port = null;
try { port = Number(fs.readFileSync(state + '/port', 'utf8')); } catch (e) { port = null; }
if (!port) { process.stderr.write('launchctl: the world\\'s launchd is not running\\n'); process.exit(64); }
const socket = net.connect(port, '127.0.0.1');
let reply = '';
socket.setEncoding('utf8');
socket.on('connect', () => socket.write(JSON.stringify({ argv, caller: process.pid, parent: process.ppid }) + '\\n'));
socket.on('data', (d) => { reply += d; });
socket.on('error', () => { process.stderr.write('launchctl: no answer from launchd\\n'); process.exit(64); });
socket.on('close', () => {
  let r = null;
  try { r = JSON.parse(reply); } catch (e) { process.stderr.write('launchctl: no answer from launchd\\n'); process.exit(64); }
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  process.exit(r.code);
});
`;
}

// One control message from a test (login, logout, fire, state, stop), sent
// synchronously through a child client; returns the daemon's answer.
function control(state, message, { timeout = 30000 } = {}) {
  const r = spawnSync(process.execPath, [__filename, '--client', state, JSON.stringify(message)],
    { encoding: 'utf8', timeout });
  try { return JSON.parse(r.stdout); } catch (e) { return { code: 64, error: `${r.stdout || ''}${r.stderr || ''}`.trim() || 'no answer' }; }
}

function client(state, text) {
  let port = null;
  try { port = Number(fs.readFileSync(path.join(state, 'port'), 'utf8')); } catch (e) { port = null; }
  if (!port) { process.stdout.write(JSON.stringify({ code: 64, error: 'the world\'s launchd is not running' })); process.exit(0); }
  const socket = net.connect(port, '127.0.0.1');
  let reply = '';
  socket.setEncoding('utf8');
  socket.on('connect', () => socket.write(text + '\n'));
  socket.on('data', (d) => { reply += d; });
  socket.on('error', () => { process.stdout.write(JSON.stringify({ code: 64, error: 'no answer' })); process.exit(0); });
  socket.on('close', () => { process.stdout.write(reply || JSON.stringify({ code: 64, error: 'no answer' })); process.exit(0); });
}

// Starts the daemon for a world, detached in a process group of its own, and
// waits for its port. Returns its pid.
function start(state, { uid = process.getuid(), env, agents, intervals = false }) {
  fs.mkdirSync(state, { recursive: true });
  fs.rmSync(path.join(state, 'port'), { force: true });
  fs.writeFileSync(path.join(state, 'launchd.json'), JSON.stringify({ uid, env, agents, intervals }));
  const child = spawn(process.execPath, [__filename, state], { cwd: '/', stdio: 'ignore', detached: true });
  child.unref();
  const end = Date.now() + 10000;
  while (!fs.existsSync(path.join(state, 'port')) && Date.now() < end) spawnSync('/bin/sleep', ['0.05']);
  if (!fs.existsSync(path.join(state, 'port'))) throw new Error('the world\'s launchd model must start');
  return child.pid;
}

const readLines = (file) => (fs.existsSync(file)
  ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const calls = (state) => readLines(path.join(state, 'calls.jsonl'));
const events = (state) => readLines(path.join(state, 'events.jsonl'));

module.exports = { launchctlScript, control, start, calls, events, KILL_AFTER_MS };

// ------------------------------------------------------------- the daemon

function daemon(state) {
  const how = JSON.parse(fs.readFileSync(path.join(state, 'launchd.json'), 'utf8'));
  const domain = `gui/${how.uid}`;
  const jobs = new Map();
  const append = (file, rec) => fs.appendFileSync(path.join(state, file), JSON.stringify({ at: Date.now() / 1000, ...rec }) + '\n');
  const groupOf = (pid) => {
    const r = spawnSync('/bin/ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' });
    return Number((r.stdout || '').trim()) || null;
  };
  const alive = (pid) => {
    try { process.kill(pid, 0); } catch (e) { return false; }
    const r = spawnSync('/bin/ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
    const stat = (r.stdout || '').trim();
    return Boolean(stat) && !stat.startsWith('Z');
  };
  const groupAlive = (pgid) => {
    const r = spawnSync('/bin/ps', ['-axo', 'pgid=,stat='], { encoding: 'utf8' });
    return (r.stdout || '').split('\n').some((l) => {
      const m = /^\s*(\d+)\s+(\S+)/.exec(l);
      return m && Number(m[1]) === pgid && !m[2].startsWith('Z');
    });
  };
  const signal = (target, sig) => { try { process.kill(target, sig); return true; } catch (e) { return false; } };

  function readPlist(file) {
    const r = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8' });
    if (r.status !== 0) return null;
    try { return JSON.parse(r.stdout); } catch (e) { return null; }
  }

  // Ends a job's process group (or its main process alone, when abandoned):
  // SIGTERM, then SIGKILL after the wait; calls done() once it is gone.
  function endGroup(job, pid, why, done = () => {}) {
    const target = job.abandon ? pid : -pid;
    append('events.jsonl', { ended: job.label, pid, group: job.abandon ? null : pid, why });
    signal(target, 'SIGTERM');
    const startedAt = Date.now();
    const poll = setInterval(() => {
      const gone = job.abandon ? !alive(pid) : !groupAlive(pid);
      if (gone) { clearInterval(poll); done(); return; }
      if (Date.now() - startedAt >= KILL_AFTER_MS) {
        signal(target, 'SIGKILL');
        if (Date.now() - startedAt >= KILL_AFTER_MS + 3000) { clearInterval(poll); done(); }
      }
    }, 50);
  }

  function run(job, why) {
    if (job.running) return job.running.pid;
    const args = job.plist.ProgramArguments || [job.plist.Program];
    const out = fs.openSync(path.join(state, `${job.label}.out`), 'a');
    const child = spawn(args[0], args.slice(1), {
      cwd: job.plist.WorkingDirectory || '/', env: { ...how.env, ...(job.plist.EnvironmentVariables || {}) },
      stdio: ['ignore', out, out], detached: true,
    });
    fs.closeSync(out);
    const running = { pid: child.pid, exit: null };
    job.running = running;
    job.runs += 1;
    append('events.jsonl', { started: job.label, pid: child.pid, why });
    child.on('error', (e) => append('events.jsonl', { startFailed: job.label, error: String(e.message || e) }));
    child.on('exit', (status, sig) => {
      running.exit = { status, signal: sig };
      append('events.jsonl', { exited: job.label, pid: child.pid, status, signal: sig });
      const after = () => {
        if (job.running === running) job.running = null;
        if (job.loaded && job.plist.KeepAlive === true && !job.stopping) {
          setTimeout(() => { if (job.loaded && !job.running) run(job, 'KeepAlive'); }, KEEP_ALIVE_AFTER_MS);
        }
      };
      // The main process has exited: the rest of its group goes with it.
      if (!job.abandon && groupAlive(child.pid)) endGroup(job, child.pid, 'its main process exited', after);
      else after();
    });
    return child.pid;
  }

  function bootstrap(plistFile) {
    const plist = readPlist(plistFile);
    if (!plist || typeof plist.Label !== 'string') return { code: 5, stderr: `Bootstrap failed: 5: Input/output error\n` };
    const known = jobs.get(plist.Label);
    if (known && known.loaded) return { code: 5, stderr: 'Bootstrap failed: 5: Input/output error\n' };
    const job = known || { label: plist.Label, runs: 0, running: null };
    Object.assign(job, { plist, file: plistFile, loaded: true, stopping: false, abandon: plist.AbandonProcessGroup === true });
    jobs.set(plist.Label, job);
    append('events.jsonl', { loaded: plist.Label, file: plistFile });
    if (plist.RunAtLoad === true || plist.KeepAlive === true) run(job, 'loaded');
    return { code: 0 };
  }

  function bootout(label, reply) {
    const job = jobs.get(label);
    if (!job || !job.loaded) { reply({ code: 113, stderr: `Boot-out failed: 113: Could not find specified service\n` }); return; }
    job.loaded = false;
    job.stopping = true;
    append('events.jsonl', { unloaded: label });
    const running = job.running;
    if (!running || running.exit) { job.stopping = false; reply({ code: 0 }); return; }
    endGroup(job, running.pid, 'booted out', () => { job.stopping = false; reply({ code: 0 }); });
  }

  function fire(label) {
    const job = jobs.get(label);
    if (!job || !job.loaded) return { code: 113 };
    if (job.running) return { code: 0, pid: job.running.pid, already: true };
    return { code: 0, pid: run(job, 'fired') };
  }

  function login() {
    let names = [];
    try { names = fs.readdirSync(how.agents).filter((n) => n.endsWith('.plist')).sort(); } catch (e) { names = []; }
    const loaded = {};
    for (const n of names) loaded[n] = bootstrap(path.join(how.agents, n)).code;
    return { code: 0, loaded };
  }

  // A log-out: every job ended with its group and unloaded.
  function logout(reply) {
    const live = [...jobs.values()].filter((j) => j.loaded || j.running);
    let left = live.length;
    if (!left) { reply({ code: 0 }); return; }
    for (const job of live) {
      job.loaded = false;
      job.stopping = true;
      const done = () => { job.stopping = false; left -= 1; if (left === 0) reply({ code: 0 }); };
      if (job.running && !job.running.exit) endGroup(job, job.running.pid, 'logged out', done);
      else done();
    }
  }

  function snapshot() {
    const out = {};
    for (const [label, job] of jobs) {
      out[label] = { loaded: job.loaded, pid: job.running ? job.running.pid : null, runs: job.runs, abandon: job.abandon };
    }
    return { code: 0, jobs: out };
  }

  function launchctl(msg, reply) {
    const argv = Array.isArray(msg.argv) ? msg.argv.map(String) : [];
    const callerGroup = msg.caller ? groupOf(msg.caller) : null;
    const rec = { argv, caller: msg.caller || null, callerGroup };
    const target = (a) => (typeof a === 'string' && a.startsWith(`${domain}/`) ? a.slice(domain.length + 1) : null);
    const done = (r) => { append('calls.jsonl', { ...rec, code: r.code }); reply(r); };
    const [verb, a1, a2] = argv;
    if (verb === 'bootstrap' && a1 === domain && a2 && argv.length === 3) { done(bootstrap(a2)); return; }
    if (verb === 'bootout' && target(a1) && argv.length === 2) {
      const job = jobs.get(target(a1));
      rec.label = target(a1);
      rec.jobGroup = job && job.running && !job.abandon ? job.running.pid : null;
      bootout(target(a1), done);
      return;
    }
    if (verb === 'print' && target(a1) && argv.length === 2) {
      const job = jobs.get(target(a1));
      rec.label = target(a1);
      done(job && job.loaded ? { code: 0, stdout: `${a1} = {\n\tstate = ${job.running ? 'running' : 'not running'}\n}\n` }
        : { code: 113, stderr: `Could not find service "${target(a1)}" in domain for user gui: ${how.uid}\n` });
      return;
    }
    rec.refused = true;
    done({ code: 64, stderr: `launchctl: this world's launchd does not model "${argv.join(' ')}"\n` });
  }

  const server = net.createServer((socket) => {
    let text = '';
    socket.setEncoding('utf8');
    socket.on('error', () => {});
    socket.on('data', (d) => {
      text += d;
      if (!text.includes('\n')) return;
      let msg = null;
      try { msg = JSON.parse(text.slice(0, text.indexOf('\n'))); } catch (e) { msg = {}; }
      const reply = (r) => { try { socket.end(JSON.stringify(r)); } catch (e) { /* the caller is gone */ } };
      if (msg.control === 'login') reply(login());
      else if (msg.control === 'logout') logout(reply);
      else if (msg.control === 'fire') reply(fire(msg.label));
      else if (msg.control === 'state') reply(snapshot());
      else if (msg.control === 'stop') { reply({ code: 0 }); setImmediate(endAll); }
      else launchctl(msg, reply);
    });
  });

  function endAll() {
    for (const job of jobs.values()) {
      job.loaded = false;
      if (job.running) signal(-job.running.pid, 'SIGKILL');
    }
    process.exit(0);
  }
  process.on('SIGTERM', endAll);

  if (how.intervals) {
    setInterval(() => {
      for (const job of jobs.values()) {
        const every = Number(job.plist.StartInterval);
        if (!job.loaded || job.running || !every) continue;
        job.lastInterval = job.lastInterval || Date.now();
        if (Date.now() - job.lastInterval >= every * 1000) { job.lastInterval = Date.now(); run(job, 'StartInterval'); }
      }
    }, 250);
  }

  server.listen(0, '127.0.0.1', () => {
    fs.writeFileSync(path.join(state, 'port.new'), String(server.address().port));
    fs.renameSync(path.join(state, 'port.new'), path.join(state, 'port'));
  });
}

if (require.main === module) {
  if (process.argv[2] === '--client') client(process.argv[3], process.argv[4]);
  else daemon(process.argv[2]);
}
