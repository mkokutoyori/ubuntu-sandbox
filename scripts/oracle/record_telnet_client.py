#!/usr/bin/env python3
"""Record what the real netkit-telnet 0.17-44build1 (Ubuntu 22.04 `telnet`) prints and sends.

usage: [ONLY=name,name] record_telnet_client.py out.json [telnet-binary]

The binary is the jammy .deb extracted somewhere (default /tmp/jammy/x/usr/bin/telnet.netkit) and run under the name `telnet` so the
prompt reads `telnet>`. Two families are recorded through a pty:

  commands   the client alone at its `telnet>` prompt (no connection); every line typed is one step.
  sessions   the client against a raw TCP server on 127.0.0.1 that sends scripted bytes; a step types bytes, makes the server send bytes,
             or makes it close. For each step: what the terminal showed, and what the server received since the previous step.

Host and port in the transcripts are replaced by <HOST> and <PORT>; line ends are normalised to \\n.
"""
import json, os, pty, select, socket, sys, threading, time, tempfile, struct, fcntl, termios

IAC, DONT, DO, WONT, WILL, SB, SE = 255, 254, 253, 252, 251, 250, 240
TELNET = sys.argv[2] if len(sys.argv) > 2 else '/tmp/jammy/x/usr/bin/telnet.netkit'
QUIET = 0.35


def drain(fd, quiet):
    out = b''
    while True:
        if not select.select([fd], [], [], quiet)[0]:
            break
        try:
            d = os.read(fd, 65536)
        except OSError:
            break
        if not d:
            break
        out += d
    return out


class Server:
    def __init__(self, port=0):
        self.sock = socket.socket()
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.sock.bind(('127.0.0.1', port))
        self.sock.listen(1)
        self.port = self.sock.getsockname()[1]
        self.received = b''
        self.conn = None
        threading.Thread(target=self.run, daemon=True).start()

    def run(self):
        c, _ = self.sock.accept()
        self.conn = c
        while True:
            try:
                d = c.recv(65536)
            except Exception:
                break
            if not d:
                break
            self.received += d

    def send(self, b):
        if self.conn:
            self.conn.sendall(b)

    def close(self):
        if self.conn:
            self.conn.close()
        self.sock.close()


def start(argv, env=None):
    pid, fd = pty.fork()
    if pid == 0:
        e = {'TERM': 'xterm', 'PATH': os.environ['PATH'], 'HOME': '/root', 'USER': 'root', 'LOGNAME': 'root'}
        e.update(env or {})
        os.execve(argv[0], argv, e)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
    return pid, fd


def stop(pid):
    for sig in (15, 9):
        try:
            os.kill(pid, sig)
        except Exception:
            pass
    try:
        os.waitpid(pid, 0)
    except Exception:
        pass


def clean(raw, port=None):
    s = raw.decode('latin-1').replace('\r\n', '\n').replace('\r', '\r')
    if port is not None:
        s = s.replace(str(port), '<PORT>')
    return s


def run_commands(lines, env=None):
    pid, fd = start(['/tmp/tl/telnet'], env)
    steps = []
    initial = drain(fd, 0.6)
    steps.append({'type': None, 'screen': clean(initial)})
    for line in lines:
        os.write(fd, line.encode('latin-1') + b'\r')
        steps.append({'type': line, 'screen': clean(drain(fd, QUIET))})
    stop(pid)
    return steps


def run_session(argv_tail, steps, port=None, env=None, rc=None):
    server = Server(port or 0)
    argv = ['/tmp/tl/telnet'] + [a.replace('<PORT>', str(server.port)) for a in argv_tail]
    env = dict(env or {})
    if rc is not None:
        home = tempfile.mkdtemp()
        open(os.path.join(home, '.telnetrc'), 'w').write(rc)
        env['HOME'] = home
    pid, fd = start(argv, env)
    out = []
    first = clean(drain(fd, 0.7), server.port)
    out.append({'step': 'start', 'screen': first, 'server_got': server.received.hex()})
    for st in steps:
        mark = len(server.received)
        kind = st[0]
        if kind == 'type':
            os.write(fd, st[1])
        elif kind == 'send':
            server.send(st[1])
        elif kind == 'close':
            server.conn.shutdown(socket.SHUT_RDWR)
            server.conn.close()
        elif kind == 'wait':
            time.sleep(st[1])
        elif kind == 'resize':
            fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', st[1][0], st[1][1], 0, 0))
        screen = drain(fd, QUIET)
        out.append({'step': [kind, st[1].hex() if isinstance(st[1], bytes) else st[1]], 'screen': clean(screen, server.port),
                    'server_got': server.received[mark:].hex()})
    stop(pid)
    server.sock.close()
    return out


