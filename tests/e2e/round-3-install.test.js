'use strict';

// Round 3's release-Verify tests: Squire set up from the download on a real
// Mac, reached over SSH as the Squire owner's user. The target is a
// parameter, as in round 2:
//
//   SQUIRE_TARGET_HOST=<ssh destination> node --test tests/e2e/round-3-install.test.js
//
// RCF_TARGET_URL is read when SQUIRE_TARGET_HOST is unset. With neither, each
// test skips with the line "external: needs a target host" and never passes.
// Each refuses to run, failing, when the target is the user running the tests
// on this machine. The target is reached with the ssh on PATH, with no
// prompt (BatchMode).
//
// The app on the target is a second parameter: SQUIRE_APP, a path as the
// target's shell expands it (~/Downloads/Squire.app unless given), placed
// there as the owner's browser download would place it.
//
// Each test needs a target fresh at its own start and depends on no other
// test's run: it first records the target's baseline and fails, never
// passes, unless there is no Squire home, no owner's folder (~/Squire), no
// Claude Code under the target's home and no transcript in Squire's config
// folder. Every read honours one Squire home, the one the record read names.
//
// By-hand steps, each waited for (bounded) and read from the target's own
// records, never asserted on directly: Open Anyway in System Settings, the
// browser sign-in, and, in the journey test, the owner's own answers to
// set-up's windows and the owner's first message at claude.ai/code. That
// first message must not name the Squire, so that a reply naming it shows
// what the session loaded rather than what the owner just typed; the test
// brief for the journey walk tells the owner so.
//
// The no-Terminal test answers set-up's windows from a test-world answer
// source: a temporary folder on the target laid out as the Mac's system
// folders (every real command a link, osascript the answer source), given to
// the app as SQUIRE_SYSTEM_ROOT (the design record's line 3). The answer
// source draws each set-up window for real through the Mac's own
// /usr/bin/osascript, closes it after two seconds and answers from the test
// world. The folder is removed afterwards. The product ships no answer file.
//
// What the no-Terminal test reads (the design record's line 19): a watcher on
// the target reads the window list every 100 milliseconds for the whole run,
// across set-up and a repair re-run over the finished set-up, and records
// each new layer-0 window (application windows) with its owner's bundle
// identifier and process ancestry. A window whose owner descends from
// Squire's app process is Squire's; any other must belong to the allow-list
// by bundle identifier, compared without regard to case; any other app's
// window fails, and so does a window whose owner neither descends from
// Squire's app nor has a bundle identifier the test can read. The test fails
// unless it saw at least one real set-up window drawn by /usr/bin/osascript.
// A hidden terminal session with no window is inside the promise.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const TARGET = process.env.SQUIRE_TARGET_HOST || process.env.RCF_TARGET_URL || '';
const APP = process.env.SQUIRE_APP || '~/Downloads/Squire.app';
const SKIP = TARGET ? false : 'external: needs a target host (SQUIRE_TARGET_HOST, an SSH destination, or RCF_TARGET_URL)';
const SET_UP_MINUTES = 60;
const REPAIR_MINUTES = 10;
const FIRST_REPLY_MINUTES = 30;
const STEPS = ['yes', 'claudeCode', 'signIn', 'appleTools', 'naming', 'ownerFolder', 'layDown', 'backup', 'health', 'phone',
  'firstConversation'];

// The apps whose windows set-up may open besides its own: the browser (the
// https handler, and Safari), System Settings, Gatekeeper's own message,
// Apple's tools dialog and the Claude app.
const ALLOWED = ['com.apple.Safari', 'com.apple.systempreferences', 'com.apple.coreservices.uiagent',
  'com.apple.dt.CommandLineTools.installondemand', 'com.anthropic.claudefordesktop'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function onTarget(command, { input = '', timeout = 60000 } = {}) {
  const r = spawnSync('ssh', ['-o', 'BatchMode=yes', TARGET, command], { input, encoding: 'utf8', timeout });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error ? String(r.error.message) : '' };
}

