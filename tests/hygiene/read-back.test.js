'use strict';

// Code hygiene for the deploy's read-back (core/tools/website.py, Deploy):
// each answer a read can get has one verdict, decided by a positive match
// only; a read-back reports "not live yet" only when every read answered as
// an address not live yet does, and any other answer leaves the site one
// Squire could not confirm. Bound to no criterion. No read leaves this Mac:
// the reads here are stand-ins handed to the verdict in-process.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const w = require('../fixtures/squire-world.js');

const WEBSITE = path.join(w.CORE, 'tools', 'website.py');

// Runs a few lines of Python against the website command's Deploy class,
// loaded from this core; the lines print one JSON value.
function python(lines) {
  const program = [
    'import importlib.util, json, socket, ssl, sys',
    'spec = importlib.util.spec_from_file_location("website_under_test", sys.argv[1])',
    'website = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(website)',
    'Deploy = website.Deploy',
    ...lines,
  ].join('\n');
  const r = spawnSync(w.PYTHON, ['-c', program, WEBSITE], { encoding: 'utf8', timeout: 30000, env: { PATH: '/usr/bin:/bin', PYTHONDONTWRITEBYTECODE: '1' } });
  assert.equal(r.status, 0, `the Python ran; got ${r.status} ${r.stderr}`);
  return JSON.parse(r.stdout);
}

test('each answer a read of a site\'s address can get has its one verdict: live only for the site\'s own page, not live yet only for the five answers of an address not live yet, and could not confirm, with a reason, for everything else', { timeout: 60000 }, () => {
  const got = python([
    'page = b"<p>the site</p>"',
    'cases = {',
    '  "200 the page": (200, None, page, page), "200 and no page to compare": (200, None, None, None),',
    '  "200 another page": (200, None, b"<p>wait</p>", page), "200 one byte off": (200, None, page + b" ", page),',
    '  "404": (404, None, None, page), "503": (503, None, None, page),',
    '  "403": (403, None, None, page), "429": (429, None, None, page), "500": (500, None, None, page),',
    '  "502": (502, None, None, page), "301": (301, None, None, page), "401": (401, None, None, page),',
    '  "no such name": (None, socket.gaierror(8, "nodename nor servname provided"), None, page),',
    '  "refused": (None, ConnectionRefusedError(61, "Connection refused"), None, page),',
    '  "TLS": (None, ssl.SSLError(1, "handshake failure"), None, page),',
    '  "timed out": (None, socket.timeout("timed out"), None, page), "timeout": (None, TimeoutError(), None, page),',
    '  "reset": (None, ConnectionResetError(54, "reset"), None, page), "words": (None, "a reason in words", None, page),',
    '  "nothing": (None, None, None, page),',
    '}',
    'print(json.dumps({k: list(Deploy.verdict_of(*v)) for k, v in cases.items()}))',
  ]);
  for (const k of ['200 the page', '200 and no page to compare']) assert.deepEqual(got[k], ['live', null], k);
  for (const k of ['404', '503', 'no such name', 'refused', 'TLS']) assert.deepEqual(got[k], ['not live yet', null], k);
  for (const k of ['200 another page', '200 one byte off', '403', '429', '500', '502', '301', '401', 'timed out', 'timeout', 'reset', 'words', 'nothing']) {
    assert.equal(got[k][0], 'could not confirm', `${k}: could not confirm`);
    assert.equal(typeof got[k][1], 'string', `${k}: a reason`);
    assert.ok(got[k][1].length > 0, `${k}: a reason in words`);
    assert.doesNotMatch(got[k][1], /\bnot (reported )?live\b|deploy/i, `${k}: the reason never says not live and never advises a deploy`);
  }
  assert.match(got['403'][1], /refused/, 'a 403 says the address refused Squire\'s check');
});

test('the read-back says not live yet only when every read answered as an address not live yet does, says live at the first read of the site\'s page, and keeps any other answer as could not confirm', { timeout: 60000 }, () => {
  const got = python([
    'def run(answers, within):',
    '    d = object.__new__(Deploy)',
    '    d.LIVE_WITHIN = within',
    '    seen = list(answers)',
    '    d.read_once = lambda page: Deploy.verdict_of(*seen.pop(0)) if len(seen) > 1 else Deploy.verdict_of(*seen[0])',
    '    return list(d.live(b"p"))',
    'print(json.dumps({',
    '  "404 throughout": run([(404, None, None, b"p")], 0),',
    '  "404 then the page": run([(404, None, None, b"p"), (200, None, b"p", b"p")], 2),',
    '  "403 then 404": run([(403, None, None, b"p"), (404, None, None, b"p")], 2),',
    '  "404 then 429": run([(404, None, None, b"p"), (429, None, None, b"p")], 2),',
    '}))',
  ]);
  assert.deepEqual(got['404 throughout'], ['not live yet', null]);
  assert.deepEqual(got['404 then the page'], ['live', null]);
  assert.equal(got['403 then 404'][0], 'could not confirm');
  assert.match(got['403 then 404'][1], /refused/);
  assert.equal(got['404 then 429'][0], 'could not confirm');
});

test('the read-back reads as an ordinary browser does, with a signature of Squire\'s own that is not the default of Python\'s own library', { timeout: 60000 }, () => {
  const got = python(['print(json.dumps(Deploy.CLIENT))']);
  assert.match(got['User-Agent'], /^Mozilla\/5\.0 /, 'a browser-like signature');
  assert.match(got['User-Agent'], /Squire/, 'naming Squire');
  assert.doesNotMatch(got['User-Agent'], /Python-urllib/i, 'not Python\'s default signature');
  assert.match(got.Accept, /text\/html/, 'it asks for a page, as a browser does');
});
