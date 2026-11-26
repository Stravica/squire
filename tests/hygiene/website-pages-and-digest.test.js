'use strict';

// Code hygiene for the website command's reading of the account's
// subscriptions page by page (core/tools/website.py, SetUp.subscriptions,
// SetUp.page_of, SetUp.paid and SetUp.paid_words), the floor's ask for the
// set-up run again to keep what costs money (core/hooks/pre-tool-use.py,
// WebsiteCommand.keep_paid), and the deploy's digest of the folder it reads
// (Deploy.files, Deploy.said_yes_to) against the floor's own digest of the
// folder it lets the deploy run over (WebsiteCommand.digest,
// WebsiteCommand.said_yes). Bound to no criterion. Nothing is called: the API
// here is a fake of the test's own handed to the set-up in-process, and every folder is
// made in the test's own temporary folder.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const w = require('../fixtures/squire-world.js');

const WEBSITE = path.join(w.CORE, 'tools', 'website.py');
const FLOOR = path.join(w.CORE, 'hooks', 'pre-tool-use.py');

function python(lines, args) {
  const r = spawnSync(w.PYTHON, ['-c', lines.join('\n'), ...args], { encoding: 'utf8', timeout: 30000, env: { PATH: '/usr/bin:/bin', PYTHONDONTWRITEBYTECODE: '1' } });
  assert.equal(r.status, 0, `the Python ran; got ${r.status} ${r.stderr}`);
  return JSON.parse(r.stdout);
}

const LOAD = [
  'import importlib.util, json, sys',
  'def load(name, where):',
  '    spec = importlib.util.spec_from_file_location(name, where)',
  '    module = importlib.util.module_from_spec(spec)',
  '    spec.loader.exec_module(module)',
  '    return module',
];

// Each case: the pages the API answers ({ status, answer }, by page), and
// what the reading gives: the names read, whether whole, or not done.
function pagesRead(cases) {
  return python([
    ...LOAD,
    'website = load("website_under_test", sys.argv[1])',
    'class Api:',
    '    def __init__(self, pages):',
    '        self.pages, self.paths = pages, []',
    '    def call(self, method, path, token, **_):',
    '        self.paths.append(path)',
    '        page = int(path.split("page=")[1]) if "page=" in path else 1',
    '        got = self.pages[page - 1] if page <= len(self.pages) else {"status": 200, "answer": {"success": True, "result": []}}',
    '        return got["status"], got["answer"]',
    'out = {}',
    'for label, pages in json.loads(sys.argv[2]):',
    '    s = object.__new__(website.SetUp)',
    '    s.account, s.token, s.api = "0123456789abcdef0123456789abcdef", "t", Api(pages)',
    '    try:',
    '        items, whole = s.subscriptions()',
    '        out[label] = {"names": [i.get("id") for i in items], "whole": whole, "paths": s.api.paths}',
    '    except website.NotDone as e:',
    '        out[label] = {"notDone": str(e), "paths": s.api.paths}',
    'print(json.dumps(out))',
  ], [WEBSITE, JSON.stringify(cases)]);
}

const page = (ids, info) => ({ status: 200, answer: { success: true, result: ids.map((id) => ({ id, price: 0 })), ...(info === undefined ? {} : { result_info: info }) } });

