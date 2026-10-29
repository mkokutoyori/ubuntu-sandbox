/*
 * `show ip igmp groups|interface`, `show ip cef`, `show ip sla statistics`
 * and `show snmp` read the words they knew and ignored the rest.
 *
 * Measured before the change: 6 of the 14 cases fall (one unknown word per
 * command, `show ip igmp interface` included); the 8 witnesses (bare forms
 * plus one valid selector each) pass either way. Selector sets - igmp groups:
 * detail|group|interface (max two); igmp interface: one interface; cef:
 * detail|summary|unresolved|internal|vrf NAME|prefix|interface; sla
 * statistics: details|aggregated|operation id; snmp: chassis|community|
 * contact|engineID|group|host|location|mib|pending|sessions|stats|user|view|
 * context - are from memory, not from a fetched page.
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

const WITNESSES = [
  'show ip igmp groups', 'show ip igmp groups detail', 'show ip igmp interface',
  'show ip cef', 'show ip cef 10.0.0.0/8', 'show ip sla statistics',
  'show ip sla statistics aggregated', 'show snmp',
];

const REFUSALS = [
  'show ip igmp groups zorglub', 'show ip igmp interface zorglub',
  'show ip cef zorglub', 'show ip sla statistics zorglub', 'show snmp zorglub',
  'show ip igmp groups detail detail zorglub',
];

describe('show igmp, cef, sla statistics and snmp selectors', () => {
  it.each(WITNESSES)('witness: `%s` is accepted', async (line) => {
    expect(await (await exec()).executeCommand(line)).not.toMatch(/Invalid input/);
  });

  it.each(REFUSALS)('`%s` is refused', async (line) => {
    expect(await (await exec()).executeCommand(line)).toMatch(/Invalid input detected/);
  });
});
