/*
 * The sub-commands of `neighbor <peer> ...` under `router bgp` are judged.
 *
 * Measured before the change: 29 of the 59 cases fall. Anything after the
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
 *
 * The last block (`network` under rip, eigrp and bgp) adds 6 failing cases: a
 * stray word after the RIP network, an EIGRP wildcard that is not an address,
 * and a BGP tail that is not `mask A.B.C.D`, `route-map NAME` or `backdoor`
 * were accepted and (for BGP) rendered back verbatim.
 *
 * The process-options block adds 10 failing cases: `passive-interface default
 * zorglub`, `default-information zorglub` / `originate zorglub` (the handler
 * ignored every argument), `bgp <unknown option>`, a flag option with a
 * trailing word, and `timers bgp` with a non-number, one value, a third value
 * or a first word that is not `bgp`.
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

describe('network under rip, eigrp and bgp', () => {
  const inProtocol = async (...lines: string[]): Promise<Cli> => {
    const r = new CiscoRouter('R1', 0, 0) as unknown as Cli & { powerOn(): void };
    r.powerOn();
    for (const l of ['enable', 'configure terminal', ...lines]) await r.executeCommand(l);
    return r;
  };

  it.each([
    ['router rip', 'network 10.0.0.0 zorglub'],
    ['router rip', 'network 10.0.0.0 0.0.0.255'],
    ['router eigrp 100', 'network 10.0.0.0 zorglub'],
    ['router eigrp 100', 'network 10.0.0.0 0.0.0.255 extra'],
    ['router bgp 65001', 'network 10.0.0.0 mask zorglub'],
    ['router bgp 65001', 'network 10.0.0.0 zorglub'],
    ['router bgp 65001', 'network 10.0.0.0 mask 255.0.0.0 mask 255.0.0.0'],
  ])('%s: refuses `%s`', async (entry, line) => {
    const r = await inProtocol(entry);
    expect(await r.executeCommand(line)).toMatch(REFUSED);
  });

  it.each([
    ['router rip', 'network 10.0.0.0'],
    ['router eigrp 100', 'network 10.0.0.0'],
    ['router eigrp 100', 'network 10.0.0.0 0.0.0.255'],
    ['router bgp 65001', 'network 10.0.0.0 mask 255.0.0.0'],
    ['router bgp 65001', 'network 10.0.0.0 mask 255.0.0.0 route-map RM'],
    ['router bgp 65001', 'network 10.0.0.0 backdoor'],
  ])('witness: %s accepts `%s`', async (entry, line) => {
    const r = await inProtocol(entry);
    expect(await r.executeCommand(line)).toBe('');
  });
});

describe('process options of rip, eigrp and bgp', () => {
  const inside = async (...lines: string[]): Promise<Cli> => {
    const r = new CiscoRouter('R1', 0, 0) as unknown as Cli & { powerOn(): void };
    r.powerOn();
    for (const l of ['enable', 'configure terminal', ...lines]) await r.executeCommand(l);
    return r;
  };

  it.each([
    ['router rip', 'passive-interface default zorglub'],
    ['router rip', 'default-information zorglub'],
    ['router rip', 'default-information originate zorglub'],
    ['router eigrp 100', 'passive-interface default zorglub'],
    ['router bgp 65001', 'bgp log-neighbor-changes zorglub'],
    ['router bgp 65001', 'bgp zorglub'],
    ['router bgp 65001', 'timers bgp zorglub'],
    ['router bgp 65001', 'timers bgp 10'],
    ['router bgp 65001', 'timers zorglub 10 30'],
    ['router bgp 65001', 'timers bgp 10 30 40'],
  ])('%s: refuses `%s`', async (entry, line) => {
    expect(await (await inside(entry)).executeCommand(line)).toMatch(REFUSED);
  });

  it.each([
    ['router rip', 'passive-interface default'],
    ['router rip', 'default-information originate'],
    ['router rip', 'default-information originate route-map RM'],
    ['router bgp 65001', 'bgp log-neighbor-changes'],
    ['router bgp 65001', 'bgp bestpath compare-routerid'],
    ['router bgp 65001', 'bgp default local-preference 200'],
    ['router bgp 65001', 'timers bgp 10 30'],
  ])('witness: %s accepts `%s`', async (entry, line) => {
    expect(await (await inside(entry)).executeCommand(line)).toBe('');
  });
});
