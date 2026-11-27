'use strict';

// Code hygiene for the health check's not-tested line (core/tools/health.py,
// TestedLine): one line only when the Claude Code the launcher answers is
// newer than the release's claudeCodeTested, compared as three whole numbers;
// none when either cannot be read or Claude Code is at or below it. Driven
// through /usr/bin/python3 with a home of its own and a launcher that answers
// the version it is given. Bound to no criterion.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CORE = path.join(__dirname, '..', '..', 'core');

function lines(t, tested, answer) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'squire-test-tested-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, 'core'), { recursive: true });
  const release = { version: '0.0.1' };
  if (tested !== undefined) release.claudeCodeTested = tested;
  fs.writeFileSync(path.join(home, 'core', 'release.json'), JSON.stringify(release));
  const bin = path.join(root, 'user', '.local', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(answer)}\n`, { mode: 0o755 });
  const driver = path.join(root, 'driver.py');
  fs.writeFileSync(driver, [
    'import json, sys',
    `sys.path.insert(0, ${JSON.stringify(path.join(CORE, 'lib'))})`,
    `sys.path.insert(0, ${JSON.stringify(path.join(CORE, 'tools'))})`,
    'import importlib.util',
    `spec = importlib.util.spec_from_file_location('health', ${JSON.stringify(path.join(CORE, 'tools', 'health.py'))})`,
    'health = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(health)',
    'print(json.dumps(health.TestedLine.lines(sys.argv[1])))',
    '',
  ].join('\n'));
  const r = spawnSync('/usr/bin/python3', ['-B', driver, home], { encoding: 'utf8', timeout: 30000,
    env: { PATH: '/usr/bin:/bin', HOME: path.join(root, 'user'), LANG: 'en_US.UTF-8' } });
  assert.equal(r.status, 0, `the driver must run; stderr: ${r.stderr}`);
  return JSON.parse(r.stdout.trim());
}

test('one line naming both versions when Claude Code is newer than the tested version, compared part by part as numbers', (t) => {
  const got = lines(t, '1.2.9', '1.2.10 (Claude Code)');
  assert.equal(got.length, 1, `one line; got ${JSON.stringify(got)}`);
  assert.ok(got[0].includes('1.2.10') && got[0].includes('1.2.9') && /not yet been tested/.test(got[0]), `the line names both versions; got ${got[0]}`);
});

test('no line at or below the tested version', (t) => {
  assert.deepEqual(lines(t, '1.2.10', '1.2.10 (Claude Code)'), [], 'at the tested version');
  assert.deepEqual(lines(t, '1.2.10', '1.2.9 (Claude Code)'), [], 'below the tested version');
});

test('no line when the release names no tested version, or either version cannot be read', (t) => {
  assert.deepEqual(lines(t, undefined, '9.9.9 (Claude Code)'), [], 'no tested version');
  assert.deepEqual(lines(t, 'newest', '9.9.9 (Claude Code)'), [], 'a tested version that is a word');
  assert.deepEqual(lines(t, 2.1, '9.9.9 (Claude Code)'), [], 'a tested version that is a number');
  assert.deepEqual(lines(t, '1.0.0', 'Claude Code'), [], 'a Claude Code answer with no version');
  assert.deepEqual(lines(t, '1.0.0', '9.9 (Claude Code)'), [], 'a Claude Code answer that is not three numbers');
});
