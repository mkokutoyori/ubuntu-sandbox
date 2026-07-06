/**
 * `nslookup`'s interactive `>` REPL, on Windows (bare `nslookup`, no
 * arguments). Windows previously fell straight through to the
 * non-interactive `executeNslookup` and printed a "Usage: ..." line —
 * this exercises the fix that gives Windows the exact same
 * `NslookupSubShell` used by `LinuxTerminalSession`
 * (see `nslookup-interactive.test.ts`, whose lab topology and BIND9 setup
 * this test mirrors) rather than a parallel Windows-only implementation.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { WindowsTerminalSession } from '@/terminal/sessions/WindowsTerminalSession';
import type { KeyEvent, TerminalSession } from '@/terminal/sessions/TerminalSession';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';

const NS1_IP = '10.0.1.10';
const NS2_IP = '10.0.1.11';
const WIN_IP = '10.0.1.2';

const ZONE_DB = [
  '$ORIGIN example.com.',
  '$TTL 3600',
  '@     IN SOA ns1.example.com. admin.example.com. ( 2024010101 3600 900 604800 300 )',
  '      IN NS  ns1.example.com.',
  '      IN MX  10 mail.example.com.',
  'ns1   IN A   10.0.1.10',
  'mail  IN A   10.0.1.25',
  'www   IN A   10.0.1.80',
  '',
].join('\n');

function namedConf(): string {
  return [
    'options {',
    '  directory "/var/cache/bind";',
    '  recursion no;',
    '};',
    'zone "example.com" {',
    '  type primary;',
    '  file "/etc/bind/db.example.com";',
    '};',
    '',
  ].join('\n');
}

function vfsOf(server: LinuxServer): VirtualFileSystem {
  return (server as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;
}

function writeRoot(server: LinuxServer, path: string, content: string): void {
  vfsOf(server).writeFile(path, content, 0, 0, 0o022);
}

async function buildLab() {
  const win = new WindowsPC('windows-pc', 'WIN1');
  const srv = new LinuxServer('NS1');

  win.powerOn();
  win.configureInterface('eth0', new IPAddress(WIN_IP), new SubnetMask('255.255.255.0'));
  srv.configureInterface('eth0', new IPAddress(NS1_IP), new SubnetMask('255.255.255.0'));
  new Cable('c1').connect(win.getPort('eth0')!, srv.getPort('eth0')!);

  writeRoot(srv, '/etc/bind/named.conf', namedConf());
  writeRoot(srv, '/etc/bind/db.example.com', ZONE_DB);
  await srv.executeCommand('systemctl start named');

  await win.executeCommand('netsh interface ip set dns name="eth0" static ' + NS1_IP);
  return { win, srv };
}

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

function linesOf(session: TerminalSession): string[] {
  return session.lines.map((l) => l.text);
}

function expectContains(session: TerminalSession, needle: string | RegExp): void {
  const ls = linesOf(session);
  const hit = ls.some((l) => (needle instanceof RegExp ? needle.test(l) : l.includes(needle)));
  if (!hit) {
    throw new Error(`Expected terminal to contain ${String(needle)}\n--- actual ---\n${ls.join('\n')}\n---`);
  }
}

describe('nslookup interactive REPL on Windows (parity with LinuxTerminalSession)', () => {
  it('bare `nslookup` enters the subshell and prints the default-server banner', async () => {
    const { win } = await buildLab();
    const term = new WindowsTerminalSession('t1', win);
    await term.init();

    await type(term, 'nslookup');
    expect(term.foreground.getPrompt()).toBe('> ');
    expectContains(term, `Default Server:  ${NS1_IP}`);
    expectContains(term, `Address:  ${NS1_IP}#53`);
  });

  it('resolves a bare domain name using the configured resolver', async () => {
    const { win } = await buildLab();
    const term = new WindowsTerminalSession('t1', win);
    await term.init();

    await type(term, 'nslookup');
    await type(term, 'www.example.com');

    expectContains(term, 'Name:\twww.example.com');
    expectContains(term, 'Address: 10.0.1.80');
  });

  it('`server <host>` switches the resolver and reprints the banner', async () => {
    const { win } = await buildLab();
    const term = new WindowsTerminalSession('t1', win);
    await term.init();

    await type(term, 'nslookup');
    await type(term, `server ${NS2_IP}`);

    expectContains(term, `Default Server:  ${NS2_IP}`);
    expectContains(term, `Address:  ${NS2_IP}#53`);
  });

  it('`set type=MX` changes the query type for subsequent lookups', async () => {
    const { win } = await buildLab();
    const term = new WindowsTerminalSession('t1', win);
    await term.init();

    await type(term, 'nslookup');
    await type(term, 'set type=MX');
    await type(term, 'example.com');

    expectContains(term, /mail exchanger = 10 mail\.example\.com/);
  });

  it('`exit` leaves the subshell and returns to the normal cmd prompt', async () => {
    const { win } = await buildLab();
    const term = new WindowsTerminalSession('t1', win);
    await term.init();

    await type(term, 'nslookup');
    expect(term.foreground.getPrompt()).toBe('> ');

    await type(term, 'exit');
    expect(term.foreground.getPrompt()).toMatch(/^[A-Z]:\\/);
  });

  it('`nslookup <domain> <server>` (non-interactive form) is unaffected — no subshell entry', async () => {
    const { win } = await buildLab();
    const term = new WindowsTerminalSession('t1', win);
    await term.init();

    await type(term, `nslookup www.example.com ${NS1_IP}`);
    expect(term.foreground.getPrompt()).not.toBe('> ');
    expectContains(term, 'Address: 10.0.1.80');
  });

  it('reports the same "Dnscache not running" error as the non-interactive command when the DNS Client service is stopped', async () => {
    const { win } = await buildLab();
    win.setCurrentUser('Administrator');
    await win.executeCommand('net stop Dnscache');
    const term = new WindowsTerminalSession('t1', win);
    await term.init();

    await type(term, 'nslookup');
    expect(term.foreground.getPrompt()).not.toBe('> ');
    expectContains(term, /No DNS servers available/);
    expectContains(term, /DNS Client \(Dnscache\) service is not running/);
  });
});
