/*
 * `show ip ospf database router|network|summary|external` ignored every word
 * but `detail`, so `... zorglub` answered like the bare command.
 *
 * Measured before the change: 4 of the 8 cases fall (one unknown word per LSA
 * type); the 4 witnesses (bare, detail, a link-state ID, self-originate) pass
 * either way. The selector set (detail, self-originate, adv-router, an
 * address, three words at most) is from memory, not from a fetched page.
 */
import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';

type Cli = { executeCommand(line: string): Promise<string> };

async function exec(): Promise<Cli> {
  const r = new CiscoRouter('R1', 0, 0) as unknown as Cli & { powerOn(): void };
  r.powerOn();
  await r.executeCommand('enable');
  return r;
}

describe('show ip ospf database selectors', () => {
  it.each([
    'show ip ospf database router', 'show ip ospf database router detail',
    'show ip ospf database network 1.1.1.1', 'show ip ospf database router self-originate',
  ])('witness: `%s` is accepted', async (line) => {
    expect(await (await exec()).executeCommand(line)).not.toMatch(/Invalid input/);
  });

  it.each(['router', 'network', 'summary', 'external'])('`%s zorglub` is refused', async (kind) => {
    expect(await (await exec()).executeCommand(`show ip ospf database ${kind} zorglub`))
      .toMatch(/Invalid input detected/);
  });
});
