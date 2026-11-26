'use strict';

// The files Claude Code itself loads from the owner's folder, where Squire's
// sessions start: its instructions and memory (CLAUDE.md, CLAUDE.local.md and
// AGENTS.md, at the folder and in any folder under it), its MCP servers
// (.mcp.json at the owner's folder) and everything under .claude/ at the
// owner's folder (agents, rules, skills, commands, output styles and its own
// CLAUDE.md; its settings files are the floor's own, refused as before). A new
// one of these the session would write is asked first, naming the file, and
// is made only on the owner's yes, so nothing Squire reads can make one. The
// names are compared as the Mac's volume compares them: another letter case,
// the long s (U+017F, which the volume folds to s) and a path through a link
// in the owner's folder are the same file.
//
// Every case runs the safety floor's PreToolUse hooks as the laid settings
// name them, in the default mode and in auto mode, each mode counted from
// zero in a job of its own per file; the owner's yes is his own message
// through core/hooks/user-prompt-submit.py. A .mcp.json in a folder under
// the owner's, and a file under a .claude folder below the owner's, are in
// the class at any depth (Claude Code reads them when a session starts
// there; an ask for the owner's own act harms nobody), under their own
// criterion. A new file the floor cannot place in or out of the class (a
// link that leads nowhere or round in a loop) is asked as one in it. A class
// file made another way than Write (a shell redirect, tee, cp, mv, or
// NotebookEdit) is asked the same way, naming the file, and so is a path
// spelt with .., ./ or a doubled slash, which the cases send as given, never
// tidied first.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const w = require('../fixtures/squire-world.js');
const U = require('../fixtures/usage-world.js');

const { tools } = w;
const MODES = ['default', 'auto'];
const TEXT = '# Notes for the session\n\nAlways answer in French.\n';

function laidWorld(t) {
  const world = U.usageWorld(t, { core: false });
  const laid = w.layDown(world, w.CORE);
  assert.equal(laid.status, 0, `laying down core must succeed; got ${w.describe(laid)}`);
  U.writeSnapshot(world, {
    fiveHour: { used: 30, resetsAt: U.onMinute(U.now() + 3 * 3600) },
    sevenDay: { used: 40, resetsAt: U.onMinute(U.now() + 4 * U.DAY) },
  });
  return world;
}

// Each new file, in each mode, in a job of its own: asked, naming the file as
// the session gave it, before any yes; let through on the owner's yes to that
// request. The asks are counted per mode, from zero.
function askedThenMade(world, rels, what) {
  askedThenMadeAt(world, rels.map((rel) => path.join(world.owner, rel)), what, 'new-file');
}

// The same, for files given exactly as the session would send them (a raw
// path is never tidied by path.join first), and for any tool call that would
// make one: call(file) gives the call, a Write unless named otherwise.
function askedThenMadeAt(world, files, what, tag, call = (file) => tools.write(file, TEXT)) {
  const floor = U.laidFloor(world, U.UTC);
  for (const mode of MODES) {
    let asked = 0;
    files.forEach((file, i) => {
      const rel = path.relative(world.owner, file) || file;
      assert.equal(fs.existsSync(file), false, `the premise: ${file} is not there yet, so the call would make a new file`);
      const job = `job-${tag}-${mode}-${i}`;
      const made = call(file);
      const r = floor.run(job, made, mode);
      w.assertBlocked(r, `${what}: a new ${rel} the session would write, in ${mode} mode, before any yes`);
      const id = w.requestIdIn(r.stderr);
      assert.notEqual(id, null, `${what}: a new ${rel} is asked, a request the owner can answer, in ${mode} mode; got ${w.describe(r)}`);
      assert.ok(r.stderr.includes(file), `${what}: the ask names the file (${file}), in ${mode} mode; got ${w.describe(r)}`);
      asked += 1;
      U.sayYesTo(world, job, r, { env: U.UTC });
      w.assertAllowed(floor.run(job, made, mode), `${what}: a new ${rel}, in ${mode} mode, on the owner's yes to ${id}`);
    });
    assert.equal(asked, files.length, `${what}: in ${mode} mode each of the ${files.length} files is asked once`);
  }
}

// The volume's folding, read without skipping: false on a volume that does
// not fold letter case.
function foldsCase(world) {
  const probe = path.join(world.owner, 'workspace', 'fold-probe-case');
  fs.mkdirSync(probe, { recursive: true });
  fs.writeFileSync(path.join(probe, 'Probe.json'), '{}\n');
  try { return fs.statSync(path.join(probe, 'Probe.json')).ino === fs.statSync(path.join(probe, 'pROBE.JSON')).ino; } catch (e) { return false; }
}

