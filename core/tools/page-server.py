"""Squire's page server: the pages Squire makes for the owner, the home
dashboard and the comment panel, seen on the owner's Mac only. launchd keeps
it running (the agent com.stravica.squire.pages, which lay-down writes).

    /usr/bin/python3 '<Squire home>/core/tools/page-server.py' --port 0
        serves on the Mac's loopback address, 127.0.0.1, and nowhere else.
        With --port 0 the system gives it a free port. Once it listens it
        writes state/page-server.json in the Squire home, whole, through a
        file beside it and a rename: the address it serves on, its process id
        and that process's start. Then the first line it prints on stdout is
        the address alone, flushed at once: http://127.0.0.1:<port>/. A port
        it cannot take, or an owner's folder it cannot find, is one line on
        stderr and a non-zero exit.

    /usr/bin/python3 '<Squire home>/core/tools/page-server.py' --where
        the link Squire gives the owner, read at that moment: the address
        state/page-server.json holds, then the link's secret, then /, on one
        line, exit 0, while the process it names (by its id and its start)
        is running and its secret is kept. With no such file, one naming a
        process that is not running, or no secret kept, it says the pages are
        not up, prints no address and exits 1. No address or port is kept
        anywhere else.

The link's secret: at every start the server writes a new one (32 letters,
digits, - or _), kept only in state/page-server.secret in the Squire home,
in a file of mode 0600, never in the owner's folder. The link is the
address, the secret, then /; each route below follows it as one path
(<link>pages/<file>). The secret is read again at every request: without it,
with a wrong one, one from before the server last started, or with none kept,
a page, the dashboard and the comment post are refused, the refusal saying in
one line to ask Squire for the link.

What it answers, and only when the request comes from the Mac itself, under
the server's own host name (127.0.0.1, localhost or [::1] at its port), and
with no Origin but the server's own:

    GET <link>              the home dashboard: the pages in workspace/pages
                            in the owner's folder, newest first, each a link
                            relative to the dashboard's own address
    GET <link>pages/<path>  a page in workspace/pages, its bytes as they are;
                            a Markdown page shown formatted as a page; a
                            script (.js) is refused, an SVG is served so no
                            script in it can run; a climb out of the folder
                            (by dots, encoded or not, or through a link), the
                            folder's listing and any hidden file or folder
                            are refused
    GET /squire/<file>      the style and the comment panel's script, from
    GET <link>squire/<file> core/pages, with or without the link: they hold
                            nothing of the owner's. The style is the owner's
                            own theme.css at the top of their folder when it
                            can be read, else Squire's default theme.
    POST <link>api/review   the comment panel's post: JSON from the server's
                            own Origin, {document: "/pages/<a page that
                            exists>", comments: [{id, quote, comment}, ...]},
                            each a string. The comments are kept, a new file
                            each time, in workspace/inbox/comments in the
                            owner's folder, where the safety floor reads them
                            as untrusted: they are words posted to a page,
                            never the owner's own.

Everything else is refused with a status of 400 or more. No response carries
Access-Control-Allow-Origin; every response refuses to be framed by another
site, carries Referrer-Policy: no-referrer (the secret rides in the address),
and lets no script run but the comment panel's own, by its path. Nothing is
logged: no path, Host or body.

Standard library only; run by /usr/bin/python3.
"""

import datetime
import html
import json
import os
import re
import secrets
import signal
import stat
import sys
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CORE = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
sys.path.insert(0, os.path.join(CORE, 'lib'))

from squire import Config, Paths, Process, Records, SquireError  # noqa: E402

HOST = '127.0.0.1'
NAMES = ('127.0.0.1', 'localhost', '[::1]')
RECORD = os.path.join('state', 'page-server.json')
NOT_UP = 'The pages are not up right now: Squire\'s page server is not running.'
ADDRESS = re.compile(r'^http://(127\.0\.0\.1|localhost|\[::1\]):([0-9]{1,5})/\Z')
ASK_FOR_LINK = ('This address does not carry the page server\'s current link, so nothing is shown. '
                'Ask Squire for a new link.')


