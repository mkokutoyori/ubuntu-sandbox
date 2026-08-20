import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import {
  parseVmstatArgs,
  vmstatHeader,
  formatVmstatRow,
} from '@/network/devices/linux/system/Vmstat';

function key(k: string, opts: { ctrlKey?: boolean } = {}): KeyEvent {
  return { key: k, ctrlKey: opts.ctrlKey ?? false, altKey: false, metaKey: false, shiftKey: false };
}
const tick = () => new Promise<void>((r) => setTimeout(r, 20));
function texts(s: LinuxTerminalSession): string[] { return s.lines.map((l) => l.text); }
function countDataRows(s: LinuxTerminalSession): number {
  return texts(s).filter((t) => /^\s*\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s*$/.test(t)).length;
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

describe('Linux vmstat — one-shot snapshot', () => {
  it('prints procps-ng header + one row when no interval is given', async () => {
    session.setInput('vmstat');
    session.handleKey(key('Enter'));
    await tick();
    expect(session.hasForegroundAsyncJob).toBe(false);
    const lines = texts(session);
    expect(lines.some((t) => /^procs -+memory-+ -+swap-+ -+io-+ -+system-+ -+cpu-+$/.test(t))).toBe(true);
    expect(lines.some((t) => / r  b   swpd   free   buff  cache   si   so    bi    bo   in   cs us sy id wa st/.test(t))).toBe(true);
    expect(countDataRows(session)).toBe(1);
  });
});

describe('Linux vmstat <interval> — scrolling monitor on the async pipeline', () => {
  it('keeps the prompt locked and appends rows, header printed only once', async () => {
    session.setInput('vmstat 1');
    session.handleKey(key('Enter'));
    await waitFor(session, (l) => l.some((t) => t.startsWith(' r  b')));
    expect(session.hasForegroundAsyncJob).toBe(true);
    expect(session.listAttachedStreams().length).toBe(1);

    await waitFor(session, () => countDataRows(session) >= 2);
    expect(countDataRows(session)).toBeGreaterThanOrEqual(2);

    const headerCount = texts(session).filter((t) => t.startsWith(' r  b')).length;
    expect(headerCount).toBe(1);

    session.handleKey(key('c', { ctrlKey: true }));
    await tick();
    expect(session.hasForegroundAsyncJob).toBe(false);
    expect(session.listAttachedStreams().length).toBe(0);
    expect(texts(session).some((t) => t === '^C')).toBe(true);
  });

  it('vmstat <interval> <count> exits on its own after <count> rows', async () => {
    session.setInput('vmstat 1 2');
    session.handleKey(key('Enter'));
    await waitFor(session, () => !session.hasForegroundAsyncJob && countDataRows(session) >= 2, 6000);
    expect(session.hasForegroundAsyncJob).toBe(false);
    expect(countDataRows(session)).toBe(2);
  });

  it('keeps two concurrent sessions isolated', async () => {
    const other = new LinuxTerminalSession('term-2', pc);
    session.setInput('vmstat 1');
    session.handleKey(key('Enter'));
    await waitFor(session, (l) => l.some((t) => t.startsWith(' r  b')));

    expect(session.hasForegroundAsyncJob).toBe(true);
    expect(other.hasForegroundAsyncJob).toBe(false);
    expect(texts(other).length).toBe(0);

    session.handleKey(key('c', { ctrlKey: true }));
    await tick();
    expect(session.hasForegroundAsyncJob).toBe(false);
  });
});

describe('Linux vmstat — pure parser + formatters', () => {
  it('parses interval, count, wide, no-recurring-header, -S unit', () => {
    expect(parseVmstatArgs(['1', '3'])).toMatchObject({ intervalSeconds: 1, count: 3 });
    expect(parseVmstatArgs(['-w', '1'])).toMatchObject({ wide: true, intervalSeconds: 1 });
    expect(parseVmstatArgs(['-n', '1'])).toMatchObject({ noRecurringHeader: true });
    expect(parseVmstatArgs(['-S', 'M', '1'])).toMatchObject({ unit: 'M' });
  });

  it('rejects unknown -S unit and unknown flags', () => {
    expect(parseVmstatArgs(['-S', 'Z', '1'])).toEqual({ error: "vmstat: -S requires k, K, m, or M" });
    expect(parseVmstatArgs(['--bogus'])).toEqual({ error: 'vmstat: unrecognized option: --bogus' });
  });

  it('renders a normal-width header that matches procps-ng', () => {
    const args = parseVmstatArgs(['1']) as ReturnType<typeof parseVmstatArgs> & { error?: string };
    if ('error' in args) throw new Error(args.error);
    const h = vmstatHeader(args);
    expect(h.split('\n')[0]).toBe('procs -----------memory---------- ---swap-- -----io---- -system-- ------cpu-----');
    expect(h.split('\n')[1]).toBe(' r  b   swpd   free   buff  cache   si   so    bi    bo   in   cs us sy id wa st');
  });

  it('renders a wide-mode header with extra padding', () => {
    const args = parseVmstatArgs(['-w', '1']) as ReturnType<typeof parseVmstatArgs> & { error?: string };
    if ('error' in args) throw new Error(args.error);
    const h = vmstatHeader(args);
    expect(h).toContain('--procs--');
    expect(h).toContain('--------cpu--------');
  });

  it('formats a row at the right column widths', () => {
    const args = parseVmstatArgs(['1']) as ReturnType<typeof parseVmstatArgs> & { error?: string };
    if ('error' in args) throw new Error(args.error);
    const row = formatVmstatRow({
      procsR: 1, procsB: 0,
      swpdKib: 0, freeKib: 123456, buffKib: 7890, cacheKib: 56789,
      siKibPerSec: 0, soKibPerSec: 0, biBlocksPerSec: 0, boBlocksPerSec: 0,
      interruptsPerSec: 0, ctxSwitchesPerSec: 0,
      cpuUser: 3, cpuSystem: 4, cpuIdle: 93, cpuIowait: 0, cpuSteal: 0,
    }, args);
    expect(row.length).toBeGreaterThan(60);
    expect(row).toContain('123456');
    expect(row).toContain(' 7890');
    expect(row).toContain('56789');
  });
});
