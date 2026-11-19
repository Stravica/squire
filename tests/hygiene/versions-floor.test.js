'use strict';

// Code hygiene for the floor's reading of Squire's versions command
// (VersionsCommand in pre-tool-use.py), through the floor's entry point: only
// one app's own folder, as the Mac resolves it, runs unasked. Bound to no
// criterion.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const w = require('../fixtures/squire-world.js');

const VERSIONS = path.join(w.CORE, 'tools', 'versions.py');

function world(t) {
  const it = w.makeWorld();
  t.after(() => w.cleanUp(it));
  return it;
}

test("the versions command runs unasked only on one app's own folder as the Mac resolves it: a link out of workspace/apps, a folder inside an app's folder, workspace/apps itself, a folder not there and a number in other digits are refused", { timeout: 60000 }, (t) => {
  const it = world(t);
  const apps = path.join(it.owner, 'workspace', 'apps');
  const app = path.join(apps, 'till');
  fs.mkdirSync(path.join(app, 'src'), { recursive: true });
  fs.symlinkSync(path.join(it.owner, 'operator'), path.join(apps, 'notes'));
  const command = (words) => w.tools.bash(`/usr/bin/python3 '${VERSIONS}' ${words}`);
  let n = 0;
  const run = (words) => w.attempt(it, `session-hygiene-versions-${(n += 1)}`, command(words));
  w.assertAllowed(run(`keep '${app}'`), "keeping a version of an app's own folder");
  w.assertAllowed(run(`back '${app}/' 2`), "going back in an app's own folder, named with a closing slash");
  for (const [what, words] of [
    ['a link in workspace/apps to the operator folder', `keep '${path.join(apps, 'notes')}'`],
    ["a folder inside an app's folder", `keep '${path.join(app, 'src')}'`],
    ['workspace/apps itself', `list '${apps}'`],
    ['a folder not there', `keep '${path.join(apps, 'not-there')}'`],
    ['a number in other digits', `back '${app}' ١`],
    ['an option for the folder', `list --help`],
  ]) {
    const r = run(words);
    w.assertBlocked(r, what);
    assert.equal(w.requestIdIn(r.stderr), null, `${what}: refused, not asked; got ${w.describe(r)}`);
  }
});
