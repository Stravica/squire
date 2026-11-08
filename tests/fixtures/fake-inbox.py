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
{"connection": n, "lines": [...], "closedBy": "sender" | "inbox"}; a silent
inbox records what it has read after every chunk. When the socket is ready,
"<record file>.ready" is written. SIGTERM ends it.
"""

import json
import os
import signal
import socket
import sys
import threading

path, record, mode = sys.argv[1], sys.argv[2], sys.argv[3]
lock = threading.Lock()


def note(entry):
    with lock:
        with open(record, 'a') as f:
            f.write(json.dumps(entry) + '\n')


def ready():
    with open(record + '.ready', 'w') as f:
        f.write(str(os.getpid()))


def serve(conn, n):
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
                note({'connection': n, 'lines': lines, 'closedBy': 'nobody'})
    except OSError:
        pass
    if buf and mode != 'reject-token':
        lines.append(buf.decode('utf-8', 'replace'))
    if mode == 'silent':
        # Never closes: the sender waits for an acknowledgement that does not come.
        note({'connection': n, 'lines': lines, 'closedBy': 'sender'})
        threading.Event().wait()
        return
    note({'connection': n, 'lines': lines, 'closedBy': closed_by})
    try:
        conn.close()
    except OSError:
        pass


def main():
    signal.signal(signal.SIGTERM, lambda *a: os._exit(0))
    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    if mode == 'stall':
        srv.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 1)
    srv.bind(path)
    if mode == 'refuse':
        srv.close()
        ready()
        signal.pause()
        return
    srv.listen(8)
    ready()
    if mode == 'stall':
        signal.pause()
        return
    n = 0
    while True:
        conn, _ = srv.accept()
        n += 1
        threading.Thread(target=serve, args=(conn, n), daemon=True).start()


main()
