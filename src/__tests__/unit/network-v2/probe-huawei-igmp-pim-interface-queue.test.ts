/*
 * Huawei interface `igmp` and `pim` commands followed by a stray word.
 *
 * Measured before the change: 6 of the 9 cases fall (`igmp enable zorglub`,
 * `igmp version 2 zorglub`, `igmp static-group 225.1.1.1 zorglub`, `pim sm
 * zorglub`, `pim dm zorglub`, `pim timer hello 30 zorglub`); the tail was
 * dropped and the command applied. The three witnesses (`igmp enable`,
 * `pim sm`, `pim timer hello 30`) pass either way. Arity of each form is from
 * memory, not from a fetched page.
 */
import { describe, it, expect } from 'vitest';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';

type Cli = { executeCommand(line: string): Promise<string> };

async function onInterface(): Promise<Cli> {
  const r = new HuaweiRouter('R1', 0, 0) as unknown as Cli & { powerOn(): void };
  r.powerOn();
  for (const l of ['system-view', 'interface GigabitEthernet0/0/0']) await r.executeCommand(l);
  return r;
}

describe('Huawei interface igmp and pim tails', () => {
  it.each(['igmp enable', 'pim sm', 'pim timer hello 30'])('witness: `%s` is accepted', async (line) => {
    expect(await (await onInterface()).executeCommand(line)).toBe('');
  });

  it.each([
    'igmp enable zorglub', 'igmp version 2 zorglub', 'igmp static-group 225.1.1.1 zorglub',
    'pim sm zorglub', 'pim dm zorglub', 'pim timer hello 30 zorglub',
  ])('`%s` is refused', async (line) => {
    expect(await (await onInterface()).executeCommand(line)).toMatch(/Error/);
  });
});
