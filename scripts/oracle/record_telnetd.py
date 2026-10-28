#!/usr/bin/env python3
"""Record what the real netkit-telnetd 0.17-44build1 (Ubuntu 22.04 `in.telnetd`) sends back to a scripted client.

usage: record_telnetd.py out.json [in.telnetd-binary]

The daemon runs the way inetd runs it: one accepted socket becomes its stdin, stdout and stderr. A scripted client then connects and,
step by step, sends bytes or waits; for each step the bytes the daemon wrote since the previous step are kept. Hostname, process ids
and the date are replaced by placeholders. A throwaway account `tester` is created for the successful-login scenarios and removed.
"""
import json, os, pty, select, socket, subprocess, sys, time, threading

IAC, DONT, DO, WONT, WILL, SB, SE = 255, 254, 253, 252, 251, 250, 240
TELNETD = sys.argv[2] if len(sys.argv) > 2 else '/tmp/jammy/x/usr/sbin/in.telnetd'
HOSTNAME = socket.gethostname()
PASSWORD = 'Tpass-123'


def hexb(*vals):
    return bytes(vals)


def spawn_daemon(extra=None):
    listener = socket.socket()
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(('127.0.0.1', 0))
    listener.listen(1)
    port = listener.getsockname()[1]
    pid = os.fork()
    if pid == 0:
        conn, _ = listener.accept()
        os.dup2(conn.fileno(), 0)
        os.dup2(conn.fileno(), 1)
        os.dup2(conn.fileno(), 2)
        os.execv(TELNETD, ['in.telnetd'] + (extra or []))
    listener.close()
    return pid, port


def read_quiet(sock, quiet, limit=6.0):
    out = b''
    end = time.time() + quiet
    hard = time.time() + limit
    sock.settimeout(0.05)
    closed = False
    while time.time() < min(end, hard):
        try:
            d = sock.recv(65536)
        except socket.timeout:
            continue
        except OSError:
            closed = True
            break
        if not d:
            closed = True
            break
        out += d
        end = time.time() + quiet
    return out, closed


def normalise(raw):
    text = raw.decode('latin-1')
    return text.replace(HOSTNAME, '<HOST>')


def run(steps, extra=None, quiet=0.8):
    pid, port = spawn_daemon(extra)
    sock = socket.create_connection(('127.0.0.1', port))
    out = []
    data, closed = read_quiet(sock, 1.5)
    out.append({'step': 'start', 'got': normalise(data).encode('latin-1').hex(), 'closed': closed})
    for st in steps:
        kind = st[0]
        if kind == 'send':
            sock.sendall(st[1])
        elif kind == 'wait':
            time.sleep(st[1])
        elif kind == 'shutdown':
            sock.shutdown(socket.SHUT_WR)
        data, closed = read_quiet(sock, quiet)
        out.append({'step': [kind, st[1].hex() if isinstance(st[1], bytes) else st[1]], 'got': normalise(data).encode('latin-1').hex(), 'closed': closed})
        if closed:
            break
    try:
        sock.close()
    except OSError:
        pass
    for sig in (15, 9):
        try:
            os.kill(pid, sig)
        except OSError:
            pass
    try:
        os.waitpid(pid, 0)
    except OSError:
        pass
    return out


S = lambda b: ('send', b)

OFFERS = hexb(IAC, WILL, 24) + hexb(IAC, WILL, 31) + hexb(IAC, WILL, 32) + hexb(IAC, WILL, 33) + hexb(IAC, WILL, 34) + hexb(IAC, WILL, 39)
TTYPE_IS = hexb(IAC, SB, 24, 0) + b'xterm' + hexb(IAC, SE)

