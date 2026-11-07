'use strict';

// Secrets, through core's secret helper as a process:
//
//   core/tools/secret.py run <name> --as <ENV_VAR> -- <command> [args...]
//
// fetches the secret <name> from the Keychain at that moment and runs the
// command with the secret in <ENV_VAR>, passing the command's output on with
// every trace of the secret kept out. The Keychain is the one SQUIRE_HOME's
// squire.json names (a temporary keychain of the test's own; the login
// keychain is never read or written), and a secret lives in a generic
// password item with service "squire" and the secret's name as its account.
//
// The tool that needs the secret is careless on purpose: it prints the secret
// on both its outputs (tests/fixtures/tools/needs-secret.js).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const w = require('../fixtures/squire-world.js');

const SECRET_HELPER = path.join(w.CORE, 'tools', 'secret.py');

function secretsWorld(t) {
  const world = w.makeWorld();
  t.after(() => w.cleanUp(world));
  w.makeKeychain(world);
  w.plantOverlays(world.owner, [w.CORE]);
  return world;
}

// Runs the careless tool through the helper; returns the helper's result and
// what the tool saw.
function useSecret(world, name, label, { env = {} } = {}) {
  const hashFile = path.join(world.root, `${label}.sha256`);
  const ranMarker = path.join(world.root, `${label}.ran`);
  const r = w.runPython(world, SECRET_HELPER,
    ['run', name, '--as', 'SERVICE_TOKEN', '--', process.execPath, w.NEEDS_SECRET, 'SERVICE_TOKEN', hashFile, ranMarker],
    { env, timeout: 20000 });
  return {
    r,
    toolRan: fs.existsSync(ranMarker),
    toolGotHash: fs.existsSync(hashFile) ? fs.readFileSync(hashFile, 'utf8') : null,
  };
}

// What Claude Code keeps of a tool run: the command's output in the transcript.
function recordInTranscript(world, r) {
  fs.appendFileSync(world.transcript, JSON.stringify({ type: 'tool_result', stdout: r.stdout, stderr: r.stderr }) + '\n');
}

test('a secret used through the helper across normal work is in the Keychain and nowhere else', { timeout: 120000 }, (t) => {
  const world = secretsWorld(t);
  const secret = w.newSecret();
  w.storeSecret(world.keychain, 'site-token', secret);

  // Normal work: the floor sees the command that uses the helper, the helper
  // hands the secret to the tool three times, and one lookup of a secret that
  // does not exist fails.
  const session = 'session-with-a-secret';
  const command = `/usr/bin/python3 "${SECRET_HELPER}" run site-token --as SERVICE_TOKEN -- python3 add-ons/invoice-helper/run.py`;
  w.assertAllowed(w.attempt(world, session, w.tools.bash(command)), 'running a local tool with a secret');
  w.ownerSays(world, session, 'Thanks, carry on.');
  for (const label of ['first', 'second', 'third']) {
    const used = useSecret(world, 'site-token', label);
    assert.equal(used.r.status, 0, `the helper must run the tool with the secret (${label} use); got ${w.describe(used.r)}`);
    assert.equal(used.toolGotHash, w.sha256(secret), `the tool must get the secret (${label} use)`);
    recordInTranscript(world, used.r);
  }
  const missing = useSecret(world, 'no-such-token', 'missing');
  assert.notEqual(missing.r.status, 0, `a secret that is not in the Keychain must not be handed over; got ${w.describe(missing.r)}`);
  recordInTranscript(world, missing.r);

  // The secret is in the Keychain...
  assert.equal(w.readSecret(world.keychain, 'site-token'), secret, 'the secret must still be in the Keychain');
  // ...and nowhere else: not in the owner's folder (its pages, state and
  // files, which the nightly backup copies), not in Squire's home, not in the
  // transcript.
  const hits = w.filesHolding([world.owner, world.home, world.transcript], secret);
  assert.deepEqual(hits, [], `the secret must be nowhere but the Keychain; found in: ${hits.join(', ')}`);
});

test('the helper hands the secret to the tool without showing it, and stops with directions when the Keychain cannot supply it', { timeout: 120000 }, (t) => {
  const world = secretsWorld(t);
  const secret = w.newSecret();
  w.storeSecret(world.keychain, 'site-token', secret);
  const decoy = w.newSecret();
  // Places a fallback would look: a file in the owner's folder, a file in
  // Squire's home and the environment. None may ever be used.
  fs.writeFileSync(path.join(world.owner, '.env'), `SERVICE_TOKEN=${decoy}\nSITE_TOKEN=${decoy}\n`);
  fs.mkdirSync(path.join(world.owner, 'secrets'), { recursive: true });
  fs.writeFileSync(path.join(world.owner, 'secrets', 'site-token'), decoy);
  fs.writeFileSync(path.join(world.home, 'site-token'), decoy);
  const decoyEnv = { SERVICE_TOKEN: decoy, SITE_TOKEN: decoy, SQUIRE_SECRET_SITE_TOKEN: decoy };

  // Fetched when needed, and never shown.
  const used = useSecret(world, 'site-token', 'unlocked', { env: decoyEnv });
  assert.equal(used.r.status, 0, `the helper must run the tool with the secret; got ${w.describe(used.r)}`);
  assert.equal(used.toolGotHash, w.sha256(secret), 'the tool must get the secret from the Keychain');
  assert.match(used.r.stdout, /status: ok/, `the tool's own output must come through; got ${w.describe(used.r)}`);
  for (const [stream, text] of [['stdout', used.r.stdout], ['stderr', used.r.stderr]]) {
    assert.ok(!text.includes(secret), `the helper's ${stream} must hold no trace of the secret`);
    assert.ok(!text.includes(Buffer.from(secret).toString('base64')), `the helper's ${stream} must hold no trace of the secret`);
  }

  // When the Keychain cannot supply the secret, the work stops, the owner is
  // told what to do, and nothing falls back.
  const assertStopped = (u, what, direction) => {
    assert.notEqual(u.r.status, 0, `${what}: the helper must stop; got ${w.describe(u.r)}`);
    assert.equal(u.r.signal, null, `${what}: the helper must stop by itself, not wait on a prompt; got ${w.describe(u.r)}`);
    assert.equal(u.toolRan, false, `${what}: the tool must not run, with any secret`);
    const said = u.r.stdout + u.r.stderr;
    assert.match(said, direction, `${what}: the helper must tell the owner what to do; got ${w.describe(u.r)}`);
    assert.ok(!said.includes(secret) && !said.includes(decoy), `${what}: no secret in the helper's output`);
  };

  w.lockKeychain(world.keychain);
  assertStopped(useSecret(world, 'site-token', 'locked', { env: decoyEnv }), 'the Keychain is locked', /lock/i);
  w.unlockKeychain(world.keychain);

  assertStopped(useSecret(world, 'other-token', 'lacking', { env: decoyEnv }), 'the Keychain lacks the secret', /other-token/);

  w.writeConfig(world, { keychain: path.join(world.root, 'no-such.keychain-db') });
  assertStopped(useSecret(world, 'site-token', 'unavailable', { env: decoyEnv }), 'the Keychain is unavailable', /keychain/i);
});
