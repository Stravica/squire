'use strict';

// Round 2's release-Verify tests: one Squire session kept running on a real
// Mac, back by itself after a restart, a crash and sleep. They run only
// against a target: a Mac with Squire installed and its session running,
// reached over SSH as the Squire owner's user. The target is a parameter:
//
//   SQUIRE_TARGET_HOST=<ssh destination> node --test tests/e2e/round-2-session.test.js
//
// RCF_TARGET_URL is read when SQUIRE_TARGET_HOST is unset (an ssh:// URL is
// an SSH destination). With neither, each test skips with the line
// "external: needs a target host" and never passes. Each refuses to run,
// failing, when the target is the user running the tests on this machine.
// The target is reached with the ssh on PATH, with no prompt (BatchMode);
// what runs there is read-only inspection, Squire's own entry points and,
// for a restart and a crash, launchctl and kill on Squire's own processes.
//
// What is observed (no surface outside a running session lists an
// account's Remote Control sessions): Squire's runner agent loaded, one
// session record whose process is alive, one Remote Control server, and the
// server's own registration and connected state in logs/session.log in the
// Squire home. The listing in the Claude app on the phone, and putting the
// target to sleep or closing its lid, are by-hand steps of the release Verify.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const TARGET = process.env.SQUIRE_TARGET_HOST || process.env.RCF_TARGET_URL || '';
const SKIP = TARGET ? false : 'external: needs a target host (SQUIRE_TARGET_HOST, an SSH destination, or RCF_TARGET_URL)';
const TWO_MINUTES = 120000;
const WAKE_WAIT_MINUTES = 15;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Runs a command on the target; with a script, Python 3 reads it on stdin.
function onTarget(command, { input = '', timeout = 60000 } = {}) {
  const r = spawnSync('ssh', ['-o', 'BatchMode=yes', TARGET, command], { input, encoding: 'utf8', timeout });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error ? String(r.error.message) : '' };
}

// Read-only: what Squire's session looks like on the target, as JSON.
const LOOK = String.raw`
import glob, json, os, plistlib, pwd, subprocess, sys
home = os.environ.get('SQUIRE_HOME') or os.path.expanduser('~/Library/Application Support/Squire')
uid = os.getuid()
offset = int(sys.argv[1]) if len(sys.argv) > 1 else 0
out = {'uid': uid, 'user': pwd.getpwuid(uid).pw_name, 'host': os.uname().nodename, 'home': home,
       'installed': os.path.isfile(os.path.join(home, 'core', 'tools', 'runner.py'))}
runner = os.path.join(home, 'core', 'tools', 'runner.py')
agents = []
for f in sorted(glob.glob(os.path.expanduser('~/Library/LaunchAgents/*.plist'))):
    try:
        with open(f, 'rb') as fh:
            p = plistlib.load(fh)
    except Exception:
        continue
    if runner in (p.get('ProgramArguments') or []):
        r = subprocess.run(['/bin/launchctl', 'print', 'gui/%d/%s' % (uid, p.get('Label'))], capture_output=True)
        agents.append({'label': p.get('Label'), 'loaded': r.returncode == 0})
out['runnerAgents'] = agents
records = []
for f in sorted(glob.glob(os.path.join(home, 'sessions', '*.json'))):
    try:
        with open(f) as fh:
            rec = json.load(fh)
    except Exception:
        rec = {}
    pid = rec.get('pid')
    alive = False
    if isinstance(pid, int) and pid > 0:
        try:
            os.kill(pid, 0)
            alive = True
        except PermissionError:
            alive = True
        except OSError:
            alive = False
    records.append({'sessionId': rec.get('sessionId'), 'pid': pid, 'alive': alive})
out['records'] = records
ps = subprocess.run(['/bin/ps', '-x', '-o', 'pid=,ppid=,command='], capture_output=True, text=True).stdout
out['servers'] = [{'pid': int(l.split()[0]), 'ppid': int(l.split()[1])} for l in ps.splitlines()
                  if ' remote-control' in l and '--spawn' in l]
log = os.path.join(home, 'logs', 'session.log')
try:
    with open(log, 'rb') as fh:
        data = fh.read()
except OSError:
    data = b''
out['logSize'] = len(data)
out['logSince'] = data[offset:].decode('utf-8', 'replace')[-4000:]
out['logTail'] = data.decode('utf-8', 'replace')[-4000:]
print(json.dumps(out))
`;