SCENARIOS = {
    'opening-only': [],
    'agrees-everything': [S(OFFERS), ('wait', 0.5), S(TTYPE_IS)],
    'refuses-everything': [S(hexb(IAC, WONT, 24, IAC, WONT, 32, IAC, WONT, 35, IAC, WONT, 39))],
    'ttype-then-login': [S(hexb(IAC, WILL, 24)), S(TTYPE_IS), ('wait', 1.0)],
    'full-handshake': [S(hexb(IAC, WILL, 24)), S(TTYPE_IS), S(hexb(IAC, WILL, 32)), S(hexb(IAC, SB, 32, 0) + b'38400,38400' + hexb(IAC, SE)),
                       S(hexb(IAC, WILL, 35)), S(hexb(IAC, SB, 35, 0) + b':0' + hexb(IAC, SE)), S(hexb(IAC, WILL, 39)), S(hexb(IAC, SB, 39, 0, 0) + b'USER' + hexb(1) + b'tester' + hexb(IAC, SE)),
                       S(hexb(IAC, WILL, 31)), S(hexb(IAC, SB, 31, 0, 80, 0, 24, IAC, SE)), ('wait', 1.0)],
    'bad-login-three-times': [S(hexb(IAC, WONT, 24, IAC, WONT, 32, IAC, WONT, 35, IAC, WONT, 39)), ('wait', 1.0), S(b'nobody\r\x00'), ('wait', 0.5), S(b'wrong\r\x00'),
                              ('wait', 1.5), S(b'nobody\r\x00'), S(b'wrong\r\x00'), ('wait', 1.5), S(b'nobody\r\x00'), S(b'wrong\r\x00'), ('wait', 2.0)],
    'login-ok-commands': [S(hexb(IAC, WONT, 24, IAC, WONT, 32, IAC, WONT, 35, IAC, WONT, 39)), ('wait', 1.0), S(b'tester\r\x00'), ('wait', 0.5), S(PASSWORD.encode() + b'\r\x00'),
                          ('wait', 1.5), S(b'echo hello\r\x00'), S(b'whoami\r\x00'), S(b'tty\r\x00'), S(b'echo $TERM\r\x00'), S(b'exit\r\x00'), ('wait', 1.0)],
    'login-ok-term': [S(hexb(IAC, WILL, 24)), S(TTYPE_IS), S(hexb(IAC, WONT, 32, IAC, WONT, 35, IAC, WONT, 39)), ('wait', 1.0), S(b'tester\r\x00'), ('wait', 0.5),
                      S(PASSWORD.encode() + b'\r\x00'), ('wait', 1.5), S(b'echo $TERM\r\x00'), S(b'exit\r\x00'), ('wait', 1.0)],
    'echo-negotiation': [S(hexb(IAC, WONT, 24, IAC, WONT, 32, IAC, WONT, 35, IAC, WONT, 39)), ('wait', 1.0), S(hexb(IAC, DONT, 1)), ('wait', 0.4), S(hexb(IAC, DO, 1)), ('wait', 0.4),
                         S(hexb(IAC, DONT, 3)), S(hexb(IAC, DO, 3)), S(hexb(IAC, WILL, 3)), S(hexb(IAC, WONT, 3))],
    'unknown-options': [S(hexb(IAC, DO, 200, IAC, WILL, 201, IAC, DO, 0, IAC, WILL, 0, IAC, DO, 5, IAC, DO, 18)), ('wait', 0.5)],
    'controls': [S(hexb(IAC, WONT, 24, IAC, WONT, 32, IAC, WONT, 35, IAC, WONT, 39)), ('wait', 1.0), S(hexb(IAC, 246)), S(hexb(IAC, 241)), S(hexb(IAC, 244)), S(hexb(IAC, 243))],
    'ayt-after-login': [S(hexb(IAC, WONT, 24, IAC, WONT, 32, IAC, WONT, 35, IAC, WONT, 39)), ('wait', 1.0), S(b'tester\r\x00'), ('wait', 0.5), S(PASSWORD.encode() + b'\r\x00'),
                        ('wait', 1.5), S(hexb(IAC, 246)), ('wait', 0.4), S(b'exit\r\x00'), ('wait', 1.0)],
    'client-eof': [S(hexb(IAC, WONT, 24, IAC, WONT, 32, IAC, WONT, 35, IAC, WONT, 39)), ('wait', 1.0), ('shutdown', 0), ('wait', 1.0)],
}


def main():
    subprocess.run(['useradd', '-m', '-s', '/bin/bash', 'tester'], check=False, capture_output=True)
    subprocess.run(['chpasswd'], input=f'tester:{PASSWORD}\n'.encode(), check=False, capture_output=True)
    result = {'daemon': os.path.basename(TELNETD), 'hostname': HOSTNAME, 'password': PASSWORD, 'issue_net': open('/etc/issue.net').read() if os.path.exists('/etc/issue.net') else None, 'scenarios': {}}
    try:
        for name, steps in SCENARIOS.items():
            result['scenarios'][name] = {'steps': [[s[0], s[1].hex() if isinstance(s[1], bytes) else s[1]] for s in steps], 'result': run(steps)}
    finally:
        subprocess.run(['userdel', '-r', 'tester'], check=False, capture_output=True)
    json.dump(result, open(sys.argv[1], 'w'), indent=1)


if __name__ == '__main__':
    main()