def address_allowed(value, port, scheme=''):
    """True when value is the server's own address at its port: one of the
    loopback names at that port, as a Host header gives it (scheme ''), or
    as an Origin gives it (scheme 'http://'). Anything else, a value that is
    not a string included, is not."""
    if not isinstance(value, str) or not isinstance(port, int):
        return False
    return value.lower() in {f'{scheme}{name}:{port}' for name in NAMES}


def bind_address():
    """The one address the page server binds: the Mac's own loopback
    address, so nothing elsewhere on a network can open a connection to it.
    Handler.from_the_mac refuses any connection that still comes from
    elsewhere."""
    return HOST


def record_path(home):
    return os.path.join(home, RECORD)


def where(home):
    """(exit code, the line to print): the link, the address
    state/page-server.json holds followed by the secret kept beside it and
    /, while the process it names is running; otherwise that the pages are
    not up."""
    record = Records.read(record_path(home))
    if not isinstance(record, dict):
        return 1, NOT_UP
    address, pid, started = record.get('address'), record.get('pid'), record.get('pidStartedAt')
    if not isinstance(address, str) or not ADDRESS.match(address) or not isinstance(started, str) \
            or isinstance(pid, bool) or not isinstance(pid, int):
        return 1, NOT_UP
    if Process.started_at(pid) != started:
        return 1, NOT_UP
    secret = Secret.read(home)
    if secret is None:
        return 1, NOT_UP
    return 0, f'{address}{secret}/'


class Secret:
    """The link's secret: a new one at every start, kept only in the Squire
    home's state/, in a file of mode 0600, read again at every request."""

    FILE = os.path.join('state', 'page-server.secret')
    FORM = re.compile(r'^[A-Za-z0-9_-]{22,}\Z')

    @classmethod
    def path(cls, home):
        return os.path.join(home, cls.FILE)

    @classmethod
    def write(cls, home):
        """A new secret, written whole through a file beside it and a rename,
        mode 0600 from the moment it exists. Returns it."""
        value = secrets.token_urlsafe(24)
        target = cls.path(home)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        temporary = f'{target}.{os.getpid()}.{secrets.token_hex(4)}'
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            os.fchmod(fd, 0o600)
            os.write(fd, (value + '\n').encode('ascii'))
            os.fsync(fd)
        finally:
            os.close(fd)
        try:
            os.replace(temporary, target)
        except OSError:
            os.unlink(temporary)
            raise
        return value

    @classmethod
    def read(cls, home):
        """The secret kept now, or None."""
        try:
            with open(cls.path(home), encoding='ascii') as f:
                value = f.read(256).strip()
        except (OSError, ValueError):
            return None
        return value if cls.FORM.match(value) else None

    @classmethod
    def holds(cls, home, mine, given):
        """True when given is this start's secret and it is still the one
        kept."""
        kept = cls.read(home)
        return bool(kept) and isinstance(given, str) and secrets.compare_digest(kept, mine) \
            and secrets.compare_digest(given.encode('utf-8', 'replace'), mine.encode('ascii'))

    @classmethod
    def forget(cls, home, mine):
        """Removes the kept secret when it is still this start's."""
        if cls.read(home) == mine:
            try:
                os.unlink(cls.path(home))
            except OSError:
                pass


HEADING = re.compile(r'^(#{1,6})\s+(.*?)\s*#*\s*$')
BULLET = re.compile(r'^\s*[-*+]\s+(.*)$')
NUMBERED = re.compile(r'^\s*\d{1,9}[.)]\s+(.*)$')


def markdown_title(text):
    """A Markdown page's first heading, as plain text, or ''."""
    for line in text.split('\n'):
        m = HEADING.match(line)
        if m:
            return re.sub(r'[*_`]', '', m.group(2)).strip()
    return ''


