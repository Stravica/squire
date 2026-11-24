"""Squire's website command: the one-off safe set-up of the owner's
Cloudflare account, and Squire's own deploy of one site. The session runs
each as one command, on the owner's yes to that run:

    /usr/bin/python3 '<Squire home>/core/tools/website.py' set-up <account id>
    /usr/bin/python3 '<Squire home>/core/tools/website.py' deploy '<site folder>' <site name>

set-up takes the owner's short-lived set-up token from the Keychain only
(the secret cloudflare-set-up, through Squire's secret helper), checks that
it holds Account API Tokens Write and Billing Read, reads the account's
subscriptions once and counts any it cannot read as free (a price of exactly
0) as paid, naming each to the owner and changing no billing, ever. Then it
makes the one token Squire keeps (Workers Scripts Write alone, on this
account alone), reads its rights back from the account, keeps it in the
Keychain as cloudflare-deploy through the secret helper, and removes the
set-up token from the account and from the Keychain. That kept token cannot
spend, and the free plan fails rather than bills: that is the spend guard,
with the safety floor's refusal of any call that would buy. A set-up that
does not finish keeps no token active and nothing in the Keychain, removes
the set-up token on every path, and tells the owner what it left.

deploy puts one site live from its own folder (workspace/sites/<site name>
in the owner's folder) as a Worker with static assets on the account's
workers.dev address, https://<site name>.<subdomain>.workers.dev, with the
token the set-up kept and nothing else: no wrangler sign-in, no token or
account in the environment. It reads the site back at its address until it
answers with the site, waiting out a new address's certificate, and only
then reports it live. The safety floor lets it run only as the owner
previewed it and on the owner's yes to that deploy.

Cloudflare's API is called directly over https, never through wrangler, and
no token is ever put on a command line: each goes in one call's
Authorization header, or to the secret helper on its stdin. The API's
address is squire.json's cloudflareApi in the Squire home
(https://api.cloudflare.com/client/v4 when absent), and a deployed site is
read back at its cloudflareSites ({name} and {subdomain} filled in;
https://{name}.{subdomain}.workers.dev/ when absent).

Standard library only; run by /usr/bin/python3.
"""

import base64
import hashlib
import importlib.util
import json
import mimetypes
import os
import re
import secrets
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.request
from urllib.parse import urlsplit

sys.dont_write_bytecode = True
CORE = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
sys.path.insert(0, os.path.join(CORE, 'lib'))

from squire import Config, Paths, Runtime, SquireError  # noqa: E402

PYTHON = '/usr/bin/python3'
SECURITY = '/usr/bin/security'
USAGE = 'Squire\'s website command takes: set-up <account id>, or deploy \'<site folder>\' <site name>'
RECORD = 'cloudflare.json'


class Refused(Exception):
    """A reason the command did nothing, in words the owner can act on."""


class NotDone(Exception):
    """A reason the set-up stopped part-way, in words the owner can act on."""


class Cloudflare:
    """Cloudflare's API, called directly over https with one token in each
    call's Authorization header. A call that does not answer, or answers
    with anything but success, is an answer like any other: the caller
    decides. Plain http is taken only for an address on this Mac's loopback."""

    DEFAULT_API = 'https://api.cloudflare.com/client/v4'
    TIMEOUT = 30
    LOOPBACK = ('127.0.0.1', 'localhost', '::1')

    def __init__(self, base):
        self.base = base.rstrip('/')

    @classmethod
    def of(cls, config):
        """The API as squire.json's cloudflareApi names it, else Cloudflare's own."""
        base = config.data.get('cloudflareApi', cls.DEFAULT_API)
        return cls(cls.address(base, 'cloudflareApi'))

    @classmethod
    def address(cls, value, key):
        """An address Squire may call: https, or http on the loopback only."""
        parts = urlsplit(value) if isinstance(value, str) else None
        if not parts or not parts.hostname or parts.scheme not in ('https', 'http') \
                or (parts.scheme == 'http' and parts.hostname not in cls.LOOPBACK):
            raise Refused(f'squire.json\'s {key} must be an https address')
        return value

    def call(self, method, path, token, body=None, raw=None, kind=None):
        """(status, the answer's JSON or None). status is None when nothing
        answered. body is sent as JSON; raw as it is, with its own type."""
        headers = {'Authorization': f'Bearer {token}', 'Accept': 'application/json'}
        data = None
        if body is not None:
            data, headers['Content-Type'] = json.dumps(body).encode('utf-8'), 'application/json'
        elif raw is not None:
            data, headers['Content-Type'] = raw, kind
        request = urllib.request.Request(self.base + path, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=self.TIMEOUT) as answer:
                status, text = answer.status, answer.read()
        except urllib.error.HTTPError as e:
            status, text = e.code, e.read()
        except (urllib.error.URLError, OSError, ValueError):
            return None, None
        try:
            return status, json.loads(text.decode('utf-8'))
        except (ValueError, UnicodeDecodeError):
            return status, None

    def result(self, method, path, token, body=None, raw=None, kind=None):
        """The result of a call that succeeded; None for any other answer."""
        status, answer = self.call(method, path, token, body, raw, kind)
        if status is None or not 200 <= status < 300 or not isinstance(answer, dict) or answer.get('success') is not True:
            return None
        return answer.get('result')


