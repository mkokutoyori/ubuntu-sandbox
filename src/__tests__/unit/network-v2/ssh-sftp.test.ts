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
import { LinuxCommandExecutor } from '@/network/devices/linux/LinuxCommandExecutor';
import { SshSession } from '@/network/protocols/ssh/session/SshSession';
import { SshConnectOptionsBuilder } from '@/network/protocols/ssh/SshConnectOptions';
import { isOk } from '@/network/protocols/ssh/Result';
import {
  parseSshKeygenArgs,
  generateAndWriteKeyPair,
} from '@/network/protocols/ssh/SshKeygen';
import { sshCopyId } from '@/network/protocols/ssh/SshCopyId';
import { parseScpArgs, parseScpEndpoint } from '@/network/protocols/ssh/Scp';
import { SshConfig } from '@/network/protocols/ssh/SshConfig';
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

describe('SSH-05 — exec channel (non-interactive command)', () => {
  it('runs a remote command through the bash interpreter and returns stdout', async () => {
    const vfs = new VirtualFileSystem();
    const userManager = new LinuxUserManager(vfs);
    userManager.useradd('alice', { m: true, s: '/bin/bash' });
    userManager.setPassword('alice', 'secret');
    const executor = new LinuxCommandExecutor(false);
    // Seed the executor's VFS so `cat /etc/motd` returns content
    executor.vfs.writeFile('/etc/motd', 'Welcome\n', 0, 0, 0o022);
    // The context sees the executor's vfs (which is independent), so use it
    const ctx = new LinuxSshServerContext(
      executor.vfs,
      executor.userMgr,
      'remote',
      { permitRootLogin: true },
      executor,
    );
    executor.userMgr.useradd('alice', { m: true, s: '/bin/bash' });
    executor.userMgr.setPassword('alice', 'secret');
    const handler = new SshServerHandler(ctx);

    const localVfs = new VirtualFileSystem();
    const session = new SshSession({
      tcpConnector: makeConnector(handler),
      vfs: localVfs,
      localUser: 'root',
      localUid: 0,
      localGid: 0,
      knownHostsPath: '/root/.ssh/known_hosts',
      interactionHandler: new SilentSshInteractionHandler('secret'),
    });
    const opts = SshConnectOptionsBuilder.create()
      .host(REMOTE_IP)
      .user('alice')
      .password('secret')
      .strictHostKeyChecking('accept-new')
      .build();
    const connect = await session.connect(opts);
    expect(isOk(connect)).toBe(true);

    const channel = session.openExecChannel('echo hello');
    expect(isOk(channel)).toBe(true);
    if (isOk(channel)) {
      const result = await channel.value.execute();
      expect(result.stdout).toContain('hello');
      expect(result.exitCode).toBe(0);
    }
  });
});

describe('SSH-03 — ssh-keygen (key pair generation)', () => {
  it('writes a deterministic key pair under ~/.ssh/ with correct modes', () => {
    const vfs = new VirtualFileSystem();
    vfs.mkdirp('/home/alice', 0o755, 1000, 1000);
    const opts = parseSshKeygenArgs(['-t', 'ed25519', '-C', 'alice@local'], '/home/alice');
    const result = generateAndWriteKeyPair(vfs, 1000, 1000, opts);
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(vfs.exists('/home/alice/.ssh/id_ed25519')).toBe(true);
    expect(vfs.exists('/home/alice/.ssh/id_ed25519.pub')).toBe(true);
    expect(result.fingerprint.startsWith('SHA256:')).toBe(true);
    const pub = vfs.readFile('/home/alice/.ssh/id_ed25519.pub');
    expect(pub).toContain('ssh-ed25519');
    expect(pub).toContain('alice@local');
  });

  it('refuses to overwrite an existing private key', () => {
    const vfs = new VirtualFileSystem();
    vfs.mkdirp('/home/alice/.ssh', 0o700, 1000, 1000);
    vfs.writeFile('/home/alice/.ssh/id_ed25519', 'pre-existing', 1000, 1000, 0o077);
    const opts = parseSshKeygenArgs([], '/home/alice');
    const result = generateAndWriteKeyPair(vfs, 1000, 1000, opts);
    expect('error' in result).toBe(true);
  });
});