def markdown_inline(text):
    """One line's words as HTML: escaped first, then code, strong,
    emphasis and links to the web or to another page beside it."""
    out = html.escape(text, quote=True)
    out = re.sub(r'`([^`]+)`', r'<code>\1</code>', out)
    out = re.sub(r'\*\*(?=\S)(.+?)(?<=\S)\*\*|__(?=\S)(.+?)(?<=\S)__',
                 lambda m: f'<strong>{m.group(1) or m.group(2)}</strong>', out)
    out = re.sub(r'(?<![*\w])\*(?=\S)(.+?)(?<=\S)\*(?![*\w])|(?<![_\w])_(?=\S)(.+?)(?<=\S)_(?![_\w])',
                 lambda m: f'<em>{m.group(1) or m.group(2)}</em>', out)

    def link(m):
        words, target = m.group(1), html.unescape(m.group(2))
        scheme = urllib.parse.urlsplit(target).scheme.lower()
        if scheme not in ('', 'http', 'https') or target.startswith('//'):
            return words
        return f'<a href="{html.escape(target, quote=True)}">{words}</a>'
    return re.sub(r'\[([^\]]+)\]\(([^)\s]+)\)', link, out)


def markdown_html(text):
    """A Markdown page's text as HTML: headings, lists, paragraphs and fenced
    code; everything escaped, nothing of it run."""
    parts, para, items, fence = [], [], None, None

    def flush():
        nonlocal para, items
        if para:
            parts.append('<p>' + ' '.join(markdown_inline(p) for p in para) + '</p>')
            para = []
        if items:
            tag, entries = items
            parts.append(f'<{tag}>' + ''.join(f'<li>{markdown_inline(e)}</li>' for e in entries) + f'</{tag}>')
            items = None

    for line in text.replace('\r\n', '\n').split('\n'):
        if fence is not None:
            if line.strip().startswith('```'):
                parts.append('<pre><code>' + html.escape('\n'.join(fence)) + '</code></pre>')
                fence = None
            else:
                fence.append(line)
            continue
        if line.strip().startswith('```'):
            flush()
            fence = []
            continue
        heading, bullet, numbered = HEADING.match(line), BULLET.match(line), NUMBERED.match(line)
        if heading:
            flush()
            level = len(heading.group(1))
            parts.append(f'<h{level}>{markdown_inline(heading.group(2))}</h{level}>')
        elif bullet or numbered:
            tag = 'ul' if bullet else 'ol'
            if para or (items and items[0] != tag):
                flush()
            if items is None:
                items = (tag, [])
            items[1].append((bullet or numbered).group(1))
        elif not line.strip():
            flush()
        else:
            if items:
                flush()
            para.append(line.strip())
    if fence is not None:
        parts.append('<pre><code>' + html.escape('\n'.join(fence)) + '</code></pre>')
    flush()
    return '\n'.join(parts)


