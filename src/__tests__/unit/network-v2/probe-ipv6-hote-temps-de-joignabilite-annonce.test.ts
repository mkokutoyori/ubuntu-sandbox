/**
 * The Reachable Time and Retrans Timer fields of a Router Advertisement (RFC 4861 §4.2, §6.3.4): ndisc_router_discovery stores a non-zero ReachableTime in the neighbour
 * parameters of the interface (base_reachable_time_ms, /proc/sys/net/ipv6/neigh/<if>/) and a non-zero RetransTimer in retrans_time_ms; the neighbour cache then keeps an entry REACHABLE for that
 * long and spaces its probes by the retransmit timer. Measured before the change: neither file existed for IPv6 and the cache used the 30 s / 1 s constants whatever the router advertised.
 * Discriminated with git stash on src/network: 7 of 8 cases fall (the two adopted values, the entry that goes STALE after the advertised 8 s, the probe spacing, the writable file, the defaults of the 'default' scope, the sysctl read-back).
 * The 1 that passes either way is the WITNESS: without the fields the entry is still REACHABLE after 20 s (the 30 s default holds before and after).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { MACAddress } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import type { VirtualTimeScheduler } from '@/events/Scheduler';
import type { IPv6Packet, ICMPv6Packet } from '@/network/core/types';
import { installVirtualClock } from '../../support/ntpTime';
import { radvdLab } from '../../support/radvdLab';

let clock: VirtualTimeScheduler;

beforeEach(() => {
  clock = installVirtualClock();
  EquipmentRegistry.getInstance().clear();
});

const config = (extra: string) =>
  `interface eth0 {\n  AdvSendAdvert on;\n  MinRtrAdvInterval 600;\n  MaxRtrAdvInterval 1800;\n  ${extra}\n  prefix 2001:db8:77::/64 { };\n};`;

const DIR = '/proc/sys/net/ipv6/neigh/eth0';

const ROUTER_LINK_LOCAL = 'fe80::ff:fe00:1';
const ROUTER_MAC = '02:00:00:00:00:01';
const PHANTOM_IP = 'fe80::dead';
const PHANTOM_MAC = '02:00:00:00:00:99';

type Cache = { learnFromAdvertisement(ip: string, mac: MACAddress, iface: string, flags: { solicited: boolean; isRouter: boolean; override: boolean }): void; get(ip: string): { state: string } | undefined; markUsed(ip: string): unknown };

function reachableNeighbour(host: object): string {
  const cache = (host as unknown as { neighborCache: Cache }).neighborCache;
  cache.learnFromAdvertisement(ROUTER_LINK_LOCAL, new MACAddress(ROUTER_MAC), 'eth0', { solicited: true, isRouter: false, override: true });
  return ROUTER_LINK_LOCAL;
}

const stateOf = (host: object, ip: string): string | undefined =>
  (host as unknown as { neighborCache: Cache }).neighborCache.get(ip)?.state;

describe('the Reachable Time and Retrans Timer of a Router Advertisement', () => {
  it('ReachableTime becomes base_reachable_time_ms', async () => {
    const { onRouter, onHost } = await radvdLab(clock, config('AdvReachableTime 20000;'));
    await onRouter('systemctl start radvd');
    expect(await onHost(`cat ${DIR}/base_reachable_time_ms`)).toBe('20000');
  });

  it('RetransTimer becomes retrans_time_ms', async () => {
    const { onRouter, onHost } = await radvdLab(clock, config('AdvRetransTimer 3000;'));
    await onRouter('systemctl start radvd');
    expect(await onHost(`cat ${DIR}/retrans_time_ms`)).toBe('3000');
  });

  it('WITNESS: without the fields an entry is still REACHABLE after 25 s', async () => {
    const { host, onRouter } = await radvdLab(clock, config(''));
    await onRouter('systemctl start radvd');
    const ip = reachableNeighbour(host);
    await clock.advance(20_000);
    expect(stateOf(host, ip)).toBe('reachable');
  });

  it('an entry goes STALE after the advertised reachable time', async () => {
    const { host, onRouter } = await radvdLab(clock, config('AdvReachableTime 8000;'));
    await onRouter('systemctl start radvd');
    const ip = reachableNeighbour(host);
    await clock.advance(5_000);
    expect(stateOf(host, ip)).toBe('reachable');
    await clock.advance(5_000);
    expect(stateOf(host, ip)).toBe('stale');
  });

  it('probes of a stale neighbour are spaced by the advertised retransmit timer', async () => {
    const { host, onRouter } = await radvdLab(clock, config('AdvRetransTimer 3000;'));
    const solicitations: number[] = [];
    host.attachCapture(({ direction, frame }) => {
      const ip = frame.payload as IPv6Packet | undefined;
      const icmp = ip?.payload as ICMPv6Packet | undefined;
      if (direction === 'out' && icmp?.icmpType === 'neighbor-solicitation' && ip?.destinationIP.toString() === PHANTOM_IP) solicitations.push(clock.now());
    });
    await onRouter('systemctl start radvd');
    const cache = (host as unknown as { neighborCache: Cache }).neighborCache;
    cache.learnFromAdvertisement(PHANTOM_IP, new MACAddress(PHANTOM_MAC), 'eth0', { solicited: true, isRouter: false, override: true });
    await clock.advance(31_000);
    cache.markUsed(PHANTOM_IP);
    await clock.advance(20_000);
    const spacing = solicitations.slice(1).map((at, index) => at - solicitations[index]);
    expect(solicitations.length).toBeGreaterThanOrEqual(2);
    expect(spacing[0]).toBe(3000);
  });

  it('the files are writable with a positive value only', async () => {
    const { onHost } = await radvdLab(clock, null);
    await onHost(`sh -c 'echo 12000 > ${DIR}/base_reachable_time_ms'`);
    expect(await onHost(`cat ${DIR}/base_reachable_time_ms`)).toBe('12000');
    await onHost(`sh -c 'echo 0 > ${DIR}/base_reachable_time_ms'`);
    expect(await onHost(`cat ${DIR}/base_reachable_time_ms`)).toBe('12000');
  });

  it('the default scope carries the kernel defaults', async () => {
    const { onHost } = await radvdLab(clock, null);
    expect(await onHost('cat /proc/sys/net/ipv6/neigh/default/base_reachable_time_ms')).toBe('30000');
    expect(await onHost('cat /proc/sys/net/ipv6/neigh/default/retrans_time_ms')).toBe('1000');
  });

  it('a value written on an interface is read back by sysctl', async () => {
    const { onHost } = await radvdLab(clock, null);
    await onHost('sysctl -w net.ipv6.neigh.eth0.retrans_time_ms=2500');
    expect(await onHost('sysctl -n net.ipv6.neigh.eth0.retrans_time_ms')).toBe('2500');
  });
});