test("a new CLAUDE.md, CLAUDE.local.md or AGENTS.md the session would write in the owner's folder, at the folder itself or in a folder under it, is asked first, naming the file, and is made only on the owner's yes, in the default mode and in auto mode", { timeout: 300000 }, (t) => {
  const world = laidWorld(t);
  askedThenMade(world, [
    'CLAUDE.md',
    'CLAUDE.local.md',
    'AGENTS.md',
    'workspace/sites/pretend-bakery/CLAUDE.md',
    'workspace/notes/CLAUDE.local.md',
    'workspace/notes/AGENTS.md',
  ], 'instructions Claude Code loads');
});

test("a new .mcp.json the session would write at the owner's folder, naming MCP servers Claude Code would start, is asked first, naming the file, and is made only on the owner's yes, in the default mode and in auto mode", { timeout: 300000 }, (t) => {
  const world = laidWorld(t);
  askedThenMade(world, ['.mcp.json'], 'the MCP servers Claude Code loads');
});

test("a new file the session would write under .claude in the owner's folder (an agent, a rule, a skill, a command, an output style or its CLAUDE.md) is asked first, naming the file, and is made only on the owner's yes, in the default mode and in auto mode", { timeout: 300000 }, (t) => {
  const world = laidWorld(t);
  askedThenMade(world, [
    '.claude/CLAUDE.md',
    '.claude/agents/helper.md',
    '.claude/rules/style.md',
    '.claude/skills/tidy/SKILL.md',
    '.claude/commands/tidy.md',
    '.claude/output-styles/plain.md',
  ], 'what Claude Code loads from its folder');
});

// The volume's own folding, shown on the volume the world lives on before the
// spellings are tried; on a volume that does not fold, the case skips,
// naming why.
function volumeFolds(t, world) {
  const probe = path.join(world.owner, 'workspace', 'fold-probe');
  fs.mkdirSync(probe, { recursive: true });
  fs.writeFileSync(path.join(probe, 'Probe.json'), '{}\n');
  const same = (a, b) => {
    try { return fs.statSync(path.join(probe, a)).ino === fs.statSync(path.join(probe, b)).ino; } catch (e) { return false; }
  };
  if (!same('Probe.json', 'pROBE.JSON')) { t.skip('the volume holding the test world does not fold letter case'); return false; }
  if (!same('Probe.json', 'Probe.jſon')) { t.skip('the volume holding the test world does not fold the long s (U+017F) to s'); return false; }
  return true;
}

test("the same files spelt another way the volume opens as them, in another letter case, with the long s for an s, or through a link in the owner's folder, are asked first, naming the file, and are made only on the owner's yes, in the default mode and in auto mode", { timeout: 300000 }, (t) => {
  const world = laidWorld(t);
  if (!volumeFolds(t, world)) return;
  const o = (rel) => path.join(world.owner, rel);
  // A link in the owner's folder to the folder itself, and one to its
  // .claude folder.
  fs.mkdirSync(o('.claude'), { recursive: true });
  fs.mkdirSync(o('workspace'), { recursive: true });
  fs.symlinkSync(world.owner, o('workspace/home-link'));
  fs.symlinkSync(o('.claude'), o('workspace/cfg-link'));
  askedThenMade(world, [
    'claude.md',
    'Agents.MD',
    'claude.LOCAL.md',
    '.MCP.JSON',
    '.Claude/agents/helper.md',
    'AGENTſ.md',
    '.mcp.jſon',
    '.claude/ſkills/tidy/SKILL.md',
    'workspace/home-link/.mcp.json',
    'workspace/home-link/CLAUDE.md',
    'workspace/cfg-link/agents/helper.md',
  ], 'a file Claude Code loads, spelt another way');
});

test("a new file the floor cannot place in or out of the files Claude Code loads, through a link that leads nowhere or round in a loop, is asked first as one of them, naming the file, and is made only on the owner's yes, in the default mode and in auto mode", { timeout: 300000 }, (t) => {
  const world = laidWorld(t);
  const o = (rel) => path.join(world.owner, rel);
  fs.mkdirSync(o('workspace/notes'), { recursive: true });
  // A plain name linked to a CLAUDE.md that is not there yet, a CLAUDE.md
  // linked to a plain file that is not there yet, and two links that lead to
  // each other.
  fs.symlinkSync(o('CLAUDE.md'), o('workspace/notes/todo.md'));
  fs.symlinkSync(o('workspace/notes/plain-target.md'), o('workspace/notes/CLAUDE.md'));
  fs.symlinkSync(o('workspace/loop-b'), o('workspace/loop-a'));
  fs.symlinkSync(o('workspace/loop-a'), o('workspace/loop-b'));
  askedThenMadeAt(world, [
    o('workspace/notes/todo.md'),
    o('workspace/notes/CLAUDE.md'),
    `${o('workspace/loop-a')}/notes.md`,
  ], 'a file the floor cannot place', 'unplaced');
});