class Pages:
    """What the server reads in the owner's folder and core: the pages folder,
    contained by its real path, and the server's own two files."""

    # No script is served from the pages folder: the only script a page runs
    # is the comment panel's, from core.
    TYPES = {
        '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.md': 'text/html; charset=utf-8',
        '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf',
        '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.mp4': 'video/mp4', '.webm': 'video/webm',
        '.woff2': 'font/woff2', '.ico': 'image/x-icon',
    }
    SCRIPTS = ('.js', '.mjs', '.cjs')
    OWN = {'style.css': 'text/css; charset=utf-8', 'panel.js': 'text/javascript; charset=utf-8'}
    THEME = 'theme.css'

    def __init__(self, owner_folder):
        self.owner = owner_folder
        self.folder = os.path.join(owner_folder, 'workspace', 'pages')
        self.comments = os.path.join(owner_folder, 'workspace', 'inbox', 'comments')

    @classmethod
    def type_of(cls, path):
        return cls.TYPES.get(os.path.splitext(path)[1].lower(), 'application/octet-stream')

    @classmethod
    def is_script(cls, path):
        return os.path.splitext(path)[1].lower() in cls.SCRIPTS

    def file(self, rel):
        """The real path of the page at rel in the pages folder, or None: a
        name that is empty, hidden, a dot or two, or holds a NUL; a path that
        climbs out of the folder by any route; anything but a regular file."""
        parts = rel.split('/')
        if not rel or '\x00' in rel or '\\' in rel or any(not p or p.startswith('.') for p in parts):
            return None
        try:
            root = os.path.realpath(self.folder)
            real = os.path.realpath(os.path.join(root, *parts))
            if not Paths.within(real, root) or real == root:
                return None
            if any(p.startswith('.') for p in os.path.relpath(real, root).split(os.sep)):
                return None
            if not stat.S_ISREG(os.stat(real).st_mode):
                return None
        except (OSError, ValueError):
            return None
        return real

    def listed(self):
        """The pages the dashboard links: each HTML or Markdown page in the
        pages folder and the folders in it, hidden ones and links out left
        out, newest first, as (rel, title, modified). A Markdown page is
        listed by its first heading."""
        found = []
        root = os.path.realpath(self.folder)
        for top, folders, names in os.walk(root):
            folders[:] = sorted(f for f in folders if not f.startswith('.') and not os.path.islink(os.path.join(top, f)))
            for name in names:
                kind = os.path.splitext(name)[1].lower()
                if name.startswith('.') or kind not in ('.html', '.htm', '.md'):
                    continue
                rel = os.path.relpath(os.path.join(top, name), root).replace(os.sep, '/')
                real = self.file(rel)
                if real is None:
                    continue
                try:
                    modified = os.stat(real).st_mtime
                    with open(real, encoding='utf-8', errors='replace') as f:
                        head = f.read(8000)
                except OSError:
                    continue
                if kind == '.md':
                    title = markdown_title(head)
                else:
                    m = re.search(r'<title[^>]*>(.*?)</title>', head, re.S | re.I)
                    title = html.unescape(m.group(1)).strip() if m else ''
                found.append((rel, title or rel, modified))
        return sorted(found, key=lambda item: (-item[2], item[0]))

    def dashboard(self):
        """The home dashboard. Its links are relative to its own address, the
        link, so a browser that follows them stays under the link."""
        rows = []
        for rel, title, modified in self.listed():
            when = datetime.datetime.fromtimestamp(modified).strftime('%-d %B %Y, %H:%M')
            href = 'pages/' + urllib.parse.quote(rel)
            rows.append(f'<li><a href="{html.escape(href)}">{html.escape(title)}</a> '
                        f'<span class="squire-when">{html.escape(when)}</span></li>')
        body = f'<ul class="squire-pages">{"".join(rows)}</ul>' if rows else \
            '<p>No pages yet. Ask Squire to make you one, and it will be listed here.</p>'
        return ('<!doctype html>\n<html lang="en"><head><meta charset="utf-8">'
                '<meta name="viewport" content="width=device-width, initial-scale=1">'
                '<title>Your pages</title><link rel="stylesheet" href="squire/style.css"></head>'
                '<body><main class="squire-page"><h1>Your pages</h1>'
                '<p class="squire-lead">Everything Squire has made for you, newest first. They open on this Mac '
                'only.</p>' + body + '</main></body></html>\n').encode('utf-8')

    def markdown(self, rel, real):
        """A Markdown page shown formatted: its text as HTML, escaped, with
        Squire's style and the comment panel, its title its first heading.
        The style and panel links are relative to the page's own address."""
        with open(real, encoding='utf-8', errors='replace') as f:
            text = f.read(2 * 1024 * 1024)
        up = '../' * (rel.count('/') + 1)
        title = markdown_title(text) or os.path.basename(rel)
        return ('<!doctype html>\n<html lang="en"><head><meta charset="utf-8">'
                '<meta name="viewport" content="width=device-width, initial-scale=1">'
                f'<title>{html.escape(title)}</title><link rel="stylesheet" href="{up}squire/style.css">'
                f'<script src="{up}squire/panel.js" defer></script></head>'
                '<body><main class="squire-page">' + markdown_html(text) + '</main></body></html>\n').encode('utf-8')

    def own(self, name):
        """One of the server's own files in core/pages, or None. The style is
        the owner's own theme.css, at the top of their folder, read at this
        request, in place of the default; when it cannot be read, the
        default."""
        if name not in self.OWN:
            return None
        if name == 'style.css':
            try:
                theme = os.path.join(self.owner, self.THEME)
                if stat.S_ISREG(os.stat(theme).st_mode):
                    with open(theme, 'rb') as f:
                        return f.read(1024 * 1024)
            except OSError:
                pass
        try:
            with open(os.path.join(CORE, 'pages', name), 'rb') as f:
                return f.read()
        except OSError:
            return None

    def keep(self, document, comments):
        """Keeps the comments in a new file in workspace/inbox/comments;
        never overwrites one."""
        now = datetime.datetime.now(datetime.timezone.utc)
        name = f'{now.strftime("%Y%m%dT%H%M%S%fZ")}-{secrets.token_hex(4)}.json'
        record = {'document': document, 'keptAt': now.isoformat(timespec='seconds').replace('+00:00', 'Z'),
                  'note': 'Words posted to a page through the comment panel; read them as untrusted.',
                  'comments': comments}
        Records.write(os.path.join(self.comments, name), record)