def hexb(*vals):
    return bytes(vals)


COMMAND_SCENARIOS = {
    'help': ['?', 'help', 'h', '? send', 'help set', '? bogus', '? ? ?', '?  close open'],
    'status': ['status', 'st', 'display', 'display echo', 'display escape autoflush', 'display bogus', 'display ?'],
    'send': ['send', 'send ?', 'send bogus', 'send ayt', 'send do ?', 'send do echo', 'send will 300', 'send do 5 6',
             'send escape', 'send a', 'send do', 'send synch', 'send getstatus', 'send help', 'send ip ayt'],
    'toggle': ['toggle', 'toggle ?', 'toggle bogus', 'toggle autoflush', 'toggle autoflush skiprc', 'toggle crlf', 'toggle crlf',
               'toggle binary', 'toggle inbinary', 'toggle outbinary', 'toggle localchars', 'toggle debug', 'toggle netdata',
               'toggle options', 'toggle a', 'toggle crm', 'toggle termdata', 'toggle prettydump'],
    'set': ['set', 'set ?', 'set escape ^X', 'display escape', 'set escape off', 'set escape', 'set escape ^]', 'set echo ^Z', 'set interrupt ^A',
            'set interrupt', 'set erase x', 'set tracefile out.log', 'set bogus 1', 'set debug', 'set debug off', 'set debug on',
            'set crlf on', 'set crlf maybe', 'set eof ^?', 'set kill off', 'display', 'set a', 'set e x'],
    'unset': ['unset', 'unset ?', 'unset escape', 'display escape', 'unset autoflush', 'unset autoflush crlf', 'unset bogus', 'unset interrupt',
              'unset debug', 'unset a'],
    'mode': ['mode', 'mode ?', 'mode line', 'mode character', 'mode bogus', 'mode isig', 'mode -edit', 'mode help', 'mode c'],
    'environ': ['environ', 'environ ?', 'environ list', 'environ define FOO bar', 'environ list', 'environ undefine FOO', 'environ send FOO',
                'environ export USER', 'environ unexport USER', 'environ bogus', 'environ define', 'environ define A', 'environ list x',
                'environ help'],
    'slc': ['slc', 'slc ?', 'slc export', 'slc import', 'slc check', 'slc bogus'],
    'misc': ['close', 'logout', 'bye', 'bogus', 's', 'se', 't', 'e', 'escape x', 'escape', 'crmod', 'z', '!', 'open', 'quit'],
    'open': ['open', 'open -l', 'open host nonexistent.invalid', 'open nonexistent.invalid', 'open 127.0.0.1 1', 'open 127.0.0.1 99999',
             'open 127.0.0.1 0', 'open 127.0.0.1 bogus-service', 'open -6 ::1 1', 'open 127.0.0.1 1 2', 'open ?', 'open -4 127.0.0.1 1',
             'open -l alice 127.0.0.1 1', 'open -a 127.0.0.1 1', 'open -b', 'open 127.0.0.1 -1', 'open 127.0.0.1 telnet'],
}

SESSION_SCENARIOS = {}


def add(name, argv_tail, steps, **kw):
    SESSION_SCENARIOS[name] = {'argv': argv_tail, 'steps': steps, 'kw': kw}


T = lambda b: ('type', b)
S = lambda b: ('send', b)

add('plain-linemode', ['127.0.0.1', '<PORT>'], [S(b'hello banner\r\n'), T(b'abc\r'), T(b'\x1d'), T(b'status\r'), T(b'display escape\r'), T(b'\r'),
    T(b'xyz\r'), T(b'\x1d'), T(b'close\r')])
add('server-closes', ['127.0.0.1', '<PORT>'], [S(b'bye\r\n'), ('close', b'')])
add('quit-from-escape', ['127.0.0.1', '<PORT>'], [S(b'hi\r\n'), T(b'\x1d'), T(b'quit\r')])
add('char-mode', ['127.0.0.1', '<PORT>'], [S(hexb(IAC, WILL, 1, IAC, WILL, 3)), T(b'ab'), T(b'\r'), T(b'\x1d'), T(b'status\r'), T(b'\r'), T(b'\x03'),
    T(b'\x1d'), T(b'toggle localchars\r'), T(b'status\r'), T(b'\r'), T(b'\x03'), T(b'\x1c')])
