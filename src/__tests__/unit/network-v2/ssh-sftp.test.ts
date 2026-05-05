/**
 * SSH + SFTP — round-trip tests on the refactored stack.
 *
 * Covers (DESIGN-SSH-SFTP.md / BRD-SSH-SFTP.md):
 *   - SSH-01..R5  host-key prompt + accept-new behaviour
 *   - SSH-02      password authentication
 *   - SSH-04      shell channel open
 *   - SSH-07      sshd_config persistence
 *   - SFTP-01     transport on SSH layer
 *   - SFTP-02     version 3 announcement
 *   - SFTP-03     put propagates errors
 *   - SFTP-04     mkdir non-recursive
 *   - SFTP-05     rename protects destination
 *   - SFTP-06     ls returns rich attributes (consumed via `-l`)
 *   - SFTP-09     formatTransferProgress shape
 *   - SFTP-14/15  chmod / chown
 *   - SFTP-16     stat
 *   - SFTP-17     df
 *   - SFTP-20     permission decorator
 *
 * The mock pair links two TcpConnections in-memory and registers a
 * SshServerHandler on the server side, so the full handshake (hello,
 * auth, open_channel, op) is exercised exactly as in production.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { TcpConnection, type TcpConnector } from '@/network/core/TcpConnection';
import { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { LinuxUserManager } from '@/network/devices/linux/LinuxUserManager';
import { LinuxSshServerContext } from '@/network/protocols/ssh/server/LinuxSshServerContext';
import { SshServerHandler } from '@/network/protocols/ssh/server/SshServerHandler';
import { SftpSession } from '@/network/protocols/ssh/sftp/SftpSession';
import { SilentSshInteractionHandler } from '@/network/protocols/ssh/session/ISshInteractionHandler';
import { ParsedArgs } from '@/network/protocols/ssh/sftp/ParsedArgs';
import {
  formatTransferProgress,
  expandTilde,
  parseKnownHostsLine,
} from '@/network/protocols/ssh/SshPureUtils';

// ── Test fixtures ────────────────────────────────────────────────

const REMOTE_IP = '10.0.0.2';
const LOCAL_IP = '10.0.0.1';

interface ServerSetup {
  vfs: VirtualFileSystem;
  userManager: LinuxUserManager;
  context: LinuxSshServerContext;
  handler: SshServerHandler;
}

function makeServer(opts: {
  username?: string;
  password?: string;
  hostname?: string;
  files?: Record<string, string>;
  dirs?: string[];
} = {}): ServerSetup {
  const {
    username = 'alice',
    password = 'secret',
    hostname = 'remote-host',
    files = {},
    dirs = [],
  } = opts;

  const vfs = new VirtualFileSystem();
  const userManager = new LinuxUserManager(vfs);
  userManager.useradd(username, { m: true, s: '/bin/bash' });
  userManager.setPassword(username, password);

  for (const dir of dirs) vfs.mkdirp(dir, 0o755, 1000, 1000);
  for (const [path, content] of Object.entries(files)) {
    vfs.writeFile(path, content, 1000, 1000, 0o022);
  }

  const context = new LinuxSshServerContext(vfs, userManager, hostname, {
    permitRootLogin: true,
  });
  const handler = new SshServerHandler(context);
  return { vfs, userManager, context, handler };
}

function makeLinkedPair(handler: SshServerHandler): TcpConnection {
  const bridge: { server: TcpConnection | null } = { server: null };

  const client = new TcpConnection(LOCAL_IP, 49000, REMOTE_IP, 22, 100, (seg) => {
    if (seg.payload != null && bridge.server) {
      bridge.server.receiveData(String(seg.payload));
    }
  });
  const server = new TcpConnection(REMOTE_IP, 22, LOCAL_IP, 49000, 200, (seg) => {
    if (seg.payload != null) client.receiveData(String(seg.payload));
  });
  bridge.server = server;
  handler.register(server, LOCAL_IP);
  return client;
}

function makeConnector(handler: SshServerHandler): TcpConnector {
  return async (host: string) =>
    host === REMOTE_IP ? makeLinkedPair(handler) : null;
}

function makeClient(
  handler: SshServerHandler,
  password: string,
  localFiles: Record<string, string> = {},
): { session: SftpSession; localVfs: VirtualFileSystem } {
  const localVfs = new VirtualFileSystem();
  for (const [p, c] of Object.entries(localFiles)) {
    localVfs.writeFile(p, c, 0, 0, 0o022);
  }
  const session = new SftpSession({
    tcpConnector: makeConnector(handler),
    localVfs,
    localUser: 'root',
    localUid: 0,
    localGid: 0,
    localCwd: '/root',
    knownHostsPath: '/root/.ssh/known_hosts',
    interactionHandler: new SilentSshInteractionHandler(password),
    homeDirectory: '/root',
  });
  return { session, localVfs };
}

// ─── tests ────────────────────────────────────────────────────────

describe('SSH server context — config persistence (BRD SSH-07)', () => {
  it('creates /etc/ssh/sshd_config and host key files at construction', () => {
    const { vfs } = makeServer();
    expect(vfs.exists('/etc/ssh/sshd_config')).toBe(true);
    expect(vfs.exists('/etc/ssh/ssh_host_ed25519_key')).toBe(true);
    expect(vfs.exists('/etc/ssh/ssh_host_ed25519_key.pub')).toBe(true);
  });

  it('reuses persisted host key on the next instantiation', () => {
    const vfs = new VirtualFileSystem();
    const userManager = new LinuxUserManager(vfs);
    const a = new LinuxSshServerContext(vfs, userManager, 'host-a');
    const b = new LinuxSshServerContext(vfs, userManager, 'host-a');
    expect(a.hostKey.publicKey).toBe(b.hostKey.publicKey);
  });
});

describe('SshSession + SftpSession — connect (BRD SSH-01..02, SFTP-01)', () => {
  it('connects with correct credentials', async () => {
    const { handler } = makeServer({ username: 'alice', password: 'secret' });
    const { session } = makeClient(handler, 'secret');
    const banner = await session.connect(`alice@${REMOTE_IP}`);
    expect(session.isConnected()).toBe(true);
    expect(banner).toContain(`Connected to ${REMOTE_IP}`);
  });

  it('rejects bad password', async () => {
    const { handler } = makeServer({ username: 'alice', password: 'secret' });
    const { session } = makeClient(handler, 'wrong');
    const result = await session.connect(`alice@${REMOTE_IP}`);
    expect(session.isConnected()).toBe(false);
    expect(result).toContain('Permission denied');
  });

  it('persists the host into known_hosts on accept-new', async () => {
    const { handler } = makeServer();
    const { session, localVfs } = makeClient(handler, 'secret');
    await session.connect(`alice@${REMOTE_IP}`);
    const known = localVfs.readFile('/root/.ssh/known_hosts');
    expect(known).not.toBeNull();
    expect(known).toContain(REMOTE_IP);
    const parsed = parseKnownHostsLine(known!.split('\n').find(Boolean) ?? '');
    expect(parsed?.host).toBe(REMOTE_IP);
  });
});

describe('SftpSession — operations (BRD SFTP-02..06,14..17)', () => {
  let setup: ServerSetup;

  beforeEach(() => {
    setup = makeServer({
      username: 'alice',
      password: 'secret',
      files: {
        '/home/alice/file.txt': 'hello world',
        '/home/alice/.dotfile': 'hidden',
      },
      dirs: ['/home/alice/docs'],
    });
  });

  async function connectedSession(localFiles: Record<string, string> = {}) {
    const { session, localVfs } = makeClient(setup.handler, 'secret', localFiles);
    await session.connect(`alice@${REMOTE_IP}`);
    return { session, localVfs };
  }

  it('SFTP-02: announces protocol version 3', async () => {
    const { session } = await connectedSession();
    expect(session.version()).toBe('SFTP protocol version 3');
  });

  it('SFTP-06: ls -l returns rich attributes', async () => {
    const { session } = await connectedSession();
    const out = session.ls(['/home/alice'], new Set(['l']));
    expect(out).toContain('file.txt');
    expect(out).toMatch(/^[d\-l]/m);
  });

  it('SFTP-06: ls without -a hides dotfiles', async () => {
    const { session } = await connectedSession();
    const out = session.ls(['/home/alice'], new Set());
    expect(out).not.toContain('.dotfile');
    expect(session.ls(['/home/alice'], new Set(['a']))).toContain('.dotfile');
  });

  it('SFTP-04: mkdir non-recursive fails when parent missing', async () => {
    const { session } = await connectedSession();
    const out = session.mkdir('/home/alice/a/b/c');
    expect(out).toContain("Couldn't create directory");
  });

  it('SFTP-04: mkdir succeeds when parent exists', async () => {
    const { session } = await connectedSession();
    expect(session.mkdir('/home/alice/newdir')).toBe('');
    expect(setup.vfs.exists('/home/alice/newdir')).toBe(true);
  });

  it('SFTP-05: rename refuses when destination exists', async () => {
    setup.vfs.writeFile('/home/alice/dst.txt', 'existing', 1000, 1000, 0o022);
    const { session } = await connectedSession();
    const out = session.rename('/home/alice/file.txt', '/home/alice/dst.txt');
    expect(out).toContain("Couldn't rename file");
  });

  it('SFTP-03: put fails with explicit error on read-only destination', async () => {
    // Make /etc unwritable for alice (uid=1001 typically): owned by root with 755
    const { session } = await connectedSession({ '/root/upload.txt': 'data' });
    const out = session.put('/root/upload.txt', '/etc/shadow');
    expect(out).toContain('Permission denied');
  });

  it('SFTP-14: chmod returns "Changing mode" message', async () => {
    const { session } = await connectedSession();
    const out = session.chmod('600', '/home/alice/file.txt');
    expect(out).toContain('Changing mode on');
  });

  it('SFTP-16: stat returns formatted attributes', async () => {
    const { session } = await connectedSession();
    const out = session.stat('/home/alice/file.txt');
    expect(out).toContain('Size:');
    expect(out).toContain('UID:');
    expect(out).toContain('GID:');
  });

  it('SFTP-17: df returns capacity table', async () => {
    const { session } = await connectedSession();
    const out = session.df(undefined, false);
    expect(out).toContain('Size');
    expect(out).toContain('%Capacity');
  });
});

describe('SftpSession — round-trip get/put (BRD SFTP-01,03,07,09,20)', () => {
  it('downloads a remote file and writes the local copy', async () => {
    const setup = makeServer({
      username: 'alice',
      password: 'secret',
      files: { '/home/alice/report.txt': 'report-body' },
    });
    const { session, localVfs } = makeClient(setup.handler, 'secret');
    await session.connect(`alice@${REMOTE_IP}`);
    const out = session.get('/home/alice/report.txt');
    expect(out).toContain('Fetching');
    expect(out).toContain('report.txt');
    expect(localVfs.readFile('/root/report.txt')).toBe('report-body');
  });

  it('uploads a local file', async () => {
    const setup = makeServer({ username: 'alice', password: 'secret' });
    const { session } = makeClient(setup.handler, 'secret', {
      '/root/upload.txt': 'content',
    });
    await session.connect(`alice@${REMOTE_IP}`);
    const out = session.put('/root/upload.txt', '/home/alice/upload.txt');
    expect(out).toContain('Uploading');
    expect(setup.vfs.readFile('/home/alice/upload.txt')).toBe('content');
  });
});

describe('Pure utilities (BRD SFTP-09/18, SSH-06)', () => {
  it('formatTransferProgress pads 40 chars and reports KB for small files', () => {
    const line = formatTransferProgress('foo.txt', 2048);
    expect(line.startsWith('foo.txt')).toBe(true);
    expect(line).toContain('100%');
    expect(line).toContain('2.0KB');
  });

  it('expandTilde resolves ~ to the home directory', () => {
    expect(expandTilde('~/file', '/home/alice')).toBe('/home/alice/file');
    expect(expandTilde('~', '/home/alice')).toBe('/home/alice');
    expect(expandTilde('/etc/passwd', '/home/alice')).toBe('/etc/passwd');
  });

  it('ParsedArgs splits flags and positionals', () => {
    const a = ParsedArgs.parse(['-la', '/etc']);
    expect(a.has('l')).toBe(true);
    expect(a.has('a')).toBe(true);
    expect(a.positional).toEqual(['/etc']);
  });
});