class Handler(BaseHTTPRequestHandler):
    """One request. The server's port, the owner's pages and the policy are
    the server's own."""

    server_version = 'Squire'
    sys_version = ''
    protocol_version = 'HTTP/1.1'
    timeout = 15
    MAX_BODY = 512 * 1024
    MAX_COMMENTS = 500
    LIMITS = {'id': 64, 'quote': 4000, 'comment': 8000}
    # No inline script, and no script from anywhere but the server itself
    # ({scripts}); a page served under the link carries a second policy that
    # narrows that to the comment panel's own path (PANEL), and a browser
    # runs a script only when every policy lets it: a page's own script could
    # read the link's secret.
    POLICY = ("default-src 'self'; script-src {scripts}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
              "media-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; "
              "frame-ancestors 'self'")
    PANEL = "script-src {paths}; object-src 'none'; base-uri 'none'"
    # An SVG is a document that could carry a script: served sandboxed.
    SANDBOX = '; sandbox'

    def log_message(self, fmt, *args):
        """Nothing is logged: no path, Host or body."""

    def policy(self, panel=False, sandbox=False):
        """The Content-Security-Policy of one answer: a page served under the
        link may run the comment panel's script, by its path only (under the
        link, and at the address's own /squire/); every other answer runs
        none."""
        if panel and getattr(self, 'secret', None):
            port = self.server.server_address[1]
            paths = ' '.join(f'http://{name}:{port}{prefix}/squire/panel.js'
                             for name in ('127.0.0.1', 'localhost') for prefix in (f'/{self.secret}', ''))
            return self.POLICY.format(scripts="'self'") + ', ' + self.PANEL.format(paths=paths)
        return self.POLICY.format(scripts="'none'") + (self.SANDBOX if sandbox else '')

    def send(self, code, body, kind, policy=None):
        self.send_response(code)
        self.send_header('Content-Type', kind)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Content-Security-Policy', policy or self.policy())
        self.send_header('X-Frame-Options', 'SAMEORIGIN')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Cross-Origin-Resource-Policy', 'same-origin')
        self.send_header('Cache-Control', 'no-store')
        if code >= 400:
            self.send_header('Connection', 'close')
            self.close_connection = True
        self.end_headers()
        self.wfile.write(body)

    def refuse(self, code, words):
        self.send(code, (words + '\n').encode('utf-8'), 'text/plain; charset=utf-8')

    def send_error(self, code, message=None, explain=None):
        """The standard library's own refusals (a malformed request, a method
        it has no handler for) carry the same headers as every other answer."""
        self.refuse(code if code >= 400 else 400, 'Squire\'s page server cannot answer that.')

    def from_the_mac(self):
        """The request came from the Mac itself, to the server's own host
        name, with no Origin but the server's own."""
        port = self.server.server_address[1]
        peer = self.client_address[0] if self.client_address else ''
        if not (peer.startswith('127.') or peer == '::1'):
            return False
        hosts = self.headers.get_all('Host') or []
        if len(hosts) != 1 or not address_allowed(hosts[0].strip(), port):
            return False
        origins = self.headers.get_all('Origin') or []
        return not origins or (len(origins) == 1 and address_allowed(origins[0].strip(), port, 'http://'))

    def route(self):
        """The route a request names under the link, or None when its path
        does not begin with the link's current secret (or none is kept)."""
        self.secret = None
        path = urllib.parse.urlsplit(self.path).path
        first, slash, rest = path[1:].partition('/')
        if not path.startswith('/') or not slash:
            return None
        if not Secret.holds(self.server.home, self.server.secret, first):
            return None
        self.secret = self.server.secret
        return '/' + rest

    def do_GET(self):
        if not self.from_the_mac():
            return self.refuse(403, 'Squire\'s pages open on the owner\'s Mac only.')
        path = urllib.parse.urlsplit(self.path).path
        pages = self.server.pages
        if not path.startswith('/squire/'):
            path = self.route()
            if path is None:
                return self.refuse(403, ASK_FOR_LINK)
        if path == '/':
            return self.send(200, pages.dashboard(), 'text/html; charset=utf-8')
        if path.startswith('/squire/'):
            body = pages.own(path[len('/squire/'):])
            if body is None:
                return self.refuse(404, 'There is no such page.')
            return self.send(200, body, Pages.OWN[path[len('/squire/'):]])
        if path.startswith('/pages/'):
            try:
                rel = urllib.parse.unquote(path[len('/pages/'):], errors='strict')
                real = pages.file(rel)
            except ValueError:
                real = None
            if real is None or Pages.is_script(real):
                return self.refuse(404, 'There is no such page.')
            kind = Pages.type_of(real)
            try:
                if real.lower().endswith('.md'):
                    body = pages.markdown(rel, real)
                else:
                    with open(real, 'rb') as f:
                        body = f.read()
            except OSError:
                return self.refuse(404, 'There is no such page.')
            return self.send(200, body, kind, self.policy(panel=kind.startswith('text/html'),
                                                          sandbox=kind.startswith('image/svg')))
        return self.refuse(404, 'There is no such page.')

    def do_POST(self):
        if not self.from_the_mac() or not self.headers.get_all('Origin'):
            return self.refuse(403, 'Only a page Squire served on this Mac can post a comment.')
        path = self.route()
        if path is None:
            return self.refuse(403, ASK_FOR_LINK)
        if path != '/api/review':
            return self.refuse(404, 'There is no such page.')
        kind = (self.headers.get('Content-Type') or '').split(';', 1)[0].strip().lower()
        if kind != 'application/json':
            return self.refuse(415, 'The comment panel posts JSON.')
        try:
            length = int(self.headers.get('Content-Length') or '')
        except ValueError:
            return self.refuse(411, 'The post must give its length.')
        if not 0 < length <= self.MAX_BODY:
            return self.refuse(413, 'The post is empty or too long.')
        try:
            data = json.loads(self.rfile.read(length).decode('utf-8'))
        except (OSError, ValueError):
            return self.refuse(400, 'The post is not JSON.')
        document, comments = self.review_of(data)
        if document is None:
            return self.refuse(400, 'The post must name a page that exists and give each comment its id, quote '
                                    'and words.')
        try:
            self.server.pages.keep(document, comments)
        except OSError:
            return self.refuse(500, 'The comments could not be kept.')
        body = json.dumps({'kept': True, 'count': len(comments)}).encode('utf-8')
        self.send(200, body, 'application/json')

    def review_of(self, data):
        """(document, comments) from a post of the right shape, or (None, None)."""
        if not isinstance(data, dict):
            return None, None
        document, comments = data.get('document'), data.get('comments')
        if not isinstance(document, str) or not document.startswith('/pages/') \
                or self.server.pages.file(urllib.parse.unquote(document[len('/pages/'):])) is None:
            return None, None
        if not isinstance(comments, list) or not 0 < len(comments) <= self.MAX_COMMENTS:
            return None, None
        kept = []
        for c in comments:
            if not isinstance(c, dict) or not all(isinstance(c.get(k), str) for k in self.LIMITS):
                return None, None
            if any(len(c[k]) > limit for k, limit in self.LIMITS.items()) or not c['comment'].strip():
                return None, None
            kept.append({k: c[k] for k in self.LIMITS})
        return document, kept

    def do_OPTIONS(self):
        self.refuse(405, 'Squire\'s page server answers GET and the comment panel\'s POST only.')

    do_PUT = do_DELETE = do_PATCH = do_HEAD = do_TRACE = do_CONNECT = do_OPTIONS


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False

    def __init__(self, port, pages, home):
        self.pages = pages
        self.home = home
        self.secret = None
        super().__init__((bind_address(), port), Handler)