// Read-only: the user, the app, Apple's tools, the Squire home (SQUIRE_HOME as
// the target's login shell gives it, else the default), set-up's record and
// its time, the owner's folder, Claude Code under the home, transcripts in
// Squire's config folder and the default browser, as JSON.
const LOOK = String.raw`
import glob, json, os, plistlib, pwd, subprocess, sys
app = os.path.expanduser(sys.argv[1])
home = os.environ.get('SQUIRE_HOME') or os.path.expanduser('~/Library/Application Support/Squire')
uid = os.getuid()
out = {'uid': uid, 'user': pwd.getpwuid(uid).pw_name, 'host': os.uname().nodename, 'home': home, 'app': app,
       'appPresent': os.path.isfile(os.path.join(app, 'Contents', 'MacOS', 'Squire'))}
r = subprocess.run(['/usr/bin/xcode-select', '-p'], capture_output=True, text=True)
out['toolsPresent'] = r.returncode == 0 and os.path.isdir(r.stdout.strip())
out['homeExists'] = os.path.lexists(home)
try:
    with open(os.path.join(home, 'set-up.json')) as f:
        out['record'] = json.load(f)
    out['recordAt'] = os.path.getmtime(os.path.join(home, 'set-up.json'))
except Exception:
    out['record'] = None
    out['recordAt'] = None
try:
    with open(os.path.expanduser('~/Squire/squire.json')) as f:
        out['ownerConfig'] = json.load(f)
except Exception:
    out['ownerConfig'] = None
out['ownerFolder'] = os.path.lexists(os.path.expanduser('~/Squire'))
out['claudeCodeUnderHome'] = [p for p in ('~/.local/bin/claude', '~/.local/share/claude') if os.path.lexists(os.path.expanduser(p))]
out['transcripts'] = len(glob.glob(os.path.join(home, 'claude-config', 'projects', '*', '*.jsonl')))
browser = None
try:
    with open(os.path.expanduser('~/Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist'), 'rb') as f:
        for h in plistlib.load(f).get('LSHandlers', []):
            if h.get('LSHandlerURLScheme') == 'https':
                browser = h.get('LSHandlerRoleAll')
except Exception:
    pass
out['browser'] = browser
print(json.dumps(out))
`;

