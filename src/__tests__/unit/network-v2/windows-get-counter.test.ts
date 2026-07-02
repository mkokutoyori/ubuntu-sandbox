import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { WindowsTerminalSession } from '@/terminal/sessions/WindowsTerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import {
  parseGetCounterArgs, sampleCounterSet, formatCounterSnapshot, formatCounterSet,
  newRateState, DEFAULT_COUNTERS,
} from '@/network/devices/windows/GetCounter';

function key(k: string, opts: { ctrlKey?: boolean } = {}): KeyEvent {
  return { key: k, ctrlKey: opts.ctrlKey ?? false, altKey: false, metaKey: false, shiftKey: false };
}
const tick = () => new Promise<void>((r) => setTimeout(r, 30));
function texts(s: WindowsTerminalSession): string[] { return s.lines.map((l) => l.text); }
async function waitFor(s: WindowsTerminalSession, pred: (l: string[]) => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) { if (pred(texts(s))) return; await tick(); }
}

async function enterPowerShell(session: WindowsTerminalSession): Promise<void> {
  session.setInput('powershell');
  session.handleKey(key('Enter'));
  await new Promise((r) => setTimeout(r, 60));
}

async function typePs(session: WindowsTerminalSession, line: string): Promise<void> {
  session.setInputBuf(line);
  session.handleKey(key('Enter'));
  await tick();
}

describe('Get-Counter — parser', () => {
  it('defaults to the curated counter set when no -Counter is passed', () => {
    const p = parseGetCounterArgs([]);
    expect(p.counters).toEqual(DEFAULT_COUNTERS);
    expect(p.sampleInterval).toBe(1);
    expect(p.maxSamples).toBe(1);
    expect(p.continuous).toBe(false);
  });

  it('parses -Counter named and positional with comma list', () => {
    expect(parseGetCounterArgs(['-Counter', '"\\Memory\\Available MBytes,\\System\\Processes"']).counters)
      .toEqual(['\\Memory\\Available MBytes', '\\System\\Processes']);
    expect(parseGetCounterArgs(['"\\System\\Processes"']).counters).toEqual(['\\System\\Processes']);
  });

  it('parses -SampleInterval, -MaxSamples and -Continuous', () => {
    const p = parseGetCounterArgs(['-SampleInterval', '2', '-MaxSamples', '5', '-Continuous']);
    expect(p.sampleInterval).toBe(2);
    expect(p.maxSamples).toBe(5);
    expect(p.continuous).toBe(true);
  });

  it('parses -ListSet', () => {
    expect(parseGetCounterArgs(['-ListSet', 'memory']).listSet).toBe('memory');
  });

  it('rejects bad values', () => {
    expect(parseGetCounterArgs(['-SampleInterval', '-1']).parseError).toMatch(/positive integer/);
    expect(parseGetCounterArgs(['-MaxSamples', 'x']).parseError).toMatch(/positive integer/);
    expect(parseGetCounterArgs(['--bogus']).parseError).toMatch(/unrecognized/);
  });

  it('flags -? / --help', () => {
    expect(parseGetCounterArgs(['-?']).showHelp).toBe(true);
    expect(parseGetCounterArgs(['--help']).showHelp).toBe(true);
  });
});

describe('Get-Counter — formatCounterSet (catalog browsing)', () => {
  it('lists the paths of a known set', () => {
    const out = formatCounterSet('memory');
    expect(out).toContain('CounterSetName     : memory');
    expect(out).toContain('\\Memory\\Available MBytes');
    expect(out).toContain('\\Memory\\% Committed Bytes In Use');
  });

  it('reports unknown sets', () => {
    expect(formatCounterSet('bogus')).toContain('Counter set was not found: bogus');
  });
});