test('the subscriptions are read whole only by a positive match: one answer with no page counts, or every page named read and as many items as the count says; anything else is not whole, and a first read that fails is not done', { timeout: 60000 }, () => {
  const got = pagesRead([
    ['one answer, no page counts', [page(['a', 'b'])]],
    ['one answer, page counts null', [page(['a'], null)]],
    ['two pages, counts right', [page(['a'], { page: 1, total_pages: 2, total_count: 2 }), page(['b'], { page: 2, total_pages: 2, total_count: 2 })]],
    ['page counts missing', [page(['a'], { page: 1, per_page: 1, count: 1 })]],
    ['page counts not an object', [page(['a'], 'two')]],
    ['total pages a word', [page(['a'], { total_pages: 'two', total_count: 2 })]],
    ['total pages true', [page(['a'], { total_pages: true, total_count: 1 })]],
    ['total pages zero', [page(['a'], { total_pages: 0, total_count: 1 })]],
    ['total pages past what is read', [page(['a'], { total_pages: 1000, total_count: 1000 })]],
    ['count short of the items named', [page(['a'], { total_pages: 1, total_count: 2 })]],
    ['a later page fails', [page(['a'], { total_pages: 2, total_count: 2 }), { status: 500, answer: { success: false, result: null } }]],
    ['a later page not JSON', [page(['a'], { total_pages: 2, total_count: 2 }), { status: 200, answer: null }]],
    ['a first read that fails', [{ status: 500, answer: { success: false } }]],
    ['a first read with no list', [{ status: 200, answer: { success: true, result: {} } }]],
  ]);
  assert.deepEqual(got['one answer, no page counts'], { names: ['a', 'b'], whole: true, paths: ['/accounts/0123456789abcdef0123456789abcdef/subscriptions'] });
  assert.equal(got['one answer, page counts null'].whole, true);
  assert.deepEqual(got['two pages, counts right'].names, ['a', 'b']);
  assert.equal(got['two pages, counts right'].whole, true);
  assert.ok(got['two pages, counts right'].paths[1].endsWith('/subscriptions?page=2'), JSON.stringify(got['two pages, counts right']));
  for (const label of ['page counts missing', 'page counts not an object', 'total pages a word', 'total pages true', 'total pages zero', 'total pages past what is read', 'count short of the items named', 'a later page fails', 'a later page not JSON']) {
    assert.equal(got[label].whole, false, `${label}: not whole; got ${JSON.stringify(got[label])}`);
  }
  assert.equal(got['total pages past what is read'].paths.length, 1, 'past what Squire reads, no further page is asked for');
  for (const label of ['a first read that fails', 'a first read with no list']) {
    assert.match(got[label].notDone || '', /could not read the account's subscriptions/, `${label}: not done; got ${JSON.stringify(got[label])}`);
  }
});

test('the set-up names a paid item with its price, currency and frequency as read, and one it cannot price in words saying so; the warning says it costs money and that Squire changes no billing; paging it cannot read whole is not done, naming what it found', { timeout: 60000 }, () => {
  const got = python([
    ...LOAD,
    'website = load("website_under_test", sys.argv[1])',
    'class Api:',
    '    def __init__(self, answer):',
    '        self.answer = answer',
    '    def call(self, method, path, token, **_):',
    '        return 200, self.answer',
    'out = {}',
    'for label, answer in json.loads(sys.argv[2]):',
    '    s = object.__new__(website.SetUp)',
    '    s.account, s.token, s.api = "0123456789abcdef0123456789abcdef", "t", Api(answer)',
    '    try:',
    '        paid = s.paid()',
    '        out[label] = {"paid": paid, "said": s.paid_words(paid, None) if paid else "", "beyond": s.paid_words(paid, paid[:1]) if paid else ""}',
    '    except website.NotDone as e:',
    '        out[label] = {"notDone": str(e)}',
    'print(json.dumps(out))',
  ], [WEBSITE, JSON.stringify([
    ['priced', { success: true, result: [{ id: 's1', price: 0 }, { id: 's2', rate_plan: { public_name: 'Plan A' }, price: 12, currency: 'GBP', frequency: 'yearly' }] }],
    ['no-price', { success: true, result: [{ id: 's3', rate_plan: { id: 'plan-two' }, price: 'nothing' }, { id: 's4', price: false }] }],
    ['not whole', { success: true, result: [{ id: 's5', rate_plan: { public_name: 'Plan C' }, price: 3 }], result_info: { total_pages: 1, total_count: 9 } }],
  ])]);
  assert.deepEqual(got.priced.paid, [{ id: 's2', name: 'Plan A', price: '12 GBP yearly' }]);
  assert.match(got.priced.said, /Plan A \(12 GBP yearly\)/);
  assert.match(got.priced.said, /costs you money/);
  assert.match(got.priced.said, /Squire changes no billing/);
  assert.match(got.priced.said, /--keep-paid/);
  assert.match(got.priced.beyond, /covered only what Squire named before it/);
  assert.deepEqual(got['no-price'].paid.map((x) => [x.name, x.price]), [['plan-two', 'a price Squire cannot read'], ['s4', 'a price Squire cannot read']]);
  assert.match(got['not whole'].notDone, /could not read every page/);
  assert.match(got['not whole'].notDone, /Plan C \(3\)/);
  assert.doesNotMatch(got['not whole'].notDone, /reads as free/);
});

test("the floor's ask for keeping what costs money names each item the set-up last named on that account, its yes bound to exactly those items, and says so when nothing was named", { timeout: 60000 }, (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'squire-hygiene-keep-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, 'runtime'), { recursive: true });
  const account = '0123456789abcdef0123456789abcdef';
  const record = (items, on = account) => fs.writeFileSync(path.join(home, 'runtime', 'cloudflare-paid.json'), JSON.stringify({ accountId: on, items }));
  const ask = () => python([
    ...LOAD,
    'floor = load("floor_under_test", sys.argv[1])',
    'class Config:',
    '    home = sys.argv[2]',
    'class Floor:',
    '    config = Config()',
    'what, item = floor.WebsiteCommand.keep_paid(Floor(), sys.argv[3])',
    'print(json.dumps({"what": what, "item": item}))',
  ], [FLOOR, home, account.toUpperCase()]);
  record([{ id: 's2', name: 'Plan A', price: '12 GBP yearly' }]);
  const one = ask();
  assert.match(one.what, /Plan A \(12 GBP yearly\)/);
  assert.match(one.what, /costs you money/);
  record([{ id: 's2', name: 'Plan A', price: '12 GBP yearly' }, { id: 's3', name: 'Plan B', price: '1 GBP' }]);
  const two = ask();
  assert.match(two.what, /Plan A \(12 GBP yearly\); Plan B \(1 GBP\)/);
  assert.notEqual(one.item, two.item, 'a yes is bound to the items named');
  record([{ id: 's2', name: 'Plan A', price: '12 GBP yearly' }], 'ffffffffffffffffffffffffffffffff');
  const other = ask();
  assert.match(other.what, /named nothing it pays for/, 'a record of another account names nothing here');
});

test("the deploy's digest of the folder it reads is the floor's digest of the same folder, and the floor's record of a yes is taken by one deploy run only", { timeout: 60000 }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'squire-hygiene-digest-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const site = path.join(root, 'site');
  fs.mkdirSync(path.join(home, 'runtime'), { recursive: true });
  fs.mkdirSync(path.join(site, 'css', 'deep'), { recursive: true });
  fs.mkdirSync(path.join(site, 'empty'), { recursive: true });
  fs.writeFileSync(path.join(site, 'index.html'), '<p>one</p>\n');
  fs.writeFileSync(path.join(site, 'css', 'a.css'), 'p{}\n');
  fs.writeFileSync(path.join(site, 'css', 'deep', 'b.css'), 'q{}\n');
  fs.writeFileSync(path.join(site, '.hidden'), 'x\n');
  const got = python([
    ...LOAD,
    'website = load("website_under_test", sys.argv[1])',
    'floor = load("floor_under_test", sys.argv[2])',
    'home, site = sys.argv[3], sys.argv[4]',
    'class Config:',
    '    pass',
    'config = Config()',
    'config.home = home',
    'class Floor:',
    '    pass',
    'f = Floor()',
    'f.config = config',
    'd = object.__new__(website.Deploy)',
    'd.config, d.folder, d.name = config, site, "a-site"',
    'd.files()',
    'kept = floor.WebsiteCommand.said_yes(f, site, "a-site", floor.WebsiteCommand.digest(site))',
    'first, second = d.said_yes_to(), d.said_yes_to()',
    'print(json.dumps({"deploy": d.digest, "floor": floor.WebsiteCommand.digest(site), "kept": kept, "first": first, "second": second}))',
  ], [WEBSITE, FLOOR, home, site]);
  assert.equal(got.deploy, got.floor, 'the same folder gives the same digest to the deploy and to the floor');
  assert.equal(got.kept, true);
  assert.equal(got.first, got.floor, 'the deploy reads the digest the yes covered');
  assert.equal(got.second, null, 'one yes serves one deploy run');
});