class SetUp:
    """The one-off safe set-up of the owner's Cloudflare account."""

    SET_UP_SECRET = 'cloudflare-set-up'
    KEPT_SECRET = 'cloudflare-deploy'
    NEEDS = ('Account API Tokens Write', 'Billing Read')
    KEPT_RIGHT = 'Workers Scripts Write'
    ACCOUNT = re.compile(r'[0-9a-f]{32}')
    SUBDOMAIN = re.compile(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?')

    def __init__(self, config, account):
        self.config = config
        account = account.lower() if isinstance(account, str) else ''
        if not self.ACCOUNT.fullmatch(account):
            raise Refused(f'{account or "that"} is not a Cloudflare account id (32 letters and digits, from the '
                          'account\'s page on Cloudflare). Nothing was done on any account')
        self.account = account
        self.api = Cloudflare.of(config)
        self.helper = Keychain.helper(config)
        self.scope = f'com.cloudflare.api.account.{account}'
        self.token = None
        self.mine = None
        self.made = None
        self.stored = False
        self.removed = False
        self.left = []

    def run(self):
        """What the set-up says, and whether it is done."""
        try:
            self.helper.check('Nothing was done on the account')
            self.token = self.helper.fetch(self.SET_UP_SECRET).decode('utf-8')
        except (SquireError, UnicodeDecodeError) as e:
            raise Refused(f'it needs the owner\'s short-lived set-up token in the Keychain as {self.SET_UP_SECRET}, '
                          f'stored with Squire\'s secret helper (secret.py set {self.SET_UP_SECRET}, the token on '
                          f'stdin), and never any other way ({e}). Nothing was done on the account')
        done, said = False, []
        try:
            said.append(self.steps())
            done = True
        except NotDone as e:
            said.append(f'Squire\'s Cloudflare set-up did not finish: {e}.')
        except Exception as e:  # noqa: BLE001 - cleaned up and named below, whatever stopped it
            said.append(f'Squire\'s Cloudflare set-up did not finish: it stopped ({type(e).__name__}).')
        if not done:
            self.undo()
        self.forget_set_up_token()
        if not self.removed and done:
            done = False
        if self.left:
            said.append('Left on the account: ' + '; '.join(self.left) + '. Remove each yourself on Cloudflare\'s '
                        'dashboard (Manage account, then Account API Tokens), then run the set-up again.')
        elif not done:
            said.append('Squire left no token on the account, and keeps nothing for it in the Keychain.')
        return done, '\n'.join(said)

    def steps(self):
        """The set-up in order, each step's failure a NotDone."""
        verified = self.api.result('GET', f'/accounts/{self.account}/tokens/verify', self.token)
        if not isinstance(verified, dict) or not isinstance(verified.get('id'), str) or verified.get('status') != 'active':
            raise NotDone(f'Cloudflare did not accept the set-up token on account {self.account}: check the account '
                          'id and the token, store the token again if it changed, and nothing was made')
        self.mine = {'id': verified['id'], 'name': None}
        record = self.api.result('GET', f'/accounts/{self.account}/tokens/{self.mine["id"]}', self.token)
        rights = self.rights(record) if isinstance(record, dict) else []
        if isinstance(record, dict) and isinstance(record.get('name'), str):
            self.mine['name'] = record['name']
        missing = [right for right in self.NEEDS if right not in rights]
        if missing:
            raise NotDone(f'the set-up token must hold {" and ".join(self.NEEDS)} on this account, and it lacks '
                          f'{" and ".join(missing)}. Make a new short-lived set-up token with those rights, store it '
                          f'as {self.SET_UP_SECRET}, and run the set-up again; nothing was made')
        paid = self.paid()
        if paid:
            raise NotDone('Squire found on the account what it cannot read as free (a price of exactly 0), which it '
                          'counts as paid: ' + '; '.join(paid) + '. Squire changes no billing: switch each off on '
                          'Cloudflare yourself, then run the set-up again')
        groups = self.api.result('GET', f'/accounts/{self.account}/tokens/permission_groups', self.token)
        group = next((g for g in groups if isinstance(g, dict) and g.get('name') == self.KEPT_RIGHT
                      and isinstance(g.get('id'), str)), None) if isinstance(groups, list) else None
        if group is None:
            raise NotDone(f'Squire could not find the {self.KEPT_RIGHT} right on the account to make its deploy token')
        name = f'Squire deploy ({time.strftime("%Y-%m-%d")})'
        made = self.api.result('POST', f'/accounts/{self.account}/tokens', self.token, body={
            'name': name,
            'policies': [{'effect': 'allow', 'resources': {self.scope: '*'}, 'permission_groups': [{'id': group['id']}]}],
        })
        if not isinstance(made, dict) or not isinstance(made.get('id'), str) or not isinstance(made.get('value'), str):
            raise NotDone('Cloudflare did not make the deploy token Squire keeps')
        self.made = {'id': made['id'], 'name': made.get('name') if isinstance(made.get('name'), str) else name,
                     'value': made['value']}
        back = self.api.result('GET', f'/accounts/{self.account}/tokens/{self.made["id"]}', self.token)
        if not self.deploy_only(back, group['id']):
            raise NotDone(f'the deploy token read back from the account holds more than {self.KEPT_RIGHT} on this '
                          'account alone, so Squire removed it and keeps none')
        subdomain = self.api.result('GET', f'/accounts/{self.account}/workers/subdomain', self.made['value'])
        if not isinstance(subdomain, dict):
            raise NotDone('the deploy token\'s first use, reading the account\'s workers.dev subdomain, failed')
        sub = subdomain.get('subdomain')
        if not isinstance(sub, str) or not self.SUBDOMAIN.fullmatch(sub):
            raise NotDone('the account has no workers.dev subdomain yet, which is where Squire puts sites live. '
                          'Choose one on Cloudflare\'s dashboard (Workers and Pages, then the workers.dev subdomain), '
                          'then run the set-up again')
        self.keep()
        self.remove_set_up_token()
        Runtime.update(self.config.home, RECORD, lambda old: {
            'accountId': self.account, 'subdomain': sub, 'tokenId': self.made['id'], 'tokenName': self.made['name'],
            'setUpAt': time.time(),
        })
        return (f'Squire\'s Cloudflare set-up is done on account {self.account}. Nothing left on the account can '
                f'spend the owner\'s money: every subscription there reads as free, the only token Squire keeps is '
                f'its deploy token ({self.made["name"]}: {self.KEPT_RIGHT} alone, on this account alone), held in the '
                f'Keychain as {self.KEPT_SECRET}, the free plan fails rather than bills, and the set-up token has been '
                f'removed from the account and the Keychain. Sites go live at '
                f'https://<site name>.{sub}.workers.dev, each on the owner\'s yes.')

    def rights(self, record):
        """The rights a token's record holds on this account, by name."""
        names = []
        for policy in record.get('policies') or []:
            if not isinstance(policy, dict) or policy.get('effect') != 'allow':
                continue
            resources = policy.get('resources') if isinstance(policy.get('resources'), dict) else {}
            if not any(r in (self.scope, 'com.cloudflare.api.account.*') for r in resources):
                continue
            names += [g.get('name') for g in policy.get('permission_groups') or [] if isinstance(g, dict)]
        return names

    def deploy_only(self, record, group_id):
        """True when a token's record holds exactly one right, Workers Scripts
        Write, allowed on this account alone (by name, or by id where the
        account gives no name)."""
        if not isinstance(record, dict) or not isinstance(record.get('policies'), list) or len(record['policies']) != 1:
            return False
        policy = record['policies'][0]
        if not isinstance(policy, dict) or policy.get('effect') != 'allow' or policy.get('resources') != {self.scope: '*'}:
            return False
        groups = policy.get('permission_groups')
        if not isinstance(groups, list) or len(groups) != 1 or not isinstance(groups[0], dict):
            return False
        name = groups[0].get('name')
        return name == self.KEPT_RIGHT if name is not None else groups[0].get('id') == group_id

    def paid(self):
        """Each subscription on the account Squire cannot read as free, named;
        none when all read as free. A read that fails is not done."""
        subscriptions = self.api.result('GET', f'/accounts/{self.account}/subscriptions', self.token)
        if not isinstance(subscriptions, list):
            raise NotDone('Squire could not read the account\'s subscriptions (its billing, read only), so it cannot '
                          'tell whether anything there costs money')
        named = []
        for sub in subscriptions:
            price = sub.get('price') if isinstance(sub, dict) else None
            if isinstance(price, (int, float)) and not isinstance(price, bool) and price == 0:
                continue
            plan = sub.get('rate_plan') if isinstance(sub, dict) and isinstance(sub.get('rate_plan'), dict) else {}
            name = next((v for v in (plan.get('public_name'), plan.get('id'), sub.get('id') if isinstance(sub, dict)
                                     else None) if isinstance(v, str) and v), 'a subscription with no name')
            shown = f'{price} {sub.get("currency", "")}'.strip() if isinstance(price, (int, float)) \
                and not isinstance(price, bool) else 'a price Squire cannot read'
            named.append(f'{name} ({shown})')
        return named

    def keep(self):
        """The deploy token into the Keychain as cloudflare-deploy, through the
        secret helper, the token on its stdin."""
        self.stored = True
        done = subprocess.run([PYTHON, os.path.join(CORE, 'tools', 'secret.py'), 'set', self.KEPT_SECRET],
                              input=(self.made['value'] + '\n').encode('utf-8'), stdout=subprocess.DEVNULL,
                              stderr=subprocess.DEVNULL, timeout=30)
        if done.returncode != 0:
            raise NotDone(f'the Keychain did not keep the deploy token as {self.KEPT_SECRET}')

    def remove_set_up_token(self):
        """The set-up token off the account, tried once."""
        if self.removed or self.mine is None:
            return
        self.mine['tried'] = True
        status, _ = self.api.call('DELETE', f'/accounts/{self.account}/tokens/{self.mine["id"]}', self.token)
        if status is not None and 200 <= status < 300:
            self.removed = True
        else:
            raise NotDone(f'Squire could not remove the set-up token ({self.label(self.mine)}) from the account, '
                          'which can still make tokens there')

    def undo(self):
        """A set-up that did not finish keeps no token of its own and nothing in
        the Keychain: the token it made is removed (with the set-up token,
        while that is still on the account) and named when it cannot be."""
        if self.made:
            gone = False
            if not self.removed:
                status, _ = self.api.call('DELETE', f'/accounts/{self.account}/tokens/{self.made["id"]}', self.token)
                gone = status is not None and 200 <= status < 300
            if not gone:
                self.left.append(f'Squire\'s deploy token {self.label(self.made)}, which can put a site live')
        Keychain.forget(self.config, self.KEPT_SECRET)
        try:
            os.unlink(Runtime.path(self.config.home, RECORD))
        except FileNotFoundError:
            pass
        if self.mine and not self.removed and not self.mine.get('tried'):
            try:
                self.remove_set_up_token()
            except NotDone:
                pass

    def forget_set_up_token(self):
        """The set-up token's own record of what is left, and its copy in the
        Keychain removed on every path: it is used once."""
        if self.mine and not self.removed:
            self.left.insert(0, f'the set-up token {self.label(self.mine)}, which can still make tokens')
        if self.token is not None:
            Keychain.forget(self.config, self.SET_UP_SECRET)

    @staticmethod
    def label(token):
        return f'{token["name"]} ({token["id"]})' if token.get('name') else token['id']


class Deploy:
    """Squire's own deploy of one site from its own folder, as a Worker with
    static assets on the account's workers.dev address, with the token the
    set-up kept alone; reported live only once the address answers with the
    site."""

    SITES = os.path.join('workspace', 'sites')
    NAME = re.compile(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?')
    DEFAULT_SITES = 'https://{name}.{subdomain}.workers.dev/'
    COMPATIBILITY = '2025-11-01'
    MOST_FILES = 20000
    MOST_BYTES = 25 * 1024 * 1024
    LIVE_WITHIN = 100

    def __init__(self, config, folder, name):
        self.config = config
        if not isinstance(name, str) or not self.NAME.fullmatch(name):
            raise Refused(f'{name or "that"} is not a name Cloudflare takes for a site: lower-case letters, digits '
                          'and dashes, at most 63, starting and ending with a letter or digit. Nothing was deployed')
        own = os.path.realpath(os.path.join(config.owner_folder, self.SITES, name))
        given = os.path.realpath(folder)
        if Paths.fold(given) != Paths.fold(own) or not os.path.isdir(given):
            raise Refused(f'Squire deploys a site only from its own folder, workspace/sites/{name} in the owner\'s '
                          f'folder, and {folder} is not it. Nothing was deployed')
        record = Runtime.read(config.home, RECORD)
        account, subdomain = record.get('accountId'), record.get('subdomain')
        if not (isinstance(account, str) and SetUp.ACCOUNT.fullmatch(account)
                and isinstance(subdomain, str) and SetUp.SUBDOMAIN.fullmatch(subdomain)):
            raise Refused('Squire\'s Cloudflare set-up has not finished on this Mac, so Squire cannot tell where the '
                          'site would go live: run the set-up first. Nothing was deployed')
        self.folder, self.name, self.account = given, name, account
        self.address = f'https://{name}.{subdomain}.workers.dev'
        template = config.data.get('cloudflareSites', self.DEFAULT_SITES)
        if not isinstance(template, str):
            raise Refused('squire.json\'s cloudflareSites must be an https address')
        self.read_at = Cloudflare.address(template.replace('{name}', name).replace('{subdomain}', subdomain),
                                          'cloudflareSites')
        self.api = Cloudflare.of(config)
        self.helper = Keychain.helper(config)

    def files(self):
        """The site's files by their path in the site: {'/<path>': bytes}.
        A link or anything but a file or folder is refused."""
        found, total = {}, 0
        for root, folders, names in os.walk(self.folder):
            folders.sort()
            for entry in sorted(folders + names):
                path = os.path.join(root, entry)
                mode = os.lstat(path).st_mode
                if stat.S_ISDIR(mode):
                    continue
                if not stat.S_ISREG(mode):
                    raise Refused(f'the site\'s folder holds {os.path.relpath(path, self.folder)}, which is not a '
                                  'plain file (a link, say), so Squire deploys nothing')
                with open(path, 'rb') as f:
                    data = f.read(self.MOST_BYTES + 1)
                if len(data) > self.MOST_BYTES:
                    raise Refused(f'{os.path.relpath(path, self.folder)} is larger than Cloudflare takes for one file '
                                  '(25 MB). Nothing was deployed')
                found['/' + os.path.relpath(path, self.folder).replace(os.sep, '/')] = data
                total += 1
                if total > self.MOST_FILES:
                    raise Refused('the site has more files than Cloudflare takes (20,000). Nothing was deployed')
        if not found:
            raise Refused('the site\'s folder holds no file to put live. Nothing was deployed')
        return found

    @staticmethod
    def multipart(parts):
        """A multipart/form-data body from (name, filename, type, bytes) parts,
        and its content type."""
        boundary = 'squire-' + secrets.token_hex(16)
        chunks = []
        for name, filename, kind, data in parts:
            head = f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"'
            head += f'; filename="{filename}"' if filename else ''
            chunks += [f'{head}\r\nContent-Type: {kind}\r\n\r\n'.encode('utf-8'), data, b'\r\n']
        chunks.append(f'--{boundary}--\r\n'.encode('utf-8'))
        return b''.join(chunks), f'multipart/form-data; boundary={boundary}'

    def run(self):
        """What the deploy says, and whether the site is live."""
        try:
            self.helper.check('Nothing was deployed')
            token = self.helper.fetch(SetUp.KEPT_SECRET).decode('utf-8')
        except (SquireError, UnicodeDecodeError) as e:
            raise Refused(f'Squire\'s deploy token is not in the Keychain as {SetUp.KEPT_SECRET} ({e}): run the '
                          'set-up again. Nothing was deployed')
        files = self.files()
        script = f'/accounts/{self.account}/workers/scripts/{self.name}'
        by_hash, manifest = {}, {}
        for path, data in files.items():
            digest = hashlib.sha256(data + os.path.splitext(path)[1].encode('utf-8')).hexdigest()[:32]
            by_hash[digest] = (path, data)
            manifest[path] = {'hash': digest, 'size': len(data)}
        session = self.api.result('POST', f'{script}/assets-upload-session', token, body={'manifest': manifest})
        if not isinstance(session, dict) or not isinstance(session.get('jwt'), str):
            return False, f'Cloudflare did not start the upload of {self.name}. Nothing was put live.'
        upload, completion = session['jwt'], None
        buckets = session.get('buckets') or []
        for bucket in buckets:
            parts = []
            for digest in bucket if isinstance(bucket, list) else []:
                if digest not in by_hash:
                    return False, 'Cloudflare asked for a file the site does not hold. Nothing was put live.'
                path, data = by_hash[digest]
                kind = mimetypes.guess_type(path)[0] or 'application/octet-stream'
                parts.append((digest, digest, kind, base64.b64encode(data)))
            body, kind = self.multipart(parts)
            status, answer = self.api.call('POST', f'/accounts/{self.account}/workers/assets/upload?base64=true', upload,
                                           raw=body, kind=kind)
            if status not in (200, 201, 202) or not isinstance(answer, dict) or answer.get('success') is not True:
                return False, f'Cloudflare did not take the files of {self.name}. Nothing was put live.'
            result = answer.get('result') if isinstance(answer.get('result'), dict) else {}
            completion = result.get('jwt') or completion
        if not buckets:
            completion = upload
        if not isinstance(completion, str):
            return False, f'Cloudflare did not finish the upload of {self.name}. Nothing was put live.'
        metadata = json.dumps({'assets': {'jwt': completion}, 'compatibility_date': self.COMPATIBILITY}).encode('utf-8')
        body, kind = self.multipart([('metadata', None, 'application/json', metadata)])
        if self.api.result('PUT', script, token, raw=body, kind=kind) is None:
            return False, f'Cloudflare did not take {self.name} as a Worker. Nothing was put live.'
        if self.api.result('POST', f'{script}/subdomain', token, body={'enabled': True}) is None:
            return False, (f'Cloudflare took {self.name} but did not put it on its workers.dev address, '
                           f'{self.address}. It is not live yet; run the deploy again.')
        if not self.live(files.get('/index.html')):
            return False, (f'Squire put {self.name} on Cloudflare, but its address, {self.address}, did not answer '
                           f'with the site within {self.LIVE_WITHIN} seconds, so it is not reported live yet. A new '
                           'address can take a few minutes; run the deploy again to check.')
        return True, (f'The site {self.name} is live at {self.address}, from its folder {self.folder}, deployed with '
                      'Squire\'s deploy-only token.')

    def live(self, page):
        """True once the site's address answers with the site (its index
        page, where it has one), read again through every failure until the
        time is up: a new address answers only once its certificate is ready."""
        end = time.monotonic() + self.LIVE_WITHIN
        while True:
            try:
                request = urllib.request.Request(self.read_at, headers={'Cache-Control': 'no-cache'})
                with urllib.request.urlopen(request, timeout=10) as answer:
                    if answer.status == 200 and (page is None or answer.read() == page):
                        return True
            except (urllib.error.URLError, OSError, ValueError):
                pass
            if time.monotonic() >= end:
                return False
            time.sleep(1)


class Keychain:
    """The Keychain squire.json names, reached for a secret only through
    Squire's secret helper; a secret it no longer needs is removed by its
    name alone."""

    @staticmethod
    def helper(config):
        """Squire's secret helper, loaded from this core, for the config's Keychain."""
        spec = importlib.util.spec_from_file_location('squire_secret_helper', os.path.join(CORE, 'tools', 'secret.py'))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        try:
            return module.SecretHelper(config)
        except SquireError as e:
            raise Refused(f'{e}. Nothing was done on the account')

    @staticmethod
    def forget(config, name):
        """A secret's item removed from the Keychain, if it is there. Only its
        name goes on the command line."""
        if not config.keychain:
            return
        subprocess.run([SECURITY, 'delete-generic-password', '-s', 'squire', '-a', name, config.keychain],
                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)


def main(argv):
    try:
        config = Config()
        if len(argv) == 2 and argv[0] == 'set-up':
            done, said = SetUp(config, argv[1]).run()
            (sys.stdout if done else sys.stderr).write(said + '\n')
            return 0 if done else 1
        if len(argv) == 3 and argv[0] == 'deploy':
            done, said = Deploy(config, argv[1], argv[2]).run()
            (sys.stdout if done else sys.stderr).write(said + '\n')
            return 0 if done else 1
        raise Refused(USAGE)
    except Refused as e:
        sys.stderr.write(f'Squire\'s website command did nothing: {e}.\n')
        return 1
    except SquireError as e:
        sys.stderr.write(f'Squire\'s website command did nothing: {e}.\n')
        return 2
    except Exception as e:  # noqa: BLE001 - said in plain words, never a traceback
        sys.stderr.write(f'Squire\'s website command failed ({type(e).__name__}).\n')
        return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
