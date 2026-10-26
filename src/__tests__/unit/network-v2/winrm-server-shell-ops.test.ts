import { describe, it, expect } from 'vitest';
import { WinRmServerHandler, type WinRmIdentity, type WinRmServerContext } from '@/network/devices/windows/server/winrm/WinRmServer';
import type { WinRmShellHost, WinRmShellReply, WinRmShellCompletion } from '@/network/devices/windows/server/winrm/WinRmShell';
import type { TcpStream } from '@/network/tcp/types';
import type { WindowsUserManager } from '@/network/devices/windows/WindowsUserManager';

class FakeStream implements TcpStream {
  readonly localIp = '10.0.0.1';
  readonly localPort = 5985;
  readonly remoteIp = '10.0.0.2';
  readonly remotePort = 49152;
  readonly sent: Array<Record<string, unknown>> = [];
  private readonly dataHandlers: Array<(data: string) => void> = [];
  private readonly closeHandlers: Array<(reason: string) => void> = [];

  write(data: string): void { this.sent.push(JSON.parse(data) as Record<string, unknown>); }
  close(): void { this.drop('local'); }
  onData(handler: (data: string) => void): () => void {
    this.dataHandlers.push(handler);
    return () => undefined;
  }
  onClose(handler: (reason: string) => void): () => void {
    this.closeHandlers.push(handler);
    return () => undefined;
  }

  receive(text: string): void { for (const handler of this.dataHandlers) handler(text); }
  send(message: Record<string, unknown>): void { this.receive(JSON.stringify(message)); }
  drop(reason = 'reset'): void { for (const handler of this.closeHandlers) handler(reason); }
  get last(): Record<string, unknown> { return this.sent[this.sent.length - 1]; }
}

class RecordingHost implements WinRmShellHost {
  readonly lines: string[] = [];
  closed = 0;
  constructor(private readonly answer: (line: string) => Promise<WinRmShellReply> = async line => ({ output: `ran ${line}`, prompt: 'PS> ', ended: false })) {}
  readonly completed: string[] = [];
  prompt(): string { return 'PS first> '; }
  complete(line: string): WinRmShellCompletion {
    this.completed.push(line);
    return { candidates: [`${line}One`, `${line}Two`], start: line.length };
  }
  run(line: string): Promise<WinRmShellReply> {
    this.lines.push(line);
    return this.answer(line);
  }
  close(): void { this.closed++; }
}

const users = {
  getUser: (name: string) => ({ enabled: name !== 'disabled' }),
  checkPassword: (_name: string, password: string) => password === 'secret',
} as unknown as WindowsUserManager;

interface Rig {
  readonly stream: FakeStream;
  readonly opened: WinRmIdentity[];
  readonly hosts: RecordingHost[];
}

function rig(overrides: Partial<WinRmServerContext> & { refuse?: boolean } = {}): Rig {
  const stream = new FakeStream();
  const opened: WinRmIdentity[] = [];
  const hosts: RecordingHost[] = [];
  const { refuse, ...context } = overrides;
  new WinRmServerHandler({
    userMgr: users,
    openShell: (identity) => {
      opened.push(identity);
      if (refuse) return null;
      const host = new RecordingHost();
      hosts.push(host);
      return host;
    },
    ...context,
  }).register(stream);
  return { stream, opened, hosts };
}

const login = (stream: FakeStream, username = 'admin'): void => stream.send({ op: 'auth', username, password: 'secret' });
const settle = async (): Promise<void> => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

describe('WinRM shell_open', () => {
  it('is refused before the client has authenticated', () => {
    const { stream, opened } = rig();
    stream.send({ op: 'shell_open' });
    expect(stream.last).toEqual({ ok: false, message: 'Access is denied.' });
    expect(opened).toEqual([]);
  });

  it('is refused by a server that offers no shell service', () => {
    const stream = new FakeStream();
    new WinRmServerHandler({ userMgr: users }).register(stream);
    login(stream);
    stream.send({ op: 'shell_open' });
    expect(stream.last).toEqual({ ok: false, message: 'The WinRM shell service is not available on this computer.' });
  });

  it('opens the shell for the authenticated identity and answers with its prompt', () => {
    const { stream, opened } = rig();
    login(stream, 'DOMAIN\\admin');
    stream.send({ op: 'shell_open' });
    expect(stream.last).toEqual({ ok: true, prompt: 'PS first> ' });
    expect(opened).toEqual([{ sam: 'admin', viaDomain: false }]);
  });

  it('is denied when the machine refuses the identity', () => {
    const { stream } = rig({ refuse: true });
    login(stream);
    stream.send({ op: 'shell_open' });
    expect(stream.last).toEqual({ ok: false, message: 'Access is denied.' });
  });

  it('closes the shell it replaces when it is asked twice', () => {
    const { stream, hosts } = rig();
    login(stream);
    stream.send({ op: 'shell_open' });
    stream.send({ op: 'shell_open' });
    expect(hosts).toHaveLength(2);
    expect(hosts[0].closed).toBe(1);
    expect(hosts[1].closed).toBe(0);
  });
});

