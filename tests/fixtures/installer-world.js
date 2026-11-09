'use strict';

// Round 3's additions to the test world: Squire's set-up app, run at its own
// entry point as a process, on a Mac made of fakes. Nothing here imports or
// copies product logic. What stands in for the outside, each owned by the
// world and first on the PATH the app is opened with (the design record's
// line 3), is:
//
//   sw_vers, sysctl, id      the Mac's version, memory and the user's groups
//   xcode-select             Apple's command line tools: present or absent,
//                            and what --install does (installs, or keeps
//                            reporting that it is still installing)
//   curl                     the download of Claude Code's installer, which
//                            serves a fake installer (or fails, times out, is
//                            cut short, finds no network, or is slow)
//   osascript                set-up's own windows: each answered by its title
//                            from the test's answers, and recorded
//   open                     the browser: records what it was asked to open
//
// The fake installer lays a fake Claude Code where the real one installs
// itself (~/.local/bin/claude, a link into ~/.local/share/claude/versions/),
// with the other places the real installer makes under the home. That fake
// answers --version, auth login, auth status (with the plan the test sets),
// auth logout and remote-control (round 2's fake session, or an account
// refusal before any session).
//
// The answer source exists only in the test world. Squire ships no answer
// file and no switch for one.
//
// Layout under the world's root (w.makeWorld's, whose squire-home and owner
// folders set-up never sees):
//   user-home/               HOME for the app: a fresh user's home, with
//                            Library/Application Support, Library/Preferences,
//                            Desktop, Documents and Downloads
//   Applications/Squire.app  the app, assembled as the release assembles it:
//                            installer/Squire.app with core/ at
//                            Contents/Resources/core
//   mac-bin/                 the fakes above
//   mac.json                 how the fake Mac behaves (changeable with set)
//   claude-code.json         how the fake Claude Code behaves
//   mac-calls.jsonl          one line per call of any fake, in order
//   dialogs.jsonl            one line per window set-up showed
//   system/                  SQUIRE_SYSTEM_ROOT: the Mac's system places
//                            (managed settings) as the health check reads them
//
// Where set-up keeps things (the design record's line 2): the Squire home is
// ~/Library/Application Support/Squire (SQUIRE_HOME is not set for the app),
// its record set-up.json, Claude Code's config folder claude-config in it,
// and the owner's folder ~/Squire.

