import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import {
  parseIostatArgs,
  iostatCpuHeader,
  formatIostatCpuRow,
  iostatDeviceHeader,
  formatIostatDeviceRow,
  sampleIostatDevices,
  type IostatArgs,
} from '@/network/devices/linux/system/Iostat';
import { StorageDevice, DiskPartition } from '@/network/devices/host/hardware/StorageDevice';

function key(k: string, opts: { ctrlKey?: boolean } = {}): KeyEvent {
  return { key: k, ctrlKey: opts.ctrlKey ?? false, altKey: false, metaKey: false, shiftKey: false };
}
const tick = () => new Promise<void>((r) => setTimeout(r, 20));
function texts(s: LinuxTerminalSession): string[] { return s.lines.map((l) => l.text); }
function deviceRows(s: LinuxTerminalSession): number {
  return texts(s).filter((t) => /^sda\b\s+\d+\.\d{2}/.test(t)).length;
}
async function waitFor(s: LinuxTerminalSession, pred: (l: string[]) => boolean, ms = 6000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) { if (pred(texts(s))) return; await tick(); }
}

let pc: LinuxPC;
let session: LinuxTerminalSession;
beforeEach(() => {
  EquipmentRegistry.resetInstance();
  pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
  pc.powerOn();
  session = new LinuxTerminalSession('term-1', pc);
});

describe('Linux iostat — one-shot snapshot', () => {
  it('prints banner + avg-cpu block + device block with the real disk', async () => {
    session.setInput('iostat');
    session.handleKey(key('Enter'));
    await tick();
    expect(session.hasForegroundAsyncJob).toBe(false);
    const lines = texts(session);
    expect(lines.some((t) => /Linux \S+ \(.+\)\s+\d{2}\/\d{2}\/\d{4}\s+_\S+_\s+\(\d+ CPU\)/.test(t))).toBe(true);
    expect(lines.some((t) => /avg-cpu:\s+%user\s+%nice\s+%system\s+%iowait\s+%steal\s+%idle/.test(t))).toBe(true);
    expect(lines.some((t) => /Device\s+tps\s+kB_read\/s\s+kB_wrtn\/s/.test(t))).toBe(true);
    expect(deviceRows(session)).toBe(1);
  });

  it('-c shows only the CPU block', async () => {
    session.setInput('iostat -c');
    session.handleKey(key('Enter'));
    await tick();
    const lines = texts(session);
    expect(lines.some((t) => /avg-cpu:/.test(t))).toBe(true);
    expect(lines.some((t) => /^Device\s+tps/.test(t))).toBe(false);
  });

  it('-d shows only the device block', async () => {
    session.setInput('iostat -d');
    session.handleKey(key('Enter'));
    await tick();
    const lines = texts(session);
    expect(lines.some((t) => /avg-cpu:/.test(t))).toBe(false);
    expect(lines.some((t) => /^Device\s+tps/.test(t))).toBe(true);
    expect(deviceRows(session)).toBe(1);
  });

  it('-x prints the extended columns including %util', async () => {
    session.setInput('iostat -x');
    session.handleKey(key('Enter'));
    await tick();
    const lines = texts(session);
    expect(lines.some((t) => /Device\s+r\/s\s+rkB\/s/.test(t))).toBe(true);
    expect(lines.some((t) => /%util/.test(t))).toBe(true);
  });

  it('-p expands partitions of the disk', async () => {
    session.setInput('iostat -p');
    session.handleKey(key('Enter'));
    await tick();
    const lines = texts(session);
    expect(lines.some((t) => /^sda1\b/.test(t))).toBe(true);
    expect(lines.some((t) => /^sda2\b/.test(t))).toBe(true);
  });
});

describe('Linux iostat <interval> — streaming on the async pipeline', () => {
  it('streams reports on an interval and stops on count exhaustion', async () => {
    session.setInput('iostat 1 2');
    session.handleKey(key('Enter'));
    await waitFor(session, () => !session.hasForegroundAsyncJob && deviceRows(session) >= 2);
    expect(session.hasForegroundAsyncJob).toBe(false);
    expect(deviceRows(session)).toBe(2);
  });

  it('locks the prompt while running and unlocks on Ctrl+C', async () => {
    session.setInput('iostat 1');
    session.handleKey(key('Enter'));
    await waitFor(session, (l) => l.some((t) => /^Device\s+tps/.test(t)));
    expect(session.hasForegroundAsyncJob).toBe(true);
    await waitFor(session, () => deviceRows(session) >= 1);

    session.handleKey(key('c', { ctrlKey: true }));
    await tick();
    expect(session.hasForegroundAsyncJob).toBe(false);
    expect(texts(session).some((t) => t === '^C')).toBe(true);
  });

  it('prints the banner only once across streamed reports', async () => {
    session.setInput('iostat 1 3');
    session.handleKey(key('Enter'));
    await waitFor(session, () => !session.hasForegroundAsyncJob && deviceRows(session) >= 3, 8000);
    const banners = texts(session).filter((t) => /Linux \S+ \(/.test(t)).length;
    expect(banners).toBe(1);
  });
});

describe('Linux iostat — pure parser + formatters', () => {
  it('parses flags, interval and count', () => {
    expect(parseIostatArgs(['-x', '1', '5'])).toMatchObject({ extended: true, intervalSeconds: 1, count: 5 });
    expect(parseIostatArgs(['-cdm'])).toMatchObject({ cpuOnly: true, deviceOnly: true, megabytes: true });
    expect(parseIostatArgs(['-V'])).toEqual({ error: 'sysstat version 12.5.2' });
    expect(parseIostatArgs(['-Q'])).toEqual({ error: "iostat: invalid option -- 'Q'" });
  });

  it('CPU header lists the six iostat percentages and the row aligns to 2 decimals', () => {
    expect(iostatCpuHeader()).toMatch(/%user.+%nice.+%system.+%iowait.+%steal.+%idle/);
    const row = formatIostatCpuRow({ user: 1.5, nice: 0, system: 0.5, iowait: 0, steal: 0, idle: 98 });
    expect(row).toMatch(/1\.50/);
    expect(row).toMatch(/98\.00/);
  });

  function args(extra: Partial<IostatArgs> = {}): IostatArgs {
    const parsed = parseIostatArgs([]);
    if ('error' in parsed) throw new Error(parsed.error);
    return { ...parsed, ...extra };
  }

  it('device header switches kB/MB units and the row carries the device name', () => {
    expect(iostatDeviceHeader(args({ megabytes: false }))).toMatch(/kB_read\/s/);
    expect(iostatDeviceHeader(args({ megabytes: true }))).toMatch(/MB_read\/s/);
    const row = formatIostatDeviceRow(args(), {
      device: 'sdb', tps: 0, readPerSec: 0, writtenPerSec: 0, discardedPerSec: 0,
      readTotal: 0, writtenTotal: 0, discardedTotal: 0, active: false,
    });
    expect(row).toMatch(/^sdb\s+0\.00/);
  });

  it('samples whole disks by default and partitions under -p', () => {
    const storage = [new StorageDevice({
      name: 'sda', sizeBytes: 1024,
      partitions: [new DiskPartition({ name: 'sda1', sizeBytes: 512 })],
    })];
    const whole = sampleIostatDevices(args(), storage);
    expect(whole.map((d) => d.device)).toEqual(['sda']);
    const parts = sampleIostatDevices(args({ perPartition: true }), storage);
    expect(parts.map((d) => d.device)).toEqual(['sda', 'sda1']);
  });
});
