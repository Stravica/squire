'use strict';

// Code hygiene for the speech engine's own reason (transcribe.py's
// engine_reason), through the transcription's entry point: where the engine
// exits 69, what it wrote on stderr is not Squire's text, so Squire passes on
// its first line only, with no control or format character and no line or
// paragraph separator, at most a bounded length, and with nothing usable left
// says its own fixed sentence. The engine here is a stand-in written into the
// test's own temporary folder; nothing is sent anywhere. Bound to no criterion.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const w = require('../fixtures/squire-world.js');
const M = require('../fixtures/media-world.js');

const TRANSCRIBE = path.join(w.CORE, 'tools', 'transcribe.py');
const FIXED = 'This Mac cannot recognise speech on the Mac itself right now, so Squire sent the recording nowhere, ' +
  'tried no other engine and kept no note.';
const UNSHOWN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

function world(t) {
  const it = w.makeWorld();
  t.after(() => w.cleanUp(it));
  return it;
}

// A stand-in engine that writes exactly `said` on stderr and exits 69.
function engineSaying(it, name, said) {
  const program = path.join(it.root, `engine-${name}`);
  fs.writeFileSync(program, `#!${process.execPath}\nprocess.stderr.write(${JSON.stringify(said)});\nprocess.exit(69);\n`);
  fs.chmodSync(program, 0o755);
  return program;
}

function onRequest(it, name, said) {
  const given = M.fixtureRecording(path.join(it.userHome, 'Downloads', `Voice memo ${name}.wav`), { seconds: 1 });
  return w.runPython(it, TRANSCRIBE, [given], { env: { SQUIRE_SPEECH_ENGINE: engineSaying(it, name, said) }, timeout: 30000 });
}

test('where the speech engine exits 69, Squire passes on its own reason bounded: the first line only, no control or format character or separator, at most a bounded length; with nothing usable left, the fixed sentence', { timeout: 60000 }, (t) => {
  const it = world(t);
  const cases = [
    ['empty', '', (said) => assert.equal(said, FIXED, 'an engine that gives no reason leaves the fixed sentence, unchanged')],
    ['blank', '\n  \n\t\n', (said) => assert.equal(said, FIXED, 'an engine that gives only blank lines leaves the fixed sentence, unchanged')],
    ['controls-only', '\u0000\u0001\u001b\n', (said) => assert.equal(said, FIXED, 'a reason of control characters only leaves the fixed sentence, unchanged')],
    ['plain', 'the speech assets for this language are not on this Mac\n', (said) => {
      assert.ok(said.includes('the speech assets for this language are not on this Mac'), `the engine's reason is passed on whole; got ${JSON.stringify(said)}`);
      assert.match(said, /cannot recognise speech on the Mac itself/, 'Squire still says the Mac cannot');
      assert.match(said, /sent the recording nowhere, tried no other engine and kept no note/, 'Squire still says nothing was sent or kept');
    }],
    ['multi-line', 'the first line of the reason\nthe second line\r\nthe third line\n', (said) => {
      assert.ok(said.includes('the first line of the reason'), `the first line is passed on; got ${JSON.stringify(said)}`);
      assert.ok(!said.includes('second') && !said.includes('third'), `only the first line is passed on; got ${JSON.stringify(said)}`);
    }],
    ['separator', 'before the separator after the separator\n', (said) => {
      assert.ok(said.includes('before the separator') && !said.includes('after the separator'), `a line separator ends the first line; got ${JSON.stringify(said)}`);
    }],
    ['controls', 'the\u0007 reason\u001b[0m\twith​controls and­formats\n', (said) => {
      assert.ok(!UNSHOWN.test(said), `no control or format character is passed on; got ${JSON.stringify(said)}`);
      assert.match(said, /the reason \[0m with controls and formats/, `each control or format character becomes a space, spaces run together; got ${JSON.stringify(said)}`);
    }],
    ['long', `${'word '.repeat(400)}\n`, (said) => {
      const reason = said.slice(said.indexOf('"') + 1, said.lastIndexOf('"'));
      assert.ok(reason.length <= 203, `a very long reason is cut to its bound; got ${reason.length} characters`);
      assert.ok(reason.endsWith('word...'), `a cut reason is cut at a space and marked; got ${JSON.stringify(reason.slice(-20))}`);
    }],
  ];
  for (const [name, said, check] of cases) {
    const r = onRequest(it, name, said);
    t.diagnostic(`${name}: ${JSON.stringify(r.stderr)}`);
    assert.equal(r.status, 69, `${name}: the transcription stops with the engine's exit code 69; got ${w.describe(r)}`);
    assert.doesNotMatch(r.stderr, /Traceback/, `${name}: never a crash; got ${w.describe(r)}`);
    assert.ok(r.stderr.endsWith('\n') && !/[\r\n]/.test(r.stderr.slice(0, -1)), `${name}: the answer is one line; got ${JSON.stringify(r.stderr)}`);
    assert.ok(!UNSHOWN.test(r.stderr.slice(0, -1)), `${name}: the answer holds no control or format character; got ${JSON.stringify(r.stderr)}`);
    check(r.stderr.slice(0, -1));
  }
});

test('the reason the voice-notes job keeps for a recording, where the engine exits 69, carries the same bounded reason on one line', { timeout: 60000 }, (t) => {
  const it = world(t);
  M.fixtureRecording(path.join(it.owner, 'Voice notes', 'Shop meeting.wav'), { seconds: 1 });
  const program = engineSaying(it, 'watch', 'the first line\u0007 of the reason\nthe second line\n');
  const r = w.runPython(it, TRANSCRIBE, ['--watch'], { cwd: '/', env: { SQUIRE_SPEECH_ENGINE: program }, timeout: 30000 });
  assert.equal(r.status, 0, `the voice-notes job exits 0; got ${w.describe(r)}`);
  const record = JSON.parse(fs.readFileSync(path.join(it.home, 'state', 'voice-notes.json'), 'utf8'));
  const kept = (record.notTranscribed || {})['Shop meeting.wav'];
  assert.ok(kept && typeof kept.reason === 'string', `the job keeps a reason; got ${JSON.stringify(record)}`);
  assert.ok(kept.reason.includes('"the first line of the reason"'), `the kept reason carries the engine's first line, bounded; got ${JSON.stringify(kept.reason)}`);
  assert.ok(!kept.reason.includes('second') && !UNSHOWN.test(kept.reason), `the kept reason is one line with no control character; got ${JSON.stringify(kept.reason)}`);
});
