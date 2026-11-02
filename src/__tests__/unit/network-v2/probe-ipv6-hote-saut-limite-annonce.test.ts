/**
 * The Cur Hop Limit field of a Router Advertisement (RFC 4861 §4.2) on a Linux host: ndisc_router_discovery copies a non-zero value into net.ipv6.conf.<if>.hop_limit unless it is
 * below accept_ra_min_hop_limit (default 1); the kernel reads that device value for every datagram it sends out of the interface (ip6_dst_hoplimit), not a global. Measured before the change:
 * the field was never read, hop_limit and accept_ra_min_hop_limit did not exist and every IPv6 datagram left with 64.
 * Discriminated with git stash on src/network: all 6 cases fall. The WITNESS (a zero field leaves 64) falls too, only because the knob did not exist; its meaning rests on the first case, which reads the same knob after a non-zero field.
 */
import { describe, it, expect, beforeEach } from 'vitest';
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

const KNOB = 'net.ipv6.conf.eth0.hop_limit';

describe('the Cur Hop Limit of a Router Advertisement', () => {
  it('becomes the interface hop limit', async () => {
    const { onRouter, onHost } = await radvdLab(clock, config('AdvCurHopLimit 32;'));
    await onRouter('systemctl start radvd');
    expect(await onHost(`sysctl -n ${KNOB}`)).toBe('32');
  });

  it('WITNESS: a zero field leaves the default of 64', async () => {
    const { onRouter, onHost } = await radvdLab(clock, config('AdvCurHopLimit 0;'));
    await onRouter('systemctl start radvd');
    expect(await onHost(`sysctl -n ${KNOB}`)).toBe('64');
  });

  it('is the hop limit of the echo requests the host sends', async () => {
    const { router, onRouter, onHost } = await radvdLab(clock, config('AdvCurHopLimit 32;'));
    const limits: number[] = [];
    router.attachCapture(({ direction, frame }) => {
      const ip = frame.payload as IPv6Packet | undefined;
      const icmp = ip?.payload as ICMPv6Packet | undefined;
      if (direction === 'in' && ip?.type === 'ipv6' && icmp?.icmpType === 'echo-request') limits.push(ip.hopLimit);
    });
    await onRouter('systemctl start radvd');
    const peer = (await onRouter('ip -6 addr show dev eth0 scope link')).match(/inet6 (fe80::\S+?)\//)![1];
    const pinging = onHost(`ping -6 -c 1 ${peer}%eth0`);
    for (let step = 0; step < 6; step++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      await clock.advance(1000);
    }
    await pinging;
    expect(limits).toEqual([32]);
  });

  it('is ignored below accept_ra_min_hop_limit', async () => {
    const { onRouter, onHost } = await radvdLab(clock, config('AdvCurHopLimit 10;'));
    await onHost('sysctl -w net.ipv6.conf.eth0.accept_ra_min_hop_limit=20');
    await onRouter('systemctl start radvd');
    expect(await onHost(`sysctl -n ${KNOB}`)).toBe('64');
  });

  it('can be written', async () => {
    const { onHost } = await radvdLab(clock, null);
    await onHost(`sysctl -w ${KNOB}=40`);
    expect(await onHost(`sysctl -n ${KNOB}`)).toBe('40');
  });

  it('is 64 on the default scope', async () => {
    const { onHost } = await radvdLab(clock, null);
    expect(await onHost('sysctl -n net.ipv6.conf.default.hop_limit')).toBe('64');
  });
});
