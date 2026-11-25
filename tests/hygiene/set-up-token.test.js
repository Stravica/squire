'use strict';

// Code hygiene for the set-up's words on a set-up token the account's path
// did not accept (core/tools/website.py, SetUp.not_accepted and
// SetUp.user_owned): only a refusal that speaks about the token (401 or 403)
// leads to the user path's verify, only an active answer there gets the
// account-owned words, a 429, a 5xx or no answer is Cloudflare not
// answering, and anything else keeps the words for any token Cloudflare does
// not accept. Bound to no criterion. Nothing is called: the API here is a
// stand-in handed to the set-up in-process.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const w = require('../fixtures/squire-world.js');

const WEBSITE = path.join(w.CORE, 'tools', 'website.py');

function words(cases) {
  const program = [
    'import importlib.util, json, sys',
    'spec = importlib.util.spec_from_file_location("website_under_test", sys.argv[1])',
    'website = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(website)',
    'class Api:',
    '    def __init__(self, user):',
    '        self.user, self.calls = user, []',
    '    def result(self, method, path, token, **_):',
    '        self.calls.append(method + " " + path)',
    '        return self.user',
    'out = {}',
    'for label, status, user in json.loads(sys.argv[2]):',
    '    s = object.__new__(website.SetUp)',
    '    s.account, s.token, s.api = "0123456789abcdef0123456789abcdef", "t", Api(user)',
    '    out[label] = {"said": s.not_accepted(status), "calls": s.api.calls}',
    'print(json.dumps(out))',
  ].join('\n');
  const r = spawnSync(w.PYTHON, ['-c', program, WEBSITE, JSON.stringify(cases)], { encoding: 'utf8', timeout: 30000, env: { PATH: '/usr/bin:/bin', PYTHONDONTWRITEBYTECODE: '1' } });
  assert.equal(r.status, 0, `the Python ran; got ${r.status} ${r.stderr}`);
  return JSON.parse(r.stdout);
}

const ACTIVE = { id: 'tok-1', status: 'active' };
const OWNED = /account-owned/;
const TODAY = /did not accept the set-up token on account [0-9a-f]{32}: check the account id and the token/;

test('only a 401 or 403 on the account\'s path and an active verify on the user path get the account-owned words and where to make the token', { timeout: 60000 }, () => {
  const got = words([
    ['401, user active', 401, ACTIVE], ['403, user active', 403, ACTIVE],
    ['401, user refused', 401, null], ['403, user not active', 403, { id: 'tok-1', status: 'disabled' }],
    ['401, user answer with no id', 401, { status: 'active' }],
  ]);
  for (const k of ['401, user active', '403, user active']) {
    assert.match(got[k].said, OWNED, `${k}: the account-owned words`);
    assert.ok(got[k].said.includes('Manage account, then Account API Tokens'), `${k}: where to make it`);
    assert.deepEqual(got[k].calls, ['GET /user/tokens/verify'], `${k}: one GET on the user path, nothing else`);
  }
  for (const k of ['401, user refused', '403, user not active', '401, user answer with no id']) {
    assert.match(got[k].said, TODAY, `${k}: today's words`);
    assert.doesNotMatch(got[k].said, OWNED, `${k}: never the account-owned words`);
  }
});

test('a 429, a 5xx or no answer on the account\'s path is Cloudflare not answering, and any other answer keeps today\'s words; neither checks the user path', { timeout: 60000 }, () => {
  const got = words([
    ['429', 429, ACTIVE], ['500', 500, ACTIVE], ['503', 503, ACTIVE], ['no answer', null, ACTIVE],
    ['400', 400, ACTIVE], ['404', 404, ACTIVE], ['200 not active', 200, ACTIVE],
  ]);
  for (const k of ['429', '500', '503', 'no answer']) {
    assert.match(got[k].said, /did not answer/, `${k}: Cloudflare did not answer`);
    assert.doesNotMatch(got[k].said, OWNED, `${k}: never the account-owned words`);
    assert.deepEqual(got[k].calls, [], `${k}: the user path is not checked`);
  }
  for (const k of ['400', '404', '200 not active']) {
    assert.match(got[k].said, TODAY, `${k}: today's words`);
    assert.deepEqual(got[k].calls, [], `${k}: the user path is not checked`);
  }
});