const { spawn, spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const w = require('./squire-world.js');
const sw = require('./session-world.js');

const APP_SOURCE = path.join(w.REPO, 'installer', 'Squire.app');
const APP_EXECUTABLE = path.join('Contents', 'MacOS', 'Squire');
const CLAUDE_VERSION = '2.1.319';
const INSTALL_URL = 'https://claude.ai/install.sh';
const MAC_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

// Set-up's windows, by title (the design record's line 4).
const TITLES = {
  plan: 'Squire: your Claude plan',
  setUp: 'Squire: set up',
  name: 'Squire: name your Squire',
  personality: "Squire: your Squire's personality",
  askPlan: 'Squire: your plan',
  phone: 'Squire: your phone',
  cannot: 'Squire: cannot set up',
  stopped: 'Squire: set-up stopped',
  paused: 'Squire: set-up paused',
  ready: 'Squire: ready',
};

// What the owner answers when a test says nothing else: Pro, Install, a name,
// a personality, Continue, Done; OK to every message.
const DEFAULT_ANSWERS = {
  [TITLES.plan]: 'Pro',
  [TITLES.setUp]: 'button returned:Install',
  [TITLES.name]: 'button returned:OK, text returned:Juniper',
  [TITLES.personality]: 'button returned:OK, text returned:Warm, brief and dry',
  [TITLES.askPlan]: 'button returned:Continue',
  [TITLES.phone]: 'button returned:Done',
  [TITLES.cannot]: 'button returned:OK',
  [TITLES.stopped]: 'button returned:OK',
  [TITLES.paused]: 'button returned:OK',
  [TITLES.ready]: 'button returned:OK',
};

// Set-up's step ids, in order (the design record's line 5).
const STEPS = ['yes', 'claudeCode', 'signIn', 'appleTools', 'naming', 'ownerFolder', 'layDown', 'backup', 'health',
  'phone', 'firstConversation'];

const DEFAULT_MAC = {
  macos: '15.1',
  memBytes: 17179869184,
  groups: 'staff everyone localaccounts _appserverusr admin _appserveradm',
  toolsPresent: true,
  toolsInstall: 'installs',
  download: 'ok',
  installer: 'ok',
};

const DEFAULT_CLAUDE = { signIn: 'ok', plan: 'pro', server: 'ok' };

const readJsonLines = (file) => (fs.existsSync(file)
  ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

// ------------------------------------------------------------------ fakes

// The code every fake shares: its behaviour file and its one call record.
function fakeHeader(iw, cmd) {
  return `#!${process.execPath}
'use strict';
const fs = require('fs');
const { spawnSync } = require('child_process');
const CMD = ${JSON.stringify(cmd)};
const mac = () => JSON.parse(fs.readFileSync(${JSON.stringify(iw.macFile)}, 'utf8'));
const argv = process.argv.slice(2);
const record = (extra = {}) => fs.appendFileSync(${JSON.stringify(iw.callsFile)}, JSON.stringify({ cmd: CMD, argv,
  at: Date.now(), pid: process.pid, ...extra }) + '\\n');
const passThrough = (real) => { const r = spawnSync(real, argv, { stdio: 'inherit' }); process.exit(r.status === null ? 1 : r.status); };
const hang = () => { setInterval(() => {}, 1000); };
`;
}

const FAKES = {
  sw_vers: `
record();
const m = mac();
if (argv.includes('-productVersion')) { process.stdout.write(m.macos + '\\n'); process.exit(0); }
if (argv.includes('-productName')) { process.stdout.write('macOS\\n'); process.exit(0); }
if (argv.includes('-buildVersion')) { process.stdout.write('24B83\\n'); process.exit(0); }
process.stdout.write('ProductName:\\t\\tmacOS\\nProductVersion:\\t\\t' + m.macos + '\\nBuildVersion:\\t\\t24B83\\n');
`,
  sysctl: `
if (!argv.includes('hw.memsize')) passThrough('/usr/sbin/sysctl');
record();
const bytes = String(mac().memBytes);
process.stdout.write((argv.includes('-n') ? bytes : 'hw.memsize: ' + bytes) + '\\n');
`,
  id: `
const flags = argv.filter((a) => a.startsWith('-')).join('');
if (!(flags.includes('G') && flags.includes('n')) || argv.some((a) => !a.startsWith('-'))) passThrough('/usr/bin/id');
record();
process.stdout.write(mac().groups + '\\n');
`,
  'xcode-select': `
const m = mac();
const marker = ${JSON.stringify('TOOLS_MARKER')};
const present = () => m.toolsPresent || fs.existsSync(marker);
record({ present: present() });
if (argv.includes('-p') || argv.includes('--print-path')) {
  if (present()) { process.stdout.write(${JSON.stringify('TOOLS_DIR')} + '\\n'); process.exit(0); }
  process.stderr.write('xcode-select: error: unable to get active developer directory, use \`sudo xcode-select --switch path/to/Xcode.app\` to set one (or see \`man xcode-select\`)\\n');
  process.exit(2);
}
if (argv.includes('--install')) {
  if (present()) { process.stderr.write('xcode-select: error: command line tools are already installed, use "Software Update" in System Settings to install updates\\n'); process.exit(1); }
  if (m.toolsInstall === 'installs') fs.writeFileSync(marker, String(Date.now()));
  process.stdout.write('xcode-select: note: install requested for command line developer tools\\n');
  process.exit(0);
}
process.stderr.write('xcode-select: error: unknown option\\n');
process.exit(1);
`,
  curl: `
const out = (() => { const i = argv.findIndex((a) => a === '-o' || a === '--output'); return i >= 0 ? argv[i + 1] : null; })();
const url = argv.find((a) => /^https?:\\/\\//.test(a)) || '';
const how = mac().download;
record({ url, out, how });
if (url !== ${JSON.stringify(INSTALL_URL)}) { process.stderr.write('curl: (6) Could not resolve host: ' + url + '\\n'); process.exit(6); }
const script = fs.readFileSync(${JSON.stringify('INSTALLER_SCRIPT')}, 'utf8');
const write = (text) => { if (out) fs.writeFileSync(out, text); else process.stdout.write(text); };
const fail = (code, line) => { process.stderr.write('curl: (' + code + ') ' + line + '\\n'); process.exit(code); };
if (how === 'fail') fail(22, 'The requested URL returned error: 503');
if (how === 'timeout') fail(28, 'Operation timed out after 600000 milliseconds with 0 bytes received');
if (how === 'offline') fail(6, 'Could not resolve host: claude.ai');
if (how === 'interrupted') { write(script.slice(0, Math.floor(script.length / 2))); fail(18, 'transfer closed with outstanding read data remaining'); }
if (how === 'slow') { setTimeout(() => { write(script); process.exit(0); }, 60000); hang(); }
else { write(script); process.exit(0); }
`,
  osascript: `
let stdin = '';
try { stdin = fs.readFileSync(0, 'utf8'); } catch (e) { stdin = ''; }
const text = argv.join(' ') + '\\n' + stdin;
const titles = ${JSON.stringify(Object.values(TITLES))}.sort((a, b) => b.length - a.length);
const title = titles.find((t) => text.includes(t)) || null;
fs.appendFileSync(${JSON.stringify('DIALOGS_FILE')}, JSON.stringify({ title, text, at: Date.now() }) + '\\n');
record({ title });
if (!title) { process.stderr.write('execution error: not one of set-up\\'s windows (-2700)\\n'); process.exit(1); }
const answers = { ...${JSON.stringify(DEFAULT_ANSWERS)}, ...(mac().answers || {}) };
const a = answers[title];
if (a && a.hang) hang();
else if (a && a.cancel) { process.stderr.write('execution error: User canceled. (-128)\\n'); process.exit(1); }
else { process.stdout.write(String(a) + '\\n'); process.exit(0); }
`,
  open: `
record();
process.exit(0);
`,
};

// The fake Claude Code the fake installer lays down.
function fakeClaudeCodeScript(iw, inner) {
  return `#!${process.execPath}
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const how = JSON.parse(fs.readFileSync(${JSON.stringify(iw.claudeFile)}, 'utf8'));
const argv = process.argv.slice(2);
const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME || '/nonexistent', '.claude');
const stateFile = path.join(configDir, '.claude.json');
fs.appendFileSync(${JSON.stringify(iw.callsFile)}, JSON.stringify({ cmd: 'claude', argv, at: Date.now(), pid: process.pid,
  configDir: process.env.CLAUDE_CONFIG_DIR || null, bin: process.argv[1] }) + '\\n');
const readState = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (e) { return {}; } };
const writeState = (s) => { fs.mkdirSync(configDir, { recursive: true }); fs.writeFileSync(stateFile, JSON.stringify(s, null, 2)); };
const hang = () => { setInterval(() => {}, 1000); };
if (argv[0] === '--version' || argv[0] === '-v') { process.stdout.write(${JSON.stringify(CLAUDE_VERSION + ' (Claude Code)')} + '\\n'); process.exit(0); }
if (argv[0] === 'auth' && argv[1] === 'login') {
  if (how.signIn === 'cancel') { process.stderr.write('Login cancelled.\\n'); process.exit(1); }
  if (how.signIn === 'timeout') { process.stderr.write('Login timed out waiting for the browser.\\n'); process.exit(1); }
  if (how.signIn === 'offline') { process.stderr.write('Unable to connect to Anthropic services (getaddrinfo ENOTFOUND claude.ai).\\n'); process.exit(1); }
  if (how.signIn === 'hang') hang();
  else {
    const s = readState();
    s.oauthAccount = { accountUuid: 'acct-test', emailAddress: 'owner@example.com', organizationUuid: 'org-test' };
    writeState(s);
    process.stdout.write('Login successful.\\n');
    process.exit(0);
  }
} else if (argv[0] === 'auth' && argv[1] === 'status') {
  const signedIn = Boolean(readState().oauthAccount);
  if (how.plan === 'unreadable' && signedIn) { process.stdout.write('Signed in.\\n'); process.exit(0); }
  const out = { loggedIn: signedIn, authMethod: signedIn ? 'claude.ai' : 'none', apiProvider: 'firstParty', configDirectory: configDir };
  if (signedIn && how.plan !== 'missing') out.subscriptionType = how.plan;
  process.stdout.write(JSON.stringify(out, null, 2) + '\\n');
  process.exit(signedIn ? 0 : 1);
} else if (argv[0] === 'auth' && argv[1] === 'logout') {
  const s = readState();
  delete s.oauthAccount;
  writeState(s);
  process.stdout.write('Successfully logged out from your Anthropic account.\\n');
  process.exit(0);
} else if (argv[0] === 'remote-control') {
  if (how.server === 'refuse') {
    process.stdout.write('Unable to determine your organization for Remote Control eligibility\\n');
    process.exit(1);
  }
  const child = spawn(process.execPath, [${JSON.stringify(inner)}, ...argv], { stdio: 'inherit' });
  const forward = (sig) => () => { try { child.kill(sig); } catch (e) {} };
  process.on('SIGTERM', forward('SIGTERM'));
  process.on('SIGINT', forward('SIGINT'));
  child.on('exit', (code) => process.exit(code === null ? 1 : code));
} else {
  process.stderr.write('fake Claude Code: no such command\\n');
  process.exit(1);
}
`;
}

// The fake installer curl serves: run with bash, it lays the fake Claude Code
// where the native installer lays it, and makes the other places it makes.
function fakeInstallerScript(iw) {
  return `#!/bin/bash
# A stand-in for Claude Code's native installer.
set -e
how=$(/usr/bin/plutil -extract installer raw -o - ${JSON.stringify(iw.macPlist)} 2>/dev/null || echo ok)
printf '{"cmd":"claude-installer","argv":[],"how":"%s","at":%s000}\\n' "$how" "$(/bin/date +%s)" >> ${JSON.stringify(iw.callsFile)}
if [ "$how" = "slow" ]; then /bin/sleep 60; fi
/bin/mkdir -p "$HOME/.local/bin" "$HOME/.local/share/claude/versions" "$HOME/.local/state/claude" "$HOME/.cache/claude" "$HOME/.claude"
[ -e "$HOME/.claude.json" ] || echo '{}' > "$HOME/.claude.json"
version="$HOME/.local/share/claude/versions/${CLAUDE_VERSION}"
if [ "$how" = "incomplete" ]; then
  /usr/bin/head -c 200 ${JSON.stringify(iw.claudeScript)} > "$version"
else
  /bin/cp ${JSON.stringify(iw.claudeScript)} "$version"
fi
/bin/chmod 755 "$version"
/bin/ln -sfn "$version" "$HOME/.local/bin/claude"
echo "Claude Code successfully installed!"
`;
}

// ------------------------------------------------------------- the world

// A fresh user's Mac, with set-up's app assembled. The assembly asserts the
// app's entry point is in this repository: until it is, every case using the
// world fails there first.
function makeInstallerWorld(t, { mac = {}, claude = {} } = {}) {
  const world = w.makeWorld();
  const root = world.root;
  const iw = {
    world,
    root,
    userHome: world.userHome,
    squireHome: path.join(world.userHome, 'Library', 'Application Support', 'Squire'),
    ownerFolder: path.join(world.userHome, 'Squire'),
    app: path.join(root, 'Applications', 'Squire.app'),
    fakes: path.join(root, 'mac-bin'),
    macFile: path.join(root, 'mac.json'),
    macPlist: path.join(root, 'mac-installer.plist'),
    claudeFile: path.join(root, 'claude-code.json'),
    claudeScript: path.join(root, 'claude-code', 'claude'),
    callsFile: path.join(root, 'mac-calls.jsonl'),
    dialogsFile: path.join(root, 'dialogs.jsonl'),
    toolsDir: path.join(root, 'CommandLineTools'),
    toolsMarker: path.join(root, 'tools-installed'),
    installerScript: path.join(root, 'claude-installer.sh'),
    system: path.join(root, 'system'),
    runners: [],
  };
  iw.configDir = path.join(iw.squireHome, 'claude-config');
  iw.record = path.join(iw.squireHome, 'set-up.json');
  t.after(async () => {
    for (const r of iw.runners) await r.stop();
    sw.killFakes(world);
    w.cleanUp(world);
  });
  for (const rel of ['Library/Application Support', 'Library/Preferences', 'Desktop', 'Documents', 'Downloads']) {
    fs.mkdirSync(path.join(iw.userHome, rel), { recursive: true });
  }
  for (const dir of [iw.fakes, iw.toolsDir, iw.system, path.dirname(iw.claudeScript)]) fs.mkdirSync(dir, { recursive: true });
  iw.set = (changes) => {
    const next = { ...DEFAULT_MAC, ...(fs.existsSync(iw.macFile) ? JSON.parse(fs.readFileSync(iw.macFile, 'utf8')) : {}), ...changes };
    fs.writeFileSync(iw.macFile, JSON.stringify(next));
    fs.writeFileSync(iw.macPlist, `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>installer</key><string>${next.installer}</string></dict></plist>\n`);
  };
  iw.setClaude = (changes) => {
    const next = { ...DEFAULT_CLAUDE, ...(fs.existsSync(iw.claudeFile) ? JSON.parse(fs.readFileSync(iw.claudeFile, 'utf8')) : {}), ...changes };
    fs.writeFileSync(iw.claudeFile, JSON.stringify(next));
  };
  iw.set(mac);
  iw.setClaude(claude);
  // The fakes.
  for (const [cmd, body] of Object.entries(FAKES)) {
    const file = path.join(iw.fakes, cmd);
    const text = (fakeHeader(iw, cmd) + body)
      .replaceAll('"TOOLS_MARKER"', JSON.stringify(iw.toolsMarker))
      .replaceAll('"TOOLS_DIR"', JSON.stringify(iw.toolsDir))
      .replaceAll('"INSTALLER_SCRIPT"', JSON.stringify(iw.installerScript))
      .replaceAll('"DIALOGS_FILE"', JSON.stringify(iw.dialogsFile));
    fs.writeFileSync(file, text);
    fs.chmodSync(file, 0o755);
  }
  // Round 2's fake session, which the fake Claude Code's remote-control runs.
  const inner = sw.installFakeClaudeCode(world, {}, { dir: path.join(root, 'claude-code-inner') });
  fs.writeFileSync(iw.claudeScript, fakeClaudeCodeScript(iw, inner.bin));
  fs.chmodSync(iw.claudeScript, 0o755);
  fs.writeFileSync(iw.installerScript, fakeInstallerScript(iw));
  iw.inner = inner;
  assembleApp(iw);
  return iw;
}

function assembleApp(iw) {
  const source = path.join(APP_SOURCE, APP_EXECUTABLE);
  assert.ok(fs.existsSync(source),
    `set-up's app is not in this repository: ${path.relative(w.REPO, source)}, its entry point (the design record's line 1), is missing`);
  fs.mkdirSync(path.dirname(iw.app), { recursive: true });
  fs.cpSync(APP_SOURCE, iw.app, { recursive: true, dereference: true });
  fs.cpSync(w.CORE, path.join(iw.app, 'Contents', 'Resources', 'core'), { recursive: true, dereference: true });
}

// Claude Code installed before set-up, as its own installer lays it.
function preinstallClaudeCode(iw) {
  const r = spawnSync('/bin/bash', [iw.installerScript], {
    env: { PATH: MAC_PATH, HOME: iw.userHome }, encoding: 'utf8',
  });
  assert.equal(r.status, 0, `the stand-in Claude Code must install before set-up; got ${r.stderr}`);
  fs.writeFileSync(iw.callsFile, '');
  return claudeCodePlaces(iw);
}

// Claude Code's places under the home, as content (path to type and digest).
function claudeCodePlaces(iw) {
  const out = {};
  for (const rel of ['.local/bin/claude', '.local/share/claude', '.local/state/claude', '.cache/claude', '.claude', '.claude.json']) {
    const abs = path.join(iw.userHome, rel);
    if (fs.existsSync(abs) || isLink(abs)) Object.assign(out, contentOf(abs, rel));
  }
  return out;
}

const isLink = (p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch (e) { return false; } };

// A tree as content only: each entry's type and bytes (or link target), with
// no times or inodes, for "left as found" after an undo.
function contentOf(abs, rel = '') {
  const out = {};
  const visit = (a, r) => {
    let st;
    try { st = fs.lstatSync(a); } catch (e) { return; }
    if (st.isSymbolicLink()) out[r] = `link ${fs.readlinkSync(a)}`;
    else if (st.isDirectory()) {
      if (r) out[r] = 'dir';
      for (const name of fs.readdirSync(a).sort()) visit(path.join(a, name), r ? `${r}/${name}` : name);
    } else out[r] = `file ${crypto.createHash('sha256').update(fs.readFileSync(a)).digest('hex')}`;
  };
  visit(abs, rel);
  return out;
}

// --------------------------------------------------------------- running

// The environment Finder opens the app with in this world: the fakes first on
// PATH, then the Mac's own folders; no SQUIRE_HOME, no Claude Code variables.
function appEnv(iw) {
  return {
    PATH: `${iw.fakes}:${MAC_PATH}`,
    HOME: iw.userHome,
    USER: process.env.USER || 'owner',
    LOGNAME: process.env.USER || 'owner',
    TMPDIR: iw.world.tmp,
    LANG: 'en_GB.UTF-8',
    SQUIRE_SYSTEM_ROOT: iw.system,
  };
}

// A stand-in for launchd: once lay-down has written Squire's runner agent
// under the world's home, starts its program as launchd would, with the
// agent's environment, in a process group of its own.
function startRunnerFromPlist(iw) {
  const file = path.join(iw.userHome, 'Library', 'LaunchAgents', 'com.stravica.squire.runner.plist');
  const r = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const plist = JSON.parse(r.stdout);
  const out = path.join(iw.root, 'runner.out');
  const fd = fs.openSync(out, 'a');
  const [program, ...args] = plist.ProgramArguments;
  const child = spawn(program, args, {
    cwd: '/', env: { ...appEnv(iw), PATH: MAC_PATH, ...(plist.EnvironmentVariables || {}) },
    stdio: ['ignore', fd, fd], detached: true,
  });
  fs.closeSync(fd);
  let exit = null;
  child.on('exit', (status, signal) => { exit = { status, signal }; });
  const runner = {
    pid: child.pid,
    exited: () => exit,
    async stop() {
      if (!exit) {
        try { process.kill(child.pid, 'SIGTERM'); } catch (e) { /* gone */ }
        await sw.waitFor(() => exit, 10000);
      }
      if (!exit) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { /* gone */ }
        await sw.waitFor(() => exit, 5000);
      }
    },
  };
  iw.runners.push(runner);
  return runner;
}

// Opens the app as Finder would and waits for it to end. Options:
//   launchd   start the runner from its agent once lay-down writes it (true)
//   killWhen  a test of the world: when it turns true the app is killed
//             (SIGKILL to its process group), as a quit or a crash would
//   timeout   the bound on the run (150 s); a run still going is killed
// Returns the exit, the output, and the windows and calls of this run.
async function runApp(iw, { launchd = true, killWhen = null, timeout = 150000 } = {}) {
  const dialogsBefore = readJsonLines(iw.dialogsFile).length;
  const callsBefore = readJsonLines(iw.callsFile).length;
  const exe = path.join(iw.app, APP_EXECUTABLE);
  const child = spawn(exe, [], { cwd: '/', env: appEnv(iw), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let stdout = '';
  let stderr = '';
  let exit = null;
  let error = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  child.on('error', (e) => { error = String(e.message || e); exit = exit || { status: null, signal: null }; });
  child.on('close', (status, signal) => { exit = { status, signal }; });
  const end = Date.now() + timeout;
  let killed = false;
  let timedOut = false;
  let started = iw.runners.some((r) => !r.exited());
  while (!exit) {
    if (launchd && !started && fs.existsSync(path.join(iw.userHome, 'Library', 'LaunchAgents', 'com.stravica.squire.runner.plist'))) {
      started = Boolean(startRunnerFromPlist(iw));
    }
    if (killWhen && killWhen(iw)) {
      killed = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { /* gone */ }
      await sw.waitFor(() => exit, 5000);
      break;
    }
    if (Date.now() > end) {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { /* gone */ }
      await sw.waitFor(() => exit, 5000);
      break;
    }
    await sw.sleep(100);
  }
  return {
    status: exit ? exit.status : null,
    signal: exit ? exit.signal : null,
    stdout,
    stderr,
    error,
    killed,
    timedOut,
    dialogs: readJsonLines(iw.dialogsFile).slice(dialogsBefore),
    calls: readJsonLines(iw.callsFile).slice(callsBefore),
  };
}

// Starts the app without waiting, for a second set-up beside a first.
function startApp(iw) {
  const child = spawn(path.join(iw.app, APP_EXECUTABLE), [], { cwd: '/', env: appEnv(iw), stdio: 'ignore', detached: true });
  let exit = null;
  child.on('exit', (status, signal) => { exit = { status, signal }; });
  return {
    pid: child.pid,
    exited: () => exit,
    async kill() {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { /* gone */ }
      await sw.waitFor(() => exit, 5000);
    },
  };
}

function describeRun(run) {
  const cut = (s) => (s.length > 500 ? s.slice(0, 500) + '...' : s).trim();
  return `exit ${run.status}${run.signal ? ` (${run.signal})` : ''}${run.killed ? ' (killed by the test)' : ''}` +
    `${run.timedOut ? ' (timed out)' : ''}${run.error ? ` (${run.error})` : ''}; windows: ` +
    `${run.dialogs.map((d) => d.title).join(' | ') || '(none)'}; stderr: ${cut(run.stderr) || '(empty)'}`;
}

// --------------------------------------------------------------- reading

function readRecord(iw) {
  try { return JSON.parse(fs.readFileSync(iw.record, 'utf8')); } catch (e) { return null; }
}

const doneSteps = (iw) => ((readRecord(iw) || {}).done || []);

const dialogsTitled = (run, title) => run.dialogs.filter((d) => d.title === title);

const callsOf = (run, cmd, test = () => true) => run.calls.filter((c) => c.cmd === cmd && test(c));

const signedInto = (iw) => {
  try { return Boolean(JSON.parse(fs.readFileSync(path.join(iw.configDir, '.claude.json'), 'utf8')).oauthAccount); }
  catch (e) { return false; }
};

// The installed health check, as the owner (or set-up) runs it, with the
// system places under the world's.
function healthOf(iw) {
  return spawnSync(w.PYTHON, ['-B', path.join(iw.squireHome, 'core', 'tools', 'health.py')], {
    cwd: '/', env: { ...appEnv(iw), PATH: MAC_PATH }, encoding: 'utf8', timeout: 60000,
  });
}

// The owner's squire.json at the top of the owner's folder.
function ownerConfig(iw) {
  try { return JSON.parse(fs.readFileSync(path.join(iw.ownerFolder, 'squire.json'), 'utf8')); } catch (e) { return null; }
}

module.exports = {
  APP_SOURCE,
  APP_EXECUTABLE,
  CLAUDE_VERSION,
  INSTALL_URL,
  MAC_PATH,
  TITLES,
  STEPS,
  DEFAULT_ANSWERS,
  makeInstallerWorld,
  preinstallClaudeCode,
  claudeCodePlaces,
  contentOf,
  appEnv,
  runApp,
  startApp,
  describeRun,
  readRecord,
  doneSteps,
  dialogsTitled,
  callsOf,
  signedInto,
  healthOf,
  ownerConfig,
  readJsonLines,
};
