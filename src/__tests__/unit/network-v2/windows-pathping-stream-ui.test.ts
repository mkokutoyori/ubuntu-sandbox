import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { WindowsTerminalSession } from '@/terminal/sessions/WindowsTerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import {
  parseWinPathpingArgs,
  formatPathpingHeader,
  formatPathpingDiscoveryHop,
  formatPathpingComputing,
  formatPathpingTrailer,
  pathpingDurationSeconds,
} from '@/network/devices/windows/WinPathping';
import { IPAddress } from '@/network/core/types';

function key(k: string, opts: { ctrlKey?: boolean } = {}): KeyEvent {
  return { key: k, ctrlKey: opts.ctrlKey ?? false, altKey: false, metaKey: false, shiftKey: false };
}
const tick = () => new Promise<void>((r) => setTimeout(r, 25));
function texts(s: WindowsTerminalSession): string[] { return s.lines.map((l) => l.text); }
async function waitFor(s: WindowsTerminalSession, pred: (l: string[]) => boolean, ms = 8000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) { if (pred(texts(s))) return; await tick(); }
}

let win: WindowsPC;
let linux: LinuxPC;
let session: WindowsTerminalSession;

beforeEach(async () => {
  EquipmentRegistry.resetInstance();
  win = new WindowsPC('windows-pc', 'PC1', 0, 0);
  linux = new LinuxPC('linux-pc', 'PC2', 0, 0);
  const sw = new CiscoSwitch('switch-cisco', 'SW', 24, 0, 0);
  win.powerOn(); linux.powerOn(); sw.powerOn();
  new Cable('c1').connect(win.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
  new Cable('c2').connect(linux.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
  await win.executeCommand('netsh interface ip set address "Ethernet0" static 192.168.1.10 255.255.255.0');
  await linux.executeCommand('ifconfig eth0 192.168.1.20');
  session = new WindowsTerminalSession('term-1', win);
  await session.init?.();
});

describe('Windows pathping — discovery + per-hop stats on the async pipeline', () => {
  it('streams the header, hop list, computing message, stats table, trailer', async () => {
    session.setInput('pathping -q 2 -p 30 -w 500 -h 5 192.168.1.20');
    session.handleKey(key('Enter'));
    expect(session.hasForegroundAsyncJob).toBe(true);

    await waitFor(session, (l) => l.some((t) => t.includes('Trace complete')));
    const lines = texts(session);

    expect(lines.some((t) => t.includes('Tracing route to 192.168.1.20'))).toBe(true);
    expect(lines.some((t) => /^\s+1\s+192\.168\.1\.20\b/.test(t))).toBe(true);
    expect(lines.some((t) => /Computing statistics for \d+ seconds\.\.\./.test(t))).toBe(true);
    expect(lines.some((t) => t.startsWith('Hop  RTT'))).toBe(true);
    expect(lines.some((t) => /\s+1\s+\S+\s+0\/\s+2 =\s+0%\s+0\/\s+2 =\s+0%\s+192\.168\.1\.20\b/.test(t))).toBe(true);
    expect(lines.some((t) => t === 'Trace complete.')).toBe(true);
    expect(session.hasForegroundAsyncJob).toBe(false);
  });

  it('reports an unresolved name without locking the prompt forever', async () => {
    session.setInput('pathping -q 1 -p 10 -w 100 -h 2 nosuch.host.local');
    session.handleKey(key('Enter'));
    await waitFor(session, (l) => l.some((t) => t.includes('Unable to resolve target system name')));
    expect(texts(session).some((t) => t.includes('Unable to resolve target system name nosuch.host.local'))).toBe(true);
    expect(session.hasForegroundAsyncJob).toBe(false);
  });

  it('cancels cleanly on Ctrl+C during the statistics phase', async () => {
    session.setInput('pathping -q 50 -p 50 -w 500 -h 5 192.168.1.20');
    session.handleKey(key('Enter'));
    await waitFor(session, (l) => l.some((t) => t.startsWith('Computing statistics')));
    expect(session.hasForegroundAsyncJob).toBe(true);

    session.handleKey(key('c', { ctrlKey: true }));
    await tick();
    expect(session.hasForegroundAsyncJob).toBe(false);
    expect(texts(session).some((t) => t === '^C')).toBe(true);
    expect(texts(session).some((t) => t === 'Trace complete.')).toBe(false);
  });
});

describe('Windows pathping — pure parser and formatters', () => {
  it('parses queries/period/maxhops/noresolve', () => {
    const p = parseWinPathpingArgs(['-q', '50', '-p', '100', '-h', '20', '-n', '10.0.0.1']);
    expect(p).toMatchObject({ queriesPerHop: 50, periodMs: 100, maxHops: 20, noResolve: true, targetStr: '10.0.0.1' });
  });

  it('uses real defaults when none provided', () => {
    const p = parseWinPathpingArgs(['10.0.0.1']);
    expect(p).toMatchObject({ queriesPerHop: 100, periodMs: 250, maxHops: 30, timeoutMs: 3000, noResolve: false });
  });

  it('header includes hostname only when provided', () => {
    expect(formatPathpingHeader(new IPAddress('10.0.0.5'), 30, 'web')[1])
      .toBe('Tracing route to web [10.0.0.5] over a maximum of 30 hops:');
    expect(formatPathpingHeader(new IPAddress('10.0.0.5'), 30)[1])
      .toBe('Tracing route to 10.0.0.5 over a maximum of 30 hops:');
  });

  it('discovery hop line numbers right-align hop, address as ip-only or host [ip]', () => {
    expect(formatPathpingDiscoveryHop(1, '10.0.0.1')).toBe('   1  10.0.0.1');
    expect(formatPathpingDiscoveryHop(10, '10.0.0.1', 'r1')).toBe('  10  r1 [10.0.0.1]');
  });

  it('computing message is realistic', () => {
    expect(formatPathpingComputing(25)).toEqual(['', 'Computing statistics for 25 seconds...']);
  });

  it('duration scales with queries × period × hopcount', () => {
    expect(pathpingDurationSeconds({
      maxHops: 30, queriesPerHop: 100, periodMs: 250, timeoutMs: 3000, noResolve: false, targetStr: '',
    }, 2)).toBe(50);
  });

  it('trailer matches Windows', () => {
    expect(formatPathpingTrailer()).toBe('Trace complete.');
  });
});
