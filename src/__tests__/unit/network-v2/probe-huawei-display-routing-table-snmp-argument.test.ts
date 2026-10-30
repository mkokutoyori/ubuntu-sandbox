/*
 * `display ip routing-table <word>` and `display snmp-agent <word>` printed
 * their normal output for a word they do not have. VRP answers `Error: Wrong
 * parameter found at '^' position.`
 *
 * Measured before the change: 2 of the 6 cases fall (`display ip routing-table
 * zorglub` and `display snmp-agent zorglub`); the 4 witnesses (`display ip
 * routing-table`, `... statistics`, `... 10.0.0.1`, `display snmp-agent`) pass
 * either way. The keyword set accepted after `routing-table` (statistics,
 * verbose, vpn-instance, protocol, summary, limit, interface, an address) is
 * from memory, not from a fetched page.
 */
import { describe, it, expect } from 'vitest';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';

type Cli = { executeCommand(line: string): Promise<string> };

function router(): Cli {
  const r = new HuaweiRouter('R1', 0, 0) as unknown as Cli & { powerOn(): void };
  r.powerOn();
  return r;
}

describe('display ip routing-table and display snmp-agent', () => {
  it.each([
    'display ip routing-table', 'display ip routing-table statistics',
    'display ip routing-table 10.0.0.1', 'display snmp-agent',
  ])('witness: `%s` is accepted', async (line) => {
    expect(await router().executeCommand(line)).not.toMatch(/Wrong parameter/);
  });

  it.each(['display ip routing-table zorglub', 'display snmp-agent zorglub'])(
    '`%s` is refused', async (line) => {
      expect(await router().executeCommand(line)).toMatch(/Wrong parameter/);
    });
});
