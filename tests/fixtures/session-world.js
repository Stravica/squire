'use strict';

// Round 2's additions to the test world: the session runner, the SessionStart
// record, the wake-up router and the Claude Code they work with. Nothing here
// imports or copies product logic. The product runs as processes, through
// /usr/bin/python3, the way its launchd agents and Claude Code run it; what
// stands in for the outside is a fake Claude Code at the place it installs
// itself and a fake messaging inbox, both owned by the world.
//
// Where the product keeps its round 2 state, under the Squire home (H), as the
// design record names it:
//   H/claude-config/         Claude Code's config folder for Squire's session:
//                            settings.json is core's settings; .claude.json
//                            answers "trust this folder" and "Enable Remote
//                            Control" in advance
//   H/sessions/<id>.json     one record per session, written by the
//                            SessionStart hook: {sessionId, socket,
//                            socketInode, token, pid, source, recordedAt}
//   H/wake-ups/<id>.json     one state per wake-up: {id, text, session,
//                            attempts: [{at, outcome, reason}], state}
//   H/logs/wake-ups.log      one line per wake-up outcome, with its reason
//
// A world never reaches a real Claude Code, a real session or a real launchd
// domain: HOME is the world's, so the runner finds the fake at
// ~/.local/bin/claude under it, and the sockets are the world's own.

const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const w = require('./squire-world.js');

const FAKE_INBOX = path.join(__dirname, 'fake-inbox.py');

const installedCore = (world) => path.join(world.home, 'core');
const configDir = (world) => path.join(world.home, 'claude-config');
const sessionsDir = (world) => path.join(world.home, 'sessions');
const wakeUpsDir = (world) => path.join(world.home, 'wake-ups');
const wakeUpLogFile = (world) => path.join(world.home, 'logs', 'wake-ups.log');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Polls until fn returns something truthy, or the time is up (then null).
async function waitFor(fn, timeoutMs, intervalMs = 100) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() >= end) return null;
    await sleep(intervalMs);
  }
}

function readJsonLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// Lays core down from this repository (or the release named) into the world's
// Squire home, as the installer would, and returns the installed core.
function layDownCore(world, release = w.CORE) {
  const r = w.layDown(world, release);
  if (r.status !== 0) throw new Error(`laying core down must succeed before a session test; got ${w.describe(r)}`);
  return fs.realpathSync(installedCore(world));
}

// ------------------------------------------------- a fake Claude Code

// The names a session's environment may hold when the runner builds it from
// nothing: what the design record lists, the locale, and what macOS itself
// adds to a process.
const ENVIRONMENT_ALLOWED = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SQUIRE_HOME', 'CLAUDE_CONFIG_DIR', 'LANG', 'LC_ALL',
  'LC_CTYPE', 'TMPDIR', '__CF_USER_TEXT_ENCODING'];
// The names that must never reach a session: credentials that bill beyond the
// plan, and Claude Code's experimental agent teams.
const ENVIRONMENT_FORBIDDEN = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS'];

