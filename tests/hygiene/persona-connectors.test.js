'use strict';

// Code hygiene for what Squire's own block tells the session of connectors
// (core/lib/squire.py, Persona.block): the check-in brief's sentence, the
// connector's key's sentence and the connector-tools command named by its
// path in the Squire home, with no placeholder. Bound to no criterion. The
// block is built in-process from this core, for a Squire home under the
// test's own temporary folder (a path with a space, as the default home's
// has); nothing is written there.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const w = require('../fixtures/squire-world.js');

const HOME = path.join(os.tmpdir(), 'persona hygiene', 'Squire');

function block() {
  const program = [
    'import sys',
    'sys.path.insert(0, sys.argv[1])',
    'from squire import Persona',
    'sys.stdout.write(Persona.block({}, sys.argv[2]))',
  ].join('\n');
  const r = spawnSync(w.PYTHON, ['-c', program, path.join(w.CORE, 'lib'), HOME], { encoding: 'utf8', timeout: 30000, env: { PATH: '/usr/bin:/bin', PYTHONDONTWRITEBYTECODE: '1' } });
  assert.equal(r.status, 0, `the block was built; got ${r.status} ${r.stderr}`);
  return r.stdout;
}

const sentences = (text) => text.split(/(?<=[.!?])\s+/);

test('Squire\'s block says a check-in brief draws only on the connector tools the owner allowed, that a connector\'s key goes through the secret helper only, and names the connector-tools command by its path in the Squire home', { timeout: 60000 }, () => {
  const text = block();
  const all = sentences(text);
  assert.ok(all.some((s) => /check-in/i.test(s) && /\ballowed\b/.test(s) && /connector/i.test(s)), 'the check-in brief\'s sentence');
  assert.ok(all.some((s) => /connector/i.test(s) && /\bkey\b/.test(s) && /secret helper/.test(s)), 'the connector key\'s sentence');
  const command = `/usr/bin/python3 '${path.join(HOME, 'core', 'tools', 'connector-tools.py')}'`;
  const said = all.find((s) => s.includes(command));
  assert.ok(said, `the command is named as ${command}`);
  assert.doesNotMatch(said, /`|<[a-z ]+>/, 'the command is named in plain words, with no code span and no placeholder');
  for (const verb of ['read', 'draft', 'remove']) assert.match(said, new RegExp(`\\b${verb}\\b`), `the command's ${verb} is named`);
});
