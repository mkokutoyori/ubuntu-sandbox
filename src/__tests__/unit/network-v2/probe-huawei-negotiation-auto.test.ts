/*
 * `negotiation <word>` on a Huawei interface: any word other than `auto`
 * silently turned auto-negotiation OFF (the handler compared the word to
 * `auto` and took everything else as "off").
 *
 * Measured before the change: 4 of the 6 cases fall (router and switch,
 * `negotiation zorglub` and `negotiation auto zorglub`). The two witnesses
 * (`negotiation auto` on each) pass either way. Turning negotiation off is
 * `undo negotiation auto` in VRP, a different command not touched here; the
 * grammar is from memory, not from a fetched page.
 */
import { describe, it, expect } from 'vitest';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';

type Cli = { executeCommand(line: string): Promise<string> };

async function onInterface(kind: 'router' | 'switch'): Promise<Cli> {
  const d = (kind === 'router' ? new HuaweiRouter('D1', 0, 0) : new HuaweiSwitch('switch-huawei', 'D1', 24, 0, 0)) as unknown as Cli & { powerOn(): void };
  d.powerOn();
  const port = kind === 'router' ? 'GigabitEthernet0/0/0' : 'GigabitEthernet0/0/1';
  for (const l of ['system-view', `interface ${port}`]) await d.executeCommand(l);
  return d;
}

describe.each(['router', 'switch'] as const)('Huawei %s negotiation', (kind) => {
  it('witness: `negotiation auto` is accepted', async () => {
    expect(await (await onInterface(kind)).executeCommand('negotiation auto')).toBe('');
  });

  it.each(['negotiation zorglub', 'negotiation auto zorglub'])('`%s` is refused', async (line) => {
    expect(await (await onInterface(kind)).executeCommand(line)).toMatch(/Error/);
  });
});
