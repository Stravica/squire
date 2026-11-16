'use strict';

// Every page Squire serves, the dashboard included, is shown in Squire's
// default theme, in light and in dark; a Markdown page is shown formatted,
// never as raw marks; when the owner has put a theme file of their own in
// their Squire folder, pages use it in place of the default (AC-901-2).
// Through the real entry point: the page server, started as Squire runs it,
// asked by real requests on this Mac's loopback through the link the owner is
// given (page-server.py --where), as a browser asks: a route is the link's own
// path (the address, the secret, /) then the route, and a page's stylesheet
// link is resolved against the page's own address, nothing added.
//
// Squire's default theme is the one the product's own site wears (the design
// step's values, for BUILD):
//   light  text #213b34 on #f6f5f0; links #2d5c45 (or the text colour)
//   dark   text #f2f2e7 on #17251f; links #c0dca5 (or the text colour),
//          under @media (prefers-color-scheme: dark)
//   type   the Mac's own system font first (-apple-system or system-ui);
//          no font, script or style fetched from any other host
// A page is read as a browser reads its theme: the stylesheets it links (each
// served 200 as text/css), comments dropped, custom properties resolved; the
// light theme from the rules outside any media query, the dark theme with the
// rules under prefers-color-scheme: dark laid over them. A rule counts for the
// page when its selector, once any :not(...) is set aside, is :root, html or
// body; a body rule wins over html, html over :root. Links are a and a:link.
//
// The owner's own theme file is theme.css at the top of the owner's Squire
// folder (a name and a place for the stage-keeper to rule on: the case names
// them here and nowhere else). With it there, the stylesheet a page links is
// the owner's, and its colours are the ones the page shows.
//
// The class is open (any page, any theme); these are instances. No case uses
// a fixed port, any host but this Mac, a model or the network.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const w = require('../fixtures/squire-world.js');
const U = require('../fixtures/usage-world.js');

const DEFAULT = {
  light: { ink: '#213b34', bg: '#f6f5f0', links: ['#2d5c45', '#213b34'] },
  dark: { ink: '#f2f2e7', bg: '#17251f', links: ['#c0dca5', '#f2f2e7'] },
};
const SYSTEM_FONT = /^\s*(-apple-system|system-ui)\b/i;
const ownerTheme = (world) => path.join(world.owner, 'theme.css');
const serverScript = (world) => path.join(world.home, 'core', 'tools', 'page-server.py');
const ADDRESS = /http:\/\/(127\.0\.0\.1|localhost|\[::1\]):(\d+)\//;

function startServer(t, world) {
  const child = spawn(w.PYTHON, [serverScript(world), '--port', '0'], {
    cwd: world.home, env: w.productEnv(world), stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  });
  t.after(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { /* gone */ } });
  let out = '';
  child.stdout.setEncoding('utf8');
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 10000);
    child.stdout.on('data', (d) => { out += d; if (ADDRESS.test(out.split('\n')[0]) && out.includes('\n')) { clearTimeout(timer); resolve(out.split('\n')[0]); } });
    child.on('exit', () => { clearTimeout(timer); resolve(null); });
  });
}

function get(url) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = http.request({ host: u.hostname.replace(/^\[|\]$/g, ''), port: u.port, path: `${u.pathname}${u.search}`, method: 'GET',
      headers: {}, timeout: 5000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('no answer in 5 s')));
    req.on('error', (e) => resolve({ status: 0, headers: {}, body: '', error: String(e.message) }));
    req.end();
  });
}

// A route under the link, in the link's one form: the link's own path (the
// address, the secret, /), then the route, as one path; no query, no cookie.
function under(link, route) {
  const l = new URL(link);
  return new URL(`${l.pathname.replace(/\/$/, '')}${route}`, l.origin).toString();
}

// The page server running in a world, its link opened as a browser opens it.
async function serving(t, world) {
  const first = await startServer(t, world);
  assert.ok(first, 'Squire\'s page server (core/tools/page-server.py --port 0) must start and name its address');
  const where = w.runPython(world, serverScript(world), ['--where'], { cwd: world.home, timeout: 15000 });
  assert.equal(where.status, 0, `the link command must give the link; got ${w.describe(where)}`);
  const link = where.stdout.trim();
  const opened = await get(link);
  return { link, opened, fetch: (route) => get(under(link, route)), fetchUrl: (url) => get(url) };
}

