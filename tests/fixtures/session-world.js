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
//                            socketInode, socketOwner, token, pid,
//                            pidStartedAt, source, recordedAt}; pid is the
//                            process listening on the socket, the hook's
//                            parent, and pidStartedAt its start in UTC
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
//                              signed in, 1 when not (as Claude Code does);
//                              like Claude Code on a Mac, which finds its
//                              sign-in only when its environment names the
//                              account, it answers not signed in when USER
//                              is missing or empty, whatever else the
//                              environment holds (LOGNAME alone does not
//                              stand in for it)
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
// (/bin/sh -c, the event on stdin; the shell runs the one command in its own
// place, so the hook's parent is the session process, the socket's listener),
// with CLAUDE_CODE_MESSAGING_SOCKET and CLAUDE_CODE_MESSAGING_TOKEN set; it keeps its session id across a restart in
// the same world (source "resume"), as a real server brings its session back.
// A line posted on its socket is taken as Claude Code takes it: every line read
// until the sender closes its side, then the connection closed; a
// {"type":"user"} line's content goes to the settings' UserPromptSubmit hooks
// as the prompt.
//
// Behaviour, changeable between calls with set():
//   { signedIn: true }        auth status answers signed in (the default),
//                             when USER is set
//   { signedIn: false }       auth status answers not signed in, exit 1
//   { loginExpiresAt: <ISO> } auth status also prints when the sign-in ends,
//                             as Claude Code 2.1.319 was measured to
//   claude auth login         answers "Login successful.", exit 0
//
// Two measured profiles of the Remote Control server (behaviour.profile):
//
//   '2.1.319' (the default; every case written before the second profile
//   runs under it, its answers unchanged): the session at the server's start,
//   as above. Claude Code 2.1.322 was measured to behave the same way
//   (Connecting, Connected and a claude.ai/code/session_ address at start,
//   the session's record about 5 seconds after the start, and at the stop
//   "Shutting down 1 active session(s)").
//
//   '2.1.332': measured on a fresh login on 27 Nov 2026. At start it prints
//   "·|· Connecting · <folder>", then "·✔︎· Ready · <folder>",
//   "    Single session · exits when complete", "Code anywhere with the Claude
//   mobile app or https://claude.ai/code?environment=<environment id>", "Or
//   ask Claude to work in this folder from your projects on claude.ai" and
//   "space to show QR code"; about 1 second after its start it writes the
//   bridge pointer, <CLAUDE_CONFIG_DIR>/projects/<the folder's name>/
//   bridge-pointer.json, {"sessionId": "", "environmentId", "source":
//   "standalone", "pid": <its own pid>, "procStart", "dir": <its folder>},
//   and never fills sessionId, even once a session exists. It makes no
//   session, no transcript and no record with no client. A session is made
//   only once a client has opened the server's own environment address and
//   sends a first message there (here: a line in the world's client record,
//   claude-client.jsonl, which the world's open writes for a claude.ai
//   address and which clientConnects adds); in that second the server starts
//   the session process, prints "·✔︎· Connected · <folder>" and "Continue
//   coding in the Claude mobile app or https://claude.ai/code/session_<id>",
//   the session's SessionStart hooks run with source startup, and then the
//   status word is replaced by the session's title ("·✔︎· <title> ·
//   <folder>"). At a stop with no session it prints "Environment preserved.
//   Restart `claude remote-control` to reconnect existing sessions."; that it
//   prints the same at a stop with a live session is a HYPOTHESIS, not
//   measured. The last word of each status line was measured as the owner
//   folder's name, Squire; the world puts its own folder's name there. Every
//   environment id, session id and address here is invented (FAKE in each).
//
//   Also measured on 2.1.332, later the same day: a server stopped and
//   started again with no client makes no session (it prints Ready and the
//   environment address again; no session process, the pointer's sessionId
//   empty, no record) until a client sends a message again; and a client
//   leaving prints nothing in the server's output and leaves the session
//   process running until the server stops. So this profile's server, started
//   again, makes no session until a new client message, and
//   clientLeaves(world) changes nothing the server prints.
//
//   Not measured, a switch, a HYPOTHESIS until measured on a real Mac:
//   { disconnectAfterMs: n }    n ms after the session is made (2.1.332) or
//                               after the start (2.1.319), the server prints
//                               a disconnection line (a network drop, not a
//                               client leaving) and never recovers. The
//                               words are 2.1.319's as the design record
//                               names them (Reconnecting, with "retrying
//                               in"); that 2.1.332 prints the same words on
//                               a network drop is a HYPOTHESIS; the line's
//                               layout is the world's own, not measured
//   The title is the first message's text with its first letter in capitals
//   (one sample: "hello" became "Hello"); the rule is a HYPOTHESIS.
//
//   Switches of the world's own, for cases that need a server that is not
//   live: { pointer: false } (2.1.332: no bridge pointer is written), {
//   neverConnects: true } (2.1.319: "Connecting" alone, no session), {
//   lastLine: <text> } (the server prints that line after its start lines),
//   { sessionAtStart: true } (2.1.332: the session made about 1 second after
//   the start, as if a client had sent "hello"). { version: <v> } makes
//   claude --version answer "<v> (Claude Code)"; the 2.1.332 profile answers
//   2.1.332; with neither, --version is not a command this fake knows.
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
// 'new' (a session a client's first message made): a new id, source startup;
// otherwise the id kept in the world comes back with source resume.
const made = process.argv[3] || 'keep';
const firstMessage = process.argv[4] || null;
let sessionId; let source;
try {
  if (made === 'new') throw new Error('a new session');
  sessionId = fs.readFileSync(${JSON.stringify(sessionIdFile)}, 'utf8').trim(); source = 'resume';
}
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
  // The client's first message, which made this session, is its first prompt.
  if (firstMessage) {
    const promptRuns = runHooks('UserPromptSubmit', { ...base, hook_event_name: 'UserPromptSubmit', prompt: firstMessage }, hookEnv);
    append(${JSON.stringify(promptsFile)}, { pid: process.pid, sessionId, socket: socketPath, lines: [], content: firstMessage,
      fromClient: true, hookRuns: promptRuns });
  }
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
  // With no USER, Claude Code cannot find its own sign-in.
  const signedIn = how.signedIn !== false && Boolean(process.env.USER);
  const out = { loggedIn: signedIn, authMethod: signedIn ? 'claude.ai' : 'none' };
  if (signedIn && how.loginExpiresAt) out.loginExpiresAt = how.loginExpiresAt;
  process.stdout.write(JSON.stringify(out, null, 2) + '\\n');
  process.exit(signedIn ? 0 : 1);
}
if (argv[0] === 'auth' && argv[1] === 'login') {
  process.stdout.write('Login successful.\\n');
  process.exit(0);
}
const version = how.version || (how.profile === '2.1.332' ? '2.1.332' : null);
if ((argv[0] === '--version' || argv[0] === '-v') && version) {
  process.stdout.write(version + ' (Claude Code)\\n');
  process.exit(0);
}
const folder = path.basename(process.cwd());
const say = (text) => { try { fs.writeSync(1, text); } catch (e) { /* no output */ } };
const disconnectLine = () => say('·|· Reconnecting · retrying in 5s · ' + folder + '\\n');
const startSession = (mode, message) => spawn(process.execPath,
  [${JSON.stringify(sessionScript)}, String(process.pid), mode, ...(message ? [message] : [])], { stdio: 'ignore' });