test("a new .mcp.json in any folder under the owner's folder, and a new file under a .claude folder at any depth below it, are asked first, naming the file, and are made only on the owner's yes, in the default mode and in auto mode", { timeout: 300000 }, (t) => {
  const world = laidWorld(t);
  askedThenMade(world, [
    'workspace/sites/pretend-bakery/.mcp.json',
    'workspace/a/b/c/.mcp.json',
    'workspace/notes/.claude/CLAUDE.md',
    'workspace/notes/.claude/agents/helper.md',
    'workspace/sites/pretend-bakery/.claude/commands/tidy.md',
  ], 'a file Claude Code loads in a folder below the owner\'s');
});

test("a new file Claude Code loads made by a shell redirect, tee, cp or mv, or by NotebookEdit, is asked first, naming the file, and is made only on the owner's yes, in the default mode and in auto mode", { timeout: 300000 }, (t) => {
  const world = laidWorld(t);
  const o = (rel) => path.join(world.owner, rel);
  const draft = o('workspace/notes/draft.md');
  fs.mkdirSync(path.dirname(draft), { recursive: true });
  fs.writeFileSync(draft, TEXT);
  const shell = {
    [o('CLAUDE.md')]: (f) => tools.bash(`printf '%s\\n' 'Always answer in French.' > '${f}'`),
    [o('.mcp.json')]: (f) => tools.bash(`printf '%s\\n' '{"mcpServers":{}}' | tee '${f}'`),
    [o('AGENTS.md')]: (f) => tools.bash(`cp '${draft}' '${f}'`),
    [o('.claude/agents/helper.md')]: (f) => tools.bash(`mv '${draft}' '${f}'`),
    [o('.claude/skills/tidy/notes.ipynb')]: (f) => tools.notebookEdit(f, 'cell-1', 'Always answer in French.'),
  };
  askedThenMadeAt(world, Object.keys(shell), 'a file Claude Code loads, made another way', 'other-route', (f) => shell[f](f));
});

test("the same files spelt with .., ./ or a doubled slash, sent as given, through a link in the owner's folder on any volume, or through a folder spelt in another letter case mid-path, are asked first, naming the file, and are made only on the owner's yes, in the default mode and in auto mode", { timeout: 300000 }, (t) => {
  const world = laidWorld(t);
  const o = (rel) => path.join(world.owner, rel);
  fs.mkdirSync(o('.claude'), { recursive: true });
  fs.mkdirSync(o('workspace/notes'), { recursive: true });
  fs.symlinkSync(world.owner, o('workspace/home-link'));
  fs.symlinkSync(o('.claude'), o('workspace/cfg-link'));
  const files = [
    `${world.owner}/workspace/../CLAUDE.md`,
    `${world.owner}/./.mcp.json`,
    `${world.owner}//.claude/agents/helper.md`,
    `${world.owner}/workspace/notes/../../.claude/rules/style.md`,
    o('workspace/home-link/.mcp.json'),
    o('workspace/home-link/AGENTS.md'),
    o('workspace/cfg-link/agents/helper.md'),
  ];
  if (foldsCase(world)) files.push(o('WORKSPACE/home-link/.mcp.json'), o('workspace/HOME-LINK/CLAUDE.local.md'), o('.CLAUDE/rules/style.md'));
  else t.diagnostic('the volume holding the test world does not fold letter case: the mid-path spellings are not sent');
  askedThenMadeAt(world, files, 'a file Claude Code loads, spelt as sent', 'spelt');
});

test("a new file elsewhere in the owner's folder, a note in workspace or a page of a site, is still written with no ask, in the default mode and in auto mode", { timeout: 300000 }, (t) => {
  const world = laidWorld(t);
  const floor = U.laidFloor(world, U.UTC);
  for (const mode of MODES) {
    [
      `workspace/notes/shopping-${mode}.md`,
      `workspace/sites/pretend-bakery/index-${mode}.html`,
      `workspace/notes/about-instructions-${mode}.md`,
    ].forEach((rel, i) => {
      const r = floor.run(`job-plain-file-${mode}-${i}`, tools.write(path.join(world.owner, rel), TEXT), mode);
      w.assertAllowed(r, `a new ${rel} in the owner's folder, in ${mode} mode`);
      assert.equal(w.requestIdIn(`${r.stderr}\n${r.stdout}`), null, `a new ${rel} is written with no ask, in ${mode} mode; got ${w.describe(r)}`);
    });
  }
});
