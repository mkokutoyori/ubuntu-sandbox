/*
 * The sub-commands of `neighbor <peer> ...` under `router bgp` are judged.
 *
 * Measured before the change: 13 of the 29 cases fall. Anything after the
 * peer that the handler did not know was pushed verbatim into the neighbor's
 * attribute list and rendered back, so `update-source zorglub`,
 * `ebgp-multihop zorglub`, `ebgp-multihop 300`, `timers zorglub`, a
 * `password` with no secret, `route-map RM zorglub`, `maximum-prefix zorglub`,
 * an unknown sub-command and a stray trailing word all answered success. The
 * sixteen witnesses are the forms that must keep working: remote-as, weight,
 * description, update-source with an interface name, ebgp-multihop with and
 * without a number, timers, password, in/out filters, maximum-prefix with its
 * options, next-hop-self, send-community, soft-reconfiguration, route
 * reflector client, shutdown, activate and peer-group.
 */
import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';

type Cli = { executeCommand(line: string): Promise<string> };

async function bgp(): Promise<Cli> {
  const r = new CiscoRouter('R1', 0, 0) as unknown as Cli & { powerOn(): void };
  r.powerOn();
  for (const l of ['enable', 'configure terminal', 'interface Loopback0',
    'ip address 1.1.1.1 255.255.255.255', 'exit', 'router bgp 65001']) {
    await r.executeCommand(l);
  }
  return r;
}

const REFUSED = /Invalid input detected|Incomplete command/;

describe('neighbor sub-commands under router bgp', () => {
  it.each([
    'neighbor 10.0.0.2 remote-as 65002',
    'neighbor 10.0.0.2 description core peer',
    'neighbor 10.0.0.2 weight 100',
    'neighbor 10.0.0.2 update-source Loopback0',
    'neighbor 10.0.0.2 ebgp-multihop',
    'neighbor 10.0.0.2 ebgp-multihop 5',
    'neighbor 10.0.0.2 timers 10 30',
    'neighbor 10.0.0.2 timers 10 30 20',
    'neighbor 10.0.0.2 password s3cret',
    'neighbor 10.0.0.2 route-map RM in',
    'neighbor 10.0.0.2 prefix-list PL out',
    'neighbor 10.0.0.2 maximum-prefix 1000 80 warning-only',
    'neighbor 10.0.0.2 next-hop-self',
    'neighbor 10.0.0.2 send-community both',
    'neighbor 10.0.0.2 soft-reconfiguration inbound',
    'neighbor 10.0.0.2 route-reflector-client',
  ])('witness: `%s` is accepted', async (line) => {
    const r = await bgp();
    await r.executeCommand('neighbor 10.0.0.2 remote-as 65002');
    expect(await r.executeCommand(line)).toBe('');
  });

  it.each([
    'neighbor 10.0.0.2 update-source zorglub',
    'neighbor 10.0.0.2 update-source Loopback0 extra',
    'neighbor 10.0.0.2 ebgp-multihop zorglub',
    'neighbor 10.0.0.2 ebgp-multihop 300',
    'neighbor 10.0.0.2 timers zorglub',
    'neighbor 10.0.0.2 timers 10',
    'neighbor 10.0.0.2 password',
    'neighbor 10.0.0.2 route-map RM zorglub',
    'neighbor 10.0.0.2 prefix-list PL sideways',
    'neighbor 10.0.0.2 maximum-prefix zorglub',
    'neighbor 10.0.0.2 maximum-prefix 1000 150',
    'neighbor 10.0.0.2 zorglub',
    'neighbor 10.0.0.2 shutdown now',
  ])('refuses `%s`', async (line) => {
    const r = await bgp();
    await r.executeCommand('neighbor 10.0.0.2 remote-as 65002');
    expect(await r.executeCommand(line)).toMatch(REFUSED);
  });
});