function look(offset = 0) {
  const r = onTarget(`/usr/bin/python3 - ${offset}`, { input: LOOK });
  assert.equal(r.status, 0, `the target must answer over SSH; got exit ${r.status} ${r.stderr.trim()} ${r.error}`);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

function refuseOwnUser(state) {
  assert.ok(!(state.uid === process.getuid() && state.host === os.hostname()),
    'the target is the user running these tests on this machine; a release-Verify test never runs Squire\'s session there');
}

// Squire installed on the target with its session running.
function assertRunning(state, what) {
  assert.ok(state.runnerAgents.length === 1 && state.runnerAgents[0].loaded,
    `${what}: Squire must be installed on the target with its runner's launchd agent loaded; found ${JSON.stringify(state.runnerAgents)} (installed core: ${state.installed})`);
  const live = state.records.filter((r) => r.alive);
  assert.equal(state.records.length, 1, `${what}: exactly one session record must be in the Squire home; found ${JSON.stringify(state.records)}`);
  assert.equal(live.length, 1, `${what}: the session record's process must be alive; found ${JSON.stringify(state.records)}`);
  assert.equal(state.servers.length, 1, `${what}: exactly one Remote Control server must run; found ${JSON.stringify(state.servers)}`);
}

// Within two minutes of an event, exactly one session runs again: one record,
// its process alive and new, one server, and the server's own registration
// and connected state written after the event.
async function assertBackWithinTwoMinutes(before, what) {
  const oldPid = before.records[0] && before.records[0].pid;
  const end = Date.now() + TWO_MINUTES;
  let state;
  for (;;) {
    state = look(before.logSize);
    const live = state.records.filter((r) => r.alive);
    if (state.records.length === 1 && live.length === 1 && live[0].pid !== oldPid && state.servers.length === 1
      && /Session started/.test(state.logSince) && /Connected|·/.test(state.logSince)) return state;
    if (Date.now() >= end) break;
    await sleep(5000);
  }
  assert.fail(`${what}: within two minutes exactly one Squire session must be running again, registered and connected; ` +
    `records ${JSON.stringify(state.records)}, servers ${JSON.stringify(state.servers)}, server output since: ${JSON.stringify(state.logSince.slice(-600))}`);
}

test('the session restarted and then crashed is back within two minutes each time as exactly one registered and connected Squire session, and a wake-up fired at it arrives', { skip: SKIP, timeout: 600000 }, async (t) => {
  if (!TARGET) { t.skip('external: needs a target host'); return; }
  const first = look();
  refuseOwnUser(first);
  assertRunning(first, 'before the restart');
  const label = first.runnerAgents[0].label;

  // Restart: Squire's runner stopped and started again by launchd.
  let r = onTarget(`/bin/launchctl kickstart -k gui/$(/usr/bin/id -u)/${label}`);
  assert.equal(r.status, 0, `restarting Squire's runner on the target must succeed; got ${r.status} ${r.stderr}`);
  const afterRestart = await assertBackWithinTwoMinutes(first, 'after a restart');

  // Crash: the server killed outright.
  const server = afterRestart.servers[0].pid;
  r = onTarget(`/bin/kill -9 ${server}`);
  assert.equal(r.status, 0, `killing the server on the target must succeed; got ${r.status} ${r.stderr}`);
  const afterCrash = await assertBackWithinTwoMinutes(afterRestart, 'after a crash');
  assert.ok(!afterCrash.servers.some((s) => s.pid === server), 'the killed server must not be counted as running');

  // A wake-up fired at the restarted session arrives.
  const text = `Release check ${Date.now()}: nothing to do.`;
  t.after(() => {
    const clean = onTarget(`/usr/bin/grep -l -F ${JSON.stringify(text)} "$HOME/Library/Application Support/Squire/wake-ups/"*.json | /usr/bin/xargs -I{} /bin/rm -f {}; ` +
      `/usr/bin/grep -l -F ${JSON.stringify(text)} "$HOME/Library/Application Support/Squire/wake-ups/"*.json; true`);
    assert.equal(clean.stdout.trim(), '', `the wake-up state this test made must be gone from the target; left: ${clean.stdout}`);
  });
  r = onTarget(`/usr/bin/python3 "$HOME/Library/Application Support/Squire/core/tools/wake-up.py" ${JSON.stringify(text)}`);
  assert.equal(r.status, 0, `a wake-up fired at the restarted session must be delivered (exit 0); got ${r.status} ${r.stdout} ${r.stderr}`);
  const states = onTarget(`/bin/cat "$HOME/Library/Application Support/Squire/wake-ups/"*.json`);
  assert.ok(states.stdout.includes(text) && /"state":\s*"delivered"/.test(states.stdout),
    `the wake-up must be recorded delivered on the target; got ${states.stdout.slice(-600)}`);
});

test('after the target sleeps or its lid is closed and it wakes, within two minutes of the wake exactly one Squire session is running, registered and connected', { skip: SKIP, timeout: (WAKE_WAIT_MINUTES + 5) * 60000 }, async (t) => {
  if (!TARGET) { t.skip('external: needs a target host'); return; }
  const first = look();
  refuseOwnUser(first);
  assertRunning(first, 'before sleep');

  // The by-hand step: put the target to sleep or close its lid, then wake it.
  // The wake is read from the target's own power log.
  const lastWake = () => {
    const r = onTarget('/usr/bin/pmset -g log | /usr/bin/grep -E "^[0-9-]+ [0-9:]+ [+-][0-9]{4} Wake " | /usr/bin/tail -1', { timeout: 120000 });
    const m = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) ([+-]\d\d)(\d\d)/.exec(r.stdout.trim());
    return m ? Date.parse(`${m[1].replace(' ', 'T')}${m[2]}:${m[3]}`) : 0;
  };
  const before = lastWake();
  t.diagnostic(`put the target to sleep or close its lid now, then wake it; waiting up to ${WAKE_WAIT_MINUTES} minutes`);
  const end = Date.now() + WAKE_WAIT_MINUTES * 60000;
  let woke = 0;
  while (Date.now() < end) {
    await sleep(15000);
    const latest = lastWake();
    if (latest > before) { woke = latest; break; }
  }
  assert.ok(woke, `the target must sleep and wake within ${WAKE_WAIT_MINUTES} minutes (read from its power log); no new wake was recorded`);

  const deadline = woke + TWO_MINUTES;
  let state;
  for (;;) {
    state = look(first.logSize);
    const live = state.records.filter((r) => r.alive);
    // Connected again after the wake, or never shown as disconnected since
    // and still connected.
    const connected = /Connected|·/.test(state.logSince)
      || (!/disconnect|reconnect|offline|error/i.test(state.logSince) && /Connected|·/.test(state.logTail));
    if (state.records.length === 1 && live.length === 1 && state.servers.length === 1 && connected) break;
    if (Date.now() >= deadline) {
      assert.fail(`within two minutes of the wake exactly one Squire session must be running and connected, so the Squire owner can reach it; ` +
        `records ${JSON.stringify(state.records)}, servers ${JSON.stringify(state.servers)}, server output since: ${JSON.stringify(state.logSince.slice(-600))}`);
    }
    await sleep(5000);
  }
});