function look() {
  const r = onTarget(`/usr/bin/python3 - ${q(APP)}`, { input: LOOK });
  assert.equal(r.status, 0, `the target must answer over SSH; got exit ${r.status} ${r.stderr.trim()} ${r.error}`);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

function refuseOwnUser(state) {
  assert.ok(!(state.uid === process.getuid() && state.host === os.hostname()),
    'the target is the user running these tests on this machine; a release-Verify test never sets Squire up there');
}

// The baseline, recorded and asserted at the test's own start.
function assertFresh(state, t) {
  const baseline = { squireHome: state.homeExists, ownerFolder: state.ownerFolder, claudeCodeUnderHome: state.claudeCodeUnderHome,
    transcripts: state.transcripts, toolsPresent: state.toolsPresent };
  t.diagnostic(`baseline: ${JSON.stringify(baseline)}`);
  const stale = [];
  if (state.homeExists) stale.push(`a Squire home at ${state.home}`);
  if (state.ownerFolder) stale.push('an owner\'s folder at ~/Squire');
  if (state.claudeCodeUnderHome.length) stale.push(`Claude Code under the home (${state.claudeCodeUnderHome.join(', ')})`);
  if (state.transcripts) stale.push(`${state.transcripts} transcript(s) in Squire's config folder`);
  assert.deepEqual(stale, [], `the target must be fresh at this test's own start; it holds ${stale.join('; ')}`);
}

// Claude Code at its fixed places, asked whether Squire's config folder (in
// the Squire home given) is signed in.
const SIGNED_IN = String.raw`
import json, os, pwd, subprocess, sys
home = sys.argv[1]
out = {'claude': None, 'status': None, 'loggedIn': False, 'oauthAccount': False}
for c in ('~/.local/bin/claude', '/usr/local/bin/claude', '/opt/homebrew/bin/claude'):
    c = os.path.expanduser(c)
    if os.access(c, os.X_OK):
        out['claude'] = c
        # The environment Squire itself gives Claude Code, built from nothing: Claude Code finds its sign-in only
        # through the account's name, so USER and LOGNAME are the account this read runs as, from the account
        # database; TMPDIR only when this read was given one.
        user = pwd.getpwuid(os.getuid()).pw_name
        env = {'HOME': os.path.expanduser('~'), 'USER': user, 'LOGNAME': user, 'PATH': '/usr/bin:/bin:/usr/sbin:/sbin',
               'LANG': 'en_US.UTF-8', 'CLAUDE_CONFIG_DIR': os.path.join(home, 'claude-config')}
        if os.environ.get('TMPDIR'):
            env['TMPDIR'] = os.environ['TMPDIR']
        r = subprocess.run([c, 'auth', 'status'], env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=30)
        out['status'] = r.returncode
        try:
            out['loggedIn'] = json.loads(r.stdout).get('loggedIn') is True
        except Exception:
            pass
        break
try:
    with open(os.path.join(home, 'claude-config', '.claude.json')) as f:
        out['oauthAccount'] = 'oauthAccount' in json.load(f)
except Exception:
    pass
print(json.dumps(out))
`;

// The session (one record whose process is alive and listens on its socket)
// and its first reply: the first assistant entry, in that session's own
// transcript, after the owner's first message sent after set-up finished.
const REPLY = String.raw`
import datetime, glob, json, os, socket, sys
home, since = sys.argv[1], float(sys.argv[2])
out = {'live': False, 'records': 0, 'ownerMessage': False, 'reply': None}
recs = []
for f in glob.glob(os.path.join(home, 'sessions', '*.json')):
    try:
        recs.append(json.load(open(f)))
    except Exception:
        pass
out['records'] = len(recs)
def at(e):
    try:
        return datetime.datetime.fromisoformat(str(e.get('timestamp')).replace('Z', '+00:00')).timestamp()
    except Exception:
        return None
def text_of(m):
    c = m.get('content')
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        return ' '.join(x.get('text', '') for x in c if isinstance(x, dict) and x.get('type') == 'text')
    return ''
if len(recs) == 1:
    r = recs[0]
    sk = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sk.settimeout(2)
    try:
        sk.connect(r.get('socket'))
        out['live'] = sk.getsockopt(0, 2) == r.get('pid')
    except Exception:
        pass
    finally:
        sk.close()
    for f in glob.glob(os.path.join(home, 'claude-config', 'projects', '*', str(r.get('sessionId')) + '.jsonl')):
        asked = False
        for line in open(f, errors='replace'):
            try:
                e = json.loads(line)
            except Exception:
                continue
            m = e.get('message') or {}
            t = at(e)
            if not asked:
                if e.get('type') == 'user' and m.get('role') == 'user' and text_of(m).strip() and t is not None and t >= since:
                    asked = True
                    out['ownerMessage'] = True
                continue
            if e.get('type') == 'assistant' and text_of(m).strip():
                out['reply'] = text_of(m)
                break
print(json.dumps(out))
`;

// The watcher: the window list every 100 milliseconds; each new layer-0
// window with its owner's bundle identifier and process ancestry, written to
// the file named, one JSON line per window.
const WATCHER = String.raw`
ObjC.import('CoreGraphics');
ObjC.import('Foundation');
function run(argv) {
  const out = argv[0];
  const app = Application.currentApplication();
  app.includeStandardAdditions = true;
  const seen = {};
  const lines = [];
  const write = () => $(lines.join('\n') + '\n').writeToFileAtomicallyEncodingError(out, true, $.NSUTF8StringEncoding, null);
  write();
  for (;;) {
    const list = ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, $.kCGNullWindowID));
    let added = false;
    for (let i = 0; i < list.count; i++) {
      const d = list.objectAtIndex(i);
      const get = (k) => {
        const v = d.objectForKey(k);
        if (v === undefined || v === null || (typeof v.isNil === 'function' && v.isNil())) return null;
        return ObjC.unwrap(v);
      };
      const number = get('kCGWindowNumber');
      if (seen[number]) continue;
      seen[number] = true;
      const w = { number, pid: get('kCGWindowOwnerPID'), owner: get('kCGWindowOwnerName'), layer: get('kCGWindowLayer'), at: Date.now() };
      if (w.layer === 0) {
        let bundle = '';
        try { bundle = app.doShellScript('/usr/bin/lsappinfo info -only bundleid ' + Number(w.pid)); } catch (e) { bundle = ''; }
        const m = /"CFBundleIdentifier"="([^"]+)"/.exec(bundle);
        w.bundleId = m ? m[1] : null;
        const table = {};
        try {
          for (const row of app.doShellScript('/bin/ps -A -o pid=,ppid=,command=').split(/\r?\n/)) {
            const p = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(row);
            if (p) table[p[1]] = { ppid: p[2], command: p[3] };
          }
        } catch (e) { /* no table */ }
        const chain = [];
        let pid = String(w.pid);
        while (pid && table[pid] && chain.length < 64) {
          chain.push({ pid: Number(pid), command: table[pid].command });
          if (pid === '1' || pid === '0') break;
          pid = table[pid].ppid;
        }
        w.chain = chain;
      }
      lines.push(JSON.stringify(w));
      added = true;
    }
    if (added) write();
    delay(0.1);
  }
}
`;

// The answer source: drawn for real through the Mac's own osascript, closed
// after two seconds, then answered from the test world by the window's title.
const ANSWERS = String.raw`#!/bin/zsh
text="$*"
input=""
[[ -t 0 ]] || input="$(/bin/cat)"
text+=" $input"
answer=""
case "$text" in
  *"Squire: your Claude plan"*) answer="Pro" ;;
  *"Squire: set up"*) answer="button returned:Install" ;;
  *"Squire: name your Squire"*) answer="button returned:OK, text returned:Juniper" ;;
  *"Squire: your Squire's personality"*) answer="button returned:OK, text returned:Warm, brief and dry" ;;
  *"Squire: your plan"*) answer="button returned:Continue" ;;
  *"Squire: your phone"*) answer="button returned:Later" ;;
  *"Squire: "*) answer="button returned:OK" ;;
  *"Squire Update"*'"Install"'*|*'"Install"'*"Squire Update"*) answer="button returned:Not now" ;;
  *"Squire Update"*) answer="button returned:OK" ;;
  *) if [[ -n "$input" ]]; then print -r -- "$input" | exec /usr/bin/osascript "$@"; else exec /usr/bin/osascript "$@"; fi ;;
esac
if [[ -n "$input" ]]; then print -r -- "$input" | /usr/bin/osascript "$@" >/dev/null 2>&1 &
else /usr/bin/osascript "$@" >/dev/null 2>&1 & fi
drawn=$!
/bin/sleep 2
kill $drawn 2>/dev/null
wait $drawn 2>/dev/null
print -r -- "$answer"
`;

// Lays the answer source's system folders under the folder named: every
// entry of the four system folders as a link, osascript the answer source.
const SYSTEM_ROOT = String.raw`
root="$1"
for d in usr/bin bin usr/sbin sbin; do
  /bin/mkdir -p "$root/$d"
  for f in /$d/*(N); do n="$(/usr/bin/basename "$f")"; /bin/ln -s "$f" "$root/$d/$n"; done
done
/bin/rm -f "$root/usr/bin/osascript"
`;

test("setting Squire up from the download on a fresh Mac user opens no Terminal window: every new window belongs to set-up, the browser, System Settings, Apple's tools dialog or the Claude app", { skip: SKIP, timeout: (SET_UP_MINUTES + REPAIR_MINUTES + 10) * 60000 }, async (t) => {
  if (SKIP) { t.skip(SKIP); return; }
  const state = look();
  refuseOwnUser(state);
  assertFresh(state, t);
  assert.ok(state.appPresent, `Squire's app must be on the target at ${APP}, as the download places it`);
  const allowed = ALLOWED.map((b) => b.toLowerCase());
  if (state.browser) allowed.push(String(state.browser).toLowerCase());
  const squireExe = `${state.app}/Contents/MacOS/Squire`;
  // Squire Update, laid down by set-up, runs as the installed core's
  // update.py --app (its launcher hands over to it).
  const updateApp = '~/Applications/Squire Update.app';
  const isSquireUpdate = (command) => /Squire Update\.app|core\/tools\/update\.py --app/.test(String(command));
  let realUpdateWindow = false;
  const made = onTarget('/usr/bin/mktemp -d -t squire-no-terminal');
  assert.equal(made.status, 0, 'a temporary folder on the target for the answer source and the watcher');
  const folder = made.stdout.trim();
  const root = `${folder}/system`;
  const watchFile = `${folder}/windows.jsonl`;
  let watcherPid = null;
  t.after(() => {
    if (watcherPid) onTarget(`/bin/kill ${Number(watcherPid)}`);
    onTarget(`/bin/rm -rf ${q(folder)}`);
  });
  assert.equal(onTarget(`/bin/zsh -s ${q(root)}`, { input: SYSTEM_ROOT }).status, 0, 'the answer source\'s system folders must be laid on the target');
  assert.equal(onTarget(`/bin/cat > ${q(`${root}/usr/bin/osascript`)} && /bin/chmod 755 ${q(`${root}/usr/bin/osascript`)}`, { input: ANSWERS }).status, 0,
    'the answer source must be laid on the target');
  assert.equal(onTarget(`/bin/cat > ${q(`${folder}/watcher.js`)}`, { input: WATCHER }).status, 0, 'the watcher must be laid on the target');
  const started = onTarget(`/usr/bin/nohup /usr/bin/osascript -l JavaScript ${q(`${folder}/watcher.js`)} ${q(watchFile)} >/dev/null 2>&1 & echo $!`);
  watcherPid = Number(started.stdout.trim());
  assert.ok(watcherPid > 0, `the watcher must start on the target; got ${started.stdout} ${started.stderr}`);
  await sleep(2000);
  // Windows on screen before the app opens are not set-up's.
  const read = () => onTarget(`/bin/cat ${q(watchFile)}`).stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const before = new Set(read().map((x) => x.number));
  const judged = new Set();
  let realSetUpWindow = false;
  const judge = () => {
    for (const win of read()) {
      if (before.has(win.number) || judged.has(win.number) || win.layer !== 0) continue;
      judged.add(win.number);
      const chain = win.chain || [];
      const squires = chain.some((p) => String(p.command).includes(squireExe));
      if (squires) {
        if (/^\/usr\/bin\/osascript\b/.test(String(chain[0] && chain[0].command))) realSetUpWindow = true;
        continue;
      }
      if (chain.some((p) => isSquireUpdate(p.command))) {
        if (/^\/usr\/bin\/osascript\b/.test(String(chain[0] && chain[0].command))) realUpdateWindow = true;
        continue;
      }
      assert.ok(win.bundleId, `a window opened during set-up whose app cannot be told (owner ${win.owner}, pid ${win.pid}) and that is not Squire's: it fails, never passes`);
      assert.ok(allowed.includes(String(win.bundleId).toLowerCase()),
        `a window of ${win.owner} (${win.bundleId}) opened during set-up; only set-up, the browser, System Settings, Apple's tools dialog and the Claude app may open one`);
    }
  };
  const openApp = () => onTarget(`/usr/bin/open -n --env SQUIRE_SYSTEM_ROOT=${q(root)} ${q(state.app)}`);
  const opened = openApp();
  assert.equal(opened.status, 0, `the app must open on the target; got ${opened.stderr.trim()}`);
  const end = Date.now() + SET_UP_MINUTES * 60000;
  for (;;) {
    judge();
    const now = look();
    if (now.record && (now.record.done || []).includes('firstConversation')) break;
    assert.ok(Date.now() < end, `set-up must finish within ${SET_UP_MINUTES} minutes (Open Anyway and the browser sign-in are by hand); its record: ${JSON.stringify(now.record)}`);
    await sleep(5000);
  }
  // A repair re-run over the finished set-up, watched the same way: the
  // backup job's agent file is taken away, and running the app again writes it.
  const agent = '~/Library/LaunchAgents/com.stravica.squire.backup.plist';
  assert.equal(onTarget(`/bin/rm -f ${agent}`).status, 0, 'the world takes the backup job\'s agent file away');
  const again = openApp();
  assert.equal(again.status, 0, `the app must open again on the target; got ${again.stderr.trim()}`);
  const repairEnd = Date.now() + REPAIR_MINUTES * 60000;
  for (;;) {
    judge();
    const back = onTarget(`/bin/test -f ${agent}`).status === 0;
    const running = onTarget(`/usr/bin/pgrep -f ${q(squireExe)}`).status === 0;
    if (back && !running) break;
    assert.ok(Date.now() < repairEnd, `the repair re-run must finish within ${REPAIR_MINUTES} minutes, writing the backup job's agent again`);
    await sleep(3000);
  }
  await sleep(1000);
  judge();
  assert.ok(realSetUpWindow, 'the test must see at least one real set-up window drawn by the Mac\'s own osascript, or it proves nothing about set-up\'s windows');
  // Squire Update, opened as the owner opens it, watched the same way: its
  // windows are its own, and it opens no Terminal window either.
  const updateOpened = onTarget(`/usr/bin/open -n --env SQUIRE_SYSTEM_ROOT=${q(root)} ~/'Applications/Squire Update.app'`);
  assert.equal(updateOpened.status, 0, `Squire Update must open on the target from ${updateApp}; got ${updateOpened.stderr.trim()}`);
  const updateEnd = Date.now() + REPAIR_MINUTES * 60000;
  await sleep(3000);
  for (;;) {
    judge();
    const running = onTarget(`/usr/bin/pgrep -f ${q('core/tools/update.py --app')}`).status === 0;
    if (!running) break;
    assert.ok(Date.now() < updateEnd, `Squire Update must end within ${REPAIR_MINUTES} minutes`);
    await sleep(3000);
  }
  await sleep(1000);
  judge();
  assert.ok(realUpdateWindow, 'the test must see at least one real Squire Update window drawn by the Mac\'s own osascript, or it proves nothing about Squire Update\'s windows');
});

test('the first-run journey on a fresh Mac user: from the download, every set-up step runs in order without Terminal, and the owner gets a first reply from their Squire, named', { skip: SKIP, timeout: (SET_UP_MINUTES + FIRST_REPLY_MINUTES + 10) * 60000 }, async (t) => {
  if (SKIP) { t.skip(SKIP); return; }
  const state = look();
  refuseOwnUser(state);
  assertFresh(state, t);
  assert.ok(state.appPresent, `Squire's app must be on the target at ${APP}, as the download places it`);
  if (state.toolsPresent) t.diagnostic('not from zero: Apple\'s command line tools were present before set-up ran');
  const opened = onTarget(`/usr/bin/open ${q(state.app)}`);
  assert.equal(opened.status, 0, `the app must open on the target; got ${opened.stderr.trim()}`);
  // The owner clicks Open Anyway, answers set-up's windows and signs in.
  let now = state;
  const end = Date.now() + SET_UP_MINUTES * 60000;
  while (!(now.record && (now.record.done || []).includes('firstConversation'))) {
    assert.ok(Date.now() < end, `set-up must finish within ${SET_UP_MINUTES} minutes; its record: ${JSON.stringify(now.record)}`);
    await sleep(5000);
    now = look();
  }
  assert.equal(now.home, state.home, 'every read must honour the one Squire home');
  const finishedAt = now.recordAt;
  t.diagnostic(`set-up finished at ${new Date(finishedAt * 1000).toISOString()} (the target's clock)`);
  assert.deepEqual(now.record.done, STEPS, 'every set-up step must be recorded done, in order');
  assert.ok(now.ownerFolder, 'the owner\'s folder must be ~/Squire');
  const name = now.ownerConfig && now.ownerConfig.squireName;
  assert.ok(typeof name === 'string' && name.trim(), 'the owner\'s squire.json must hold the Squire\'s name');
  const signed = onTarget(`/usr/bin/python3 - ${q(now.home)}`, { input: SIGNED_IN });
  assert.equal(signed.status, 0, `the target must answer; got ${signed.stderr}`);
  const signedIn = JSON.parse(signed.stdout.trim().split('\n').pop());
  assert.ok(signedIn.claude && signedIn.status === 0 && signedIn.loggedIn && signedIn.oauthAccount,
    `Claude Code must be installed and signed in into Squire's config folder (loggedIn and oauthAccount); got ${JSON.stringify(signedIn)}`);
  const backup = onTarget(`/bin/launchctl print gui/${Number(now.uid)}/com.stravica.squire.backup`);
  assert.equal(backup.status, 0, 'the backup job\'s agent must be loaded in the owner\'s own launchd domain');
  // The owner's first message at claude.ai/code, which does not name the
  // Squire, and the Squire's first reply to it.
  const replyEnd = Date.now() + FIRST_REPLY_MINUTES * 60000;
  let seen = null;
  for (;;) {
    const r = onTarget(`/usr/bin/python3 - ${q(now.home)} ${Number(finishedAt)}`, { input: REPLY });
    assert.equal(r.status, 0, `the target must answer; got ${r.stderr}`);
    seen = JSON.parse(r.stdout.trim().split('\n').pop());
    if (seen.reply) break;
    assert.ok(Date.now() < replyEnd, `the owner's first message after set-up must get a reply within ${FIRST_REPLY_MINUTES} minutes; the session: ${JSON.stringify(seen)}`);
    await sleep(10000);
  }
  assert.ok(seen.live, 'the session must be running: one record whose process is alive and listens');
  assert.ok(seen.reply.includes(name), `the Squire's first reply must name the Squire (${name}); it said: ${seen.reply.slice(0, 300)}`);
});