// ------------------------------------------------------- reading a theme

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

// Top-level blocks of a stylesheet: { prelude, body }, at-rules with their
// inner text as body.
function blocks(css) {
  const out = [];
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    if (open < 0) break;
    const prelude = css.slice(i, open).trim();
    let depth = 1;
    let j = open + 1;
    while (j < css.length && depth > 0) {
      if (css[j] === '{') depth += 1;
      else if (css[j] === '}') depth -= 1;
      j += 1;
    }
    out.push({ prelude: prelude.replace(/^[;\s]+/, ''), body: css.slice(open + 1, j - 1) });
    i = j;
  }
  return out;
}

const declarations = (body) => body.split(';').map((d) => {
  const at = d.indexOf(':');
  return at < 0 ? null : [d.slice(0, at).trim().toLowerCase(), d.slice(at + 1).replace(/!important/i, '').trim()];
}).filter((d) => d && d[0]);

// Which element a selector list styles for the page: 'body', 'html', ':root',
// 'a', or none.
function targets(prelude) {
  return prelude.split(',').map((sel) => sel.replace(/:not\([^)]*\)/g, '').trim().toLowerCase())
    .filter((sel) => ['body', 'html', ':root', 'a', 'a:link'].includes(sel))
    .map((sel) => (sel === 'a:link' ? 'a' : sel));
}

// The theme a stylesheet gives the page in a mode: { vars, el: { body, html,
// ':root', a } } with each a map of property to value.
function themeOf(css, mode) {
  const vars = {};
  const el = { body: {}, html: {}, ':root': {}, a: {} };
  const take = (list) => {
    for (const b of list) {
      for (const target of targets(b.prelude)) {
        for (const [prop, value] of declarations(b.body)) {
          if (prop.startsWith('--')) vars[prop] = value;
          else el[target][prop] = value;
        }
      }
    }
  };
  const top = blocks(stripComments(css));
  take(top.filter((b) => !b.prelude.startsWith('@')));
  if (mode === 'dark') {
    for (const b of top.filter((x) => /^@media\b/i.test(x.prelude) && /prefers-color-scheme\s*:\s*dark/i.test(x.prelude))) take(blocks(b.body));
  }
  return { vars, el };
}

function resolve(value, vars, depth = 0) {
  if (!value || depth > 10) return value;
  return value.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*))?\)/g, (m, name, fallback) => resolve(vars[name] !== undefined ? vars[name] : (fallback || ''), vars, depth + 1));
}

function hex(value) {
  const m = /#([0-9a-f]{6}|[0-9a-f]{3})\b/i.exec(value || '');
  if (!m) return null;
  const h = m[1].toLowerCase();
  return `#${h.length === 3 ? h.split('').map((c) => c + c).join('') : h}`;
}

function shown(theme) {
  const pick = (prop) => {
    for (const target of ['body', 'html', ':root']) {
      const v = theme.el[target][prop];
      if (v !== undefined) return resolve(v, theme.vars);
    }
    return undefined;
  };
  const background = pick('background-color') || pick('background');
  const font = pick('font-family') || (pick('font') || '').replace(/^.*?\d[\w.%]*(\/[\w.%]+)?\s+/, '');
  const link = theme.el.a.color !== undefined ? resolve(theme.el.a.color, theme.vars) : pick('color');
  return { ink: hex(pick('color')), bg: hex(background), link: hex(link), font };
}

function luminance(h) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

