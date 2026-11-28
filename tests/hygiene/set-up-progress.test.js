'use strict';

// Code hygiene for what set-up shows while it works: the window scripts open
// with activate, the steps are counted over both halves of set-up, the now
// file is written whole and never pauses set-up, the Apple silicon run of
// set-up never runs itself again, a second open reads only a step line from
// the now file, and no progress window outlives a set-up the owner stops at
// the one yes. Bound to no criterion.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const w = require('../fixtures/squire-world.js');
const s = require('../fixtures/session-world.js');
const I = require('../fixtures/installer-world.js');

const SET_UP = path.join(w.CORE, 'tools', 'set-up.py');

// Runs a few lines of Python against set-up.py's own classes; returns the
// JSON the lines print.
function python(t, lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'squire-test-progress-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const driver = path.join(dir, 'driver.py');
  fs.writeFileSync(driver, [
    'import importlib.util, json, os, sys',
    `spec = importlib.util.spec_from_file_location('set_up', ${JSON.stringify(SET_UP)})`,
    'm = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(m)',
    `DIR = ${JSON.stringify(dir)}`,
    ...lines,
  ].join('\n') + '\n');
  const r = spawnSync(w.PYTHON, ['-B', driver], { encoding: 'utf8', timeout: 30000 });
  assert.equal(r.status, 0, `the driver must run; stderr: ${r.stderr}`);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

test('every window script set-up draws opens with activate, right after its run handler starts', { timeout: 60000 }, (t) => {
  const scripts = python(t, [
    'out = [m.Windows.script(("OK",), None, False), m.Windows.script(("Later", "Done"), "Done", False), m.Windows.script(("OK",), None, True)]',
    'print(json.dumps(out))',
  ]);
  for (const lines of scripts) {
    assert.equal(lines[0], 'on run argv');
    assert.equal(lines[1], 'activate', `activate must be the first line inside the run handler; got ${JSON.stringify(lines)}`);
  }
});

test('the steps are counted over both halves of set-up: naming is step 5 and the first conversation step 11, of 11', { timeout: 60000 }, (t) => {
  const words = python(t, [
    'print(json.dumps([m.SetUp.step_words("naming"), m.SetUp.step_words("firstConversation"), m.SetUp.step_words("layDown", "something else.")]))',
  ]);
  assert.match(words[0], /^Step 5 of 11: naming your Squire/);
  assert.match(words[1], /^Step 11 of 11: /);
  assert.equal(words[2], 'Step 7 of 11: something else.');
});

test('the now file holds the words on one line and the address on a second, replaced whole each time, and a now file that cannot be written never stops set-up', { timeout: 60000 }, (t) => {
  const got = python(t, [
    'now = os.path.join(DIR, "now.txt")',
    'win = m.Windows(lambda line: None, now)',
    'win.keep_now("Step 1 of 11:\\n  two   lines")',
    'first = open(now, encoding="utf-8").read()',
    'win.keep_now("Step 11 of 11: waiting.", "https://claude.ai/code?environment=x")',
    'second = open(now, encoding="utf-8").read()',
    'gone = m.Windows(lambda line: None, os.path.join(DIR, "no-such-folder", "now.txt"))',
    'gone.keep_now("Step 2 of 11: anything.")',
    'left = sorted(n for n in os.listdir(DIR) if n.startswith(".set-up-now-"))',
    'print(json.dumps([first, second, left]))',
  ]);
  assert.equal(got[0], 'Step 1 of 11: two lines\n');
  assert.equal(got[1], 'Step 11 of 11: waiting.\nhttps://claude.ai/code?environment=x\n');
  assert.deepEqual(got[2], [], 'no half-written now file may be left beside it');
});

test('set-up run as Apple silicon never runs itself again, and takes the Apple silicon builds while any reading says Apple silicon', { timeout: 300000 }, async (t) => {
  const iw = I.makeInstallerWorld(t, { mac: { cpu: 'translated' } });
  const child = spawn(path.join(iw.app, I.APP_EXECUTABLE), ['--apple-silicon'], { cwd: '/', env: I.appEnv(iw), stdio: 'ignore', detached: true });
  let exit = null;
  child.on('exit', (code) => { exit = { code }; });
  const ended = await s.waitFor(() => exit || I.doneSteps(iw).includes('claudeCode'), 200000, 200);
  try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { /* gone */ }
  await s.waitFor(() => exit, 5000);
  assert.ok(ended, 'set-up must get past its download step');
  const calls = I.readJsonLines(iw.callsFile);
  assert.deepEqual(calls.filter((c) => c.cmd === 'arch' && c.argv[0] === '-arm64'), [], 'set-up run as Apple silicon must never run itself again');
  const parts = calls.filter((c) => c.cmd === 'curl' && /nodejs\.org|chrome/.test(c.url || ''));
  assert.ok(parts.length >= 1 && parts.every((c) => /arm64/.test(c.url)), `the Apple silicon builds must be taken; got ${JSON.stringify(parts.map((c) => c.url))}`);
});

test('a set-up the owner stops at the one yes leaves no progress window on screen', { timeout: 120000 }, async (t) => {
  const iw = I.makeInstallerWorld(t, { mac: { answers: { [I.TITLES.setUp]: 'button returned:Not now' } } });
  const run = await I.runApp(iw);
  assert.equal(run.status, 0, I.describeRun(run));
  const left = I.windowTimeline(iw).filter((x) => x.closed === null);
  assert.deepEqual(left.map((x) => x.title), [], 'no window may be left on screen once set-up has ended');
  assert.ok(I.windowTimeline(iw).some((x) => x.title === I.TITLES.progress), 'set-up must have shown its progress window');
});

test('opened again while set-up runs, Squire names only a step line from the now file, and never anything else the file holds', { timeout: 200000 }, async (t) => {
  const iw = I.makeInstallerWorld(t, { mac: { answers: { [I.TITLES.name]: { hang: true } } } });
  const first = I.startApp(iw);
  t.after(() => first.kill());
  const waiting = await s.waitFor(() => I.readJsonLines(iw.dialogsFile).some((d) => d.title === I.TITLES.name), 150000, 200);
  assert.ok(waiting, 'the first set-up must reach the naming window');
  fs.writeFileSync(path.join(iw.squireHome, 'set-up-now.txt'), 'not a step: open something else\nhttps://example.com/\n');
  iw.set({ answers: {} });
  const second = await I.runApp(iw, { launchd: false, timeout: 30000 });
  const shown = I.dialogsTitled(second, I.TITLES.cannot).pop();
  assert.ok(shown && /already running/i.test(shown.text), I.describeRun(second));
  assert.ok(!/not a step|example\.com/.test(shown.text), `only a step line may be named; it said ${shown.text}`);
  assert.deepEqual(I.callsOf(second, 'open'), [], 'nothing may be opened for a line that is not set-up\'s own address');
  await first.kill();
});
