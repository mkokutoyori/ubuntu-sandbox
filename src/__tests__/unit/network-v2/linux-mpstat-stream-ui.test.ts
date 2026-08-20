import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import {
  parseMpstatArgs,
  mpstatBanner,
  mpstatColumnHeader,
  formatMpstatRow,
  formatMpstatAverageRow,
  MpstatAccumulator,
} from '@/network/devices/linux/system/Mpstat';
import { CpuSpec } from '@/network/devices/host/hardware/CpuSpec';
import { KernelInfo } from '@/network/devices/host/identity/KernelInfo';

function key(k: string, opts: { ctrlKey?: boolean } = {}): KeyEvent {
  return { key: k, ctrlKey: opts.ctrlKey ?? false, altKey: false, metaKey: false, shiftKey: false };
}
const tick = () => new Promise<void>((r) => setTimeout(r, 20));
function texts(s: LinuxTerminalSession): string[] { return s.lines.map((l) => l.text); }
function countDataRows(s: LinuxTerminalSession): number {
  return texts(s).filter((t) => /^\d\d:\d\d:\d\d (?:AM|PM)\s+(?:all|\d+)\s+\d+\.\d{2}/.test(t)).length;
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

describe('Linux mpstat — one-shot snapshot', () => {
  it('prints banner + column header + aggregate row', async () => {
    session.setInput('mpstat');
    session.handleKey(key('Enter'));
    await tick();
    expect(session.hasForegroundAsyncJob).toBe(false);
    const lines = texts(session);
    expect(lines.some((t) => /Linux \S+ \(.+\)\s+\d{2}\/\d{2}\/\d{4}\s+_\S+_\s+\(\d+ CPU\)/.test(t))).toBe(true);
    expect(lines.some((t) => /CPU\s+%usr\s+%nice\s+%sys\s+%iowait/.test(t))).toBe(true);
    expect(countDataRows(session)).toBe(1);
  });

  it('-P ALL prints aggregate plus one row per CPU', async () => {
    session.setInput('mpstat -P ALL');
    session.handleKey(key('Enter'));
    await tick();
    const dataRows = countDataRows(session);
    expect(dataRows).toBeGreaterThanOrEqual(2);
  });
});

describe('Linux mpstat <interval> — streaming on the async pipeline', () => {
  it('streams rows, prints Average on count exhaustion', async () => {
    session.setInput('mpstat 1 2');
    session.handleKey(key('Enter'));
    await waitFor(session, () => !session.hasForegroundAsyncJob && countDataRows(session) >= 2, 6000);
    expect(session.hasForegroundAsyncJob).toBe(false);
    expect(countDataRows(session)).toBe(2);
    expect(texts(session).some((t) => /^Average:\s+all\s+\d+\.\d{2}/.test(t))).toBe(true);
  });

  it('prints Average on Ctrl+C and unlocks the prompt', async () => {
    session.setInput('mpstat 1');
    session.handleKey(key('Enter'));
    await waitFor(session, (l) => l.some((t) => /CPU\s+%usr/.test(t)));
    expect(session.hasForegroundAsyncJob).toBe(true);
    await waitFor(session, () => countDataRows(session) >= 1);

    session.handleKey(key('c', { ctrlKey: true }));
    await tick();
    expect(session.hasForegroundAsyncJob).toBe(false);
    expect(texts(session).some((t) => t === '^C')).toBe(true);
    expect(texts(session).some((t) => /^Average:\s+all\s+\d+\.\d{2}/.test(t))).toBe(true);
  });

  it('header (banner + column row) only appears once across streamed frames', async () => {
    session.setInput('mpstat 1 3');
    session.handleKey(key('Enter'));
    await waitFor(session, () => !session.hasForegroundAsyncJob && countDataRows(session) >= 3, 8000);
    const banners = texts(session).filter((t) => /Linux \S+ \(/.test(t)).length;
    const columnHeaders = texts(session).filter((t) => /CPU\s+%usr\s+%nice/.test(t)).length;
    expect(banners).toBe(1);
    expect(columnHeaders).toBe(1);
  });
});

describe('Linux mpstat — pure parser + formatters + accumulator', () => {
  it('parses -P ALL, -P 0,1, interval, count', () => {
    expect(parseMpstatArgs(['-P', 'ALL'])).toMatchObject({ showAllCpus: true });
    expect(parseMpstatArgs(['-P', '0,1', '1', '3'])).toMatchObject({
      selectedCpus: [0, 1], intervalSeconds: 1, count: 3,
    });
    expect(parseMpstatArgs(['1'])).toMatchObject({ intervalSeconds: 1, count: null });
  });

  it('rejects unknown -P arg and unknown options', () => {
    expect(parseMpstatArgs(['-P', 'foo'])).toEqual({ error: 'mpstat: invalid -P argument: foo' });
    expect(parseMpstatArgs(['--bogus'])).toEqual({ error: 'mpstat: unknown option: --bogus' });
  });

  it('banner format matches sysstat: kernel hostname date _arch_ (N CPU)', () => {
    const cpu = new CpuSpec({ sockets: 1, coresPerSocket: 2, threadsPerCore: 1, architecture: 'x86_64' });
    const kernel = new KernelInfo({ sysname: 'Linux', release: '5.15.0-130-generic' });
    const banner = mpstatBanner(kernel, 'pc1', cpu, new Date('2026-06-26T13:24:00'));
    expect(banner).toMatch(/^Linux 5\.15\.0-130-generic \(pc1\)\s+06\/26\/2026\s+_x86_64_\s+\(2 CPU\)/);
  });

  it('column header lists all 10 %-columns', () => {
    const h = mpstatColumnHeader(new Date('2026-06-26T13:24:05'));
    for (const col of ['%usr', '%nice', '%sys', '%iowait', '%irq', '%soft', '%steal', '%guest', '%gnice', '%idle']) {
      expect(h).toContain(col);
    }
  });

  it('row formatter aligns 2-decimal percentages', () => {
    const row = formatMpstatRow(new Date('2026-06-26T13:24:05'), {
      label: 'all', usr: 1.5, nice: 0, sys: 0.5, iowait: 0,
      irq: 0, soft: 0, steal: 0, guest: 0, gnice: 0, idle: 98,
    });
    expect(row).toContain('   1.50');
    expect(row).toContain('  98.00');
  });

  it('accumulator averages across multiple samples', () => {
    const acc = new MpstatAccumulator();
    acc.add([{ label: 'all', usr: 10, nice: 0, sys: 0, iowait: 0, irq: 0, soft: 0, steal: 0, guest: 0, gnice: 0, idle: 90 }]);
    acc.add([{ label: 'all', usr: 30, nice: 0, sys: 0, iowait: 0, irq: 0, soft: 0, steal: 0, guest: 0, gnice: 0, idle: 70 }]);
    expect(acc.sampleCount()).toBe(2);
    const avg = acc.averages()[0];
    expect(avg.usr).toBeCloseTo(20);
    expect(avg.idle).toBeCloseTo(80);
    expect(formatMpstatAverageRow(avg)).toContain('Average:');
  });
});
