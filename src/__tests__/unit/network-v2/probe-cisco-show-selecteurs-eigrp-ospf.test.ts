/*
 * Selectors of `show ip eigrp neighbors|topology|interfaces` and `show ip
 * ospf interface`: the handlers read the first words they knew and ignored
 * the rest, so `... zorglub` answered like the bare command.
 *
 * Measured before the change: 7 of the 16 cases fall (every refusal except
 * `show ip ospf interface brief zorglub`, which another layer already
 * refused: non-regression). The 8 witnesses (the bare commands and one valid
 * selector each) pass either way. The selector sets - neighbors:
 * detail|static|interface; topology: all-links|summary|zero-successors|
 * active|pending|detail-links|prefix|AS; interfaces: detail|interface|AS;
 * ospf interface: brief|interface - are from memory, not from a fetched page.
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
  'show ip eigrp neighbors', 'show ip eigrp neighbors detail',
  'show ip eigrp topology', 'show ip eigrp topology all-links',
  'show ip eigrp interfaces', 'show ip eigrp interfaces detail',
  'show ip ospf interface', 'show ip ospf interface brief',
];

const REFUSALS = [
  'show ip eigrp neighbors zorglub', 'show ip eigrp neighbors detail zorglub',
  'show ip eigrp topology zorglub', 'show ip eigrp topology all-links zorglub zorglub',
  'show ip eigrp interfaces zorglub', 'show ip eigrp interfaces detail Gi0/0 zorglub',
  'show ip ospf interface zorglub', 'show ip ospf interface brief zorglub',
];

describe('show selectors of eigrp and ospf', () => {
  it.each(WITNESSES)('witness: `%s` is accepted', async (line) => {
    expect(await (await exec()).executeCommand(line)).not.toMatch(/Invalid input/);
  });

  it.each(REFUSALS)('`%s` is refused', async (line) => {
    expect(await (await exec()).executeCommand(line)).toMatch(/Invalid input detected/);
  });
});