add('echo-only', ['127.0.0.1', '<PORT>'], [S(hexb(IAC, WILL, 1)), T(b'ab\r'), T(b'\x1d'), T(b'status\r'), T(b'\r')])
add('sga-only', ['127.0.0.1', '<PORT>'], [S(hexb(IAC, WILL, 3)), T(b'ab\r'), T(b'\x1d'), T(b'status\r'), T(b'\r')])
add('offers', ['127.0.0.1', '<PORT>'], [S(hexb(IAC, DO, 24)), S(hexb(IAC, SB, 24, 1, IAC, SE)), S(hexb(IAC, DO, 31)), S(hexb(IAC, DO, 32)),
    S(hexb(IAC, SB, 32, 1, IAC, SE)), S(hexb(IAC, DO, 35)), S(hexb(IAC, DO, 39)), S(hexb(IAC, SB, 39, 1, IAC, SE)), S(hexb(IAC, DO, 34)),
    S(hexb(IAC, DO, 5)), S(hexb(IAC, DO, 33)), S(hexb(IAC, DO, 200)), S(hexb(IAC, DO, 0)), S(hexb(IAC, WILL, 0)), S(hexb(IAC, WILL, 5)),
    S(hexb(IAC, WILL, 6)), S(hexb(IAC, DO, 6)), S(hexb(IAC, WILL, 24)), S(hexb(IAC, WILL, 100)), S(hexb(IAC, DONT, 24)), S(hexb(IAC, DO, 3)),
    S(hexb(IAC, DONT, 3)), S(hexb(IAC, WONT, 1))])
add('offers-then-display', ['127.0.0.1', '<PORT>'], [S(hexb(IAC, DO, 24, IAC, DO, 31, IAC, WILL, 1, IAC, WILL, 3, IAC, DO, 34)), T(b'\x1d'),
    T(b'display\r'), T(b'status\r'), T(b'\r')])
add('data-translation', ['127.0.0.1', '<PORT>'], [S(b'a\r\nb\r\x00c\rd\n'), S(hexb(IAC, IAC, 65)), S(b'x\ry'), T(b'q\r'), T(b'\xff\r'), T(b'\x1d'),
    T(b'toggle crlf\r'), T(b'\r'), T(b'z\r'), T(b'\x1d'), T(b'toggle crmod\r'), T(b'\r'), S(b'p\rq\n')])
add('controls', ['127.0.0.1', '<PORT>'], [S(hexb(IAC, 241, IAC, 249, IAC, 246)), S(b'text'), S(hexb(IAC, 242)), S(b'more\r\n')])
add('send-commands', ['127.0.0.1', '<PORT>'], [S(hexb(IAC, WILL, 1, IAC, WILL, 3)), T(b'\x1d'), T(b'send ayt\r'), T(b'send ip\r'), T(b'send brk\r'),
    T(b'send ec\r'), T(b'send el\r'), T(b'send ao\r'), T(b'send ga\r'), T(b'send nop\r'), T(b'send eor\r'), T(b'send abort\r'), T(b'send susp\r'),
    T(b'send eof\r'), T(b'send escape\r'), T(b'send synch\r'), T(b'send getstatus\r'), T(b'send do echo\r'), T(b'send will 99\r'),
    T(b'send ayt ip\r'), T(b'send xyz\r')])
add('escape-char', ['127.0.0.1', '<PORT>'], [S(hexb(IAC, WILL, 1, IAC, WILL, 3)), T(b'\x1d'), T(b'set escape ^X\r'), T(b'\r'), T(b'\x18'),
    T(b'status\r'), T(b'\r'), T(b'\x18\x18'), T(b'e\r'), T(b'\x18'), T(b'quit\r')])
add('dash-e', ['-e', '^X', '127.0.0.1', '<PORT>'], [S(b'hi\r\n'), T(b'\x18'), T(b'status\r'), T(b'\r')])
add('dash-E', ['-E', '127.0.0.1', '<PORT>'], [S(b'hi\r\n'), T(b'\x1d'), T(b'abc\r')])
add('dash-8', ['-8', '127.0.0.1', '<PORT>'], [S(b'hi\r\n'), T(b'\x1d'), T(b'status\r'), T(b'display\r'), T(b'\r')])
add('dash-L', ['-L', '127.0.0.1', '<PORT>'], [S(b'hi\r\n'), T(b'\x1d'), T(b'display\r'), T(b'\r')])
add('dash-l-port23', ['-l', 'alice', '127.0.0.1', '23'], [S(hexb(IAC, DO, 39)), S(hexb(IAC, SB, 39, 1, IAC, SE)), S(hexb(IAC, DO, 24)),
    S(hexb(IAC, SB, 24, 1, IAC, SE))], port=23)
