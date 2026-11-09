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
// By-hand steps, each waited for (bounded) and read from the target's own
// records, never asserted on directly: Open Anyway in System Settings, the
// browser sign-in, and, in the journey test, the owner's own answers to
// set-up's windows and the owner's first message at claude.ai/code. In the
// no-Terminal test set-up's windows are answered by a test-world answer
// source laid in a temporary folder on the target and put first on the PATH
// the app is opened with (open --env); it is removed afterwards. The product
// ships no answer file.
//
// What the no-Terminal test reads (the design record's line 19): the window
// list (each on-screen window's owning process, owner name and layer, with no
// permission held; titles are withheld) and each owner's bundle identifier.
// Application windows are layer 0. Every new layer-0 window during set-up
// must belong to the allow-list; any other app's window fails, and a window
// whose owner has no bundle identifier the test can read fails. A hidden
// terminal session with no window is inside the promise.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const TARGET = process.env.SQUIRE_TARGET_HOST || process.env.RCF_TARGET_URL || '';
const APP = process.env.SQUIRE_APP || '~/Downloads/Squire.app';
const SKIP = TARGET ? false : 'external: needs a target host (SQUIRE_TARGET_HOST, an SSH destination, or RCF_TARGET_URL)';
const SET_UP_MINUTES = 60;
const FIRST_REPLY_MINUTES = 30;
const STEPS = ['yes', 'claudeCode', 'signIn', 'appleTools', 'naming', 'ownerFolder', 'layDown', 'backup', 'health', 'phone',
  'firstConversation'];

// The apps whose windows set-up may open: set-up itself, the browser (the
// https handler, and Safari), System Settings, Gatekeeper's own message,
// Apple's tools dialog and the Claude app.
const ALLOWED = ['com.stravica.squire', 'com.apple.Safari', 'com.apple.systempreferences', 'com.apple.coreservices.uiagent',
  'com.apple.dt.CommandLineTools.installondemand', 'com.anthropic.claudefordesktop'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function onTarget(command, { input = '', timeout = 60000 } = {}) {
  const r = spawnSync('ssh', ['-o', 'BatchMode=yes', TARGET, command], { input, encoding: 'utf8', timeout });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error ? String(r.error.message) : '' };
}

// Read-only: the user, the app, Apple's tools, set-up's record, the owner's
// folder and the default browser, as JSON.
const LOOK = String.raw`
import json, os, plistlib, pwd, subprocess, sys
app = os.path.expanduser(sys.argv[1])
home = os.environ.get('SQUIRE_HOME') or os.path.expanduser('~/Library/Application Support/Squire')
uid = os.getuid()
out = {'uid': uid, 'user': pwd.getpwuid(uid).pw_name, 'host': os.uname().nodename, 'home': home, 'app': app,
       'appPresent': os.path.isfile(os.path.join(app, 'Contents', 'MacOS', 'Squire'))}
r = subprocess.run(['/usr/bin/xcode-select', '-p'], capture_output=True, text=True)
out['toolsPresent'] = r.returncode == 0 and os.path.isdir(r.stdout.strip())
try:
    with open(os.path.join(home, 'set-up.json')) as f:
        out['record'] = json.load(f)
except Exception:
    out['record'] = None
try:
    with open(os.path.expanduser('~/Squire/squire.json')) as f:
        out['ownerConfig'] = json.load(f)
except Exception:
    out['ownerConfig'] = None
out['ownerFolder'] = os.path.isdir(os.path.expanduser('~/Squire'))
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

// The on-screen windows: number, owner pid, owner name, layer, and the
// owner's bundle identifier where lsappinfo gives one.
const WINDOWS = String.raw`
ObjC.import('CoreGraphics');
ObjC.import('Foundation');
function run() {
  const list = ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, $.kCGNullWindowID));
  const out = [];
  for (let i = 0; i < list.count; i++) {
    const d = list.objectAtIndex(i);
    const get = (k) => { const v = d.objectForKey(k); return v.isNil() ? null : ObjC.unwrap(v); };
    out.push({ number: get('kCGWindowNumber'), pid: get('kCGWindowOwnerPID'), owner: get('kCGWindowOwnerName'), layer: get('kCGWindowLayer') });
  }
  return JSON.stringify(out);
}
`;

function look() {
  const r = onTarget(`/usr/bin/python3 - ${JSON.stringify(APP)}`, { input: LOOK });
  assert.equal(r.status, 0, `the target must answer over SSH; got exit ${r.status} ${r.stderr.trim()} ${r.error}`);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

function windows() {
  const r = onTarget('/usr/bin/osascript -l JavaScript -', { input: WINDOWS });
  assert.equal(r.status, 0, `the target's window list must be readable over SSH; got exit ${r.status} ${r.stderr.trim()}`);
  const list = JSON.parse(r.stdout.trim());
  const pids = [...new Set(list.filter((x) => x.layer === 0).map((x) => x.pid))];
  const ids = {};
  for (const pid of pids) {
    const b = onTarget(`/usr/bin/lsappinfo info -only bundleid ${Number(pid)}`);
    const m = /"CFBundleIdentifier"="([^"]+)"/.exec(b.stdout);
    ids[pid] = m ? m[1] : null;
  }
  return list.map((x) => ({ ...x, bundleId: x.layer === 0 ? ids[x.pid] : undefined }));
}