// A stand-in for Claude Code at the place its installer lays it,
// ~/.local/bin/claude under the world's home (or the folder given: a decoy
// first on PATH, say). It answers the two commands the runner uses:
//
//   claude auth status         prints {"loggedIn": ...} and exits 0 when
//                              signed in, 1 when not (as Claude Code does)
//   claude remote-control ...  a server that stays up until stopped, with one
//                              session process in the server's process group,
//                              as Claude Code's single-session server runs; it
//                              prints "Session started: ..." and "Connected ·
//                              <folder>", and stopping the server alone leaves
//                              its session process running, as killing Claude
//                              Code's server did
//
// The session process does what Claude Code's does for Squire's floor: it
// binds a messaging socket in the world, reads $CLAUDE_CONFIG_DIR/settings.json
// and runs every SessionStart hook in it as Claude Code runs a command hook
// (/bin/sh -c, the event on stdin), with CLAUDE_CODE_MESSAGING_SOCKET and
// CLAUDE_CODE_MESSAGING_TOKEN set; it keeps its session id across a restart in
// the same world (source "resume"), as a real server brings its session back.
// A line posted on its socket is taken as Claude Code takes it: every line read
// until the sender closes its side, then the connection closed; a
// {"type":"user"} line's content goes to the settings' UserPromptSubmit hooks
// as the prompt.
//
// Behaviour, changeable between calls with set():
//   { signedIn: true }        auth status answers signed in (the default)
//   { signedIn: false }       auth status answers not signed in, exit 1
//
// Records, in the world:
//   claude-code-calls.jsonl     one line per invocation: argv, cwd, pid, its
//                               process group, the environment's names and
//                               values (values only for the allowed names and
//                               the forbidden ones), and the names in
//                               <cwd>/.claude when the call started
//   claude-code-sessions.jsonl  one line per session process: pid, server pid,
//                               session id, source, socket, the hook runs
//   claude-code-prompts.jsonl   one line per user line taken from the socket:
//                               the content and the UserPromptSubmit hook runs
function installFakeClaudeCode(world, behaviour = {}, { dir = path.join(world.userHome, '.local', 'bin'), mode = 0o755 } = {}) {
  const configFile = path.join(world.root, 'fake-claude-code.json');
  const callsFile = path.join(world.root, 'claude-code-calls.jsonl');
  const sessionsFile = path.join(world.root, 'claude-code-sessions.jsonl');
  const promptsFile = path.join(world.root, 'claude-code-prompts.jsonl');
  const sessionIdFile = path.join(world.root, 'fake-session-id');
  const socketDir = path.join(world.root, 's');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(socketDir, { recursive: true });
  const sessionScript = path.join(world.root, 'fake-claude-code-session.js');
  const common = `
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const append = (file, rec) => fs.appendFileSync(file, JSON.stringify({ at: Date.now(), ...rec }) + '\\n');
const pgidOf = (pid) => Number(spawnSync('/bin/ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim()) || null;
const settingsOf = () => {
  try { return JSON.parse(fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR || '/nonexistent', 'settings.json'), 'utf8')); }
  catch (e) { return {}; }
};
// Every command hook for one event, run as Claude Code runs it.
function runHooks(eventName, event, env) {
  const groups = ((settingsOf().hooks || {})[eventName]) || [];
  const runs = [];
  for (const group of groups) {
    for (const h of group.hooks || []) {
      if (h.type !== 'command') continue;
      const options = { input: JSON.stringify(event), cwd: event.cwd, env, encoding: 'utf8',
        timeout: (typeof h.timeout === 'number' ? h.timeout : 60) * 1000, killSignal: 'SIGKILL' };
      const r = Array.isArray(h.args)
        ? spawnSync(h.command, h.args.map((a) => a.replace(/\\$\\{([A-Za-z_][A-Za-z0-9_]*)\\}/g, (_, n) => env[n] || '')), options)
        : spawnSync('/bin/sh', ['-c', h.command], options);
      runs.push({ command: h.command, status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' });
    }
  }
  return runs;
}
`;
  fs.writeFileSync(sessionScript, `'use strict';
${common}
const net = require('net');
const crypto = require('crypto');
const serverPid = Number(process.argv[2]);
let sessionId; let source;
try { sessionId = fs.readFileSync(${JSON.stringify(sessionIdFile)}, 'utf8').trim(); source = 'resume'; }
catch (e) { sessionId = crypto.randomUUID(); source = 'startup'; fs.writeFileSync(${JSON.stringify(sessionIdFile)}, sessionId); }
const socketPath = path.join(${JSON.stringify(socketDir)}, process.pid + '.sock');
const token = crypto.randomBytes(16).toString('hex');
const hookEnv = { ...process.env, CLAUDE_CODE_MESSAGING_SOCKET: socketPath, CLAUDE_CODE_MESSAGING_TOKEN: token,
  CLAUDE_PROJECT_DIR: process.cwd() };
const base = { session_id: sessionId, transcript_path: path.join(${JSON.stringify(world.root)}, 'transcript.jsonl'),
  cwd: process.cwd(), permission_mode: 'bypassPermissions' };
const server = net.createServer((conn) => {
  let data = '';
  conn.setEncoding('utf8');
  conn.on('data', (d) => { data += d; });
  conn.on('error', () => {});
  conn.on('end', () => {
    conn.end();
    const lines = data.split('\\n').filter(Boolean);
    for (const line of lines) {
      let msg = null;
      try { msg = JSON.parse(line); } catch (e) { msg = null; }
      if (msg && msg.type === 'user' && msg.message && typeof msg.message.content === 'string') {
        const runs = runHooks('UserPromptSubmit', { ...base, hook_event_name: 'UserPromptSubmit', prompt: msg.message.content }, hookEnv);
        append(${JSON.stringify(promptsFile)}, { pid: process.pid, sessionId, socket: socketPath, lines, content: msg.message.content, hookRuns: runs });
      }
    }
  });
});
server.listen(socketPath, () => {
  const runs = runHooks('SessionStart', { ...base, hook_event_name: 'SessionStart', source }, hookEnv);
  append(${JSON.stringify(sessionsFile)}, { pid: process.pid, serverPid, pgid: pgidOf(process.pid), sessionId, source, socket: socketPath, hookRuns: runs });
});
const stop = () => { try { server.close(); fs.unlinkSync(socketPath); } catch (e) {} process.exit(0); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
setInterval(() => {}, 1000);
`);
  const script = `#!${process.execPath}
'use strict';
${common}
const { spawn } = require('child_process');
const how = JSON.parse(fs.readFileSync(${JSON.stringify(configFile)}, 'utf8'));
const shown = ${JSON.stringify([...ENVIRONMENT_ALLOWED, ...ENVIRONMENT_FORBIDDEN])};
const env = {};
for (const name of shown) if (name in process.env) env[name] = process.env[name];
let ownerClaude = null;
try { ownerClaude = fs.readdirSync(path.join(process.cwd(), '.claude')).sort(); } catch (e) { ownerClaude = null; }
const argv = process.argv.slice(2);
append(${JSON.stringify(callsFile)}, { argv, cwd: process.cwd(), pid: process.pid, pgid: pgidOf(process.pid),
  envNames: Object.keys(process.env).sort(), env, ownerClaude });
if (argv[0] === 'auth' && argv[1] === 'status') {
  const signedIn = how.signedIn !== false;
  process.stdout.write(JSON.stringify({ loggedIn: signedIn, authMethod: signedIn ? 'claude.ai' : 'none' }, null, 2) + '\\n');
  process.exit(signedIn ? 0 : 1);
}
if (argv[0] === 'remote-control') {
  const child = spawn(process.execPath, [${JSON.stringify(sessionScript)}, String(process.pid)], { stdio: 'ignore' });
  process.stdout.write('Session started: "Session cse_fake" (cse_fake)\\nConnected · ' + path.basename(process.cwd()) + '\\n');
  // Only the server stops: its session process stays in the process group.
  const stop = () => process.exit(0);
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  setInterval(() => {}, 1000);
} else {
  process.stderr.write('fake Claude Code: no such command\\n');
  process.exit(1);
}
`;
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, script);
  fs.chmodSync(bin, mode);
  const fake = {
    bin,
    dir,
    set(next) { fs.writeFileSync(configFile, JSON.stringify(next)); },
    calls: () => readJsonLines(callsFile),
    serverCalls: () => readJsonLines(callsFile).filter((c) => c.argv[0] === 'remote-control'),
    authCalls: () => readJsonLines(callsFile).filter((c) => c.argv[0] === 'auth'),
    sessions: () => readJsonLines(sessionsFile),
    prompts: () => readJsonLines(promptsFile),
  };
  fake.set(behaviour);
  return fake;
}