add('default-port', ['127.0.0.1'], [S(hexb(IAC, WILL, 1, IAC, WILL, 3, IAC, DO, 24, IAC, DO, 31, IAC, DO, 32, IAC, DO, 39, IAC, DO, 34, IAC, DO, 33,
    IAC, WILL, 5)), T(b'\x1d'), T(b'status\r'), T(b'display\r'), T(b'\r')], port=23)
add('default-port-wait', ['127.0.0.1'], [('wait', 0.2), T(b'\x1d'), T(b'status\r'), T(b'\r')], port=23)
add('dash-a-port23', ['-a', '127.0.0.1'], [S(hexb(IAC, DO, 39)), S(hexb(IAC, SB, 39, 1, IAC, SE))], port=23)
add('binary', ['127.0.0.1', '<PORT>'], [S(hexb(IAC, WILL, 1, IAC, WILL, 3)), T(b'\x1d'), T(b'toggle binary\r'), T(b'toggle binary\r'), T(b'toggle inbinary\r'),
    T(b'toggle outbinary\r'), T(b'toggle outbinary\r'), T(b'\r'), S(hexb(IAC, DO, 0, IAC, WILL, 0)), T(b'\x1d'), T(b'toggle binary\r'), T(b'\r')])
add('mode-line-char', ['127.0.0.1', '<PORT>'], [S(hexb(IAC, WILL, 1, IAC, WILL, 3)), T(b'\x1d'), T(b'mode line\r'), T(b'status\r'), T(b'mode character\r'),
    T(b'status\r'), T(b'mode isig\r'), T(b'\r')])
add('linemode-option', ['127.0.0.1', '<PORT>'], [S(hexb(IAC, DO, 34)), S(hexb(IAC, SB, 34, 1, 7, IAC, SE)), T(b'\x1d'), T(b'status\r'),
    T(b'mode -edit\r'), T(b'mode isig\r'), T(b'status\r'), T(b'slc export\r'), T(b'status\r'), T(b'\r'), S(hexb(IAC, DONT, 34))])
add('status-option', ['127.0.0.1', '<PORT>'], [S(hexb(IAC, DO, 5)), T(b'\x1d'), T(b'send getstatus\r'), T(b'\r'),
    S(hexb(IAC, SB, 5, 0, WILL, 1, DO, 3, IAC, SE))])
add('tm', ['127.0.0.1', '<PORT>'], [S(hexb(IAC, DO, 6)), S(hexb(IAC, WILL, 6)), S(hexb(IAC, DONT, 6))])
add('refused-then-close', ['127.0.0.1', '<PORT>'], [S(b'x'), T(b'\x1d'), T(b'open 127.0.0.1 1\r'), T(b'close\r'), T(b'close\r'), T(b'status\r')])
add('open-twice', ['127.0.0.1', '<PORT>'], [S(b'x'), T(b'\x1d'), T(b'open 127.0.0.1 2\r'), T(b'\r')])
add('ctrl-c', ['127.0.0.1', '<PORT>'], [S(b'x'), T(b'\x03')])
add('suspend-key', ['127.0.0.1', '<PORT>'], [S(hexb(IAC, WILL, 1, IAC, WILL, 3)), T(b'\x1a')])
add('timestamped', ['-d', '127.0.0.1', '<PORT>'], [S(b'x'), T(b'\x1d'), T(b'status\r'), T(b'display\r'), T(b'\r')])
add('long-line', ['127.0.0.1', '<PORT>'], [S(b'x'), T(b'a' * 300 + b'\r')])

LM_SLC_HEAD = hexb(IAC, SB, 34, 3)

