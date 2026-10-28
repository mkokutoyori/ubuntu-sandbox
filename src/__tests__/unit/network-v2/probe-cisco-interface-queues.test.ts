/*
 * Interface sub-commands whose tail was dropped or stored verbatim.
 *
 * Measured before the change: 14 of the 24 cases fall. `negotiation zorglub`
 * silently turned auto-negotiation OFF (anything but `auto` was read as
 * "off"), `ip tcp adjust-mss zorglub` and a value outside 500-1460 were
 * accepted and ignored, `ip hello-interval eigrp` and `ip hold-time eigrp`
 * kept any word and stored it in the running-config, `encapsulation zorglub`
 * and `encapsulation dot1Q 10 zorglub` were accepted, and `ip ospf
 * authentication zorglub` enabled simple authentication; `tunnel source
 * zorglub` and `tunnel source 999.1.1.1` were accepted (a source is an address
 * or an interface name). The six witnesses
 * (the valid form of each family) pass either way.
 */
import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';

type Cli = { executeCommand(line: string): Promise<string> };

async function onInterface(): Promise<Cli> {
  const r = new CiscoRouter('R1', 0, 0) as unknown as Cli & { powerOn(): void };
  r.powerOn();
  for (const l of ['enable', 'configure terminal', 'interface GigabitEthernet0/0']) {
    await r.executeCommand(l);
  }
  return r;
}

const REFUSED = /Invalid input detected|Incomplete command/;

describe('interface sub-command tails', () => {
  it.each([
    'negotiation auto', 'ip tcp adjust-mss 1360', 'ip hello-interval eigrp 100 10',
    'ip hold-time eigrp 100 30', 'ip ospf authentication', 'ip ospf authentication null',
  ])('witness: `%s` is accepted', async (line) => {
    expect(await (await onInterface()).executeCommand(line)).toBe('');
  });

  it.each([
    'negotiation zorglub', 'negotiation auto zorglub',
    'ip tcp adjust-mss zorglub', 'ip tcp adjust-mss 100', 'ip tcp adjust-mss 9000',
    'ip hello-interval eigrp 100 zorglub', 'ip hello-interval eigrp 100',
    'ip hold-time eigrp zorglub 30', 'ip hello-interval eigrp 100 10 zorglub',
    'encapsulation zorglub', 'ip ospf authentication zorglub',
    'ip ospf authentication null zorglub',
  ])('refuses `%s`', async (line) => {
    expect(await (await onInterface()).executeCommand(line)).toMatch(REFUSED);
  });
});

describe('tunnel source', () => {
  it.each(['tunnel source zorglub', 'tunnel source 999.1.1.1', 'tunnel source 10.0.0.1 extra'])(
    'refuses `%s`', async (line) => {
      expect(await (await onInterface()).executeCommand(line)).toMatch(REFUSED);
    });

  it.each(['tunnel source 10.0.0.1', 'tunnel source GigabitEthernet0/0', 'tunnel source Loopback0'])(
    'witness: accepts `%s`', async (line) => {
      expect(await (await onInterface()).executeCommand(line)).not.toMatch(REFUSED);
    });
});
