import type { TcpStream } from '@/network/tcp/types';
import { SshSftpChannel } from './channels/SshSftpChannel';

export const SSH_CLIENT_IDENTIFICATION = 'SSH-2.0-OpenSSH_9.6';

export interface SshWireHostKey {
  algorithm: string;
  publicKey: string;
}

export interface SshWireExecResult {
  connected: boolean;
  authenticated: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  hostKey?: SshWireHostKey;
  serverVersion?: string;
  preAuthBanner?: string;
  error?: string;
}

export interface SshWireTransferResult {
  connected: boolean;
  authenticated: boolean;
  ok: boolean;
  content?: string;
  error?: string;
}

export interface SshWireStack {
  connect(ip: string, port: number): TcpStream | null;
}

export interface SshWireAuthOptions {
  stack: SshWireStack;
  host: string;
  port: number;
  user: string;
  password?: string;
  clientVersion?: string;
}

export interface SshWireExecOptions extends SshWireAuthOptions {
  command: string;
}

interface Inbox {
  next(): Promise<Record<string, unknown>>;
  dispose(): void;
}

function attachInbox(socket: TcpStream): Inbox {
  const queue: Record<string, unknown>[] = [];
  const waiters: Array<(msg: Record<string, unknown>) => void> = [];
  const off = socket.onData((data) => {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }
    const waiter = waiters.shift();
    if (waiter) waiter(parsed);
    else queue.push(parsed);
  });
  return {
    next: () =>
      new Promise<Record<string, unknown>>((resolve) => {
        const ready = queue.shift();
        if (ready) resolve(ready);
        else waiters.push(resolve);
      }),
    dispose: off,
  };
}

type Session =
  | { ok: true; socket: TcpStream; inbox: Inbox; hostKey?: SshWireHostKey; serverVersion?: string; preAuthBanner?: string }
  | { ok: false; connected: boolean; authenticated: boolean; error: string; hostKey?: SshWireHostKey; serverVersion?: string; preAuthBanner?: string };

async function connectAndAuth(opts: SshWireAuthOptions): Promise<Session> {
  const socket = opts.stack.connect(opts.host, opts.port);
  if (!socket) return { ok: false, connected: false, authenticated: false, error: 'connect failed' };
  if ((socket as unknown as { everEstablished?: boolean }).everEstablished !== true) {
    socket.close();
    return { ok: false, connected: false, authenticated: false, error: 'connection failed' };
  }

  const inbox = attachInbox(socket);
  socket.write(JSON.stringify({
    op: 'hello',
    clientVersion: opts.clientVersion ?? SSH_CLIENT_IDENTIFICATION,
  }));
  const hello = await inbox.next();
  const hostKey = hello.hostKey as SshWireHostKey | undefined;
  const serverVersion = hello.serverVersion as string | undefined;
  const preAuthBanner = hello.preAuthBanner as string | undefined;

  socket.write(JSON.stringify({
    op: 'auth', user: opts.user, method: 'password', password: opts.password ?? '',
  }));
  const auth = await inbox.next();
  if (auth.ok !== true) {
    inbox.dispose();
    socket.close();
    return {
      ok: false, connected: true, authenticated: false,
      error: (auth.error as string | undefined) ?? 'authentication failed',
      hostKey, serverVersion, preAuthBanner,
    };
  }
  return { ok: true, socket, inbox, hostKey, serverVersion, preAuthBanner };
}

export async function sshWireExec(opts: SshWireExecOptions): Promise<SshWireExecResult> {
  const session = await connectAndAuth(opts);
  if (!session.ok) {
    return {
      connected: session.connected, authenticated: session.authenticated,
      stdout: '', stderr: '', exitCode: 255, error: session.error,
      hostKey: session.hostKey, serverVersion: session.serverVersion, preAuthBanner: session.preAuthBanner,
    };
  }

  const { socket, inbox, hostKey, serverVersion, preAuthBanner } = session;
  const finish = (result: SshWireExecResult): SshWireExecResult => {
    inbox.dispose();
    socket.close();
    return result;
  };

  try {
    const channelId = 0;
    socket.write(JSON.stringify({ op: 'open_channel', channelType: 'exec', channelId }));
    const opened = await inbox.next();
    if (opened.ok !== true) {
      return finish({
        connected: true, authenticated: true, stdout: '', stderr: '', exitCode: 255,
        hostKey, serverVersion, preAuthBanner,
        error: (opened.error as string | undefined) ?? 'channel open failed',
      });
    }

    socket.write(JSON.stringify({ op: 'exec', command: opts.command, channelId }));
    const result = await inbox.next();
    socket.write(JSON.stringify({ op: 'close_channel', channelId }));

    return finish({
      connected: true, authenticated: true,
      stdout: (result.stdout as string | undefined) ?? '',
      stderr: (result.stderr as string | undefined) ?? '',
      exitCode: (result.exitCode as number | undefined) ?? 0,
      hostKey, serverVersion, preAuthBanner,
    });
  } catch (e) {
    return finish({
      connected: true, authenticated: true, stdout: '', stderr: '', exitCode: 255,
      hostKey, serverVersion, preAuthBanner, error: e instanceof Error ? e.message : String(e),
    });
  }
}

async function sshWireSftp(
  opts: SshWireAuthOptions,
  drive: (channel: SshSftpChannel) => SshWireTransferResult,
): Promise<SshWireTransferResult> {
  const session = await connectAndAuth(opts);
  if (!session.ok) {
    return { connected: session.connected, authenticated: session.authenticated, ok: false, error: session.error };
  }
  const { socket, inbox } = session;
  inbox.dispose();
  const channel = new SshSftpChannel(socket, 0);
  try {
    channel.open();
    return drive(channel);
  } catch (e) {
    return { connected: true, authenticated: true, ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    channel.close();
    socket.close();
  }
}

export function sshWireSftpPut(
  opts: SshWireAuthOptions & { remotePath: string; content: string },
): Promise<SshWireTransferResult> {
  return sshWireSftp(opts, (channel) => {
    const reply = channel.sendRequest({ op: 'put', path: opts.remotePath, content: opts.content });
    return { connected: true, authenticated: true, ok: reply.ok === true, error: reply.error as string | undefined };
  });
}

export function sshWireSftpGet(
  opts: SshWireAuthOptions & { remotePath: string },
): Promise<SshWireTransferResult> {
  return sshWireSftp(opts, (channel) => {
    const reply = channel.sendRequest({ op: 'get', path: opts.remotePath });
    return {
      connected: true, authenticated: true, ok: reply.ok === true,
      content: reply.content as string | undefined, error: reply.error as string | undefined,
    };
  });
}
