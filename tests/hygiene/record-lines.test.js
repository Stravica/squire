'use strict';

// Code hygiene for Squire's record (core/lib/squire.py, Record): each line is
// one line whatever its fields hold, a secret is hidden in every form the
// secret helper hides before a field is cut short, the page starts with its
// heading once, and anything but a plain file at its path, or its folder
// anywhere but the owner's own workspace/pages, leaves it not writable.
// Bound to no criterion. In-process, in a folder under the test's own
// temporary folder; no Keychain is read. Each break character is written by
// its code point, so this file holds none of them itself.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const w = require('../fixtures/squire-world.js');

const BREAK_POINTS = [0x0a, 0x0d, 0x85, 0x2028, 0x2029];

function python(lines, args = []) {
  const program = ['import json, os, sys', 'sys.path.insert(0, sys.argv[1])', 'from squire import Record', ...lines].join('\n');
  const r = spawnSync(w.PYTHON, ['-c', program, path.join(w.CORE, 'lib'), ...args], { encoding: 'utf8', timeout: 30000, env: { PATH: '/usr/bin:/bin', PYTHONDONTWRITEBYTECODE: '1' } });
  assert.equal(r.status, 0, `the Python ran; got ${r.status} ${r.stderr}`);
  return JSON.parse(r.stdout);
}

test('a line is one line whatever its fields hold, and a secret is hidden in every form before a field is cut short', { timeout: 60000 }, () => {
  const secret = 'sq-' + 'ab12'.repeat(12);
  const got = python([
    'secret = sys.argv[2].encode()',
    'helper = Record.helper()',
    'hide = lambda text: Record.hidden(text, [secret], helper)',
    'breaks = "".join(c + chr(p) for c, p in zip("abcdefgh", (0x0a, 0x0d, 0x2028, 0x2029, 0x00, 0x85, 0x200b, 0x1b)))',
    'lines = [Record.line(0, "job-1", "asked r-1", "mcp__example_notes__send_note", breaks),',
    '         Record.line(0, "job" + chr(0x0a) + "- forged", "refused", "Write", "/x", "why" + chr(0x0a) + "not")]',
    'forms = [secret.decode(), secret.hex(), secret.hex().upper(), __import__("base64").b64encode(secret).decode()]',
    'kept = [Record.line(0, "job-2", "ran", "mcp__example_notes__read_note", ("x" * 140) + form, hide=hide) for form in forms]',
    'print(json.dumps({"lines": lines, "kept": kept}))',
  ], [secret]);
  for (const line of got.lines) {
    for (const point of BREAK_POINTS) {
      assert.ok(!line.includes(String.fromCodePoint(point)), `no break (U+${point.toString(16)}) in the line: ${JSON.stringify(line)}`);
    }
    assert.match(line, /^- 1970-01-01T00:00:00Z job /, `the line starts with its time and job: ${JSON.stringify(line)}`);
  }
  assert.ok(got.lines[1].includes('(why: why not)'), `a refusal's reason is kept on its line: ${JSON.stringify(got.lines[1])}`);
  const hex = Buffer.from(secret).toString('hex');
  for (const line of got.kept) {
    for (const form of [secret, hex, hex.toUpperCase(), Buffer.from(secret).toString('base64')]) {
      assert.ok(!line.includes(form.slice(0, 12)), `no part of a form of the secret is left before the cut: ${JSON.stringify(line)}`);
    }
  }
});

test('the page gets its heading once and a line per entry; a link, a folder or a hard link at its path, or its folder a link, leaves it not writable and adds nothing', { timeout: 60000 }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'record-hygiene-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const owner = path.join(root, 'owner');
  fs.mkdirSync(path.join(owner, 'workspace'), { recursive: true });
  const add = (folder) => python([
    'class Config: pass',
    'c = Config(); c.owner_folder = sys.argv[2]; c.keychain = None',
    'ok = [Record.add(c, [("job-1", "asked r-1", "Bash", "", "")], 0), Record.add(c, [("job-1", "used r-1", "Bash", "", "")], 0)]',
    'print(json.dumps({"ok": ok, "writable": Record.writable(sys.argv[2])}))',
  ], [folder]);
  const first = add(owner);
  assert.deepEqual(first.ok, [true, true]);
  const text = fs.readFileSync(path.join(owner, 'workspace', 'pages', 'squire-record.md'), 'utf8');
  assert.equal(text.split('\n').filter((l) => l.startsWith('# ')).length, 1, 'one heading');
  assert.equal(text.split('\n').filter((l) => l.startsWith('- ')).length, 2, 'one line per entry');

  const pages = (o) => path.join(o, 'workspace', 'pages');
  const cases = [
    ['a link at its path', (o) => { fs.mkdirSync(pages(o), { recursive: true }); fs.symlinkSync(path.join(root, 'elsewhere.md'), path.join(pages(o), 'squire-record.md')); }],
    ['a folder at its path', (o) => fs.mkdirSync(path.join(pages(o), 'squire-record.md'), { recursive: true })],
    ['a hard link at its path', (o) => { fs.mkdirSync(pages(o), { recursive: true }); fs.writeFileSync(path.join(root, 'kept.md'), ''); fs.linkSync(path.join(root, 'kept.md'), path.join(pages(o), 'squire-record.md')); }],
    ['its folder a link', (o) => { fs.mkdirSync(path.join(root, 'other-pages')); fs.symlinkSync(path.join(root, 'other-pages'), pages(o)); }],
  ];
  cases.forEach(([what, plant], i) => {
    const o = path.join(root, `owner-${i}`);
    fs.mkdirSync(path.join(o, 'workspace'), { recursive: true });
    plant(o);
    assert.deepEqual(add(o), { ok: [false, false], writable: false }, `${what}: not writable, nothing added`);
  });
  assert.equal(fs.existsSync(path.join(root, 'elsewhere.md')), false, 'nothing was written through the link');
  assert.equal(fs.readFileSync(path.join(root, 'kept.md'), 'utf8'), '', 'nothing was written through the hard link');
});
