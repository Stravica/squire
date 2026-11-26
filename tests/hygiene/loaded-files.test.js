'use strict';

// Code hygiene for the floor's class of files Claude Code itself loads from
// the owner's folder (core/hooks/pre-tool-use.py, LoadedFiles): a new file is
// shown outside the class only by a positive match, its spelling as sent and
// the path the Mac resolves both outside it and both placed; a name or a
// folder on the way that folds to a class name is in it; a path the floor
// cannot place (a link at the path itself, a link that leads round in a loop
// on the way) is asked as one in it. Bound to no criterion. Nothing is
// written through the floor: the class is called in-process on folders the
// test makes in its own temporary folder.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const w = require('../fixtures/squire-world.js');

const FLOOR = path.join(w.CORE, 'hooks', 'pre-tool-use.py');

function why(owner, paths) {
  const program = [
    'import importlib.util, json, sys',
    'spec = importlib.util.spec_from_file_location("floor_under_test", sys.argv[1])',
    'floor = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(floor)',
    'owner = sys.argv[2]',
    'out = {}',
    'for given in json.loads(sys.argv[3]):',
    '    resolved = floor.Paths.canonical(given, owner)',
    '    out[given] = floor.LoadedFiles.why(given, resolved, owner, owner)',
    'print(json.dumps(out))',
  ].join('\n');
  const r = spawnSync(w.PYTHON, ['-c', program, FLOOR, owner, JSON.stringify(paths)], { encoding: 'utf8', timeout: 30000, env: { PATH: '/usr/bin:/bin', PYTHONDONTWRITEBYTECODE: '1' } });
  assert.equal(r.status, 0, `the Python ran; got ${r.status} ${r.stderr}`);
  return JSON.parse(r.stdout);
}

test('a class name or a .claude folder at any depth, in any letter case or Unicode form the volume folds alike, spelt with .. or a doubled slash, or reached through a link, is in the class; a plain new file is outside it', { timeout: 60000 }, (t) => {
  const owner = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squire-hygiene-loads-')));
  t.after(() => fs.rmSync(owner, { recursive: true, force: true }));
  fs.mkdirSync(path.join(owner, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(owner, 'workspace', 'notes'), { recursive: true });
  fs.symlinkSync(path.join(owner, '.claude'), path.join(owner, 'workspace', 'cfg'));
  const o = (rel) => `${owner}/${rel}`;
  const inClass = [
    o('CLAUDE.md'), o('claude.local.md'), o('Agents.MD'), o('AGENTſ.md'), o('.mcp.json'), o('workspace/a/b/.MCP.json'),
    o('.claude/x.md'), o('workspace/notes/.Claude/agents/y.md'), o('workspace/../CLAUDE.md'), o('/.claude//rules/z.md'),
    o('workspace/cfg/agents/helper.md'), o('workspace/notes/CLAUDE.md'),
  ];
  const outside = [o('workspace/notes/todo.md'), o('workspace/notes/about-claude.md'), o('workspace/sites/a/index.html'), o('workspace/claude/x.md')];
  const got = why(owner, [...inClass, ...outside]);
  for (const p of inClass) assert.equal(typeof got[p], 'string', `${p} is in the class; got ${JSON.stringify(got[p])}`);
  for (const p of outside) assert.equal(got[p], null, `${p} is outside the class; got ${JSON.stringify(got[p])}`);
});

test('a new file the floor cannot place, a link at the path itself or a link loop on the way, is asked as one in the class', { timeout: 60000 }, (t) => {
  const owner = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squire-hygiene-unplaced-')));
  t.after(() => fs.rmSync(owner, { recursive: true, force: true }));
  fs.mkdirSync(path.join(owner, 'workspace', 'notes'), { recursive: true });
  fs.symlinkSync(path.join(owner, 'workspace', 'notes', 'nowhere.md'), path.join(owner, 'workspace', 'notes', 'todo.md'));
  fs.symlinkSync(path.join(owner, 'workspace', 'loop-b'), path.join(owner, 'workspace', 'loop-a'));
  fs.symlinkSync(path.join(owner, 'workspace', 'loop-a'), path.join(owner, 'workspace', 'loop-b'));
  const got = why(owner, [`${owner}/workspace/notes/todo.md`, `${owner}/workspace/loop-a/notes.md`, `${owner}/workspace/new/deep/plain.md`]);
  assert.match(got[`${owner}/workspace/notes/todo.md`] || '', /cannot place/);
  assert.match(got[`${owner}/workspace/loop-a/notes.md`] || '', /cannot place/);
  assert.equal(got[`${owner}/workspace/new/deep/plain.md`], null, 'a plain file in folders not made yet is placed and outside the class');
});