// Every process a fake Claude Code started in this world, alive or not.
function fakeProcesses(world) {
  const pids = new Set();
  for (const c of readJsonLines(path.join(world.root, 'claude-code-calls.jsonl'))) pids.add(c.pid);
  for (const s of readJsonLines(path.join(world.root, 'claude-code-sessions.jsonl'))) pids.add(s.pid);
  return [...pids];
}

// Kills whatever a fake left running, so no test leaves a process behind.
function killFakes(world) {
  for (const pid of fakeProcesses(world)) {
    try { process.kill(pid, 'SIGKILL'); } catch (e) { /* gone */ }
  }
}

// ------------------------------------------------------------ the runner

// Runs the installed runner as its launchd agent would: /usr/bin/python3 -B
// <Squire home>/core/tools/runner.py, in a process group of its own, with the
// world's environment and anything extra the test sets around it.
function startRunner(world, { coreDir = installedCore(world), env = {} } = {}) {
  const out = path.join(world.root, 'runner.out');
  const fd = fs.openSync(out, 'a');
  const child = spawn(w.PYTHON, ['-B', path.join(coreDir, 'tools', 'runner.py')], {
    cwd: '/', env: w.productEnv(world, env), stdio: ['ignore', fd, fd], detached: true,
  });
  fs.closeSync(fd);
  let exit = null;
  child.on('exit', (status, signal) => { exit = { status, signal }; });
  return {
    child,
    pid: child.pid,
    exited: () => exit,
    output: () => (fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : ''),
    // Stops the runner as launchd does (SIGTERM), then makes sure nothing it
    // or a fake started is left.
    async stop() {
      if (!exit) {
        try { process.kill(child.pid, 'SIGTERM'); } catch (e) { /* gone */ }
        await waitFor(() => exit, 10000);
      }
      if (!exit) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { /* gone */ }
        await waitFor(() => exit, 5000);
      }
      killFakes(world);
    },
  };
}

