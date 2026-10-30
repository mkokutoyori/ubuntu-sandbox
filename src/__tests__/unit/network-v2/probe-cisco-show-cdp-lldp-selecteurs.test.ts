/*
 * `show cdp` / `show lldp` selectors. `showCdp` sniffed the joined arguments
 * with `includes`, so `show cdp zorglub` answered the global block,
 * `show cdp neighbors zorglub` the table, `show cdp traffic zorglub` the
 * counters, and the same tails were dropped by `show lldp`.
 *
 * Measured before the change: 7 of the 16 cases fall (every refusal except
 * `show lldp zorglub`, which was already refused: non-regression); the 8
 * witnesses (bare forms, neighbors, neighbors detail, traffic) pass either way. The selector sets - neighbors: [interface] [detail]; interface:
 * [name]; entry: one name; traffic, local-information and errors: nothing -
 * are from memory, not from a fetched page.
 */
import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';

type Cli = { executeCommand(line: string): Promise<string> };

async function exec(): Promise<Cli> {
  const r = new CiscoRouter('R1', 0, 0) as unknown as Cli & { powerOn(): void };
  r.powerOn();
  for (const l of ['enable', 'configure terminal', 'cdp run', 'lldp run', 'end']) {
    await r.executeCommand(l);
  }
  return r;
}

const WITNESSES = [
  'show cdp', 'show cdp neighbors', 'show cdp neighbors detail', 'show cdp traffic',
  'show lldp', 'show lldp neighbors', 'show lldp neighbors detail', 'show lldp traffic',
];

const REFUSALS = [
  'show cdp zorglub', 'show cdp neighbors zorglub', 'show cdp neighbors detail zorglub',
  'show cdp traffic zorglub',
  'show lldp zorglub', 'show lldp neighbors zorglub', 'show lldp neighbors detail zorglub',
  'show lldp traffic zorglub',
];

describe('show cdp and show lldp selectors', () => {
  it.each(WITNESSES)('witness: `%s` is accepted', async (line) => {
    expect(await (await exec()).executeCommand(line)).not.toMatch(/Invalid input/);
  });

  it.each(REFUSALS)('`%s` is refused', async (line) => {
    expect(await (await exec()).executeCommand(line)).toMatch(/Invalid input detected/);
  });
});