// The stylesheets a served page links, fetched as the browser fetches them:
// each href resolved against the page's own address, nothing added.
async function stylesheetsOf(server, page, pageUrl) {
  const hrefs = [...page.body.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0])
    .filter((tag) => /rel\s*=\s*["']?stylesheet/i.test(tag))
    .map((tag) => (/href\s*=\s*["']([^"']+)["']/i.exec(tag) || [])[1]).filter(Boolean);
  const sheets = [];
  for (const href of hrefs) {
    sheets.push({ href, res: await server.fetchUrl(new URL(href, pageUrl).toString()) });
  }
  return sheets;
}

const MARKDOWN = '# Weekly orders\n\nThe **wedding cake** is three tiers.\n\n## Saturday\n\n- **Wedding cake**, three tiers\n- *Sourdough*, twelve loaves\n';
const MADE = '<!doctype html><html><head><meta charset="utf-8"><title>Flour order</title><link rel="stylesheet" href="/squire/style.css"></head>' +
  '<body><main class="squire-page"><h1>Flour order</h1><p>25 kg on Thursday.</p></main></body></html>\n';

function seedPages(world) {
  const pages = path.join(world.owner, 'workspace', 'pages');
  fs.mkdirSync(pages, { recursive: true });
  fs.writeFileSync(path.join(pages, 'flour-order.html'), MADE);
  fs.writeFileSync(path.join(pages, 'notes.md'), MARKDOWN);
}

// The three kinds of page: one Squire made, a Markdown page and the dashboard.
const KINDS = [['a page Squire made', '/pages/flour-order.html'], ['a Markdown page', '/pages/notes.md'], ['the home dashboard', '/']];

const visibleText = (html) => html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, '\n');