add('trace-options', ['127.0.0.1', '<PORT>'], [T(b'\x1d'), T(b'toggle options\r'), T(b'\r'), S(hexb(IAC, DO, 24)), S(hexb(IAC, SB, 24, 1, IAC, SE)), S(hexb(IAC, DO, 31)),
    S(hexb(IAC, DO, 32)), S(hexb(IAC, SB, 32, 1, IAC, SE)), S(hexb(IAC, DO, 33)), S(hexb(IAC, SB, 33, 1, IAC, SE)), S(hexb(IAC, SB, 33, 0, IAC, SE)),
    S(hexb(IAC, SB, 33, 5, IAC, SE)), S(hexb(IAC, DO, 34)), S(hexb(IAC, SB, 34, 1, 7, IAC, SE)), S(hexb(IAC, SB, 34, 1, 3 | 4, IAC, SE)),
    S(hexb(IAC, SB, 34, 251, 2, IAC, SE)), S(hexb(IAC, SB, 34, 253, 2, 255, 255, IAC, SE)), S(hexb(IAC, SB, 34, 9, 1, 2, IAC, SE)),
    S(hexb(IAC, WILL, 1, IAC, WILL, 3)), S(hexb(IAC, DO, 5)), S(hexb(IAC, SB, 5, 1, IAC, SE)), S(hexb(IAC, SB, 5, 0, WILL, 1, DO, 3, SB, 24, 0, 65, 66, SE, IAC, SE)),
    S(hexb(IAC, DO, 39)), S(hexb(IAC, SB, 39, 1, 0, 85, 83, 69, 82, 3, 70, 79, 79, IAC, SE)), S(hexb(IAC, SB, 39, 1, IAC, SE)),
    S(hexb(IAC, SB, 39, 0, 0, 65, 1, 66, IAC, SE)), S(hexb(IAC, SB, 39, 2, 3, 120, 1, 121, 2, 1, IAC, SE)), S(hexb(IAC, SB, 39, 9, IAC, SE)),
    S(hexb(IAC, DO, 35)), S(hexb(IAC, SB, 35, 1, IAC, SE)), S(hexb(IAC, SB, 35, 0, 49, IAC, SE)), S(hexb(IAC, WILL, 6)), S(hexb(IAC, DO, 6)),
    S(hexb(IAC, SB, 200, 1, 2, 3, IAC, SE)), S(hexb(IAC, SB, 24, 1, 255, 1)), S(hexb(IAC, SB, 24, 1, IAC, 241)), S(hexb(IAC, 249, IAC, 241, IAC, 242)),
    S(hexb(IAC, WILL, 200)), S(hexb(IAC, DO, 255)), T(b'\x1d'), T(b'display\r'), T(b'\r')])
add('environ-session', ['-l', 'alice', '127.0.0.1', '<PORT>'], [S(hexb(IAC, DO, 39)), S(hexb(IAC, SB, 39, 1, IAC, SE)), S(hexb(IAC, SB, 39, 1, 0, 85, 83, 69, 82, 3, 70, 79, 79, IAC, SE)),
    S(hexb(IAC, SB, 39, 1, 0, 68, 73, 83, 80, 76, 65, 89, 3, 88, 89, IAC, SE)), S(hexb(IAC, SB, 39, 1, 3, IAC, SE)), T(b'\x1d'), T(b'environ define FOO bar\r'),
    T(b'environ export FOO\r'), T(b'environ send FOO\r'), T(b'environ send NOPE\r'), T(b'environ list\r'), T(b'\r'), S(hexb(IAC, SB, 39, 1, IAC, SE)),
    T(b'\x1d'), T(b'environ undefine FOO\r'), T(b'\r'), S(hexb(IAC, SB, 39, 1, IAC, SE))], port=None, env={'DISPLAY': ':0.0', 'LANG': 'C', 'LC_ALL': 'C', 'PRINTER': 'lp', 'MYVAR': 'v'})
add('xdisploc', ['127.0.0.1', '<PORT>'], [S(hexb(IAC, DO, 35)), S(hexb(IAC, SB, 35, 1, IAC, SE))], env={'DISPLAY': 'host.example:1.2'})
add('xdisploc-unix', ['127.0.0.1', '<PORT>'], [S(hexb(IAC, DO, 35)), S(hexb(IAC, SB, 35, 1, IAC, SE))], env={'DISPLAY': 'unix:0'})
add('term-variants', ['127.0.0.1', '<PORT>'], [S(hexb(IAC, DO, 24)), S(hexb(IAC, SB, 24, 1, IAC, SE)), S(hexb(IAC, SB, 24, 1, IAC, SE))], env={'TERM': 'vt100'})
add('term-absent', ['127.0.0.1', '<PORT>'], [S(hexb(IAC, DO, 24)), S(hexb(IAC, SB, 24, 1, IAC, SE))], env={'TERM': ''})
add('linemode-slc', ['127.0.0.1', '<PORT>'], [S(hexb(IAC, DO, 34)), S(hexb(IAC, SB, 34, 1, 7, IAC, SE)), S(LM_SLC_HEAD + hexb(3, 2, 3, 4, 2, 15, 255, 255) + hexb(IAC, SE)),
    S(LM_SLC_HEAD + hexb(3, 3, 0, 8, 3, 0, 9, 1, 26, 19, 2, 2, 0, 0, 0) + hexb(IAC, SE)), S(LM_SLC_HEAD + hexb(3, 130, 3) + hexb(IAC, SE)), S(LM_SLC_HEAD + hexb(200, 2, 1) + hexb(IAC, SE)),
    T(b'\x1d'), T(b'status\r'), T(b'slc import\r'), T(b'status\r'), T(b'slc check\r'), T(b'status\r'), T(b'slc export\r'), T(b'set interrupt ^A\r'), T(b'set eof off\r'),
    T(b'set flushoutput ^P\r'), T(b'\r'), S(hexb(IAC, SB, 34, 1, 0, IAC, SE)), S(hexb(IAC, SB, 34, 1, 1, IAC, SE)), S(hexb(IAC, SB, 34, 251, 2, IAC, SE)),
    S(hexb(IAC, SB, 34, 253, 2, IAC, SE)), S(hexb(IAC, SB, 34, 252, 2, IAC, SE)), S(hexb(IAC, SB, 34, 254, 2, IAC, SE)), S(hexb(IAC, DONT, 34)), S(hexb(IAC, DO, 34))])
