"""A stand-in for a Claude Code session's messaging inbox: a Unix socket the
test world owns, at a path the test names. Test fixture only, never product
code; the tests run it with /usr/bin/python3.

    fake-inbox.py <socket path> <record file> <mode>

Modes, as Claude Code's own inbox behaves and as it fails:
  accept        reads each connection's lines until the sender closes its
                side, then closes the connection: Claude Code's inbox, which
                writes nothing back and closes once the sender is done
  silent        reads each connection's lines and never closes it: a session
                that took the line and never acknowledged it
  reject-token  reads the first line of a connection, then closes it: an
                inbox that turns the auth line away
  stall         takes connections but never reads, with a receive buffer of
                one byte, so a sender cannot hand over its line
  refuse        leaves a socket file nobody listens on: connecting is refused

Every connection is recorded as one JSON line in the record file:
{"connection": n, "socket": <the path it came in on>, "lines": [...],
"closedBy": "sender" | "inbox"}; a silent inbox records what it has read
after every chunk. When the socket is ready, "<record file>.ready" is
written. SIGTERM ends it.

The inbox also stands in for the session process when Claude Code runs the
SessionStart hook: the process listening on the socket is the hook's parent.
The test asks for it by writing "<record file>.cmd.<n>.json" (n from 1, in
order): {"bind": <a new socket path, or null>, "run": {"argv", "input",
"env", "cwd"}}. With "bind", the inbox closes its socket and listens on the
new path instead, as one session process does after /clear; with "run", it
runs that command as its own child and writes
"<record file>.cmd.<n>.result.json": {"status", "stdout", "stderr"}.
"""

import json
import os
import signal
import socket
import subprocess
import sys
import threading
import time

path, record, mode = sys.argv[1], sys.argv[2], sys.argv[3]
lock = threading.Lock()
listening = {'server': None, 'path': None}


def note(entry):
    with lock:
        with open(record, 'a') as f:
            f.write(json.dumps(entry) + '\n')


def ready():
    with open(record + '.ready', 'w') as f:
        f.write(str(os.getpid()))


def serve(conn, n, on):
    buf = b''
    lines = []
    closed_by = 'sender'
    try:
        while True:
            chunk = conn.recv(4096)
            if not chunk:
                break
            buf += chunk
            while b'\n' in buf:
                line, buf = buf.split(b'\n', 1)
                lines.append(line.decode('utf-8', 'replace'))
            if mode == 'reject-token' and lines:
                lines = lines[:1]
                closed_by = 'inbox'
                break
            if mode == 'silent':
                note({'connection': n, 'socket': on, 'lines': lines, 'closedBy': 'nobody'})
    except OSError:
        pass
    if buf and mode != 'reject-token':
        lines.append(buf.decode('utf-8', 'replace'))
    if mode == 'silent':
        # Never closes: the sender waits for an acknowledgement that does not come.
        note({'connection': n, 'socket': on, 'lines': lines, 'closedBy': 'sender'})
        threading.Event().wait()
        return
    note({'connection': n, 'socket': on, 'lines': lines, 'closedBy': closed_by})
    try:
        conn.close()
    except OSError:
        pass


counter = {'n': 0}


def accept_on(srv, on):
    while True:
        try:
            conn, _ = srv.accept()
        except OSError:
            return
        with lock:
            counter['n'] += 1
            n = counter['n']
        threading.Thread(target=serve, args=(conn, n, on), daemon=True).start()


def listen_on(where):
    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    if mode == 'stall':
        srv.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 1)
    srv.bind(where)
    if mode == 'refuse':
        srv.close()
        return
    srv.listen(8)
    old, old_path = listening['server'], listening['path']
    listening['server'], listening['path'] = srv, where
    if old is not None:
        try:
            old.close()
            os.unlink(old_path)
        except OSError:
            pass
    if mode != 'stall':
        threading.Thread(target=accept_on, args=(srv, where), daemon=True).start()


def commands():
    # The test's requests, taken in order: rebind, and run a command as this
    # process's own child.
    n = 1
    while True:
        cmd_file = '%s.cmd.%d.json' % (record, n)
        if not os.path.exists(cmd_file):
            time.sleep(0.02)
            continue
        with open(cmd_file) as f:
            cmd = json.load(f)
        if cmd.get('bind'):
            listen_on(cmd['bind'])
        result = {}
        run = cmd.get('run')
        if run:
            try:
                r = subprocess.run(run['argv'], input=run.get('input', '').encode('utf-8'), env=run.get('env'),
                                   cwd=run.get('cwd'), capture_output=True, timeout=run.get('timeout', 60))
                result = {'status': r.returncode, 'stdout': r.stdout.decode('utf-8', 'replace'),
                          'stderr': r.stderr.decode('utf-8', 'replace')}
            except subprocess.TimeoutExpired:
                result = {'status': None, 'stdout': '', 'stderr': 'timed out'}
        tmp = '%s.cmd.%d.result.tmp' % (record, n)
        with open(tmp, 'w') as f:
            json.dump(result, f)
        os.rename(tmp, '%s.cmd.%d.result.json' % (record, n))
        n += 1


def main():
    signal.signal(signal.SIGTERM, lambda *a: os._exit(0))
    listen_on(path)
    threading.Thread(target=commands, daemon=True).start()
    ready()
    while True:
        signal.pause()


main()
