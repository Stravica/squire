'use strict';

// Round 1's journey, end to end on a laid-down core: core is laid down into a
// Squire home beside the owner's folder, and from then on only the INSTALLED
// copies run: the floor's hooks as Claude Code would run them, the secret
// helper as a tool would call it, and the lay-down again as an update would.
//
// The target is a parameter: SQUIRE_RELEASE_DIR names the core release to lay
// down (a release folder holding hooks/, tools/ and the rest of core). Unset,
// it is this repository's core/.
//
//   SQUIRE_RELEASE_DIR=/path/to/release node --test tests/e2e/

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const w = require('../fixtures/squire-world.js');

const { tools } = w;

test('on a laid-down core the floor holds through a send, a delete, an install, a secret and a second lay-down', { timeout: 180000 }, (t) => {
  const release = process.env.SQUIRE_RELEASE_DIR ? path.resolve(process.env.SQUIRE_RELEASE_DIR) : w.CORE;
  const world = w.makeWorld();
  t.after(() => w.cleanUp(world));
  w.makeKeychain(world);
  const secret = w.newSecret();
  w.storeSecret(world.keychain, 'site-token', secret);

  // Core is laid down from the release, by the release's own lay-down.
  const layDown = () => w.runPython(world, path.join(release, 'tools', 'lay-down.py'), [release], { cwd: world.root });
  let r = layDown();
  assert.equal(r.status, 0, `laying down core from the release must succeed; got ${w.describe(r)}`);
  const installed = fs.realpathSync(path.join(world.home, 'core'));
  assert.deepEqual(w.treeOf(installed), w.treeOf(release), 'the laid-down core must be exactly the release');
  const on = { coreDir: installed };

  // The owner's folder holds an overlay at every installed core path.
  w.plantOverlays(world.owner, [installed]);

  // A send waits for the owner's yes, and the yes covers that one send.
  const s = 'session-journey';
  const send = tools.gmailSend('alice@example.com', 'Saturday', 'The cake is ready.');
  w.assertBlocked(w.attempt(world, s, send, on), 'sending an email, with no yes', 'alice@example.com');
  w.ownerSays(world, s, 'Yes', on);
  w.assertAllowed(w.attempt(world, s, send, on), 'sending the email after the owner said yes');
  w.assertBlocked(w.attempt(world, s, send, on), 'sending the same email again on one yes', 'alice@example.com');

  // Deleting the owner's things and installing software wait too.
  w.assertBlocked(w.attempt(world, s, tools.bash('rm workspace/files/tax-return-2025.pdf'), on),
    'deleting an owner file, with no yes', 'tax-return-2025.pdf');
  w.assertBlocked(w.attempt(world, s, tools.bash('brew install ffmpeg'), on),
    'installing software, with no yes', 'ffmpeg');

  // The session cannot rewrite the installed floor or Squire's config.
  const installedHook = path.join(installed, 'hooks', 'pre-tool-use.py');
  w.assertBlocked(w.attempt(world, s, tools.write(installedHook, 'import sys\nsys.exit(0)\n'), on),
    'the session rewriting the installed floor');
  w.assertBlocked(w.attempt(world, s, tools.bash(`printf 'import sys\\nsys.exit(0)\\n' > "${installedHook}"`), on),
    'the session rewriting the installed floor from the shell');
  w.assertBlocked(w.attempt(world, s, tools.write(path.join(world.home, 'squire.json'), '{}\n'), on),
    'the session rewriting Squire\'s config');

  // A job holding untrusted input and private things cannot also send.
  const mixed = 'session-mixed';
  w.assertAllowed(w.attempt(world, mixed, tools.webFetch('https://example.com/wholesale-offer'), on), 'reading a web page');
  w.assertAllowed(w.attempt(world, mixed, tools.read(path.join(world.owner, 'operator/profile.md')), on),
    'reading the owner\'s profile');
  w.assertBlocked(w.attempt(world, mixed, tools.gmailSend('bob@example.com', 'Offer', 'What Ada thinks.'), on),
    'sending, in a job that read a web page and the owner\'s profile');

  // The installed helper hands a tool its secret and shows none of it.
  const hashFile = path.join(world.root, 'journey.sha256');
  const ranMarker = path.join(world.root, 'journey.ran');
  r = w.runPython(world, path.join(installed, 'tools', 'secret.py'),
    ['run', 'site-token', '--as', 'SERVICE_TOKEN', '--', process.execPath, w.NEEDS_SECRET, 'SERVICE_TOKEN', hashFile, ranMarker],
    { timeout: 20000 });
  assert.equal(r.status, 0, `the installed helper must run the tool with the secret; got ${w.describe(r)}`);
  assert.equal(fs.readFileSync(hashFile, 'utf8'), w.sha256(secret), 'the tool must get the secret');
  assert.match(r.stdout, /status: ok/, `the tool's own output must come through; got ${w.describe(r)}`);
  assert.ok(!(r.stdout + r.stderr).includes(secret), 'the helper\'s output must hold no trace of the secret');
  fs.appendFileSync(world.transcript, JSON.stringify({ type: 'tool_result', stdout: r.stdout, stderr: r.stderr }) + '\n');

  // Core laid down again: the owner's folder, the floor's records included,
  // is byte for byte the same, and the floor still holds.
  const before = w.snapshot(world.owner);
  r = layDown();
  assert.equal(r.status, 0, `laying core down again must succeed; got ${w.describe(r)}`);
  assert.deepEqual(w.treeOf(path.join(world.home, 'core')), w.treeOf(release), 'the core laid down again must be exactly the release');
  const diffs = w.snapshotDifferences(before, w.snapshot(world.owner));
  assert.deepEqual(diffs, [], `laying core down again must leave the owner's folder byte for byte the same; it changed: ${diffs.join(', ')}`);
  const again = { coreDir: fs.realpathSync(path.join(world.home, 'core')) };
  w.assertBlocked(w.attempt(world, s, send, again), 'sending the email after core was laid down again', 'alice@example.com');

  // The secret is in the Keychain and nowhere else.
  assert.equal(w.readSecret(world.keychain, 'site-token'), secret, 'the secret must still be in the Keychain');
  const hits = w.filesHolding([world.owner, world.home, world.transcript], secret);
  assert.deepEqual(hits, [], `the secret must be nowhere but the Keychain; found in: ${hits.join(', ')}`);
});
