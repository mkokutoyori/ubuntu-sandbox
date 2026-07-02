import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import {
  parsePidstatArgs,
  pidstatColumnHeader,
  formatPidstatCpuRow,
  formatPidstatMemRow,
  formatPidstatAverageCpuRow,
  PidstatAccumulator,
  type PidstatCpuRow,
  type PidstatMemRow,
} from '@/network/devices/linux/system/Pidstat';

function key(k: string, opts: { ctrlKey?: boolean } = {}): KeyEvent {
  return { key: k, ctrlKey: opts.ctrlKey ?? false, altKey: false, metaKey: false, shiftKey: false };
}
const tick = () => new Promise<void>((r) => setTimeout(r, 20));
function texts(s: LinuxTerminalSession): string[] { return s.lines.map((l) => l.text); }
function countCpuRows(s: LinuxTerminalSession): number {
  return texts(s).filter((t) => /^\d\d:\d\d:\d\d (?:AM|PM)\s+\d+\s+\d+\s+\d+\.\d{2}\s+\d+\.\d{2}/.test(t)).length;
}
function countMemRows(s: LinuxTerminalSession): number {
  return texts(s).filter((t) => /^\d\d:\d\d:\d\d (?:AM|PM)\s+\d+\s+\d+\s+\d+\.\d{2}\s+\d+\.\d{2}\s+\d+\s+\d+\s+\d+\.\d{2}/.test(t)).length;
}
async function waitFor(s: LinuxTerminalSession, pred: (l: string[]) => boolean, ms = 4000): Promise<void> {
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

describe('Linux pidstat — one-shot snapshot', () => {
  it('prints sysstat banner + CPU column header + one row per process', async () => {
    session.setInput('pidstat');
    session.handleKey(key('Enter'));
    await tick();
    expect(session.hasForegroundAsyncJob).toBe(false);
    const lines = texts(session);
    expect(lines.some((t) => /Linux \S+ \(.+\)\s+\d{2}\/\d{2}\/\d{4}\s+_\S+_\s+\(\d+ CPU\)/.test(t))).toBe(true);
    expect(lines.some((t) => /UID\s+PID\s+%usr %system\s+%guest\s+%wait\s+%CPU\s+CPU\s+Command/.test(t))).toBe(true);
    expect(countCpuRows(session)).toBeGreaterThanOrEqual(1);
  });

  it('-r switches to memory columns', async () => {
    session.setInput('pidstat -r');
    session.handleKey(key('Enter'));
    await tick();
    const lines = texts(session);
    expect(lines.some((t) => /UID\s+PID\s+minflt\/s\s+majflt\/s\s+VSZ\s+RSS\s+%MEM\s+Command/.test(t))).toBe(true);
    expect(countMemRows(session)).toBeGreaterThanOrEqual(1);
  });
});

describe('Linux pidstat <interval> — streaming on the async pipeline', () => {
  it('streams CPU rows, prints Average on count exhaustion', async () => {
    session.setInput('pidstat 1 2');
    session.handleKey(key('Enter'));
    await waitFor(session, () => !session.hasForegroundAsyncJob && countCpuRows(session) >= 2, 6000);
    expect(session.hasForegroundAsyncJob).toBe(false);
    expect(countCpuRows(session)).toBeGreaterThanOrEqual(2);
    expect(texts(session).some((t) => /^Average:\s+\d+\s+\d+\s+\d+\.\d{2}/.test(t))).toBe(true);
  });

  it('prints Average on Ctrl+C and unlocks the prompt', async () => {
    session.setInput('pidstat 1');
    session.handleKey(key('Enter'));
    await waitFor(session, (l) => l.some((t) => /UID\s+PID\s+%usr/.test(t)));
    expect(session.hasForegroundAsyncJob).toBe(true);
    await waitFor(session, () => countCpuRows(session) >= 1);

    session.handleKey(key('c', { ctrlKey: true }));
    await tick();
    expect(session.hasForegroundAsyncJob).toBe(false);
    expect(texts(session).some((t) => t === '^C')).toBe(true);
    expect(texts(session).some((t) => /^Average:\s+\d+\s+\d+\s+\d+\.\d{2}/.test(t))).toBe(true);
  });

  it('header (banner + column row) only appears once across streamed frames', async () => {
    session.setInput('pidstat 1 3');
    session.handleKey(key('Enter'));
    await waitFor(session, () => !session.hasForegroundAsyncJob && countCpuRows(session) >= 3, 8000);
    const banners = texts(session).filter((t) => /Linux \S+ \(/.test(t)).length;
    const columnHeaders = texts(session).filter((t) => /UID\s+PID\s+%usr/.test(t)).length;
    expect(banners).toBe(1);
    expect(columnHeaders).toBe(1);
  });
});

describe('Linux pidstat — pure parser + formatters + accumulator', () => {
  it('parses -r, -u, -p list, interval, count', () => {
    expect(parsePidstatArgs([])).toMatchObject({ report: 'cpu', selectedPids: null });
    expect(parsePidstatArgs(['-r'])).toMatchObject({ report: 'memory' });
    expect(parsePidstatArgs(['-p', '1,2,3', '1', '2'])).toMatchObject({
      selectedPids: [1, 2, 3], intervalSeconds: 1, count: 2,
    });
  });

  it('rejects bad -p and unknown options', () => {
    expect(parsePidstatArgs(['-p', 'foo'])).toEqual({ error: 'pidstat: invalid -p argument: foo' });
    expect(parsePidstatArgs(['--bogus'])).toEqual({ error: 'pidstat: unknown option: --bogus' });
  });

  it('CPU column header is sysstat-shaped', () => {
    const h = pidstatColumnHeader({
      intervalSeconds: 1, count: null, report: 'cpu',
      selectedPids: null, selfOnly: false, humanReadable: false,
    }, new Date('2026-06-26T13:24:05'));
    expect(h).toContain('UID');
    expect(h).toContain('%usr');
    expect(h).toContain('%CPU');
    expect(h).toContain('Command');
  });

  it('formats CPU and memory rows at the expected column widths', () => {
    const cpu: PidstatCpuRow = {
      uid: 0, pid: 1, usr: 1.5, system: 0.5, guest: 0, wait: 0, cpu: 2.0, cpuNumber: 0, command: 'systemd',
    };
    expect(formatPidstatCpuRow(new Date(), cpu)).toMatch(/0\s+1\s+1\.50\s+0\.50/);

    const mem: PidstatMemRow = {
      uid: 0, pid: 1, minfltPerSec: 0, majfltPerSec: 0, vszKib: 12345, rssKib: 6789, memPct: 1.50, command: 'systemd',
    };
    expect(formatPidstatMemRow(new Date(), mem)).toMatch(/12345\s+6789\s+1\.50/);
  });

  it('CPU accumulator averages across multiple samples', () => {
    const acc = new PidstatAccumulator<PidstatCpuRow>('cpu');
    acc.add([{ uid: 0, pid: 1, usr: 10, system: 5, guest: 0, wait: 0, cpu: 15, cpuNumber: 0, command: 'systemd' }]);
    acc.add([{ uid: 0, pid: 1, usr: 30, system: 15, guest: 0, wait: 0, cpu: 45, cpuNumber: 0, command: 'systemd' }]);
    expect(acc.sampleCount()).toBe(2);
    const avg = acc.averages()[0] as PidstatCpuRow;
    expect(avg.usr).toBeCloseTo(20);
    expect(avg.cpu).toBeCloseTo(30);
    expect(formatPidstatAverageCpuRow(avg)).toContain('Average:');
  });
});