add('linemode-edit', ['127.0.0.1', '<PORT>'], [S(hexb(IAC, DO, 34)), S(hexb(IAC, SB, 34, 1, 5, IAC, SE)), T(b'abc\r'), T(b'\x03'), T(b'\x1d'), T(b'status\r'), T(b'mode softtabs\r'),
    T(b'mode litecho\r'), T(b'mode -isig\r'), T(b'mode +edit\r'), T(b'status\r'), T(b'mode character\r'), T(b'mode line\r'), T(b'\r'), T(b'\x04'), T(b'x\r')])
add('kludge-line', ['127.0.0.1', '<PORT>'], [S(hexb(IAC, WILL, 1, IAC, WILL, 3)), T(b'\x1d'), T(b'mode line\r'), T(b'status\r'), T(b'\r'), T(b'ab\r'), T(b'\x05'), T(b'\x05'), T(b'cd\r'),
    T(b'\x1d'), T(b'mode kludgeline\r'), T(b'status\r'), T(b'\r'), S(hexb(IAC, DONT, 3)), S(hexb(IAC, WONT, 1)), T(b'ef\r'), T(b'\x1d'), T(b'mode character\r'), T(b'status\r'), T(b'\r')])
add('rlogin-flag', ['-r', '127.0.0.1', '<PORT>'], [S(b'hi\r\n'), T(b'~'), T(b'.'), T(b'x')])
add('rlogin-escape', ['-r', '127.0.0.1', '<PORT>'], [S(b'hi\r\n'), T(b'abc\r'), T(b'~'), T(b'~'), T(b'~'), T(b'?'), T(b'~'), T(b'\x04')])
add('rlogin-command', ['-r', '127.0.0.1', '<PORT>'], [S(b'hi\r\n'), T(b'~'), T(b'\x1d'), T(b'status\r')])
add('autologin-env', ['-a', '127.0.0.1', '<PORT>'], [S(hexb(IAC, DO, 39)), S(hexb(IAC, SB, 39, 1, IAC, SE))])
add('lflow', ['127.0.0.1', '<PORT>'], [S(hexb(IAC, DO, 33)), S(hexb(IAC, SB, 33, 1, IAC, SE)), T(b'\x1d'), T(b'status\r'), T(b'\r'), S(hexb(IAC, SB, 33, 0, IAC, SE)), T(b'\x1d'), T(b'status\r'), T(b'\r')])
add('naws-resize', ['127.0.0.1', '<PORT>'], [S(hexb(IAC, DO, 31)), ('resize', [30, 100]), ('resize', [255, 255]), S(hexb(IAC, DONT, 31)), ('resize', [10, 10])])
add('tm-flush', ['127.0.0.1', '<PORT>'], [S(b'data'), T(b'\x0f'), S(hexb(IAC, WILL, 6)), S(b'more'), T(b'\x03'), S(hexb(IAC, WILL, 6))])
add('send-do-names', ['127.0.0.1', '<PORT>'], [S(b'x'), T(b'\x1d'), T(b'send do binary\r'), T(b'send will echo\r'), T(b'send dont term\r'), T(b'send wont terminal-type\r'), T(b'send do 300\r'),
    T(b'send do ex\r'), T(b'send do s\r'), T(b'send do "terminal type"\r'), T(b'send do 255\r'), T(b'send do 256\r'), T(b'send do -1\r'), T(b'send will x\r'), T(b'send wont ?\r'),
    T(b'send do binary will binary\r'), T(b'\r')])
add('toggle-session', ['127.0.0.1', '<PORT>'], [S(hexb(IAC, WILL, 1, IAC, WILL, 3)), T(b'\x1d'), T(b'toggle autosynch\r'), T(b'toggle autoflush\r'), T(b'\r'), T(b'\x03'), T(b'\x1d'),
    T(b'toggle autoflush\r'), T(b'\r'), T(b'\x03'), S(hexb(IAC, WILL, 6)), T(b'\x1d'), T(b'toggle localchars\r'), T(b'\r'), T(b'\x03')])
