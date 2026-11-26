'use strict';

// Code hygiene for the mark a handover note carries across /clear
// (core/lib/squire.py, Ledger.note and Ledger.note_for;
// core/hooks/session-start.py, SessionStart.pickup_mark): a note is clean
// only where the ledger holds the floor's line for it, by its path, with the
// digest of the note as it now reads and no untrusted input held by the job
// that wrote it; a note with no line, one changed since, one written in a job
// holding untrusted input, and one that cannot be read each name the note as
// untrusted input. Bound to no criterion. The ledger is a temporary one the
// test makes; no hook is run.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const w = require('../fixtures/squire-world.js');

const START = path.join(w.CORE, 'hooks', 'session-start.py');
const LIB = path.join(w.CORE, 'lib');

test('a picked-up note is clean only by the floor line for it with its digest as it reads now, written in a clean job; anything else names the note as untrusted input', { timeout: 60000 }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'squire-hygiene-mark-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ledgerPath = path.join(root, 'state', 'approvals.jsonl');
  const notes = path.join(root, 'handover');
  fs.mkdirSync(notes, { recursive: true });
  const write = (name, text) => { fs.writeFileSync(path.join(notes, name), text); return path.join(notes, name); };
  const digest = (text) => crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
  const clean = write('clean.md', 'clean note\n');
  const tainted = write('tainted.md', 'tainted note\n');
  const changed = write('changed.md', 'changed note\n');
  const unseen = write('unseen.md', 'unseen note\n');
  const gone = path.join(notes, 'gone.md');
  const program = [
    'import importlib.util, json, sys, os',
    'sys.path.insert(0, sys.argv[2])',
    'from squire import Ledger, Paths',
    'spec = importlib.util.spec_from_file_location("start_under_test", sys.argv[1])',
    'start = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(start)',
    'ledger_path, lines, asked = sys.argv[3], json.loads(sys.argv[4]), json.loads(sys.argv[5])',
    'with Ledger(ledger_path) as ledger:',
    '    for session, p, digest, untrusted in lines:',
    '        ledger.note(session, Paths.fold(os.path.realpath(p)), digest, untrusted, 1.0)',
    'out = {}',
    'with Ledger(ledger_path) as ledger:',
    '    for p in asked:',
    '        out[p] = start.SessionStart.pickup_mark(ledger, p)',
    'print(json.dumps(out))',
  ].join('\n');
  const lines = [
    ['job-a', clean, digest('clean note\n'), []],
    ['job-b', tainted, digest('tainted note\n'), ['WebFetch https://example.com/']],
    ['job-c', changed, digest('the note as it was saved\n'), []],
    ['job-d', clean, digest('an older save\n'), ['WebFetch https://example.com/']],
  ];
  // The newest line for a note is the one that counts: job-d's older line for
  // clean.md comes first here, then job-a's.
  const ordered = [lines[3], lines[0], lines[1], lines[2]];
  const r = spawnSync(w.PYTHON, ['-c', program, START, LIB, ledgerPath, JSON.stringify(ordered), JSON.stringify([clean, tainted, changed, unseen, gone])], { encoding: 'utf8', timeout: 30000, env: { PATH: '/usr/bin:/bin', PYTHONDONTWRITEBYTECODE: '1' } });
  assert.equal(r.status, 0, `the Python ran; got ${r.status} ${r.stderr}`);
  const got = JSON.parse(r.stdout);
  assert.equal(got[clean], null, 'a note the floor saw saved in a clean job, unchanged since, is clean');
  for (const [p, said] of [[tainted, /untrusted input/], [changed, /changed/], [unseen, /did not see/], [gone, /could not/]]) {
    assert.equal(typeof got[p], 'string', `${path.basename(p)} marks the job that picks it up; got ${JSON.stringify(got[p])}`);
    assert.ok(got[p].includes(path.basename(p)), `the mark names the note (${path.basename(p)}); got ${got[p]}`);
    assert.match(got[p], said);
  }
  const kinds = fs.readFileSync(ledgerPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l).type);
  assert.deepEqual([...new Set(kinds)], ['note'], 'the line is a note record in the ledger');
});

// core/hooks/pre-tool-use.py, Floor.picked_up_read; core/lib/squire.py,
// Ledger.pickup and Ledger.picked_up; core/hooks/session-start.py,
// SessionStart.picked_up.
test('a read of the note a job picked up, unchanged since, leaves no mark of private things in that job; in another job, of another file, or after the note changed, the read keeps every mark', { timeout: 60000 }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'squire-hygiene-pickup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ledgerPath = path.join(root, 'state', 'approvals.jsonl');
  const notes = path.join(root, 'handover');
  fs.mkdirSync(notes, { recursive: true });
  const note = path.join(notes, 'picked.md');
  const other = path.join(notes, 'other.md');
  fs.writeFileSync(note, 'the note picked up\n');
  fs.writeFileSync(other, 'another note\n');
  const program = [
    'import importlib.util, json, sys, os',
    'sys.path.insert(0, sys.argv[3])',
    'from squire import Ledger',
    'def load(name, file):',
    '    spec = importlib.util.spec_from_file_location(name, file)',
    '    module = importlib.util.module_from_spec(spec)',
    '    spec.loader.exec_module(module)',
    '    return module',
    'floor, start = load("floor_under_test", sys.argv[1]), load("start_under_test", sys.argv[2])',
    'ledger_path, note, other = sys.argv[4], sys.argv[5], sys.argv[6]',
    'with Ledger(ledger_path) as ledger:',
    '    start.SessionStart.picked_up(ledger, "job-x", note, 1.0)',
    '    start.SessionStart.picked_up(ledger, "job-x", os.path.join(os.path.dirname(note), "gone.md"), 1.0)',
    'marks = [("private", "Read note"), ("untrusted", "Read note")]',
    'out = {}',
    'with Ledger(ledger_path) as ledger:',
    '    read = lambda job, p: floor.Floor.picked_up_read(ledger, job, os.path.realpath(p), list(marks))',
    '    out["same"], out["otherJob"], out["otherFile"] = read("job-x", note), read("job-y", note), read("job-x", other)',
    '    out["none"] = floor.Floor.picked_up_read(ledger, "job-x", None, list(marks))',
    'with open(note, "a", encoding="utf-8") as f:',
    '    f.write("a line added after the pickup\\n")',
    'with Ledger(ledger_path) as ledger:',
    '    out["changed"] = floor.Floor.picked_up_read(ledger, "job-x", os.path.realpath(note), list(marks))',
    'print(json.dumps(out))',
  ].join('\n');
  const r = spawnSync(w.PYTHON, ['-c', program, path.join(w.CORE, 'hooks', 'pre-tool-use.py'), START, LIB, ledgerPath, note, other], { encoding: 'utf8', timeout: 30000, env: { PATH: '/usr/bin:/bin', PYTHONDONTWRITEBYTECODE: '1' } });
  assert.equal(r.status, 0, `the Python ran; got ${r.status} ${r.stderr}`);
  const got = JSON.parse(r.stdout);
  const both = [['private', 'Read note'], ['untrusted', 'Read note']];
  assert.deepEqual(got.same, [['untrusted', 'Read note']], 'the note the job picked up, unchanged, read again: only the private mark is left off');
  for (const k of ['otherJob', 'otherFile', 'none', 'changed']) assert.deepEqual(got[k], both, `${k}: every mark kept`);
  const records = fs.readFileSync(ledgerPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(records.map((x) => x.type), ['pickup'], 'one pickup record, for the note that could be read; none for a note that is not there');
});