describe('WinRM shell_run', () => {
  it('is refused while no shell is open', () => {
    const { stream } = rig();
    login(stream);
    stream.send({ op: 'shell_run', line: 'hostname' });
    expect(stream.last).toEqual({ ok: false, message: 'The WinRM shell is not open.' });
  });

  it('hands the line to the shell and answers with its output, prompt and end flag', async () => {
    const { stream, hosts } = rig();
    login(stream);
    stream.send({ op: 'shell_open' });
    stream.send({ op: 'shell_run', line: 'hostname' });
    await settle();
    expect(hosts[0].lines).toEqual(['hostname']);
    expect(stream.last).toEqual({ ok: true, output: 'ran hostname', prompt: 'PS> ', ended: false });
  });

  it('runs an empty line when none is given', async () => {
    const { stream, hosts } = rig();
    login(stream);
    stream.send({ op: 'shell_open' });
    stream.send({ op: 'shell_run' });
    await settle();
    expect(hosts[0].lines).toEqual(['']);
  });

  it('reports the end of the session the shell announced', async () => {
    const { stream } = rig({
      openShell: () => new RecordingHost(async () => ({ output: '', prompt: '', ended: true })),
    });
    login(stream);
    stream.send({ op: 'shell_open' });
    stream.send({ op: 'shell_run', line: 'exit' });
    await settle();
    expect(stream.last).toEqual({ ok: true, output: '', prompt: '', ended: true });
  });

  it('answers a failure of the shell with its message', async () => {
    const { stream } = rig({
      openShell: () => new RecordingHost(async () => { throw new Error('boom'); }),
    });
    login(stream);
    stream.send({ op: 'shell_open' });
    stream.send({ op: 'shell_run', line: 'x' });
    await settle();
    expect(stream.last).toEqual({ ok: false, message: 'boom' });
  });

  it('answers a failure that is not an error with its text', async () => {
    const { stream } = rig({
      openShell: () => new RecordingHost(() => Promise.reject('plain text')),
    });
    login(stream);
    stream.send({ op: 'shell_open' });
    stream.send({ op: 'shell_run', line: 'x' });
    await settle();
    expect(stream.last).toEqual({ ok: false, message: 'plain text' });
  });

  it('takes a request that arrives in two pieces', async () => {
    const { stream, hosts } = rig();
    login(stream);
    stream.send({ op: 'shell_open' });
    const request = JSON.stringify({ op: 'shell_run', line: 'Get-ChildItem' });
    stream.receive(request.slice(0, 11));
    expect(hosts[0].lines).toEqual([]);
    stream.receive(request.slice(11));
    await settle();
    expect(hosts[0].lines).toEqual(['Get-ChildItem']);
  });
});

describe('WinRM shell_complete', () => {
  it('is refused while no shell is open', () => {
    const { stream } = rig();
    login(stream);
    stream.send({ op: 'shell_complete', line: 'Get-' });
    expect(stream.last).toEqual({ ok: false, message: 'The WinRM shell is not open.' });
  });

  it('answers with the candidates of the shell and where the completed word starts', () => {
    const { stream, hosts } = rig();
    login(stream);
    stream.send({ op: 'shell_open' });
    stream.send({ op: 'shell_complete', line: 'Get-' });
    expect(hosts[0].completed).toEqual(['Get-']);
    expect(stream.last).toEqual({ ok: true, candidates: ['Get-One', 'Get-Two'], start: 4 });
  });

  it('completes an empty line when none is given', () => {
    const { stream, hosts } = rig();
    login(stream);
    stream.send({ op: 'shell_open' });
    stream.send({ op: 'shell_complete' });
    expect(hosts[0].completed).toEqual(['']);
  });
});

describe('WinRM shell_close and connection loss', () => {
  it('closes the shell and says nothing', () => {
    const { stream, hosts } = rig();
    login(stream);
    stream.send({ op: 'shell_open' });
    const replies = stream.sent.length;
    stream.send({ op: 'shell_close' });
    expect(hosts[0].closed).toBe(1);
    expect(stream.sent).toHaveLength(replies);
  });

  it('refuses a line once the shell is closed', () => {
    const { stream } = rig();
    login(stream);
    stream.send({ op: 'shell_open' });
    stream.send({ op: 'shell_close' });
    stream.send({ op: 'shell_run', line: 'hostname' });
    expect(stream.last).toEqual({ ok: false, message: 'The WinRM shell is not open.' });
  });

  it('closes the shell when the connection drops', () => {
    const { stream, hosts } = rig();
    login(stream);
    stream.send({ op: 'shell_open' });
    stream.drop();
    expect(hosts[0].closed).toBe(1);
  });

  it('does not close a shell it never opened', () => {
    const { stream, hosts } = rig();
    login(stream);
    stream.send({ op: 'shell_close' });
    stream.drop();
    expect(hosts).toEqual([]);
  });

  it('closes the shell once when it is closed and the connection then drops', () => {
    const { stream, hosts } = rig();
    login(stream);
    stream.send({ op: 'shell_open' });
    stream.send({ op: 'shell_close' });
    stream.drop();
    expect(hosts[0].closed).toBe(1);
  });
});
