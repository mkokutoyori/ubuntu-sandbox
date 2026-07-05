/**
 * PRD-FTP-SFTP.md §2.1.11/P9 — the interactive `ftp` command exposed in
 * `LinuxTerminalSession`, driven the same way a React view would
 * (`session.foreground.setInput(...)` + Enter), mirroring
 * `cross-vendor-ssh-interactive.test.ts`'s UI-level testing style.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { FtpServer } from '@/network/ftp/FtpServer';
import { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { LinuxSftpFSAdapter } from '@/network/protocols/ssh/sftp/LinuxSftpFSAdapter';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import type { KeyEvent, TerminalSession } from '@/terminal/sessions/TerminalSession';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
});

function key(k: string): KeyEvent {
  return { key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false };
}

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

async function type(session: TerminalSession, line: string): Promise<void> {
  const fg = session.foreground;
  fg.setInput(line);
  fg.setInputBuf(line);
  session.handleKey(key('Enter'));
  await flush();
}

async function ftpLogin(session: TerminalSession, line: string, password: string): Promise<void> {
  await type(session, line);
  if (session.currentInputMode.type === 'password') {
    session.setPasswordBuf(password);
    session.handleKey(key('Enter'));
    await flush();
  }
}

function linesOf(session: TerminalSession): string[] {
  return session.lines.map((l) => l.text);
}

function lastN(session: TerminalSession, n: number): string[] {
  const ls = linesOf(session);
  return ls.slice(Math.max(0, ls.length - n));
}

function expectContains(session: TerminalSession, needle: string | RegExp): void {
  const ls = linesOf(session);
  const hit = ls.some((l) => (needle instanceof RegExp ? needle.test(l) : l.includes(needle)));
  if (!hit) {
    throw new Error(`Expected terminal to contain ${String(needle)}\n--- actual ---\n${ls.join('\n')}\n---`);
  }
}

function buildTopology() {
  const pc = new LinuxPC('linux-pc', 'PC1');
  const srv = new LinuxServer('FTP1');
  pc.configureInterface('eth0', new IPAddress('10.0.9.2'), new SubnetMask('255.255.255.0'));
  srv.configureInterface('eth0', new IPAddress('10.0.9.10'), new SubnetMask('255.255.255.0'));
  new Cable('c1').connect(pc.getPort('eth0')!, srv.getPort('eth0')!);

  const vfs = new VirtualFileSystem();
  vfs.mkdirp('/srv/ftp', 0o755, 1000, 1000);
  vfs.writeFile('/srv/ftp/hello.txt', 'hello ftp world', 1000, 1000, 0o022);
  const fs = new LinuxSftpFSAdapter(vfs, 1000, 1000);
  const users = new Map([['alice', 'wonderland']]);
  const server = new FtpServer(srv.getTcpStack(), '10.0.9.10', { users, fs, rootPath: '/srv/ftp' });
  server.start();

  return { pc, srv, vfs };
}

describe('ftp CLI (PRD-FTP-SFTP.md §2.1.11)', () => {
  it('logs in, lands in the ftp> subshell, and PWD reports the server root', async () => {
    const { pc } = buildTopology();
    const term = new LinuxTerminalSession('t1', pc);
    await term.init();

    await ftpLogin(term, 'ftp alice@10.0.9.10', 'wonderland');
    expect(term.foreground.getPrompt()).toBe('ftp> ');
    expectContains(term, 'User alice logged in.');

    await type(term, 'pwd');
    expectContains(term, '"/srv/ftp" is the current directory.');
  });

  it('rejects a wrong password and stays out of the subshell', async () => {
    const { pc } = buildTopology();
    const term = new LinuxTerminalSession('t1', pc);
    await term.init();

    await ftpLogin(term, 'ftp alice@10.0.9.10', 'not-the-password');
    expect(term.foreground.getPrompt()).not.toBe('ftp> ');
    expectContains(term, /Login incorrect/);
  });

  it('ls lists the remote directory (PASV negotiated transparently)', async () => {
    const { pc } = buildTopology();
    const term = new LinuxTerminalSession('t1', pc);
    await term.init();
    await ftpLogin(term, 'ftp alice@10.0.9.10', 'wonderland');

    await type(term, 'ls');
    expectContains(term, /hello\.txt/);
  });

  it('cd changes the remote directory', async () => {
    const { pc, vfs } = buildTopology();
    vfs.mkdirp('/srv/ftp/sub', 0o755, 1000, 1000);
    const term = new LinuxTerminalSession('t1', pc);
    await term.init();
    await ftpLogin(term, 'ftp alice@10.0.9.10', 'wonderland');

    await type(term, 'cd sub');
    await type(term, 'pwd');
    expectContains(term, '"/srv/ftp/sub" is the current directory.');
  });

  it('get downloads a remote file byte-exact into the local filesystem', async () => {
    const { pc } = buildTopology();
    await pc.executeCommand('mkdir -p /tmp/ftpdl');
    const term = new LinuxTerminalSession('t1', pc);
    await term.init();
    await ftpLogin(term, 'ftp alice@10.0.9.10', 'wonderland');

    await type(term, 'lcd /tmp/ftpdl');
    await type(term, 'get hello.txt');
    expectContains(term, /local: \/tmp\/ftpdl\/hello\.txt remote: hello\.txt/);

    const out = await pc.executeCommand('cat /tmp/ftpdl/hello.txt');
    expect(out).toContain('hello ftp world');
  });

  it('put uploads a local file byte-exact to the remote server', async () => {
    const { pc, vfs } = buildTopology();
    await pc.executeCommand("echo -n 'uploaded via ftp cli' > /tmp/upload.txt");
    const term = new LinuxTerminalSession('t1', pc);
    await term.init();
    await ftpLogin(term, 'ftp alice@10.0.9.10', 'wonderland');

    await type(term, 'put /tmp/upload.txt uploaded.txt');
    expectContains(term, /local: \/tmp\/upload\.txt remote: uploaded\.txt/);
    expect(vfs.readFile('/srv/ftp/uploaded.txt')).toBe('uploaded via ftp cli');
  });

  it('lpwd/lcd operate on the local filesystem independently of the remote cwd', async () => {
    const { pc } = buildTopology();
    const term = new LinuxTerminalSession('t1', pc);
    await term.init();
    await ftpLogin(term, 'ftp alice@10.0.9.10', 'wonderland');

    await type(term, 'lcd /tmp');
    await type(term, 'lpwd');
    expectContains(term, 'Local directory now /tmp');
  });

  it('bye disconnects and returns to the local shell prompt', async () => {
    const { pc } = buildTopology();
    const term = new LinuxTerminalSession('t1', pc);
    await term.init();
    await ftpLogin(term, 'ftp alice@10.0.9.10', 'wonderland');
    expect(term.foreground.getPrompt()).toBe('ftp> ');

    await type(term, 'bye');
    expect(term.foreground.getPrompt()).not.toBe('ftp> ');
    expect(lastN(term, 2).some((l) => l.includes('Goodbye'))).toBe(true);
  });

  it('an unrecognized command reports an error without exiting the subshell', async () => {
    const { pc } = buildTopology();
    const term = new LinuxTerminalSession('t1', pc);
    await term.init();
    await ftpLogin(term, 'ftp alice@10.0.9.10', 'wonderland');

    await type(term, 'bogus');
    expectContains(term, '?Invalid command');
    expect(term.foreground.getPrompt()).toBe('ftp> ');
  });
});