// The installed health check's lines and exit code.
function health(world, { coreDir = installedCore(world) } = {}) {
  return w.runPython(world, path.join(coreDir, 'tools', 'health.py'), [], { cwd: world.root });
}

// The files under a folder holding exactly these bytes.
function filesWithContent(dir, bytes) {
  const found = [];
  const visit = (p) => {
    let st;
    try { st = fs.lstatSync(p); } catch (e) { return; }
    if (st.isDirectory()) for (const name of fs.readdirSync(p)) visit(path.join(p, name));
    else if (st.isFile() && st.size === bytes.length && fs.readFileSync(p).equals(bytes)) found.push(p);
  };
  visit(dir);
  return found;
}

// ------------------------------------------------- the messaging inbox

// A fake session inbox at <world>/s/<name>.sock (see fake-inbox.py for the
// modes). Its process stands in for the session's process: alive while the
// inbox runs, gone once stopped.
async function startInbox(world, name, mode = 'accept') {
  const dir = path.join(world.root, 's');
  fs.mkdirSync(dir, { recursive: true });
  const socket = path.join(dir, `${name}.sock`);
  const record = path.join(world.root, `inbox-${name}.jsonl`);
  for (const f of [record, `${record}.ready`]) fs.rmSync(f, { force: true });
  const child = spawn(w.PYTHON, ['-B', FAKE_INBOX, socket, record, mode], { stdio: 'ignore' });
  const ready = await waitFor(() => fs.existsSync(`${record}.ready`), 10000, 20);
  if (!ready) throw new Error(`the fake inbox ${name} (${mode}) did not start`);
  const inbox = {
    name,
    mode,
    socket,
    pid: child.pid,
    // One entry per connection, the last thing recorded for it.
    connections() {
      const byId = new Map();
      for (const e of readJsonLines(record)) byId.set(e.connection, e);
      return [...byId.values()];
    },
    lines() { return inbox.connections().flatMap((c) => c.lines); },
    // The {"type":"user"} lines it was given, parsed.
    userMessages() {
      return inbox.lines().map((l) => { try { return JSON.parse(l); } catch (e) { return null; } })
        .filter((m) => m && m.type === 'user');
    },
    stop() {
      try { child.kill('SIGKILL'); } catch (e) { /* gone */ }
      return waitFor(() => w.processGone(child.pid), 5000, 20);
    },
  };
  return inbox;
}

// ----------------------------------------------- session records

// Writes a session record into the Squire home in the form the design record
// names, as the SessionStart hook would have written it. socketInode defaults
// to the inode of the file at socket, when there is one.
function seedSessionRecord(world, { sessionId, socket, token = crypto.randomBytes(16).toString('hex'), pid,
  socketInode, source = 'startup', ...extra }) {
  let inode = socketInode;
  if (inode === undefined) {
    try { inode = fs.statSync(socket).ino; } catch (e) { inode = null; }
  }
  const record = { sessionId, socket, socketInode: inode, token, pid, source, recordedAt: Date.now() / 1000, ...extra };
  fs.mkdirSync(sessionsDir(world), { recursive: true });
  fs.writeFileSync(path.join(sessionsDir(world), `${sessionId}.json`), JSON.stringify(record, null, 2) + '\n');
  return record;
}

