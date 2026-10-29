/*
 * `show ip ospf neighbor <selector>`: the selector was used as a substring
 * filter over the rendered table, so any word was accepted and silently
 * produced an empty table.
 *
 * Measured before the change: 3 of the 9 cases fall (`zorglub`, `detail
 * zorglub`, `GigabitEthernet0/0 zorglub`). The six witnesses (bare, detail,
 * all, an interface, an address, an interface followed by detail) pass either
 * way. The accepted selector set (detail, all, a neighbor ID, an interface,
 * an interface followed by detail) is from memory, not from a fetched page.
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

describe('show ip ospf neighbor selector', () => {
  it.each([
    'show ip ospf neighbor', 'show ip ospf neighbor detail', 'show ip ospf neighbor all',
    'show ip ospf neighbor GigabitEthernet0/0', 'show ip ospf neighbor 9.9.9.9',
    'show ip ospf neighbor GigabitEthernet0/0 detail',
  ])('witness: `%s` is accepted', async (line) => {
    expect(await (await exec()).executeCommand(line)).not.toMatch(/Invalid input/);
  });

  it.each([
    'show ip ospf neighbor zorglub', 'show ip ospf neighbor detail zorglub',
    'show ip ospf neighbor GigabitEthernet0/0 zorglub',
  ])('`%s` is refused', async (line) => {
    expect(await (await exec()).executeCommand(line)).toMatch(/Invalid input detected/);
  });
});
