'use strict';

// Code hygiene for the reason the runner keeps when Claude Code's server
// stops before any session, through the runner's entry point: the server's
// own last non-blank line with terminal escapes and control characters
// removed and cut at 300 characters, or "with no output" and the exit code.
// Bound to no criterion.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const w = require('../fixtures/squire-world.js');
const s = require('../fixtures/session-world.js');

const PREFIX = "no session: Claude Code's Remote Control server stopped before any session";

// A world with core laid down and a stub claude at ~/.local/bin/claude whose
// server prints `out` and exits with `code` before any session.
function stoppedServer(t, out, code) {
  const world = w.makeWorld();
  let runner = null;
  t.after(async () => { if (runner) await runner.stop(); w.cleanUp(world); });
  s.layDownCore(world);
  const bin = path.join(world.userHome, '.local', 'bin', 'claude');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, `#!${process.execPath}
'use strict';
const argv = process.argv.slice(2);
if (argv[0] === 'auth') {
  process.stdout.write(JSON.stringify({ loggedIn: true }) + '\\n');
  process.exit(0);
}
process.stdout.write(${JSON.stringify(out)});
process.exit(${code});
`, { mode: 0o755 });
  runner = s.startRunner(world);
  return { world, runner };
}

async function stoppedReason(it) {
  const file = path.join(it.world.home, 'runner.json');
  const read = () => { try { return (JSON.parse(fs.readFileSync(file, 'utf8')).problems || []).find((p) => p.startsWith(PREFIX)); } catch (e) { return null; } };
  const reason = await s.waitFor(read, 20000);
  assert.ok(reason, `the runner must record why the server stopped; output: ${it.runner.output().slice(-600) || '(none)'}`);
  return reason;
}

test("the server's last line is kept without terminal escapes or control characters, cut at 300 characters", { timeout: 60000 }, async (t) => {
  const last = '\u001b[31mRefused:\u001b[0m ' + 'x'.repeat(400) + '\u0007';
  const it = stoppedServer(t, `Starting\n${last}\n\n`, 1);
  const reason = await stoppedReason(it);
  assert.doesNotMatch(reason, /[\u0000-\u001f\u007f]/, `no escape or control character may be kept; got ${JSON.stringify(reason)}`);
  const line = reason.slice(reason.indexOf(': ', PREFIX.length) + 2);
  assert.ok(line.startsWith('Refused: x'), `the reason must be the server's own last non-blank line; got ${JSON.stringify(reason)}`);
  assert.ok(line.length <= 300, `the server's line must be cut at 300 characters; got ${line.length}`);
});

test('a server that stops with no output is recorded as such, with its exit code', { timeout: 60000 }, async (t) => {
  const it = stoppedServer(t, '', 3);
  const reason = await stoppedReason(it);
  assert.match(reason, /no output/, `the reason must say the server gave no output; got ${JSON.stringify(reason)}`);
  assert.match(reason, /exit 3/, `the reason must give the exit code; got ${JSON.stringify(reason)}`);
});
