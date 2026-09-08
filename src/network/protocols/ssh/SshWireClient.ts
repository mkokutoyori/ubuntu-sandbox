import type { TcpStream } from '@/network/tcp/types';

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

export interface SshWireStack {
  connect(ip: string, port: number): TcpStream | null;
}

export interface SshWireExecOptions {
  stack: SshWireStack;
  host: string;
  port: number;
  user: string;
  password?: string;
  command: string;
  clientVersion?: string;
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

export async function sshWireExec(opts: SshWireExecOptions): Promise<SshWireExecResult> {
  const socket = opts.stack.connect(opts.host, opts.port);
  const empty: SshWireExecResult = {
    connected: false, authenticated: false, stdout: '', stderr: '', exitCode: 255,
  };
  if (!socket) return { ...empty, error: 'connect failed' };

  if ((socket as unknown as { everEstablished?: boolean }).everEstablished !== true) {
    socket.close();
    return { ...empty, error: 'connection failed' };
  }

  const inbox = attachInbox(socket);
  const finish = (result: SshWireExecResult): SshWireExecResult => {
    inbox.dispose();
    socket.close();
    return result;
  };

  try {
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
      return finish({
        connected: true, authenticated: false, stdout: '', stderr: '', exitCode: 255,
        hostKey, serverVersion, preAuthBanner,
        error: (auth.error as string | undefined) ?? 'authentication failed',
      });
    }

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
    return finish({ ...empty, connected: true, error: e instanceof Error ? e.message : String(e) });
  }
}
