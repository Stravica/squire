"""Squire's website command: the one-off safe set-up of the owner's
Cloudflare account. The session runs it as one command, on the owner's yes:

    /usr/bin/python3 '<Squire home>/core/tools/website.py' set-up <account id>

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

Cloudflare's API is called directly over https, never through wrangler, and
no token is ever put on a command line: each goes in one call's
Authorization header, or to the secret helper on its stdin. The API's
address is squire.json's cloudflareApi in the Squire home
(https://api.cloudflare.com/client/v4 when absent).

Standard library only; run by /usr/bin/python3.
"""

import importlib.util
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from urllib.parse import urlsplit

sys.dont_write_bytecode = True
CORE = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
sys.path.insert(0, os.path.join(CORE, 'lib'))

from squire import Config, Runtime, SquireError  # noqa: E402

PYTHON = '/usr/bin/python3'
SECURITY = '/usr/bin/security'
USAGE = 'Squire\'s website command takes: set-up <account id>'
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