test("every page Squire serves, the dashboard included, is shown in Squire's default theme in light and in dark: the stylesheet it links gives the default theme's text, background and links in each mode, each at least 4.5 to 1, in the Mac's own system font", { timeout: 60000 }, async (t) => {
  const world = U.usageWorld(t);
  seedPages(world);
  const server = await serving(t, world);
  for (const [kind, route] of KINDS) {
    const page = await server.fetch(route);
    assert.equal(page.status, 200, `${kind} must be served under the link; got ${page.status} ${page.body.slice(0, 200)}`);
    assert.match(String(page.headers['content-type'] || ''), /text\/html/i, `${kind} must be served as a page (text/html); got ${page.headers['content-type']}`);
    const sheets = await stylesheetsOf(server, page, under(server.link, route));
    assert.ok(sheets.length > 0, `${kind} must link a stylesheet; got ${page.body.slice(0, 300)}`);
    for (const s of sheets) {
      assert.equal(s.res.status, 200, `${kind}: its stylesheet ${s.href} must be served; got ${s.res.status}`);
      assert.match(String(s.res.headers['content-type'] || ''), /text\/css/i, `${kind}: its stylesheet ${s.href} is served as text/css`);
    }
    const css = sheets.map((s) => s.res.body).join('\n');
    assert.match(stripComments(css), /@media[^{]*prefers-color-scheme\s*:\s*dark/i, `${kind}: the theme must have a dark half (prefers-color-scheme: dark)`);
    for (const mode of ['light', 'dark']) {
      const got = shown(themeOf(css, mode));
      const want = DEFAULT[mode];
      assert.equal(got.ink, want.ink, `${kind}, ${mode}: the text must be the default theme's ${want.ink}; got ${JSON.stringify(got)}`);
      assert.equal(got.bg, want.bg, `${kind}, ${mode}: the background must be the default theme's ${want.bg}; got ${JSON.stringify(got)}`);
      assert.ok(want.links.includes(got.link), `${kind}, ${mode}: links must be the default theme's ${want.links[0]} (or the text colour); got ${JSON.stringify(got)}`);
      assert.ok(contrast(got.ink, got.bg) >= 4.5 && contrast(got.link, got.bg) >= 4.5, `${kind}, ${mode}: text and links must be at least 4.5 to 1 against the background; got ${JSON.stringify(got)}`);
      assert.match(got.font || '', SYSTEM_FONT, `${kind}, ${mode}: the text must be in the Mac's own system font first; got ${JSON.stringify(got.font)}`);
    }
  }
});

test("a Markdown page is shown formatted, never as raw marks: served as a page with its headings, list and emphasis as HTML, and no # or ** left in its text", { timeout: 60000 }, async (t) => {
  const world = U.usageWorld(t);
  seedPages(world);
  const server = await serving(t, world);
  const r = await server.fetch('/pages/notes.md');
  assert.equal(r.status, 200, `a Markdown page must be served under the link; got ${r.status} ${r.body.slice(0, 200)}`);
  assert.match(String(r.headers['content-type'] || ''), /text\/html/i, `a Markdown page must be shown as a page (text/html), never as raw text; got ${r.headers['content-type']}`);
  assert.match(r.body, /<h1\b[^>]*>\s*Weekly orders\s*<\/h1>/i, 'its first heading is a heading');
  assert.match(r.body, /<h2\b[^>]*>\s*Saturday\s*<\/h2>/i, 'its second heading is a heading');
  assert.match(r.body, /<li\b[^>]*>[\s\S]*?Sourdough[\s\S]*?<\/li>/i, 'its list is a list');
  assert.match(r.body, /<(strong|b)\b[^>]*>\s*wedding cake\s*<\/\1>/i, 'its strong words are strong');
  assert.match(r.body, /<(em|i)\b[^>]*>\s*Sourdough\s*<\/\1>/i, 'its emphasis is emphasis');
  const text = visibleText(r.body);
  assert.ok(!text.split('\n').some((l) => /^\s*#{1,6}\s/.test(l)) && !text.includes('**'), `no raw Markdown marks may be left in what the page shows; got ${JSON.stringify(text.replace(/\s+/g, ' ').slice(0, 300))}`);
});

test("when the owner has put a theme file of their own in their Squire folder, every page Squire serves, the dashboard included, uses it in place of the default", { timeout: 60000 }, async (t) => {
  const world = U.usageWorld(t);
  seedPages(world);
  const mark = `owner-theme-${crypto.randomBytes(6).toString('hex')}`;
  fs.writeFileSync(ownerTheme(world), `/* ${mark} */\n:root { --ink: #111111; --paper: #fafafa; }\n@media (prefers-color-scheme: dark) { :root { --ink: #fafafa; --paper: #111111; } }\n` +
    'body { color: var(--ink); background: var(--paper); font-family: system-ui, sans-serif; }\na { color: var(--ink); }\n');
  const server = await serving(t, world);
  for (const [kind, route] of KINDS) {
    const page = await server.fetch(route);
    assert.equal(page.status, 200, `${kind} must be served under the link; got ${page.status} ${page.body.slice(0, 200)}`);
    const sheets = await stylesheetsOf(server, page, under(server.link, route));
    const css = sheets.map((s) => (s.res.status === 200 ? s.res.body : '')).join('\n');
    assert.ok(css.includes(mark), `${kind} must use the owner's own theme file (${ownerTheme(world)}); the stylesheets it links (${sheets.map((s) => `${s.href} ${s.res.status}`).join(', ') || 'none'}) do not hold it`);
    const light = shown(themeOf(css, 'light'));
    const dark = shown(themeOf(css, 'dark'));
    assert.deepEqual([light.ink, light.bg, dark.ink, dark.bg], ['#111111', '#fafafa', '#fafafa', '#111111'], `${kind}: the owner's theme is used in place of the default; got light ${JSON.stringify(light)}, dark ${JSON.stringify(dark)}`);
  }
});

test("no page Squire serves fetches a font, a script or a style from any other host: every stylesheet, script and font it names is the page server's own", { timeout: 60000 }, async (t) => {
  // A guard at the base head: nothing is fetched from elsewhere now, and the
  // new theme keeps it so.
  const world = U.usageWorld(t);
  seedPages(world);
  const server = await serving(t, world);
  const off = (ref) => /^(https?:)?\/\//i.test(ref.trim()) && !ref.includes(new URL(server.link).host);
  for (const [kind, route] of KINDS) {
    const page = await server.fetch(route);
    if (page.status !== 200) continue;
    const refs = [...page.body.matchAll(/<(link|script|img)\b[^>]*\b(href|src)\s*=\s*["']([^"']+)["']/gi)].map((m) => m[3]);
    assert.deepEqual(refs.filter(off), [], `${kind} must name nothing on another host`);
    for (const s of await stylesheetsOf(server, page, under(server.link, route))) {
      const urls = [...stripComments(s.res.body).matchAll(/(?:url\(\s*["']?|@import\s+["'])([^"')]+)/gi)].map((m) => m[1]);
      assert.deepEqual(urls.filter(off), [], `${kind}: its stylesheet ${s.href} must fetch no font or style from another host`);
    }
  }
});