add('logout', ['127.0.0.1', '<PORT>'], [S(b'x'), T(b'\x1d'), T(b'logout\r'), S(hexb(IAC, WILL, 18)), S(hexb(IAC, WONT, 18))])
add('telnetrc', ['127.0.0.1', '<PORT>'], [S(b'x'), T(b'\x1d'), T(b'display escape\r'), T(b'\r')], rc='127.0.0.1\n  set escape ^X\n  toggle crmod\n')

PIPE_SCENARIOS = {}


def add_pipe(name, argv_tail, steps, **kw):
    PIPE_SCENARIOS[name] = {'argv': argv_tail, 'steps': steps, 'kw': kw}


add_pipe('banner-then-eof', ['127.0.0.1', '<PORT>'], [S(b'login: '), ('stdin', b'alice\n'), ('eof', b''), ('wait', 0.3), ('close', b'')])
add_pipe('char-mode-lines', ['127.0.0.1', '<PORT>'], [S(hexb(IAC, WILL, 1, IAC, WILL, 3)), ('stdin', b'ab\ncd\n'), ('eof', b''), ('wait', 0.3), ('close', b'')])
add_pipe('line-mode-lines', ['127.0.0.1', '<PORT>'], [S(b'hello\r\n'), ('stdin', b'ab\ncd\r\n'), ('wait', 0.2), ('eof', b''), ('wait', 0.3), ('close', b'')])
add_pipe('server-closes-first', ['127.0.0.1', '<PORT>'], [S(b'bye\r\n'), ('close', b''), ('wait', 0.3)])
add_pipe('escape-in-pipe', ['127.0.0.1', '<PORT>'], [S(b'hi\r\n'), ('stdin', b'a\x1dstatus\nquit\n'), ('wait', 0.3), ('close', b'')])
add_pipe('refused', ['127.0.0.1', '1'], [('wait', 0.2)])
add_pipe('no-args-eof', [], [('eof', b''), ('wait', 0.3)])
add_pipe('no-args-commands', [], [('stdin', b'status\nquit\n'), ('wait', 0.3)])
add_pipe('binary-bytes', ['-8', '127.0.0.1', '<PORT>'], [S(hexb(IAC, WILL, 0, IAC, DO, 0)), ('stdin', bytes([0x80, 0xff, 0x0a])), ('wait', 0.3), ('eof', b''), ('close', b'')])
add_pipe('options-negotiated', ['127.0.0.1', '<PORT>'], [S(hexb(IAC, DO, 24)), S(hexb(IAC, SB, 24, 1, IAC, SE)), S(hexb(IAC, DO, 31)), S(hexb(IAC, DO, 32)),
    S(hexb(IAC, SB, 32, 1, IAC, SE)), ('wait', 0.3), ('close', b'')])


def run_pipe(argv_tail, steps, port=None, env=None):
    import subprocess
    server = Server(port or 0)
    argv = ['/tmp/tl/telnet'] + [a.replace('<PORT>', str(server.port)) for a in argv_tail]
    e = {'TERM': 'xterm', 'PATH': os.environ['PATH'], 'HOME': '/root', 'USER': 'root', 'LOGNAME': 'root'}
    e.update(env or {})
    proc = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=e)
    os.set_blocking(proc.stdout.fileno(), False)
    collected = {'out': b''}

    def pump(quiet):
        end = time.time() + quiet
        while time.time() < end:
            try:
                d = proc.stdout.read()
            except Exception:
                d = None
            if d:
                collected['out'] += d
                end = time.time() + quiet
            time.sleep(0.02)

    pump(0.7)
    out = [{'step': 'start', 'stdout': collected['out'].decode('latin-1').replace(str(server.port), '<PORT>'), 'server_got': server.received.hex(), 'exit': proc.poll()}]
    collected['out'] = b''
    for st in steps:
        mark = len(server.received)
        kind = st[0]
        if kind == 'stdin':
            proc.stdin.write(st[1]); proc.stdin.flush()
        elif kind == 'eof':
            proc.stdin.close()
        elif kind == 'send':
            server.send(st[1])
        elif kind == 'close':
            if server.conn:
                server.conn.shutdown(socket.SHUT_RDWR); server.conn.close()
        elif kind == 'wait':
            time.sleep(st[1])
        pump(0.35)
        out.append({'step': [kind, st[1].hex() if isinstance(st[1], bytes) else st[1]], 'stdout': collected['out'].decode('latin-1').replace(str(server.port), '<PORT>'),
                    'server_got': server.received[mark:].hex(), 'exit': proc.poll()})
        collected['out'] = b''
    if proc.poll() is None:
        proc.kill()
    proc.wait()
    server.sock.close()
    return out


