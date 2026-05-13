/**
 * End-to-end reactive SSH integration.
 *
 * Verifies that the SshServerEventBus drives all three subsystems wired
 * into LinuxSshServerContext:
 *   - SshSyslogger writes /var/log/auth.log entries
 *   - SshAuthThrottler blocks IPs after repeated failures
 *   - Extended sshd_config (DenyUsers, PermitEmptyPasswords, AllowGroups)
 *     is enforced inside the auth pipeline
 *
 * The fixture is the in-memory linked-TCP pair from ssh-sftp.test.ts so
 * the full handshake runs (hello → auth → events).
 */

import { describe, it, expect } from 'vitest';
import { TcpConnection, type TcpConnector } from '@/network/core/TcpConnection';
import { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { LinuxUserManager } from '@/network/devices/linux/LinuxUserManager';
import { LinuxSshServerContext } from '@/network/protocols/ssh/server/LinuxSshServerContext';
import { SshServerHandler } from '@/network/protocols/ssh/server/SshServerHandler';
import { SshSession } from '@/network/protocols/ssh/session/SshSession';
import { SshConnectOptionsBuilder } from '@/network/protocols/ssh/SshConnectOptions';
import { SilentSshInteractionHandler } from '@/network/protocols/ssh/session/ISshInteractionHandler';
import { isOk } from '@/network/protocols/ssh/Result';
import { parseSshdConfig, serializeSshdConfig } from '@/network/protocols/ssh/server/SshSshdConfig';
import type { SshServerEvent } from '@/network/protocols/ssh/server/SshServerEvent';

const REMOTE_IP = '10.0.0.2';
const LOCAL_IP = '10.0.0.1';

interface Server {
  vfs: VirtualFileSystem;
  ctx: LinuxSshServerContext;
  handler: SshServerHandler;
}

function makeServer(opts: {
  username?: string;
  password?: string;
  sshdConfig?: string;
  throttlerThreshold?: number;
  throttlerBlockMs?: number;
} = {}): Server {
  const {
    username = 'alice',
    password = 'secret',
    sshdConfig,
    throttlerThreshold,
    throttlerBlockMs,
  } = opts;

  const vfs = new VirtualFileSystem();
  const userManager = new LinuxUserManager(vfs);
  userManager.useradd(username, { m: true, s: '/bin/bash' });
  userManager.setPassword(username, password);

  // Pre-seed /etc/ssh/sshd_config so the context picks it up on construction.
  if (sshdConfig) {
    vfs.mkdirp('/etc/ssh', 0o755, 0, 0);
    vfs.writeFile('/etc/ssh/sshd_config', sshdConfig, 0, 0, 0o022);
  }

  const ctx = new LinuxSshServerContext(
    vfs,
    userManager,
    'sandbox-host',
    {},
    null,
    null,
    {
      throttlerThreshold: throttlerThreshold ?? 3,
      throttlerWindowMs: 60_000,
      throttlerBlockMs: throttlerBlockMs ?? 300_000,
    },
  );
  const handler = new SshServerHandler(ctx);
  return { vfs, ctx, handler };
}

function linkPair(handler: SshServerHandler): TcpConnection {
  const bridge: { server: TcpConnection | null } = { server: null };
  const client = new TcpConnection(LOCAL_IP, 49000, REMOTE_IP, 22, 100, (seg) => {
    if (seg.payload != null && bridge.server) bridge.server.receiveData(String(seg.payload));
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
    host === REMOTE_IP ? linkPair(handler) : null;
}

async function attemptLogin(
  handler: SshServerHandler,
  user: string,
  password: string,
): Promise<boolean> {
  const localVfs = new VirtualFileSystem();
  const session = new SshSession({
    tcpConnector: makeConnector(handler),
    vfs: localVfs,
    localUser: 'root',
    localUid: 0,
    localGid: 0,
    knownHostsPath: '/root/.ssh/known_hosts',
    interactionHandler: new SilentSshInteractionHandler(password),
  });
  const result = await session.connect(
    SshConnectOptionsBuilder.create()
      .host(REMOTE_IP)
      .user(user)
      .port(22)
      .password(password)
      .strictHostKeyChecking('accept-new')
      .build(),
  );
  session.disconnect();
  return isOk(result);
}

describe('SSH reactive integration — auth.log production', () => {
  it('writes Accepted password line on successful login', async () => {
    const { vfs, handler } = makeServer({ username: 'alice', password: 'secret' });
    expect(await attemptLogin(handler, 'alice', 'secret')).toBe(true);

    const log = vfs.readFile('/var/log/auth.log') ?? '';
    expect(log).toContain('Accepted password for alice from 10.0.0.1');
    expect(log).toMatch(/sshd\[\d+\]:/);
  });

  it('writes Failed password line on bad password', async () => {
    const { vfs, handler } = makeServer({ username: 'alice', password: 'secret' });
    expect(await attemptLogin(handler, 'alice', 'wrong')).toBe(false);

    const log = vfs.readFile('/var/log/auth.log') ?? '';
    expect(log).toContain('Failed password for alice from 10.0.0.1');
  });

  it('writes Invalid user line for unknown users', async () => {
    const { vfs, handler } = makeServer({ username: 'alice' });
    expect(await attemptLogin(handler, 'ghost', 'whatever')).toBe(false);

    const log = vfs.readFile('/var/log/auth.log') ?? '';
    expect(log).toContain('Invalid user ghost from 10.0.0.1');
  });
});

describe('SSH reactive integration — auth throttler', () => {
  it('blocks the IP after the configured threshold of failures', async () => {
    const { handler, ctx } = makeServer({
      username: 'alice',
      password: 'secret',
      throttlerThreshold: 3,
    });

    expect(await attemptLogin(handler, 'alice', 'bad1')).toBe(false);
    expect(await attemptLogin(handler, 'alice', 'bad2')).toBe(false);
    expect(await attemptLogin(handler, 'alice', 'bad3')).toBe(false);

    expect(ctx.isClientBlocked(LOCAL_IP)).toBe(true);

    // Even the correct password is refused once throttled.
    expect(await attemptLogin(handler, 'alice', 'secret')).toBe(false);
  });

  it('emits auth_throttled on the bus when blocking', async () => {
    const { handler, ctx } = makeServer({
      username: 'alice',
      password: 'secret',
      throttlerThreshold: 3,
    });

    const events: SshServerEvent[] = [];
    ctx.events.on('auth_throttled', (e) => events.push(e));

    for (let i = 0; i < 3; i++) await attemptLogin(handler, 'alice', 'wrong');

    expect(events.length).toBe(1);
    const e = events[0] as Extract<SshServerEvent, { kind: 'auth_throttled' }>;
    expect(e.ip).toBe(LOCAL_IP);
    expect(e.failuresInWindow).toBeGreaterThanOrEqual(3);
  });

  it('throttling is logged in auth.log', async () => {
    const { vfs, handler } = makeServer({
      username: 'alice',
      password: 'secret',
      throttlerThreshold: 3,
    });

    for (let i = 0; i < 3; i++) await attemptLogin(handler, 'alice', 'wrong');

    const log = vfs.readFile('/var/log/auth.log') ?? '';
    expect(log).toContain('Refusing connection from 10.0.0.1');
    expect(log).toContain('authentication failures');
  });
});

describe('SSH reactive integration — sshd_config enforcement', () => {
  it('rejects users in DenyUsers regardless of password', async () => {
    const cfg = serializeSshdConfig(parseSshdConfig('DenyUsers alice\nPermitRootLogin yes\n'));
    const { handler, vfs } = makeServer({
      username: 'alice',
      password: 'secret',
      sshdConfig: cfg,
    });
    expect(await attemptLogin(handler, 'alice', 'secret')).toBe(false);
    expect(vfs.readFile('/var/log/auth.log') ?? '').toContain('Failed');
  });

  it('rejects empty passwords when PermitEmptyPasswords is off', async () => {
    const { handler, vfs } = makeServer({
      username: 'alice',
      password: '',
      // High threshold so the inner password-auth retries don't throttle.
      throttlerThreshold: 100,
    });
    // sshd_config defaults to PermitEmptyPasswords=no
    expect(await attemptLogin(handler, 'alice', '')).toBe(false);
    const log = vfs.readFile('/var/log/auth.log') ?? '';
    expect(log).toContain('Failed password for alice');
  });

  it('accepts empty passwords when PermitEmptyPasswords yes is set', async () => {
    const cfg = serializeSshdConfig(
      parseSshdConfig('PermitEmptyPasswords yes\nPermitRootLogin yes\n'),
    );
    const { handler } = makeServer({
      username: 'alice',
      password: '',
      sshdConfig: cfg,
    });
    expect(await attemptLogin(handler, 'alice', '')).toBe(true);
  });

  it('AllowUsers restricts to listed principals only', async () => {
    const cfg = serializeSshdConfig(
      parseSshdConfig('AllowUsers bob\nPermitRootLogin yes\n'),
    );
    const { handler } = makeServer({
      username: 'alice',
      password: 'secret',
      sshdConfig: cfg,
    });
    expect(await attemptLogin(handler, 'alice', 'secret')).toBe(false);
  });
});

describe('SSH reactive integration — event bus richness', () => {
  it('emits client_connected, auth_invalid_user, auth_failure for a ghost user', async () => {
    const { handler, ctx } = makeServer({ username: 'alice' });
    const events: SshServerEvent[] = [];
    ctx.events.on('*', (e) => events.push(e));

    await attemptLogin(handler, 'ghost', 'whatever');

    expect(events.some((e) => e.kind === 'client_connected')).toBe(true);
    expect(events.some((e) => e.kind === 'auth_invalid_user')).toBe(true);
    expect(events.some((e) => e.kind === 'auth_failure')).toBe(true);
  });

  it('auth_failure events carry the method field', async () => {
    const { handler, ctx } = makeServer({ username: 'alice', password: 'secret' });
    const failures: SshServerEvent[] = [];
    ctx.events.on('auth_failure', (e) => failures.push(e));

    await attemptLogin(handler, 'alice', 'wrong');

    const e = failures[0] as Extract<SshServerEvent, { kind: 'auth_failure' }>;
    expect(e.method).toBe('password');
    expect(e.reason).toBe('wrong_password');
  });

  it('emits channel_opened and channel_closed for an exec channel', async () => {
    const { handler, ctx } = makeServer({ username: 'alice', password: 'secret' });
    const events: SshServerEvent[] = [];
    ctx.events.on('*', (e) => events.push(e));

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
    await session.connect(
      SshConnectOptionsBuilder.create()
        .host(REMOTE_IP)
        .user('alice')
        .port(22)
        .password('secret')
        .strictHostKeyChecking('accept-new')
        .build(),
    );
    const ch = session.openExecChannel('echo hi');
    if (isOk(ch)) {
      await ch.value.execute();
      ch.value.close();
    }
    session.disconnect();

    expect(events.some((e) => e.kind === 'channel_opened')).toBe(true);
    expect(events.some((e) => e.kind === 'channel_closed')).toBe(true);
  });
});

describe('SSH reactive integration — shutdown', () => {
  it('detaches reactive subscribers on context.shutdown()', async () => {
    const { vfs, ctx, handler } = makeServer({ username: 'alice', password: 'secret' });
    await attemptLogin(handler, 'alice', 'secret');
    const logBefore = vfs.readFile('/var/log/auth.log') ?? '';
    expect(logBefore).toContain('Accepted');

    ctx.shutdown();
    // Emit a synthetic event directly — without subscribers, log must not grow.
    ctx.events.emit({
      kind: 'auth_success',
      user: 'bob',
      method: 'password',
      ip: '9.9.9.9',
    });
    const logAfter = vfs.readFile('/var/log/auth.log') ?? '';
    expect(logAfter).toBe(logBefore);
  });
});