def serve(port):
    home = Config.default_home()
    try:
        config = Config(home)
    except SquireError as e:
        sys.stderr.write(f'Squire\'s page server cannot start: {e}.\n')
        return 2
    try:
        server = Server(port, Pages(config.owner_folder), home)
    except OSError as e:
        sys.stderr.write(f'Squire\'s page server cannot take port {port} ({e.strerror or type(e).__name__}).\n')
        return 1
    port = server.server_address[1]
    address = f'http://{HOST}:{port}/'
    pid = os.getpid()
    try:
        server.secret = Secret.write(home)
    except OSError as e:
        sys.stderr.write(f'Squire\'s page server cannot keep its link\'s secret ({e.strerror or type(e).__name__}).\n')
        server.server_close()
        return 1
    try:
        Records.write(record_path(home), {'address': address, 'host': HOST, 'port': port, 'pid': pid,
                                          'pidStartedAt': Process.started_at(pid),
                                          'startedAt': datetime.datetime.now(datetime.timezone.utc)
                                          .isoformat(timespec='seconds').replace('+00:00', 'Z')})
    except OSError as e:
        sys.stderr.write(f'Squire\'s page server cannot write {RECORD} ({e.strerror or type(e).__name__}).\n')
        server.server_close()
        return 1
    sys.stdout.write(address + '\n')
    sys.stdout.flush()

    def stop(signum, frame):
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        server.serve_forever()
    finally:
        server.server_close()
        Secret.forget(home, server.secret)
        record = Records.read(record_path(home))
        if isinstance(record, dict) and record.get('pid') == pid:
            try:
                os.unlink(record_path(home))
            except OSError:
                pass
    return 0


def main(argv):
    if argv == ['--where']:
        code, line = where(Config.default_home())
        (sys.stdout if code == 0 else sys.stderr).write(line + '\n')
        return code
    if len(argv) == 2 and argv[0] == '--port' and argv[1].isdigit() and int(argv[1]) <= 65535:
        return serve(int(argv[1]))
    sys.stderr.write('Use: page-server.py --port <port, 0 for one the system gives> | --where\n')
    return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