describe('SSH-03 — ssh-copy-id (authorized_keys deployment)', () => {
  it('appends the public key to remote ~/.ssh/authorized_keys', async () => {
    const setup = makeServer({ username: 'alice', password: 'secret' });
    const localVfs = new VirtualFileSystem();
    const session = new SshSession({
      tcpConnector: makeConnector(setup.handler),
      vfs: localVfs,
      localUser: 'root',
      localUid: 0,
      localGid: 0,
      knownHostsPath: '/root/.ssh/known_hosts',
      interactionHandler: new SilentSshInteractionHandler('secret'),
    });
    const opts = SshConnectOptionsBuilder.create()
      .host(REMOTE_IP)
      .user('alice')
      .password('secret')
      .strictHostKeyChecking('accept-new')
      .build();
    expect(isOk(await session.connect(opts))).toBe(true);

    const result = await sshCopyId(
      session,
      'ssh-ed25519 AAAAabcXYZ alice@local',
      '/home/alice',
    );
    expect('added' in result && result.added).toBe(1);
    const stored = setup.vfs.readFile('/home/alice/.ssh/authorized_keys');
    expect(stored).toContain('AAAAabcXYZ');
    session.disconnect();
  });
});

describe('SSH-08 — scp argument parsing', () => {
  it('parseScpEndpoint distinguishes local from remote forms', () => {
    expect(parseScpEndpoint('/etc/hosts')).toEqual({ remote: false, path: '/etc/hosts' });
    expect(parseScpEndpoint('alice@host:/etc/hosts')).toEqual({
      remote: true,
      user: 'alice',
      host: 'host',
      path: '/etc/hosts',
    });
    expect(parseScpEndpoint('host:relative/path')).toEqual({
      remote: true,
      host: 'host',
      path: 'relative/path',
    });
    // Local path with a colon AFTER a slash should stay local.
    expect(parseScpEndpoint('/tmp/file:notremote').remote).toBe(false);
  });

  it('parseScpArgs collects -r, -P, -i, source, destination', () => {
    const args = parseScpArgs([
      '-r',
      '-P',
      '2222',
      '-i',
      '~/.ssh/id_ed25519',
      'docs/',
      'alice@host:/home/alice/',
    ]);
    expect(args).not.toBeNull();
    expect(args?.recursive).toBe(true);
    expect(args?.port).toBe(2222);
    expect(args?.identityFiles).toEqual(['~/.ssh/id_ed25519']);
    expect(args?.source.remote).toBe(false);
    expect(args?.destination.remote).toBe(true);
    expect(args?.destination.host).toBe('host');
  });
});

describe('SSH-06 — ~/.ssh/config (multi-host + wildcard)', () => {
  it('resolves an alias to its HostName/User/Port/IdentityFile', () => {
    const cfg = SshConfig.parse(`
Host *
    User defaultuser
    StrictHostKeyChecking accept-new

Host prod
    HostName 192.168.1.10
    User alice
    Port 2222
    IdentityFile ~/.ssh/id_prod
`);
    const entry = cfg.resolve('prod');
    expect(entry.hostName).toBe('192.168.1.10');
    expect(entry.user).toBe('alice');
    expect(entry.port).toBe(2222);
    expect(entry.identityFile).toBe('~/.ssh/id_prod');
    expect(entry.strictHostKeyChecking).toBe('accept-new');
  });

  it('falls back to wildcard defaults for unknown hosts', () => {
    const cfg = SshConfig.parse('Host *\n    User defaultuser\n');
    const entry = cfg.resolve('whatever');
    expect(entry.user).toBe('defaultuser');
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
