import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { TerminalManager } from '@/terminal/sessions/TerminalManager';
import { EventBus, __setDefaultEventBus } from '@/events/EventBus';
import {
  parseMtrArgs, MtrHopStats, formatMtrFrame, MTR_USAGE, MTR_VERSION,
} from '@/network/devices/linux/Mtr';
import type { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';

function key(k: string, opts: { ctrlKey?: boolean } = {}): KeyEvent {
  return { key: k, ctrlKey: opts.ctrlKey ?? false, altKey: false, metaKey: false, shiftKey: false };
}
const flush = () => new Promise<void>((r) => setTimeout(r, 5));

describe('mtr — parseMtrArgs', () => {
  it('parses bare target', () => {
    const p = parseMtrArgs(['10.0.0.2']);
    expect(p.target).toBe('10.0.0.2');
    expect(p.reportMode).toBe(false);
    expect(p.cycles).toBe(10);
    expect(p.intervalSec).toBe(1);
    expect(p.maxHops).toBe(30);
    expect(p.noDns).toBe(false);
  });

  it('recognises -r/--report and -c/--report-cycles', () => {
    expect(parseMtrArgs(['-r', '10.0.0.2']).reportMode).toBe(true);
    expect(parseMtrArgs(['--report', '10.0.0.2']).reportMode).toBe(true);
    expect(parseMtrArgs(['-c', '5', '10.0.0.2']).cycles).toBe(5);
    expect(parseMtrArgs(['--report-cycles=4', '10.0.0.2']).cycles).toBe(4);
  });

  it('recognises -i/--interval and -m/--max-ttl', () => {
    expect(parseMtrArgs(['-i', '0.5', '10.0.0.2']).intervalSec).toBe(0.5);
    expect(parseMtrArgs(['--interval=2', '10.0.0.2']).intervalSec).toBe(2);
    expect(parseMtrArgs(['-m', '5', '10.0.0.2']).maxHops).toBe(5);
    expect(parseMtrArgs(['--max-ttl=8', '10.0.0.2']).maxHops).toBe(8);
  });

  it('flags help and version', () => {
    expect(parseMtrArgs(['--help']).showHelp).toBe(true);
    expect(parseMtrArgs(['-V']).showVersion).toBe(true);
  });

  it('rejects bad values', () => {
    expect(parseMtrArgs(['-c', 'x', 'h']).parseError).toMatch(/bad cycles/);
    expect(parseMtrArgs(['-i', '-1', 'h']).parseError).toMatch(/bad interval/);
    expect(parseMtrArgs(['-m', '0', 'h']).parseError).toMatch(/bad max-ttl/);
    expect(parseMtrArgs(['--bogus']).parseError).toMatch(/unrecognized/);
  });
});

describe('mtr — MtrHopStats', () => {
  it('tracks last / best / worst / avg / stddev across probes', () => {
    const s = new MtrHopStats();
    s.record({ ip: '10.0.0.1', rttMs: 1, lost: false });
    s.record({ ip: '10.0.0.1', rttMs: 3, lost: false });
    s.record({ ip: '10.0.0.1', rttMs: 2, lost: false });
    expect(s.sent).toBe(3);
    expect(s.received).toBe(3);
    expect(s.last).toBe(2);
    expect(s.best).toBe(1);
    expect(s.worst).toBe(3);
    expect(s.avg()).toBeCloseTo(2);
    expect(s.stDev()).toBeGreaterThan(0);
    expect(s.lossPct()).toBe(0);
  });

  it('counts losses correctly', () => {
    const s = new MtrHopStats();
    s.record({ ip: '10.0.0.1', rttMs: 1, lost: false });
    s.record({ ip: '10.0.0.1', lost: true });
    s.record({ ip: '10.0.0.1', lost: true });
    s.record({ ip: '10.0.0.1', rttMs: 2, lost: false });
    expect(s.sent).toBe(4);
    expect(s.received).toBe(2);
    expect(s.lossPct()).toBeCloseTo(50);
    expect(s.last).toBe(2);
    expect(s.best).toBe(1);
  });

  it('stddev is 0 with fewer than 2 samples', () => {
    const s = new MtrHopStats();
    expect(s.stDev()).toBe(0);
    s.record({ ip: '10.0.0.1', rttMs: 5, lost: false });
    expect(s.stDev()).toBe(0);
  });
});

describe('mtr — formatMtrFrame', () => {
  function statsFor(ip: string, rtts: number[]): MtrHopStats {
    const s = new MtrHopStats();
    for (const r of rtts) s.record({ ip, rttMs: r, lost: false });
    return s;
  }

  it('renders the live table with header rows', () => {
    const out = formatMtrFrame({
      hostname: 'PC1', target: '10.0.0.2', startedAt: new Date(0),
      hops: [statsFor('10.0.0.1', [1, 2]), statsFor('10.0.0.2', [3, 4])],
    });
    expect(out).toContain('mtr 0.95');
    expect(out).toContain('PC1 (10.0.0.2)');
    expect(out).toContain('Keys:');
    expect(out).toContain('Loss%');
    expect(out).toMatch(/ 1\. 10\.0\.0\.1\s+0\.0%\s+2/);
    expect(out).toMatch(/ 2\. 10\.0\.0\.2\s+0\.0%\s+2/);
  });

  it('renders the report-mode header', () => {
    const out = formatMtrFrame({
      hostname: 'PC1', target: '10.0.0.2', startedAt: new Date(0),
      hops: [statsFor('10.0.0.1', [1])],
    }, 'report');
    expect(out).toContain('Start: 1970-01-01T00:00:00.000Z');
    expect(out).not.toContain('Keys:');
  });

  it('shows ??? when no probe ever responded', () => {
    const s = new MtrHopStats();
    s.record({ lost: true });
    s.record({ lost: true });
    const out = formatMtrFrame({
      hostname: 'PC1', target: '10.0.0.2', startedAt: new Date(0), hops: [s],
    });
    expect(out).toMatch(/ 1\. \?\?\?\s+100\.0%\s+2/);
  });
});

describe('mtr — UI streaming through the terminal session', () => {
  let bus: EventBus;
  let manager: TerminalManager;
  let pc1: LinuxPC;
  let pc2: LinuxPC;
  let sw: CiscoSwitch;
  let session: LinuxTerminalSession;

  beforeEach(async () => {
    resetCounters();
    MACAddress.resetCounter();
    Logger.reset();
    EquipmentRegistry.resetInstance();
    bus = new EventBus();
    __setDefaultEventBus(bus);
    EquipmentRegistry.getInstance().setEventBus(bus);

    sw = new CiscoSwitch('switch-cisco', 'SW1', 8, 0, 0);
    sw.setEventBus(bus);
    pc1 = new LinuxPC('linux-pc', 'PC1', 0, 0);
    pc1.setEventBus(bus);
    pc2 = new LinuxPC('linux-pc', 'PC2', 0, 0);
    pc2.setEventBus(bus);
    new Cable('c1').connect(pc1.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('c2').connect(pc2.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
    await pc1.executeCommand('ifconfig eth0 10.0.0.1');
    await pc2.executeCommand('ifconfig eth0 10.0.0.2');
    // Warm both ARP caches so sync ping probes don't hit the async ARP
    // queue path (sendEchoReply via fwdQueueAndResolve).
    await pc1.executeCommand('ping -c 1 10.0.0.2');
    await pc2.executeCommand('ping -c 1 10.0.0.1');

    manager = new TerminalManager(bus);
    const sid = manager.openTerminal(pc1)!;
    session = manager.getSession(sid) as LinuxTerminalSession;
    for (let i = 0; i < 40 && session.isBooting; i++) await new Promise((r) => setTimeout(r, 50));
  });

  async function type(cmd: string): Promise<void> {
    session.setInput(cmd);
    session.handleKey(key('Enter'));
    await flush();
  }

  it('mtr --version prints the version line', async () => {
    await type('mtr --version');
    expect(session.lines.some((l) => l.text.includes(MTR_VERSION))).toBe(true);
  });

  it('mtr --help prints the usage', async () => {
    await type('mtr --help');
    expect(session.lines.some((l) => l.text.includes('--report-cycles'))).toBe(true);
  });

  it('mtr (no target) reports the error inline', async () => {
    await type('mtr');
    expect(session.lines.some((l) => l.text.includes('mtr: no host specified'))).toBe(true);
  });

  it('mtr -r -c 1 prints a final report and unlocks the prompt', async () => {
    await type('mtr -r -c 1 10.0.0.2');
    for (let i = 0; i < 40 && session.hasForegroundAsyncJob; i++) await new Promise((r) => setTimeout(r, 50));
    expect(session.hasForegroundAsyncJob).toBe(false);
    const text = session.lines.map((l) => l.text).join('\n');
    expect(text).toContain('Start:');
    expect(text).toMatch(/PC1 \(10\.0\.0\.2\)/);
    expect(text).toMatch(/ 1\. 10\.0\.0\.2/);
  });

  it('mtr (live) keeps the prompt locked until Ctrl+C', async () => {
    await type('mtr 10.0.0.2');
    for (let i = 0; i < 40 && !session.hasForegroundAsyncJob; i++) await new Promise((r) => setTimeout(r, 50));
    expect(session.hasForegroundAsyncJob).toBe(true);
    const before = session.lines.length;
    expect(session.lines.some((l) => l.text.includes('mtr 0.95'))).toBe(true);

    session.handleKey(key('c', { ctrlKey: true }));
    await new Promise((r) => setTimeout(r, 100));
    expect(session.hasForegroundAsyncJob).toBe(false);
    expect(session.lines.length).toBeGreaterThanOrEqual(before);
  });
});
