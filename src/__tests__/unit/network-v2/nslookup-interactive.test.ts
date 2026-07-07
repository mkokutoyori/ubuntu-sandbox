/**
 * PRD-Nslookup-Dig-Rndc-Runas.md §2.1.1/P1 — the interactive `nslookup` REPL
 * exposed in `LinuxTerminalSession` (bare `nslookup`, no arguments), driven
 * the same way a React view would (`session.foreground.setInput(...)` +
 * Enter), mirroring `ftp-cli.test.ts`'s UI-level testing style. Shares the
 * exact same DNS transport and BIND9 lab setup as
 * `dig-nslookup-enriched.test.ts` — this is a REPL wrapper test, not a
 * parallel DNS-stack test.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import type { KeyEvent, TerminalSession } from '@/terminal/sessions/TerminalSession';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';

const NS1_IP = '10.0.1.10';
const NS2_IP = '10.0.1.11';

const ZONE_DB = [
  '$ORIGIN example.com.',
  '$TTL 3600',
  '@     IN SOA ns1.example.com. admin.example.com. ( 2024010101 3600 900 604800 300 )',
  '      IN NS  ns1.example.com.',
  '      IN MX  10 mail.example.com.',
  '      IN TXT "v=spf1 -all"',
  'ns1   IN A   10.0.1.10',
  'mail  IN A   10.0.1.25',
  'www   IN A   10.0.1.80',
  'alias IN CNAME www',
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
  const pc = new LinuxPC('linux-pc', 'PC1');
  const srv = new LinuxServer('linux-server', 'NS1');

  pc.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
  srv.configureInterface('eth0', new IPAddress(NS1_IP), new SubnetMask('255.255.255.0'));
  new Cable('c1').connect(pc.getPort('eth0')!, srv.getPort('eth0')!);

  writeRoot(srv, '/etc/bind/named.conf', namedConf());
  writeRoot(srv, '/etc/bind/db.example.com', ZONE_DB);
  await srv.executeCommand('systemctl start named');

  await pc.executeCommand(`sudo sh -c 'echo "nameserver ${NS1_IP}" > /etc/resolv.conf'`);
  return { pc, srv };
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

describe('nslookup interactive REPL (PRD-Nslookup-Dig-Rndc-Runas.md §2.1.1)', () => {
  it('bare `nslookup` enters the subshell and prints the default-server banner', async () => {
    const { pc } = await buildLab();
    const term = new LinuxTerminalSession('t1', pc);
    await term.init();

    await type(term, 'nslookup');
    expect(term.foreground.getPrompt()).toBe('> ');
    expectContains(term, `Default Server:  ${NS1_IP}`);
    expectContains(term, `Address:  ${NS1_IP}#53`);
  });

  it('resolves a bare domain name using the configured resolver', async () => {
    const { pc } = await buildLab();
    const term = new LinuxTerminalSession('t1', pc);
    await term.init();

    await type(term, 'nslookup');
    await type(term, 'www.example.com');

    expectContains(term, 'Name:\twww.example.com');
    expectContains(term, 'Address: 10.0.1.80');
  });

  it('`server <host>` switches the resolver and reprints the banner', async () => {
    const { pc } = await buildLab();
    const term = new LinuxTerminalSession('t1', pc);
    await term.init();

    await type(term, 'nslookup');
    await type(term, `server ${NS2_IP}`);

    expectContains(term, `Default Server:  ${NS2_IP}`);
    expectContains(term, `Address:  ${NS2_IP}#53`);
  });

  it('`set type=MX` changes the query type for subsequent lookups', async () => {
    const { pc } = await buildLab();
    const term = new LinuxTerminalSession('t1', pc);
    await term.init();

    await type(term, 'nslookup');
    await type(term, 'set type=MX');
    await type(term, 'example.com');

    expectContains(term, /mail exchanger = 10 mail\.example\.com/);
  });

  it('CNAME lookups print the canonical-name line then the resolved address', async () => {
    const { pc } = await buildLab();
    const term = new LinuxTerminalSession('t1', pc);
    await term.init();

    await type(term, 'nslookup');
    await type(term, 'alias.example.com');

    expectContains(term, 'alias.example.com\tcanonical name = www.example.com.');
    expectContains(term, 'Address: 10.0.1.80');
  });

  it('`exit` leaves the subshell and returns to the normal shell prompt', async () => {
    const { pc } = await buildLab();
    const term = new LinuxTerminalSession('t1', pc);
    await term.init();

    await type(term, 'nslookup');
    expect(term.foreground.getPrompt()).toBe('> ');

    await type(term, 'exit');
    expect(term.foreground.getPrompt()).not.toBe('> ');
  });

  it('a missing name reports the real `nslookup` no-answer error without exiting', async () => {
    const { pc } = await buildLab();
    const term = new LinuxTerminalSession('t1', pc);
    await term.init();

    await type(term, 'nslookup');
    await type(term, 'missing.example.com');

    expectContains(term, `** server can't find missing.example.com: NXDOMAIN`);
    expect(term.foreground.getPrompt()).toBe('> ');
  });

  it('`nslookup <domain> <server>` (non-interactive form) is unaffected — no subshell entry', async () => {
    const { pc } = await buildLab();
    const term = new LinuxTerminalSession('t1', pc);
    await term.init();

    await type(term, `nslookup www.example.com ${NS1_IP}`);
    expect(term.foreground.getPrompt()).not.toBe('> ');
    expectContains(term, 'Address: 10.0.1.80');
  });
});
