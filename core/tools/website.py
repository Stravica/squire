"""Squire's website command: the one-off safe set-up of the owner's
Cloudflare account, and Squire's own deploy of one site. The session runs
each as one command, on the owner's yes to that run:

    /usr/bin/python3 '<Squire home>/core/tools/website.py' set-up <account id>
    /usr/bin/python3 '<Squire home>/core/tools/website.py' set-up <account id> --keep-paid
    /usr/bin/python3 '<Squire home>/core/tools/website.py' deploy '<site folder>' <site name>

set-up takes the owner's short-lived set-up token from the Keychain only
(the secret cloudflare-set-up, through Squire's secret helper), checks that
it holds Account API Tokens Write and Billing Read, reads every page of the
account's subscriptions and counts any it cannot read as free (a price of
exactly 0) as paid, naming each with its price to the owner, warning that it
costs money and changing no billing, ever. Paging it cannot read whole is
not read as free. A set-up that finds a paid item does not finish: it keeps
what it named in a runtime record, and the owner's yes to keeping exactly
those is the set-up run again with --keep-paid, which the safety floor asks
for naming each. Then it makes the one token Squire keeps (Workers Scripts
Write alone, on this account alone), reads its rights back from the account
by name and by permission group id, keeps it in the
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
account in the environment. It reads the site back at its address as an
ordinary browser does until it answers with the site, waiting out a new
address's certificate, and only then reports it live; an address that is
not live yet is said so, and one that answers any other way is one Squire
could not confirm, named for the owner to open. The safety floor lets it run
only as the owner previewed it and on the owner's yes to that deploy.

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
import http.client
import importlib.util
import json
import mimetypes
import os
import re
import secrets
import socket
import ssl
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
USAGE = ('Squire\'s website command takes: set-up <account id>, set-up <account id> --keep-paid, or deploy '
         '\'<site folder>\' <site name>')
RECORD = 'cloudflare.json'
KEEP_PAID = '--keep-paid'


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
    # What the set-up last named as paid on an account, kept in the Squire
    # home where the session cannot write: the floor's ask for --keep-paid
    # names each item from it, and a run with --keep-paid keeps only these.
    PAID = 'cloudflare-paid.json'
    MOST_PAGES = 100

    def __init__(self, config, account, keep_paid=False):
        self.config = config
        self.keep_paid = keep_paid is True
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
        status, answer = self.api.call('GET', f'/accounts/{self.account}/tokens/verify', self.token)
        verified = answer.get('result') if isinstance(answer, dict) and answer.get('success') is True \
            and status is not None and 200 <= status < 300 else None
        if not isinstance(verified, dict) or not isinstance(verified.get('id'), str) or verified.get('status') != 'active':
            raise NotDone(self.not_accepted(status))
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
            covered = self.named() if self.keep_paid else []
            beyond = [item for item in paid if item not in covered]
            if not self.keep_paid or beyond:
                self.name_paid(paid)
                raise NotDone(self.paid_words(paid, beyond if self.keep_paid else None))
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
                          f'account alone (Squire asked for the permission group {group["id"]} and compares what it '
                          'reads back by that id as well as by name), so Squire removed it and keeps none')
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
        token = (f'its deploy token ({self.made["name"]}: {self.KEPT_RIGHT} alone, on this account alone), held in the '
                 f'Keychain as {self.KEPT_SECRET}')
        if paid:
            return (f'Squire\'s Cloudflare set-up is done on account {self.account}, on your yes to keeping what your '
                    f'account pays for: {self.listed(paid)}. That costs you money, and Squire changes no billing: it '
                    f'stays as you keep it, and switching it off is yours to do on Cloudflare. The only token Squire '
                    f'keeps is {token}; it can spend nothing, and the set-up token has been removed from the account '
                    f'and the Keychain. Sites go live at https://<site name>.{sub}.workers.dev, each on the owner\'s '
                    'yes.')
        return (f'Squire\'s Cloudflare set-up is done on account {self.account}. Nothing left on the account can '
                f'spend the owner\'s money: every subscription there reads as free, the only token Squire keeps is '
                f'{token}, the free plan fails rather than bills, and the set-up token has been '
                f'removed from the account and the Keychain. Sites go live at '
                f'https://<site name>.{sub}.workers.dev, each on the owner\'s yes.')

    def not_accepted(self, status):
        """What the set-up says when the account's path did not accept the
        set-up token, by what that path answered. Only a refusal that speaks
        about the token (401 or 403, whatever its code) leads to the user
        path's verify, a GET that makes and keeps nothing, and only an active
        answer there makes the token one made under the owner's own profile.
        A 429, a 5xx or no answer is Cloudflare not answering. Anything else
        keeps the words for any token Cloudflare does not accept."""
        if status in (401, 403) and self.user_owned():
            return (f'Cloudflare did not accept the set-up token on account {self.account}, and accepts it only as a '
                    'token made under your own profile: the set-up token must be an account-owned token. Make it on '
                    'Cloudflare\'s dashboard under Manage account, then Account API Tokens, with '
                    f'{" and ".join(self.NEEDS)}, store it as {self.SET_UP_SECRET}, check the account id too, and run '
                    'the set-up again; nothing was made')
        if status is None or status == 429 or 500 <= status <= 599:
            return (f'Cloudflare did not answer the set-up\'s check of the set-up token on account {self.account}, '
                    'so the set-up could not tell whether it accepts it: run the set-up again later; nothing was made')
        return (f'Cloudflare did not accept the set-up token on account {self.account}: check the account id and the '
                'token, store the token again if it changed, and nothing was made')

    def user_owned(self):
        """True only when Cloudflare's user path verifies the set-up token
        as active: a token made under the owner's own profile."""
        verified = self.api.result('GET', '/user/tokens/verify', self.token)
        return isinstance(verified, dict) and isinstance(verified.get('id'), str) and verified.get('status') == 'active'

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
        Write, allowed on this account alone: its group's id is the one the
        set-up asked for, read from the account's own list, and its name,
        where the account gives one, is that right's. A right named Workers
        Scripts Write under another group's id is not it."""
        if not isinstance(record, dict) or not isinstance(record.get('policies'), list) or len(record['policies']) != 1:
            return False
        policy = record['policies'][0]
        if not isinstance(policy, dict) or policy.get('effect') != 'allow' or policy.get('resources') != {self.scope: '*'}:
            return False
        groups = policy.get('permission_groups')
        if not isinstance(groups, list) or len(groups) != 1 or not isinstance(groups[0], dict):
            return False
        name = groups[0].get('name')
        if not isinstance(group_id, str) or groups[0].get('id') != group_id:
            return False
        return name is None or name == self.KEPT_RIGHT

    def paid(self):
        """Each subscription on the account Squire cannot read as free, on
        every page, as {'id', 'name', 'price'} (the price as read, or words
        saying it cannot be read); none when all read as free. A first read
        that fails, or paging that cannot be read whole, is not done."""
        subscriptions, whole = self.subscriptions()
        named = []
        for sub in subscriptions:
            price = sub.get('price') if isinstance(sub, dict) else None
            if isinstance(price, (int, float)) and not isinstance(price, bool) and price == 0:
                continue
            sub = sub if isinstance(sub, dict) else {}
            plan = sub.get('rate_plan') if isinstance(sub.get('rate_plan'), dict) else {}
            name = next((v for v in (plan.get('public_name'), plan.get('id'), sub.get('id'))
                         if isinstance(v, str) and v), 'a subscription with no name')
            if isinstance(price, (int, float)) and not isinstance(price, bool):
                shown = ' '.join(str(v) for v in (price, sub.get('currency'), sub.get('frequency'))
                                 if isinstance(v, (str, int, float)) and not isinstance(v, bool) and str(v))
            else:
                shown = 'a price Squire cannot read'
            named.append({'id': sub.get('id') if isinstance(sub.get('id'), str) else None, 'name': name,
                          'price': shown})
        if not whole:
            found = f' Of what it read, it counts as paid: {self.listed(named)}.' if named else ''
            raise NotDone('Squire could not read every page of the account\'s subscriptions (its billing, read '
                          'only), so it cannot tell whether anything there costs money, and it counts what it could '
                          f'not read as paid.{found} Squire changes no billing; run the set-up again later')
        return named

    def subscriptions(self):
        """The account's subscriptions on every page: (the list, True) when
        the answer can be read whole, (what was read, False) when it cannot.
        An answer with no page counts is one whole answer; one that names
        pages is read page by page and is whole only when every page reads
        and the items read are as many as its total count says. Page counts
        that are missing, not whole numbers, or past what Squire reads, and a
        later page that fails or is not JSON, leave it not whole. A first read
        that fails is not done."""
        path = f'/accounts/{self.account}/subscriptions'
        first = self.page_of(*self.api.call('GET', path, self.token))
        if first is None:
            raise NotDone('Squire could not read the account\'s subscriptions (its billing, read only), so it cannot '
                          'tell whether anything there costs money')
        items, info = first
        if info is None:
            return items, True
        pages, total = info.get('total_pages'), info.get('total_count')
        if not self.whole_number(pages) or not 1 <= pages <= self.MOST_PAGES or not self.whole_number(total):
            return items, False
        for page in range(2, pages + 1):
            later = self.page_of(*self.api.call('GET', f'{path}?page={page}', self.token))
            if later is None:
                return items, False
            items += later[0]
        return items, len(items) == total

    @staticmethod
    def page_of(status, answer):
        """(the page's items, its result_info) for an answer that succeeded
        with a list; result_info is None where the answer carries none, and
        an empty object where it carries one Squire cannot read. None for any
        other answer."""
        if status is None or not 200 <= status < 300 or not isinstance(answer, dict) \
                or answer.get('success') is not True or not isinstance(answer.get('result'), list):
            return None
        info = answer.get('result_info')
        return list(answer['result']), (info if isinstance(info, dict) or info is None else {})

    @staticmethod
    def whole_number(value):
        return isinstance(value, int) and not isinstance(value, bool) and value >= 0

    @staticmethod
    def listed(items):
        return '; '.join(f'{item["name"]} ({item["price"]})' for item in items)

    def paid_words(self, paid, beyond):
        """What the set-up says when it stops over paid items: each named
        with its price, a warning that it costs money and that Squire changes
        no billing, and how the owner keeps them. beyond is None for a run
        with no yes to keeping them; else the items the yes did not cover."""
        how = (f'Squire changes no billing. Switch each off on Cloudflare yourself and run the set-up again; or, to '
               f'finish the set-up and keep {"it" if len(paid) == 1 else "them"}, store a new set-up token as '
               f'{self.SET_UP_SECRET} and run the set-up again as set-up {self.account} {KEEP_PAID}, which Squire '
               'asks you about first, naming each')
        if beyond is None:
            return (f'your Cloudflare account pays for {self.listed(paid)}, which Squire cannot read as free (a '
                    f'price of exactly 0) and counts as paid. That costs you money, and {how}')
        return (f'your yes to keeping what your account pays for covered only what Squire named before it, and the '
                f'account also pays for {self.listed(beyond)}. That costs you money, and {how}')

    def named(self):
        """The paid items the set-up last named on this account, from its
        record in the Squire home: what the owner's yes to --keep-paid,
        asked naming them, covers."""
        record = Runtime.read(self.config.home, self.PAID)
        items = record.get('items') if record.get('accountId') == self.account else None
        return [item for item in items if isinstance(item, dict)] if isinstance(items, list) else []

    def name_paid(self, paid):
        """Keeps what this run named as paid, for the floor's ask."""
        try:
            Runtime.update(self.config.home, self.PAID, lambda old: {
                'accountId': self.account, 'items': paid, 'namedAt': time.time()})
        except OSError:
            pass

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
        verdict, reason = self.live(files.get('/index.html'))
        if verdict == self.NOT_YET:
            return False, (f'Squire put {self.name} on Cloudflare, but its address, {self.address}, did not answer '
                           f'with the site within {self.LIVE_WITHIN} seconds, so it is not reported live yet. A new '
                           'address can take a few minutes to answer.')
        if verdict != self.LIVE:
            return False, (f'Squire put {self.name} on Cloudflare, but could not confirm the site at its address, '
                           f'{self.address}: {reason}. Open {self.address} yourself to see whether the site is there.')
        return True, (f'The site {self.name} is live at {self.address}, from its folder {self.folder}, deployed with '
                      'Squire\'s deploy-only token.')

    LIVE = 'live'
    NOT_YET = 'not live yet'
    UNCONFIRMED = 'could not confirm'
    READ_WAIT = 10
    # Squire's read-back reads the address as an ordinary browser does: some
    # hosting turns away the default signature of Python's own library.
    CLIENT = {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) '
                      'Version/17.0 Safari/605.1.15 Squire',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en',
        'Cache-Control': 'no-cache',
    }

    def live(self, page):
        """(verdict, reason): LIVE once the site's address serves the site
        (its index page, where it has one) to an ordinary client's read, read
        again until the time is up, since a new address answers only once its
        certificate is ready. NOT_YET only when every read answered one of
        the five answers of an address not live yet (verdict_of); any other
        answer, at any read, leaves the site one Squire could not confirm,
        with that answer's reason in plain words."""
        end = time.monotonic() + self.LIVE_WITHIN
        unconfirmed = None
        while True:
            verdict, reason = self.read_once(page)
            if verdict == self.LIVE:
                return self.LIVE, None
            if verdict != self.NOT_YET:
                unconfirmed = reason
            if time.monotonic() >= end:
                return (self.UNCONFIRMED, unconfirmed) if unconfirmed is not None else (self.NOT_YET, None)
            time.sleep(1)

    def read_once(self, page):
        """One read of the address as an ordinary client, through the web
        proxy this Mac's environment names, if any: its verdict and reason."""
        try:
            request = urllib.request.Request(self.read_at, headers=dict(self.CLIENT))
            with urllib.request.urlopen(request, timeout=self.READ_WAIT) as answer:
                status = answer.status
                body = answer.read() if status == 200 and page is not None else None
            return self.verdict_of(status, None, body, page)
        except urllib.error.HTTPError as e:
            return self.verdict_of(e.code, None, None, page)
        except urllib.error.URLError as e:
            return self.verdict_of(None, e.reason, None, page)
        except (OSError, ValueError) as e:
            return self.verdict_of(None, e, None, page)
        except http.client.HTTPException:
            return self.UNCONFIRMED, 'the address\'s answer stopped part way through or could not be read'

    @classmethod
    def verdict_of(cls, status, failure, body, page):
        """A read's verdict, by a positive match only: LIVE for a 200 that
        serves the site's page byte for byte; NOT_YET for exactly 404, 503, a
        name that does not resolve, a refused connection or a failed TLS
        handshake; every other answer is UNCONFIRMED, with its reason."""
        if status == 200:
            if page is None or body == page:
                return cls.LIVE, None
            return cls.UNCONFIRMED, 'the address served a page that is not the site\'s own'
        if status in (404, 503):
            return cls.NOT_YET, None
        if status == 403:
            return cls.UNCONFIRMED, 'the address refused Squire\'s own check of it (it answered 403)'
        if status == 429:
            return cls.UNCONFIRMED, 'the address answered that it had too many reads (429)'
        if isinstance(status, int) and 500 <= status <= 599:
            return cls.UNCONFIRMED, f'the address answered with a server error ({status})'
        if isinstance(status, int):
            return cls.UNCONFIRMED, f'the address answered {status}, which Squire cannot read as the site'
        if isinstance(failure, (socket.gaierror, ConnectionRefusedError, ssl.SSLError)):
            return cls.NOT_YET, None
        if isinstance(failure, (socket.timeout, TimeoutError)):
            return cls.UNCONFIRMED, (f'the address took Squire\'s read and gave no answer within {cls.READ_WAIT} '
                                     'seconds')
        name = type(failure).__name__ if isinstance(failure, BaseException) else 'no answer'
        return cls.UNCONFIRMED, f'Squire\'s read of the address failed ({name})'


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
        if argv[:1] == ['set-up'] and (len(argv) == 2 or (len(argv) == 3 and argv[2] == KEEP_PAID)):
            done, said = SetUp(config, argv[1], keep_paid=len(argv) == 3).run()
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