function refuseOwnUser(state) {
  assert.ok(!(state.uid === process.getuid() && state.host === os.hostname()),
    'the target is the user running these tests on this machine; a release-Verify test never sets Squire up there');
}

// The answer source of the no-Terminal test: a zsh script named osascript
// answering set-up's windows by title (a fresh Mac has zsh before Apple's
// tools), in a temporary folder on the target.
const ANSWERS = String.raw`#!/bin/zsh
text="$*"
[[ -t 0 ]] || text+=" $(/bin/cat)"
case "$text" in
  *"Squire: your Claude plan"*) print -r -- "Pro" ;;
  *"Squire: set up"*) print -r -- "button returned:Install" ;;
  *"Squire: name your Squire"*) print -r -- "button returned:OK, text returned:Juniper" ;;
  *"Squire: your Squire's personality"*) print -r -- "button returned:OK, text returned:Warm, brief and dry" ;;
  *"Squire: your plan"*) print -r -- "button returned:Continue" ;;
  *"Squire: your phone"*) print -r -- "button returned:Later" ;;
  *"Squire: "*) print -r -- "button returned:OK" ;;
  *) exec /usr/bin/osascript "$@" ;;
esac
`;

test("setting Squire up from the download on a fresh Mac user opens no Terminal window: every new window belongs to set-up, the browser, System Settings, Apple's tools dialog or the Claude app", { skip: SKIP, timeout: (SET_UP_MINUTES + 10) * 60000 }, async (t) => {
  if (SKIP) { t.skip(SKIP); return; }
  const state = look();
  refuseOwnUser(state);
  assert.ok(state.appPresent, `Squire's app must be on the target at ${APP}, as the download places it`);
  if (state.browser) ALLOWED.push(state.browser);
  const made = onTarget('/usr/bin/mktemp -d -t squire-answers');
  assert.equal(made.status, 0, 'a temporary folder on the target for the answer source');
  const folder = made.stdout.trim();
  t.after(() => onTarget(`/bin/rm -rf ${JSON.stringify(folder)}`));
  assert.equal(onTarget(`/bin/mkdir ${JSON.stringify(folder + '/bin')} && /bin/cat > ${JSON.stringify(folder + '/bin/osascript')} && /bin/chmod 755 ${JSON.stringify(folder + '/bin/osascript')}`, { input: ANSWERS }).status, 0,
    'the answer source must be laid on the target');
  const before = new Set(windows().map((x) => x.number));
  const opened = onTarget(`/usr/bin/open -n --env PATH=${JSON.stringify(folder + '/bin:/usr/bin:/bin:/usr/sbin:/sbin')} ${JSON.stringify(state.app)}`);
  assert.equal(opened.status, 0, `the app must open on the target; got ${opened.stderr.trim()}`);
  const end = Date.now() + SET_UP_MINUTES * 60000;
  for (;;) {
    for (const win of windows()) {
      if (before.has(win.number) || win.layer !== 0) continue;
      assert.ok(win.bundleId, `a window opened during set-up whose app cannot be told (owner ${win.owner}, pid ${win.pid}): it fails, never passes`);
      assert.ok(ALLOWED.includes(win.bundleId), `a window of ${win.owner} (${win.bundleId}) opened during set-up; only set-up, the browser, System Settings, Apple's tools dialog and the Claude app may open one`);
      before.add(win.number);
    }
    const now = look();
    if (now.record && (now.record.done || []).includes('firstConversation')) break;
    assert.ok(Date.now() < end, `set-up must finish within ${SET_UP_MINUTES} minutes (Open Anyway and the browser sign-in are by hand); its record: ${JSON.stringify(now.record)}`);
    await sleep(2000);
  }
});