// Runs the real SessionStart hook for a session, as Claude Code would at the
// session's start, with the session's messaging socket and token in its
// environment. The hook's parent is this test's process, which stands in for
// the session's process.
function recordSessionByHook(world, { sessionId, source = 'startup', socket, token = crypto.randomBytes(16).toString('hex'),
  coreDir = world.core, env = {} }) {
  const event = {
    session_id: sessionId, transcript_path: world.transcript, cwd: world.owner,
    hook_event_name: 'SessionStart', source,
  };
  const r = w.runPython(world, path.join(coreDir, 'hooks', 'session-start.py'), [], {
    input: JSON.stringify(event), cwd: world.owner,
    env: { CLAUDE_CODE_MESSAGING_SOCKET: socket, CLAUDE_CODE_MESSAGING_TOKEN: token, CLAUDE_PROJECT_DIR: world.owner, ...env },
  });
  return { ...r, token };
}

function sessionRecords(world) {
  const dir = sessionsDir(world);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort()
    .map((n) => ({ file: path.join(dir, n), ...JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')) }));
}

// The id of a process that has exited.
function deadPid() {
  const r = spawnSync('/usr/bin/true');
  return r.pid;
}

// ------------------------------------------------------------ wake-ups

// Runs the installed (or given) router for one wake-up, as Squire fires one.
function fireWakeUp(world, text, { coreDir = world.core, env = {} } = {}) {
  return w.runPython(world, path.join(coreDir, 'tools', 'wake-up.py'), [text], { cwd: world.root, env, timeout: 60000 });
}

// Runs the router as the wake-up scheduler's agent does: the retries now due.
function runDueWakeUps(world, { coreDir = world.core, env = {} } = {}) {
  return w.runPython(world, path.join(coreDir, 'tools', 'wake-up.py'), ['--due'], { cwd: world.root, env, timeout: 60000 });
}

// Writes a wake-up's state into the Squire home, in the form the design record
// names: attempts are {at (seconds since 1970), outcome, reason}.
function seedWakeUp(world, state) {
  fs.mkdirSync(wakeUpsDir(world), { recursive: true });
  fs.writeFileSync(path.join(wakeUpsDir(world), `${state.id}.json`), JSON.stringify(state, null, 2) + '\n');
  return state;
}

function wakeUpStates(world) {
  const dir = wakeUpsDir(world);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort()
    .map((n) => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')));
}

function wakeUpLog(world) {
  const f = wakeUpLogFile(world);
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean) : [];
}

const nowSeconds = () => Date.now() / 1000;

// ------------------------------------------------------- launchd agents

// The launchd agents lay-down wrote under the world's home, parsed by the
// Mac's own plutil (read only): { file, plist }.
function launchAgents(world) {
  const dir = path.join(world.userHome, 'Library', 'LaunchAgents');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => n.endsWith('.plist')).sort().map((n) => {
    const file = path.join(dir, n);
    const r = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`plutil could not read ${n}: ${r.stderr}`);
    return { file, plist: JSON.parse(r.stdout) };
  });
}

// True when the launchd domain of whoever runs the tests holds a job with this
// label (launchctl list, read only).
function launchdHas(label) {
  return spawnSync('/bin/launchctl', ['list', label], { encoding: 'utf8' }).status === 0;
}

module.exports = {
  ENVIRONMENT_ALLOWED,
  ENVIRONMENT_FORBIDDEN,
  installedCore,
  configDir,
  sessionsDir,
  wakeUpsDir,
  wakeUpLogFile,
  waitFor,
  layDownCore,
  installFakeClaudeCode,
  killFakes,
  startRunner,
  health,
  filesWithContent,
  startInbox,
  seedSessionRecord,
  recordSessionByHook,
  sessionRecords,
  deadPid,
  fireWakeUp,
  runDueWakeUps,
  seedWakeUp,
  wakeUpStates,
  wakeUpLog,
  nowSeconds,
  launchAgents,
  launchdHas,
};
