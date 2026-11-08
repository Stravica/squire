'use strict';

// Code hygiene for the floor's reading of shell words, through its entry
// point. Bound to no criterion.

const { test } = require('node:test');
const path = require('node:path');
const w = require('../fixtures/squire-world.js');

test('the floor\'s own files and the Keychain named inside a command substitution or a zsh group are never the session\'s, yes or no', { timeout: 60000 }, (t) => {
  const it = w.makeWorld();
  t.after(() => w.cleanUp(it));
  const hook = path.join(w.CORE, 'hooks', 'pre-tool-use.py');
  // A keychain that does not exist, in the world's own folder.
  const missing = path.join(it.root, 'no-such.keychain-db');
  const calls = [
    ['copying over the floor inside $(...)', `echo $(cp workspace/drafts/order.json ${hook})`],
    ['copying over the floor inside backticks', `echo \`cp workspace/drafts/order.json ${hook}\``],
    ['copying over the floor named inside a zsh group', `cp workspace/drafts/order.json (${hook})`],
    ['reading the Keychain inside $(...)', `echo $(security dump-keychain -d ${missing})`],
  ];
  calls.forEach(([what, command], i) => {
    const s = `session-hygiene-words-${i}`;
    w.assertBlocked(w.attempt(it, s, w.tools.bash(command)), what);
    w.ownerSays(it, s, 'yes');
    w.assertBlocked(w.attempt(it, s, w.tools.bash(command)), `${what}, after a yes`);
  });
});
