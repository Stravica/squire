'use strict';

// Code hygiene for how Squire Update and the weekly check read the health
// check (core/tools/update.py, HealthLines.read_within and
// HealthLines.problem): the wait on the check is bounded, a check that does
// not finish in time reads as one that could not run, never as a pass, and
// the problem is named in the check's own plain words, each fault line up to
// its first semicolon, lines that are not faults left out. Bound to no
// criterion. Nothing is installed or fetched: the module is loaded in-process
// and its health read is replaced for each case.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const w = require('../fixtures/squire-world.js');

const UPDATE = path.join(w.CORE, 'tools', 'update.py');

function run(lines) {
  const r = spawnSync(w.PYTHON, ['-c', lines.join('\n'), UPDATE], { encoding: 'utf8', timeout: 60000, env: { PATH: '/usr/bin:/bin', PYTHONDONTWRITEBYTECODE: '1' } });
  assert.equal(r.status, 0, `the Python ran; got ${r.status} ${r.stderr}`);
  return JSON.parse(r.stdout);
}

const LOAD = [
  'import importlib.util, json, sys, time',
  'spec = importlib.util.spec_from_file_location("update_under_test", sys.argv[1])',
  'update = importlib.util.module_from_spec(spec)',
  'spec.loader.exec_module(update)',
  'H = update.HealthLines',
];

test('the wait on the health check is bounded: a check that does not finish in time, or cannot run, reads as could not run; one that finishes gives its lines', { timeout: 60000 }, () => {
  const got = run([
    ...LOAD,
    'out = {}',
    'H.read = staticmethod(lambda config: (time.sleep(5), ["floor: late"])[1])',
    'started = time.monotonic()',
    'out["hangs"] = H.read_within(None, 0.5)',
    'out["waited"] = time.monotonic() - started',
    'H.read = staticmethod(lambda config: None)',
    'out["cannot run"] = H.read_within(None, 5)',
    'H.read = staticmethod(lambda config: ["agents: all loaded"])',
    'out["finishes"] = H.read_within(None, 5)',
    'print(json.dumps(out))',
  ]);
  assert.equal(got.hangs, null, 'a check that does not finish in time reads as one that could not run');
  assert.ok(got.waited < 3, `the wait is bounded; it waited ${got.waited} s`);
  assert.equal(got['cannot run'], null);
  assert.deepEqual(got.finishes, ['agents: all loaded']);
});

test("the problem is named in the check's own words: each fault line up to its first semicolon, a line the check cannot classify among them, lines that are not faults left out; a check that could not run says so; no fault, no problem", { timeout: 60000 }, () => {
  const got = run([
    ...LOAD,
    'print(json.dumps({',
    '  "none": H.problem(None),',
    '  "faults": H.problem(["floor: hooks/a.py has changed since core was laid down; ask for its fix: x", "ignored: y", "sign-in: ended"]),',
    '  "unknown": H.problem(["something odd"]),',
    '  "clean": H.problem(["ignored: y", "backup: fine"]),',
    '  "empty": H.problem([]),',
    '}))',
  ]);
  assert.match(got.none, /could not run/);
  assert.equal(got.faults, 'floor: hooks/a.py has changed since core was laid down; sign-in: ended');
  assert.equal(got.unknown, 'something odd', 'a line the check cannot classify is a problem named as it reads');
  assert.equal(got.clean, null);
  assert.equal(got.empty, null);
});