test('the first-run journey on a fresh Mac user: from the download, every set-up step runs in order without Terminal, and the owner gets a first reply from their Squire, named', { skip: SKIP, timeout: (SET_UP_MINUTES + FIRST_REPLY_MINUTES + 10) * 60000 }, async (t) => {
  if (SKIP) { t.skip(SKIP); return; }
  const state = look();
  refuseOwnUser(state);
  assert.ok(state.appPresent, `Squire's app must be on the target at ${APP}, as the download places it`);
  if (state.toolsPresent) t.diagnostic('not from zero: Apple\'s command line tools were present before set-up ran');
  const opened = onTarget(`/usr/bin/open ${JSON.stringify(state.app)}`);
  assert.equal(opened.status, 0, `the app must open on the target; got ${opened.stderr.trim()}`);
  // The owner clicks Open Anyway, answers set-up's windows and signs in.
  let now = state;
  const end = Date.now() + SET_UP_MINUTES * 60000;
  while (!(now.record && (now.record.done || []).includes('firstConversation'))) {
    assert.ok(Date.now() < end, `set-up must finish within ${SET_UP_MINUTES} minutes; its record: ${JSON.stringify(now.record)}`);
    await sleep(5000);
    now = look();
  }
  assert.deepEqual(now.record.done, STEPS, 'every set-up step must be recorded done, in order');
  assert.ok(now.ownerFolder, 'the owner\'s folder must be ~/Squire');
  const name = now.ownerConfig && now.ownerConfig.squireName;
  assert.ok(typeof name === 'string' && name.trim(), 'the owner\'s squire.json must hold the Squire\'s name');
  const signedIn = onTarget(String.raw`for c in ~/.local/bin/claude /usr/local/bin/claude /opt/homebrew/bin/claude; do [ -x "$c" ] && { "$c" --version >/dev/null && CLAUDE_CONFIG_DIR="$HOME/Library/Application Support/Squire/claude-config" "$c" auth status; exit $?; }; done; exit 9`);
  assert.equal(signedIn.status, 0, `Claude Code must be installed and signed in into Squire's config folder; got ${signedIn.stdout} ${signedIn.stderr}`);
  assert.equal(JSON.parse(signedIn.stdout).loggedIn, true, 'Claude Code must answer signed in for Squire\'s config folder');
  // The session: one record whose process is alive and listens; then the
  // owner's first message at claude.ai/code, and the Squire's first reply,
  // read from the session's own transcript in the config folder.
  const REPLY = String.raw`
import glob, json, os, socket, sys
home = os.path.expanduser('~/Library/Application Support/Squire')
name = sys.argv[1]
out = {'live': False, 'reply': None}
recs = []
for f in glob.glob(os.path.join(home, 'sessions', '*.json')):
    try:
        recs.append(json.load(open(f)))
    except Exception:
        pass
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
        for line in open(f, errors='replace'):
            try:
                e = json.loads(line)
            except Exception:
                continue
            m = e.get('message') or {}
            if e.get('type') == 'assistant' and isinstance(m.get('content'), list):
                text = ' '.join(c.get('text', '') for c in m['content'] if c.get('type') == 'text')
                if text.strip():
                    out['reply'] = text
                    break
print(json.dumps(out))
`;
  const replyEnd = Date.now() + FIRST_REPLY_MINUTES * 60000;
  let seen = null;
  for (;;) {
    const r = onTarget(`/usr/bin/python3 - ${JSON.stringify(name)}`, { input: REPLY });
    assert.equal(r.status, 0, `the target must answer; got ${r.stderr}`);
    seen = JSON.parse(r.stdout.trim().split('\n').pop());
    if (seen.reply) break;
    assert.ok(Date.now() < replyEnd, `the owner's first message must get a reply within ${FIRST_REPLY_MINUTES} minutes; the session: ${JSON.stringify(seen)}`);
    await sleep(10000);
  }
  assert.ok(seen.live, 'the session must be running: one record whose process is alive and listens');
  assert.ok(seen.reply.includes(name), `the Squire's first reply must name the Squire (${name}); it said: ${seen.reply.slice(0, 300)}`);
});