describe('Get-Counter — sampleCounterSet (sampling)', () => {
  let win: WindowsPC;
  beforeEach(() => {
    EquipmentRegistry.resetInstance();
    win = new WindowsPC('windows-pc', 'PC1', 0, 0);
    win.powerOn();
  });

  it('samples the default counter set against the device hardware', () => {
    const snap = sampleCounterSet(DEFAULT_COUNTERS, win, newRateState());
    expect(snap.samples).toHaveLength(2);
    expect(snap.samples[0].path).toBe('\\Processor(_Total)\\% Processor Time');
    expect(snap.samples[0].unknown).toBe(false);
    expect(snap.samples[1].path).toBe('\\Memory\\Available MBytes');
    expect(snap.samples[1].value).toBeGreaterThan(0);
  });

  it('reports unknown=true on unrecognised paths', () => {
    const snap = sampleCounterSet(['\\Bogus\\Counter'], win, newRateState());
    expect(snap.samples[0].unknown).toBe(true);
    expect(snap.samples[0].value).toBe(0);
  });

  it('expands wildcard interface counters into per-port samples', () => {
    const snap = sampleCounterSet(['\\Network Interface(*)\\Bytes Total/sec'], win, newRateState());
    expect(snap.samples.length).toBeGreaterThanOrEqual(1);
    expect(snap.samples.every((s) => s.path.includes('\\Network Interface('))).toBe(true);
    expect(snap.samples.every((s) => !s.unknown)).toBe(true);
  });
});

describe('Get-Counter — formatCounterSnapshot', () => {
  it('renders Timestamp + per-sample blocks with backslashed host\\path', () => {
    const snap = {
      ts: new Date(0),
      samples: [
        { path: '\\Memory\\Available MBytes', value: 3024, unknown: false },
        { path: '\\System\\Processes', value: 42, unknown: false },
      ],
    };
    const out = formatCounterSnapshot('PC1', snap);
    expect(out).toContain('Timestamp');
    expect(out).toContain('CounterSamples');
    expect(out).toContain('\\\\pc1\\memory\\available mbytes :');
    expect(out).toContain('3024.00');
    expect(out).toContain('\\\\pc1\\system\\processes :');
    expect(out).toContain('42.00');
  });
});

describe('Get-Counter — UI streaming through WindowsTerminalSession', () => {
  let win: WindowsPC;
  let session: WindowsTerminalSession;

  beforeEach(async () => {
    EquipmentRegistry.resetInstance();
    win = new WindowsPC('windows-pc', 'PC1', 0, 0);
    win.powerOn();
    session = new WindowsTerminalSession('term-1', win);
    await session.init?.();
    await enterPowerShell(session);
  });

  it('Get-Counter (one-shot, default counters) prints a single snapshot synchronously', async () => {
    await typePs(session, 'Get-Counter');
    expect(session.hasForegroundAsyncJob).toBe(false);
    const all = texts(session);
    expect(all.some((t) => t === 'Timestamp                 CounterSamples')).toBe(true);
    expect(all.some((t) => t.includes('\\\\pc1\\processor(_total)\\% processor time'))).toBe(true);
    expect(all.some((t) => t.includes('\\\\pc1\\memory\\available mbytes'))).toBe(true);
  });

  it('Get-Counter -ListSet memory prints the set catalog and stays sync', async () => {
    await typePs(session, 'Get-Counter -ListSet memory');
    expect(session.hasForegroundAsyncJob).toBe(false);
    expect(texts(session).some((t) => t.includes('CounterSetName     : memory'))).toBe(true);
  });

  it('Get-Counter -MaxSamples 2 -SampleInterval 1 streams two snapshots and exits', async () => {
    await typePs(session, 'Get-Counter -MaxSamples 2 -SampleInterval 1');
    await waitFor(session, (l) => l.filter((t) => t === 'Timestamp                 CounterSamples').length >= 2, 4000);
    await waitFor(session, () => !session.hasForegroundAsyncJob, 4000);
    expect(session.hasForegroundAsyncJob).toBe(false);
  });

  it('Get-Counter -Continuous keeps the job running until Ctrl+C', async () => {
    await typePs(session, 'Get-Counter -Continuous -SampleInterval 1');
    await waitFor(session, (l) => l.some((t) => t.includes('Timestamp')), 3000);
    expect(session.hasForegroundAsyncJob).toBe(true);

    session.handleKey(key('c', { ctrlKey: true }));
    await tick();
    expect(session.hasForegroundAsyncJob).toBe(false);
    expect(texts(session).some((t) => t === '^C')).toBe(true);
  });

  it('rejects unknown parameters with a clear inline error', async () => {
    await typePs(session, 'Get-Counter --bogus');
    expect(session.hasForegroundAsyncJob).toBe(false);
    expect(texts(session).some((t) => t.includes('unrecognized parameter --bogus'))).toBe(true);
  });
});