ARG_SCENARIOS = {
    'no-host-flags': [['-l'], ['-e'], ['-x'], ['-z'], ['-4'], ['-6', '::1'], ['127.0.0.1', '1', '2'], ['-8', '-4', '127.0.0.1', '1'], ['-n'],
                      ['-b', '127.0.0.1', '127.0.0.1', '1'], ['-r', '127.0.0.1', '1'], ['-E', '-e', 'x', '127.0.0.1', '1'], ['-7', '127.0.0.1', '1'],
                      ['-K', '127.0.0.1', '1'], ['-X', 'x', '127.0.0.1', '1'], ['-S', 'x', '127.0.0.1', '1'], ['-k', 'r', '127.0.0.1', '1'],
                      ['-c', '127.0.0.1', '1'], ['-t', 'x', '127.0.0.1', '1'], ['nonexistent.invalid'], ['nonexistent.invalid', '23'],
                      ['127.0.0.1', '1'], ['127.0.0.1', 'bogus'], ['127.0.0.1', '0'], ['127.0.0.1', '99999'], ['127.0.0.1', '-1'], ['127.0.0.1', '65536'],
                      ['::1', '1'], ['999.999.999.999', '1'], ['localhost', '1'], [''], ['-h'], ['--help'], ['-?']],
}


def run_args(argv_tail):
    pid, fd = start(['/tmp/tl/telnet'] + argv_tail)
    out = drain(fd, 1.0)
    stop(pid)
    return clean(out)


def main():
    only = [n for n in os.environ.get('ONLY', '').split(',') if n]
    if only and os.path.exists(sys.argv[1]):
        result = json.load(open(sys.argv[1]))
        for name in [n for n in only if n in SESSION_SCENARIOS]:
            sc = SESSION_SCENARIOS[name]
            steps = sc['steps']
            out = run_session(sc['argv'], steps, **sc['kw'])
            result['sessions'][name] = {'argv': sc['argv'], 'port': sc['kw'].get('port'), 'env': sc['kw'].get('env'), 'rc': sc['kw'].get('rc'),
                                        'steps': [[s[0], s[1].hex() if isinstance(s[1], bytes) else s[1]] for s in steps], 'result': out}
        for name in [n for n in only if n in PIPE_SCENARIOS]:
            sc = PIPE_SCENARIOS[name]
            result.setdefault('pipes', {})[name] = {'argv': sc['argv'], 'steps': [[x[0], x[1].hex() if isinstance(x[1], bytes) else x[1]] for x in sc['steps']],
                                                    'result': run_pipe(sc['argv'], sc['steps'], **sc['kw'])}
        json.dump(result, open(sys.argv[1], 'w'), indent=1)
        return
    result = {'telnet': os.path.basename(TELNET), 'commands': {}, 'sessions': {}, 'args': {}}
    for name, lines in COMMAND_SCENARIOS.items():
        result['commands'][name] = {'lines': lines, 'steps': run_commands(lines)}
    result['commands']['env-display'] = {'lines': ['display', 'environ list'], 'env': {'DISPLAY': ':0'},
                                          'steps': run_commands(['display', 'environ list'], {'DISPLAY': ':0'})}
    for name, sc in SESSION_SCENARIOS.items():
        steps = sc['steps']
        out = run_session(sc['argv'], steps, **sc['kw'])
        result['sessions'][name] = {'argv': sc['argv'], 'port': sc['kw'].get('port'), 'env': sc['kw'].get('env'), 'rc': sc['kw'].get('rc'),
                                    'steps': [[s[0], s[1].hex() if isinstance(s[1], bytes) else s[1]] for s in steps], 'result': out}
    for name, argvs in ARG_SCENARIOS.items():
        result['args'][name] = [{'argv': a, 'screen': run_args(a)} for a in argvs]
    result['pipes'] = {}
    for name, sc in PIPE_SCENARIOS.items():
        result['pipes'][name] = {'argv': sc['argv'], 'steps': [[x[0], x[1].hex() if isinstance(x[1], bytes) else x[1]] for x in sc['steps']],
                                 'result': run_pipe(sc['argv'], sc['steps'], **sc['kw'])}
    json.dump(result, open(sys.argv[1], 'w'), indent=1)


if __name__ == '__main__':
    main()