if (argv[0] === 'remote-control' && how.profile === '2.1.332') {
  // The 2.1.332 profile (see above): no session until a client's first
  // message at the server's own environment address.
  const started = Date.now();
  let envId;
  try { envId = fs.readFileSync(${JSON.stringify(path.join(world.root, 'fake-environment-id'))}, 'utf8').trim(); }
  catch (e) {
    envId = 'env_FAKE' + Array.from({ length: 12 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.floor(Math.random() * 24)]).join('');
    fs.writeFileSync(${JSON.stringify(path.join(world.root, 'fake-environment-id'))}, envId);
  }
  say('·|· Connecting · ' + folder + '\\n');
  setTimeout(() => {
    say('·✔︎· Ready · ' + folder + '\\n    Single session · exits when complete\\n' +
      'Code anywhere with the Claude mobile app or https://claude.ai/code?environment=' + envId + '\\n' +
      'Or ask Claude to work in this folder from your projects on claude.ai\\nspace to show QR code\\n');
    if (how.lastLine) say(how.lastLine + '\\n');
  }, 200);
  if (how.pointer !== false) {
    setTimeout(() => {
      // The folder's name as Claude Code names it: measured for one path
      // (each "/" as "-"); every other character not a letter or digit as
      // "-" too is a HYPOTHESIS.
      const dir = path.join(process.env.CLAUDE_CONFIG_DIR || '/nonexistent', 'projects', process.cwd().replace(/[^A-Za-z0-9]/g, '-'));
      // Behind a world's launcher (the release and installer worlds), the
      // pid the launcher hands on: the process Squire started, as Claude Code
      // is one process on a real Mac.
      const self = Number(process.env.FAKE_CLAUDE_CODE_PID) || process.pid;
      const ps = spawnSync('/bin/ps', ['-o', 'lstart=', '-p', String(self)], { encoding: 'utf8', env: { LC_ALL: 'C', PATH: '/usr/bin:/bin' } });
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'bridge-pointer.json'), JSON.stringify({ sessionId: '', environmentId: envId,
          source: 'standalone', pid: self, procStart: (ps.stdout || '').trim(), dir: process.cwd() }));
      } catch (e) { /* the config folder cannot be written */ }
    }, 1000);
  }
  let session = null;
  const make = (mode, message) => {
    if (session) return;
    session = startSession(mode, message);
    const sid = 'session_FAKE' + String(process.pid).padStart(8, '0');
    say('·✔︎· Connected · ' + folder + '\\nContinue coding in the Claude mobile app or https://claude.ai/code/' + sid + '\\n');
    const title = message ? message.trim().replace(/^./, (c) => c.toUpperCase()) : folder;
    setTimeout(() => say('·✔︎· ' + title + ' · ' + folder + '\\n'), 300);
    if (how.disconnectAfterMs) setTimeout(disconnectLine, how.disconnectAfterMs);
  };
  if (how.sessionAtStart) setTimeout(() => make('new', 'hello'), 1000);
  // The client: an open of this environment's own address, then a first
  // message sent after this server started.
  const clientFile = ${JSON.stringify(path.join(world.root, 'claude-client.jsonl'))};
  setInterval(() => {
    if (session) return;
    let lines = [];
    try { lines = fs.readFileSync(clientFile, 'utf8').split('\\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (e) { lines = []; }
    const opened = lines.some((l) => l.type === 'open' && typeof l.url === 'string' && l.url.includes('environment=' + envId));
    const now = Date.now();
    const message = lines.find((l) => l.type === 'message' && l.at >= started && l.at <= now);
    if (opened && message) make('new', message.text);
  }, 200);
  // The session ends when its server stops (measured).
  const stop = () => {
    say('Environment preserved. Restart \`claude remote-control\` to reconnect existing sessions.\\n');
    if (session) { try { session.kill('SIGTERM'); } catch (e) { /* gone */ } }
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
} else if (argv[0] === 'remote-control') {
  if (how.neverConnects) {
    say('·|· Connecting · ' + folder + '\\n');
    if (how.lastLine) say(how.lastLine + '\\n');
  } else {
    const child = startSession('keep', null);
    process.stdout.write('Session started: "Session cse_fake" (cse_fake)\\nConnected · ' + folder + '\\n');
    if (how.disconnectAfterMs) setTimeout(disconnectLine, how.disconnectAfterMs);
  }
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

// ---------------------------------------- the 2.1.332 profile's client

// The client record the 2.1.332 profile's server reads: { type: 'open', url }
// when a browser or the phone opens an address (the world's open writes one
// for a claude.ai address), { type: 'message', text } when the Squire owner
// sends a message there; each with the time it happens (at).
const clientFile = (world) => path.join(world.root, 'claude-client.jsonl');
const appendClient = (world, rec) => fs.appendFileSync(clientFile(world), JSON.stringify({ at: Date.now(), ...rec }) + '\n');
// The environment id the 2.1.332 profile's server printed (null before its
// first start).
const environmentOf = (world) => {
  try { return fs.readFileSync(path.join(world.root, 'fake-environment-id'), 'utf8').trim(); } catch (e) { return null; }
};
const environmentAddress = (world) => (environmentOf(world) ? `https://claude.ai/code?environment=${environmentOf(world)}` : null);
// A client opens an address (the server's own environment address unless
// another is given) and, with text, sends a first message there afterMs
// later (the page's sign-in check takes the owner a moment).
function clientConnects(world, { url = environmentAddress(world), text = 'hello', afterMs = 500 } = {}) {
  appendClient(world, { type: 'open', url });
  if (text !== null) appendClient(world, { type: 'message', text, at: Date.now() + afterMs });
}
const clientRecord = (world) => readJsonLines(clientFile(world));
// The client leaves (the page or the app closed): measured on 2.1.332, the
// server prints nothing and the session stays until the server stops.
const clientLeaves = (world) => appendClient(world, { type: 'leave' });
// The bridge pointers under the Squire home's Claude Code config folder:
// { file, mtimeMs, ...pointer }.
function bridgePointers(world) {
  const projects = path.join(configDir(world), 'projects');
  if (!fs.existsSync(projects)) return [];
  const out = [];
  for (const name of fs.readdirSync(projects)) {
    const file = path.join(projects, name, 'bridge-pointer.json');
    try { out.push({ file, mtimeMs: fs.statSync(file).mtimeMs, ...JSON.parse(fs.readFileSync(file, 'utf8')) }); } catch (e) { /* none */ }
  }
  return out;
}
const sessionLog = (world) => {
  try { return fs.readFileSync(path.join(world.home, 'logs', 'session.log'), 'utf8'); } catch (e) { return ''; }
};
// The two measured profiles, the second first: a case run under both meets
// the lazy session before the eager one.
const PROFILES = ['2.1.332', '2.1.319'];

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
  for (const f of fs.readdirSync(world.root)) {
    if (f.startsWith(`inbox-${name}.jsonl.cmd.`)) fs.rmSync(path.join(world.root, f), { force: true });
  }
  const child = spawn(w.PYTHON, ['-B', FAKE_INBOX, socket, record, mode], { stdio: 'ignore' });
  const ready = await waitFor(() => fs.existsSync(`${record}.ready`), 10000, 20);
  if (!ready) throw new Error(`the fake inbox ${name} (${mode}) did not start`);
  let commandsSent = 0;
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
    // The connections that came in on one socket path.
    connectionsOn(socketPath) { return inbox.connections().filter((c) => c.socket === socketPath); },
    // Asks the inbox process to run a command as its own child (and first,
    // with bind, to listen on a new socket path instead of its own); returns
    // { status, stdout, stderr, error } once the command has run.
    async run({ argv, input = '', env, cwd, bind = null, timeoutSeconds = 60 }) {
      commandsSent += 1;
      const n = commandsSent;
      const file = `${record}.cmd.${n}.json`;
      fs.writeFileSync(`${file}.tmp`, JSON.stringify({ bind, run: { argv, input, env, cwd, timeout: timeoutSeconds } }));
      fs.renameSync(`${file}.tmp`, file);
      const resultFile = `${record}.cmd.${n}.result.json`;
      const done = await waitFor(() => fs.existsSync(resultFile), (timeoutSeconds + 10) * 1000, 20);
      if (!done) return { status: null, signal: null, stdout: '', stderr: '', error: `the fake inbox ${name} did not run the command` };
      if (bind) inbox.socket = bind;
      const r = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
      return { status: r.status, signal: null, stdout: r.stdout || '', stderr: r.stderr || '', error: r.status === null ? 'timed out' : '' };
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

// A process's start, in the design record's form: /bin/ps -o lstart= read
// with LC_ALL=C and TZ=UTC0, written as ISO 8601 UTC to the second
// (2026-11-08T20:30:07Z), so it reads the same whatever the locale or time
// zone. null when no process has that id.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function startTimeOf(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const r = spawnSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { LC_ALL: 'C', TZ: 'UTC0', PATH: '/usr/bin:/bin' } });
  const parts = (r.stdout || '').trim().split(/\s+/);
  if (r.status !== 0 || parts.length !== 5) return null;
  const [, mon, day, hms, year] = parts;
  const [h, m, sec] = hms.split(':').map(Number);
  const at = Date.UTC(Number(year), MONTHS.indexOf(mon), Number(day), h, m, sec);
  return Number.isNaN(at) ? null : new Date(at).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// Writes a session record into the Squire home in the form the design record
// names, as the SessionStart hook would have written it. socketInode and
// socketOwner default to the inode and owner of the file at socket, when
// there is one (the owner otherwise to this user); pidStartedAt to the start
// of the process pid names, so a seeded record of a live process passes the
// identity check.
function seedSessionRecord(world, { sessionId, socket, token = crypto.randomBytes(16).toString('hex'), pid,
  socketInode, socketOwner, pidStartedAt, source = 'startup', ...extra }) {
  let inode = socketInode;
  let owner = socketOwner;
  let st = null;
  try { st = fs.statSync(socket); } catch (e) { st = null; }
  if (inode === undefined) inode = st ? st.ino : null;
  if (owner === undefined) owner = st ? st.uid : process.getuid();
  const started = pidStartedAt === undefined ? startTimeOf(pid) : pidStartedAt;
  const record = { sessionId, socket, socketInode: inode, socketOwner: owner, token, pid, pidStartedAt: started, source,
    recordedAt: Date.now() / 1000, ...extra };
  fs.mkdirSync(sessionsDir(world), { recursive: true });
  fs.writeFileSync(path.join(sessionsDir(world), `${sessionId}.json`), JSON.stringify(record, null, 2) + '\n');
  return record;
}

function sessionStartEvent(world, sessionId, source) {
  return { session_id: sessionId, transcript_path: world.transcript, cwd: world.owner, hook_event_name: 'SessionStart', source };
}

// Runs the real SessionStart hook from this test's process with no messaging
// socket in its environment: for the cases that need the floor's job records
// and no session record (a hook given no socket writes none).
function recordSessionByHook(world, { sessionId, source = 'startup', coreDir = world.core, env = {} }) {
  return w.runPython(world, path.join(coreDir, 'hooks', 'session-start.py'), [], {
    input: JSON.stringify(sessionStartEvent(world, sessionId, source)), cwd: world.owner,
    env: { CLAUDE_PROJECT_DIR: world.owner, ...env },
  });
}

// Runs the real SessionStart hook as Claude Code runs it for a session: from
// the session's process, the one listening on the messaging socket (here a
// fake inbox), as that process's child, with the socket and token in its
// environment. With bind, the inbox first listens on a new socket path, as
// one session process does after /clear (a new id, socket and token); with
// socket, the hook is given that path instead of the inbox's own.
async function recordSessionFromInbox(world, inbox, { sessionId, source = 'startup', token = crypto.randomBytes(16).toString('hex'),
  bind = null, socket: given = null, coreDir = world.core, env = {} }) {
  const socket = given || bind || inbox.socket;
  const r = await inbox.run({
    argv: [w.PYTHON, '-B', path.join(coreDir, 'hooks', 'session-start.py')],
    input: JSON.stringify(sessionStartEvent(world, sessionId, source)),
    cwd: world.owner,
    env: w.productEnv(world, { CLAUDE_CODE_MESSAGING_SOCKET: socket, CLAUDE_CODE_MESSAGING_TOKEN: token, CLAUDE_PROJECT_DIR: world.owner, ...env }),
    bind,
  });
  return { ...r, token, socket };
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
  sleep,
  layDownCore,
  installFakeClaudeCode,
  killFakes,
  startRunner,
  health,
  filesWithContent,
  startInbox,
  startTimeOf,
  seedSessionRecord,
  recordSessionByHook,
  recordSessionFromInbox,
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
  PROFILES,
  clientFile,
  clientConnects,
  clientRecord,
  clientLeaves,
  environmentOf,
  environmentAddress,
  bridgePointers,
  sessionLog,
  readJsonLines,
};
