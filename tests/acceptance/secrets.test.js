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

// Every place a secret could land: the owner's folder, Squire's home and its
// logs, the transcript, TMPDIR, the user's home and core, where the helper's
// own files are.
function scanSet(world) {
  return [world.owner, world.home, world.transcript, world.tmp, world.userHome, w.CORE];
}

test('a secret used through the helper across normal work is in the Keychain and nowhere else', { timeout: 120000 }, (t) => {
  const world = secretsWorld(t);
  const secret = w.newSecret();
  // The owner stores the secret through the helper, the value on stdin.
  const set = w.runPython(world, SECRET_HELPER, ['set', 'site-token'], { input: `${secret}\n`, timeout: 20000 });
  assert.equal(set.status, 0, `storing a secret through the helper must succeed; got ${w.describe(set)}`);
  recordInTranscript(world, set);

  // Normal work: the floor sees the command that uses the helper and asks
  // before it runs a tool Squire built for the owner, the helper hands the
  // secret to the tool three times, and one lookup of a secret that does not
  // exist fails.
  const session = 'session-with-a-secret';
  const command = `/usr/bin/python3 "${SECRET_HELPER}" run site-token --as SERVICE_TOKEN -- python3 add-ons/invoice-helper/run.py`;
  w.assertBlocked(w.attempt(world, session, w.tools.bash(command)), 'running a local tool with a secret, with no yes',
    'add-ons/invoice-helper/run.py');
  w.ownerSays(world, session, 'yes');
  w.assertAllowed(w.attempt(world, session, w.tools.bash(command)), 'running a local tool with a secret, after the owner said yes');
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
  // ...and nowhere else, in any encoding: not in the owner's folder (its
  // pages, state and files, which the nightly backup copies), not in Squire's
  // home or its logs, not in the transcript, not in TMPDIR or the user's home,
  // not among the helper's own files.
  const hits = w.filesHolding(scanSet(world), secret, { everyTrace: true });
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

test('a secret is stored through the helper from stdin, never from the command line and never empty, and lands in the Keychain only', { timeout: 120000 }, (t) => {
  const world = secretsWorld(t);
  const secret = w.newSecret();
  const set = (args, input) => w.runPython(world, SECRET_HELPER, args, { input, timeout: 20000 });

  //   core/tools/secret.py set <name>
  // reads the value from stdin, where one trailing newline ends it and is not
  // part of it (with nothing on stdin it asks in a hidden Mac dialog, which no
  // test drives).
  const stored = set(['set', 'site-token'], `${secret}\n`);
  assert.equal(stored.status, 0, `storing a secret from stdin must succeed; got ${w.describe(stored)}`);
  assert.equal(w.readSecret(world.keychain, 'site-token'), secret, 'the Keychain must hold the secret exactly as given');
  for (const trace of w.tracesOf(secret)) {
    assert.ok(!Buffer.from(stored.stdout + stored.stderr).includes(trace.bytes), `storing a secret must not show it (${trace.name})`);
  }

  // A value on the command line is refused, whatever stdin holds, and
  // nothing is stored.
  const onArgv = w.newSecret();
  for (const args of [['set', 'argv-token', onArgv], ['set', 'argv-token', '--value', onArgv], ['set', 'argv-token', `--value=${onArgv}`]]) {
    const r = set(args, `${w.newSecret()}\n`);
    const said = r.stdout + r.stderr;
    assert.doesNotMatch(said, /can't open file|Traceback \(most recent call last\)/, `the helper must refuse a value on the command line itself; got ${w.describe(r)}`);
    assert.notEqual(r.status, 0, `a secret given on the command line must be refused; got ${w.describe(r)}`);
    assert.equal(r.signal, null, `the refusal must come at once, with no prompt; got ${w.describe(r)}`);
    assert.equal(w.hasSecret(world.keychain, 'argv-token'), false, 'a refused secret must not be stored');
    assert.ok(!said.includes(onArgv), 'the refusal must not repeat the value');
  }

  // An empty value (an empty line) is refused at once, with no dialog, and nothing is stored.
  const empty = set(['set', 'empty-token'], '\n');
  assert.notEqual(empty.status, 0, `an empty secret must be refused; got ${w.describe(empty)}`);
  assert.equal(empty.signal, null, `an empty secret must be refused at once, with no dialog; got ${w.describe(empty)}`);
  assert.equal(w.hasSecret(world.keychain, 'empty-token'), false, 'an empty secret must not be stored');

  const hits = w.filesHolding(scanSet(world), secret, { everyTrace: true });
  assert.deepEqual(hits, [], `a stored secret must be nowhere but the Keychain; found in: ${hits.join(', ')}`);
});

test('the helper keeps every encoding of the secret out of its output, whole, split across writes or amid bytes that are not UTF-8, and out of every file, while the rest of the tool output comes through', { timeout: 120000 }, (t) => {
  const world = secretsWorld(t);
  const secret = w.newSecretWithSymbols();
  w.storeSecret(world.keychain, 'site-token', secret);
  const hashFile = path.join(world.root, 'leaks.sha256');
  const ranMarker = path.join(world.root, 'leaks.ran');
  const r = w.runPythonRaw(world, SECRET_HELPER,
    ['run', 'site-token', '--as', 'SERVICE_TOKEN', '--', process.execPath, w.LEAKS_SECRET, 'SERVICE_TOKEN', hashFile, ranMarker],
    { timeout: 20000 });
  const shown = `exit ${r.status}${r.signal ? ` (killed by ${r.signal})` : ''}; stderr: ${r.stderr.toString('utf8').slice(0, 600)}; ` +
    `stdout: ${r.stdout.toString('utf8').slice(0, 600)}`;

  assert.equal(r.status, 0, `the helper must run the tool with the secret; got ${shown}`);
  assert.equal(fs.readFileSync(hashFile, 'utf8'), w.sha256(secret), 'the tool must get the secret from the Keychain');
  for (const line of ['status: ok', 'rows: 14', 'done: 3 invoices']) {
    assert.ok(r.stdout.includes(Buffer.from(line)), `the tool's own output "${line}" must come through; got ${shown}`);
  }
  assert.ok(r.stderr.includes(Buffer.from('debug: finished')), `the tool's own errors must come through; got ${shown}`);
  for (const [stream, bytes] of [['stdout', r.stdout], ['stderr', r.stderr]]) {
    for (const trace of w.tracesOf(secret)) {
      assert.ok(!bytes.includes(trace.bytes), `the helper's ${stream} must hold no trace of the secret (${trace.name})`);
    }
  }

  fs.appendFileSync(world.transcript,
    JSON.stringify({ type: 'tool_result', stdout: r.stdout.toString('utf8'), stderr: r.stderr.toString('utf8') }) + '\n');
  const hits = w.filesHolding(scanSet(world), secret, { everyTrace: true });
  assert.deepEqual(hits, [], `the secret must be nowhere but the Keychain; found in: ${hits.join(', ')}`);
});

test('with no keychain in the config the helper stops with directions and falls back to nothing, and the session can never read the Keychain itself, yes or no', { timeout: 120000 }, (t) => {
  const world = secretsWorld(t);
  const secret = w.newSecret();
  w.storeSecret(world.keychain, 'site-token', secret);
  const decoy = w.newSecret();

  // No keychain named: the helper stops and says so. It never tries the
  // login keychain or any other.
  w.writeConfigFile(world.home, { ownerFolder: world.owner, approvalTimeoutSeconds: 600 });
  const u = useSecret(world, 'site-token', 'no-keychain', { env: { SERVICE_TOKEN: decoy, SITE_TOKEN: decoy } });
  const said = u.r.stdout + u.r.stderr;
  assert.doesNotMatch(said, /can't open file|Traceback \(most recent call last\)/, `the helper itself must stop with directions; got ${w.describe(u.r)}`);
  assert.notEqual(u.r.status, 0, `with no keychain in the config the helper must stop; got ${w.describe(u.r)}`);
  assert.equal(u.r.signal, null, `the helper must stop by itself, not wait on a prompt; got ${w.describe(u.r)}`);
  assert.equal(u.toolRan, false, 'with no keychain in the config the tool must not run, with any secret');
  assert.match(said, /keychain/i, `the helper must tell the owner the Keychain is not set up; got ${w.describe(u.r)}`);
  assert.ok(!said.includes(secret) && !said.includes(decoy), 'no secret in the helper\'s output');

  // The session reading the Keychain itself is blocked, yes or no: a yes
  // would put the value in the transcript.
  w.writeConfig(world);
  const kc = world.keychain.path;
  const s = 'session-keychain';
  for (const [what, call] of [
    ['the session fetching a secret with security', w.tools.bash('security find-generic-password -s squire -a site-token -w')],
    ['the session fetching a secret from the configured keychain', w.tools.bash(`/usr/bin/security find-generic-password -s squire -a site-token -w "${kc}"`)],
    ['the session dumping the Keychain', w.tools.bash('security dump-keychain -d')],
    ['the session reading the keychain file', w.tools.read(kc)],
    ['the session printing the keychain file', w.tools.bash(`cat "${kc}"`)],
  ]) {
    w.assertBlocked(w.attempt(world, s, call), what);
    w.ownerSays(world, s, 'yes');
    w.assertBlocked(w.attempt(world, s, call), `${what}, even after the owner said yes`);
  }
});
