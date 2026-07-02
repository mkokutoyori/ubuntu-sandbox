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
  parseDstatArgs, sampleDstat, formatDstatHeader, formatDstatRow,
  newDstatRateState, DEFAULT_GROUPS, DSTAT_USAGE, DSTAT_VERSION,
} from '@/network/devices/linux/system/Dstat';
import type { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';

function key(k: string, opts: { ctrlKey?: boolean } = {}): KeyEvent {
  return { key: k, ctrlKey: opts.ctrlKey ?? false, altKey: false, metaKey: false, shiftKey: false };
}
const flush = () => new Promise<void>((r) => setTimeout(r, 5));

describe('dstat — parser', () => {
  it('defaults to time+cpu+disk+net+paging+system at 1s', () => {
    const p = parseDstatArgs([]);
    expect(p.groups).toEqual(DEFAULT_GROUPS);
    expect(p.intervalSeconds).toBe(1);
    expect(p.count).toBeNull();
  });

  it('group flags switch to "only these"', () => {
    const p = parseDstatArgs(['-c', '-m']);
    expect(p.groups.cpu).toBe(true);
    expect(p.groups.memory).toBe(true);
    expect(p.groups.disk).toBe(false);
    expect(p.groups.net).toBe(false);
    expect(p.groups.paging).toBe(false);
    expect(p.groups.system).toBe(false);
  });

  it('long names work', () => {
    const p = parseDstatArgs(['--cpu', '--net', '--time']);
    expect(p.groups.cpu).toBe(true);
    expect(p.groups.net).toBe(true);
    expect(p.groups.time).toBe(true);
    expect(p.groups.disk).toBe(false);
  });

  it('positional delay [count]', () => {
    const p = parseDstatArgs(['2', '5']);
    expect(p.intervalSeconds).toBe(2);
    expect(p.count).toBe(5);
  });

  it('rejects unknown options and bad positional', () => {
    expect(parseDstatArgs(['--bogus']).parseError).toMatch(/unknown option/);
    expect(parseDstatArgs(['abc']).parseError).toMatch(/cannot parse abc/);
    expect(parseDstatArgs(['-N']).parseError).toMatch(/-N requires/);
  });

  it('flags version / help / list', () => {
    expect(parseDstatArgs(['--version']).showVersion).toBe(true);
    expect(parseDstatArgs(['--help']).showHelp).toBe(true);
    expect(parseDstatArgs(['--list']).listStats).toBe(true);
  });
});

describe('dstat — formatter', () => {
  it('header renders the title row and the column row for the selected groups', () => {
    const out = formatDstatHeader({
      time: true, cpu: true, disk: false, memory: false,
      net: true, paging: false, system: false,
    });
    expect(out).toContain('----system----');
    expect(out).toContain('----total-cpu-usage----');
    expect(out).toContain('-net/total-');
    expect(out).not.toContain('-dsk/total-');
    expect(out).toContain('usr sys idl wai stl');
    expect(out).toContain(' recv  send');
  });

  it('row renders cpu/disk/net/paging/system numerically and includes a timestamp when -t', () => {
    const sample = {
      ts: new Date(0),
      cpu: { user: 12, system: 5, idle: 83, wait: 0, steal: 0 },
      disk: { readBytesPerSec: 0, writeBytesPerSec: 0 },
      memory: { usedKib: 0, buffersKib: 0, cacheKib: 0, freeKib: 0 },
      net: { recvBytesPerSec: 1024, sendBytesPerSec: 2048 },
      paging: { inKib: 0, outKib: 0 },
      system: { interruptsPerSec: 100, ctxSwitchesPerSec: 200 },
    };
    const row = formatDstatRow(sample, DEFAULT_GROUPS);
    expect(row).toMatch(/\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
    expect(row).toMatch(/ 12   5  83   0   0/);
    expect(row).toContain('   1k');
    expect(row).toContain('   2k');
  });
});

describe('dstat — sampleDstat', () => {
  it('first sample reports 0 B/sec for net (no previous reference)', () => {
    const pm = { list: () => [] } as unknown as Parameters<typeof sampleDstat>[0]['pm'];
    const mem = { totalKib: 4_000_000, freeKib: 2_000_000, buffersKib: 100_000, cacheKib: 200_000 } as Parameters<typeof sampleDstat>[0]['memory'];
    const rate = newDstatRateState();
    const snap = sampleDstat({ pm, memory: mem, ports: [{ bytesIn: 5000, bytesOut: 9000 }] }, rate);
    expect(snap.net.recvBytesPerSec).toBe(0);
    expect(snap.net.sendBytesPerSec).toBe(0);
    expect(snap.memory.usedKib).toBe(4_000_000 - 2_000_000 - 100_000 - 200_000);
  });

  it('second sample reports delta bytes per second', () => {
    const pm = { list: () => [] } as unknown as Parameters<typeof sampleDstat>[0]['pm'];
    const mem = { totalKib: 4_000_000, freeKib: 2_000_000, buffersKib: 100_000, cacheKib: 200_000 } as Parameters<typeof sampleDstat>[0]['memory'];
    const rate = newDstatRateState();
    sampleDstat({ pm, memory: mem, ports: [{ bytesIn: 1000, bytesOut: 2000 }] }, rate);
    // simulate time passing
    rate.lastTsMs = Date.now() - 1000;
    const snap = sampleDstat({ pm, memory: mem, ports: [{ bytesIn: 2000, bytesOut: 3000 }] }, rate);
    expect(snap.net.recvBytesPerSec).toBeGreaterThan(900);
    expect(snap.net.recvBytesPerSec).toBeLessThan(1100);
    expect(snap.net.sendBytesPerSec).toBeGreaterThan(900);
    expect(snap.net.sendBytesPerSec).toBeLessThan(1100);
  });
});

describe('dstat — UI streaming', () => {
  let bus: EventBus;
  let manager: TerminalManager;
  let pc: LinuxPC;
  let session: LinuxTerminalSession;

  beforeEach(async () => {
    resetCounters();
    MACAddress.resetCounter();
    Logger.reset();
    EquipmentRegistry.resetInstance();
    bus = new EventBus();
    __setDefaultEventBus(bus);
    EquipmentRegistry.getInstance().setEventBus(bus);

    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8, 0, 0);
    sw.setEventBus(bus);
    pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    pc.setEventBus(bus);
    new Cable('c1').connect(pc.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
    await pc.executeCommand('ifconfig eth0 10.0.0.1');

    manager = new TerminalManager(bus);
    const sid = manager.openTerminal(pc)!;
    session = manager.getSession(sid) as LinuxTerminalSession;
    for (let i = 0; i < 40 && session.isBooting; i++) await new Promise((r) => setTimeout(r, 50));
  });

  async function type(cmd: string): Promise<void> {
    session.setInput(cmd);
    session.handleKey(key('Enter'));
    await flush();
  }

  it('dstat --version prints the version line', async () => {
    await type('dstat --version');
    expect(session.lines.some((l) => l.text.includes(DSTAT_VERSION))).toBe(true);
  });

  it('dstat --help prints the usage', async () => {
    await type('dstat --help');
    expect(session.lines.some((l) => l.text.includes('Versatile tool'))).toBe(true);
  });

  it('dstat --list prints the available stats', async () => {
    await type('dstat --list');
    expect(session.lines.some((l) => l.text.includes('cpu, disk, mem'))).toBe(true);
  });

  it('dstat 1 2 prints header + 2 rows and unlocks the prompt', async () => {
    await type('dstat 1 2');
    for (let i = 0; i < 60 && session.hasForegroundAsyncJob; i++) await new Promise((r) => setTimeout(r, 50));
    expect(session.hasForegroundAsyncJob).toBe(false);
    const text = session.lines.map((l) => l.text).join('\n');
    expect(text).toContain('----total-cpu-usage----');
    expect(text).toContain('usr sys idl wai stl');
    const dataRows = session.lines.filter((l) => /^\s*\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(l.text)).length;
    expect(dataRows).toBeGreaterThanOrEqual(2);
  });

  it('dstat -c -m (cpu + memory only) hides the other groups', async () => {
    await type('dstat -c -m 1 1');
    for (let i = 0; i < 60 && session.hasForegroundAsyncJob; i++) await new Promise((r) => setTimeout(r, 50));
    const text = session.lines.map((l) => l.text).join('\n');
    expect(text).toContain('----total-cpu-usage----');
    expect(text).toContain('------memory-usage-----');
    expect(text).not.toContain('-net/total-');
    expect(text).not.toContain('---paging--');
    expect(text).not.toContain(' int   csw');
  });

  it('dstat (live) keeps the prompt locked, repaints, and unlocks on Ctrl+C', async () => {
    await type('dstat');
    for (let i = 0; i < 40 && !session.hasForegroundAsyncJob; i++) await new Promise((r) => setTimeout(r, 50));
    expect(session.hasForegroundAsyncJob).toBe(true);

    session.handleKey(key('c', { ctrlKey: true }));
    await new Promise((r) => setTimeout(r, 100));
    expect(session.hasForegroundAsyncJob).toBe(false);
  });

  it('rejects an unknown option inline', async () => {
    await type('dstat --bogus');
    expect(session.hasForegroundAsyncJob).toBe(false);
    expect(session.lines.some((l) => l.text.includes('unknown option --bogus'))).toBe(true);
  });
});
