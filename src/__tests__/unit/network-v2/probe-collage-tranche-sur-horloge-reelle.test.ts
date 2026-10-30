/**
 * The paste slice that hands control back to the browser is measured on the
 * host clock, not on the simulated one.
 *
 * Measured before the fix: `pasteText` timed its 12 ms slice with
 * `simulationNowMs()`. Whenever the simulated clock does not move during the
 * paste (a virtual scheduler, a frozen lab, a clock held by the operator) the
 * slice never elapsed, the loop never yielded and a 4000-line paste froze the
 * tab for its whole duration (1.6 s measured in Chromium).
 *
 * Discriminated with `git stash push -- src/terminal`: 1 of 2 cases falls
 * before the fix ("the event loop turns while a frozen-clock paste runs").
 * The other, "every line still executes in order", is the WITNESS that the
 * mocked clock does not break the paste itself.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/network/core/SystemClock', async (original) => ({
  ...(await original<typeof import('@/network/core/SystemClock')>()),
  simulationNowMs: () => 1_700_000_000_000,
}));

import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

let session: LinuxTerminalSession;

beforeEach(() => {
  EquipmentRegistry.resetInstance();
  const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
  pc.powerOn();
  session = new LinuxTerminalSession('term-1', pc);
});

const BLOC = Array.from({ length: 300 }, (_, i) => `echo ligne${i}`).join('\n') + '\n';

describe('a paste yields on the host clock', () => {
  it('the event loop turns while a frozen-clock paste runs', async () => {
    let turns = 0;
    let stop = false;
    const beat = () => { if (!stop) { turns++; setTimeout(beat, 0); } };
    setTimeout(beat, 0);
    await new Promise((r) => setTimeout(r, 20));
    const before = turns;
    await session.pasteText(BLOC);
    stop = true;
    expect(turns - before).toBeGreaterThan(0);
  }, 60_000);

  it('WITNESS: every line still executes in order', async () => {
    await session.pasteText(BLOC);
    const out = session.lines.map((l) => l.text).join('\n');
    expect(out.indexOf('ligne0')).toBeGreaterThanOrEqual(0);
    expect(out.indexOf('ligne0')).toBeLessThan(out.indexOf('ligne299'));
  }, 60_000);
});
