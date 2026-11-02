/**
 * The MTU option of a Router Advertisement (RFC 4861 §4.6.4) on a Linux host: ndisc_router_discovery applies it as the interface's IPv6 MTU (net.ipv6.conf.<if>.mtu) when
 * accept_ra_mtu is on (default 1) and the value lies between IPV6_MIN_MTU (1280) and the device MTU; anything else is ignored. The file /proc/sys/net/ipv6/conf/<if>/mtu reads the
 * interface's IPv6 MTU and refuses a write outside the same window (EINVAL). Measured before the change: the option was never read and the file did not exist.
 * Discriminated with git stash on src/network: 6 of 7 cases fall (applied option, accept_ra_mtu=0, above the device MTU, the datagram that fails with the advertised MTU, the write window, the knob).
 * The 1 that passes either way is the WITNESS: without the option the device MTU is 1500 and the file does not hold 1400. The two "ignored" cases fall before only because the file did not exist; their meaning rests on the applied-option case, which uses the same lab with the knob and the device MTU left alone.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import type { VirtualTimeScheduler } from '@/events/Scheduler';
import { installVirtualClock } from '../../support/ntpTime';
import { radvdLab } from '../../support/radvdLab';

let clock: VirtualTimeScheduler;

beforeEach(() => {
  clock = installVirtualClock();
  EquipmentRegistry.getInstance().clear();
});

const config = (extra: string) =>
  `interface eth0 {\n  AdvSendAdvert on;\n  MinRtrAdvInterval 600;\n  MaxRtrAdvInterval 1800;\n  ${extra}\n  prefix 2001:db8:77::/64 { };\n};`;

const MTU_FILE = '/proc/sys/net/ipv6/conf/eth0/mtu';

describe('the MTU option of a Router Advertisement', () => {
  it('is applied as the interface IPv6 MTU', async () => {
    const { onRouter, onHost } = await radvdLab(clock, config('AdvLinkMTU 1400;'));
    await onRouter('systemctl start radvd');
    expect(await onHost(`cat ${MTU_FILE}`)).toBe('1400');
  });

  it('WITNESS: without the option the IPv6 MTU is the device MTU', async () => {
    const { onRouter, onHost } = await radvdLab(clock, config(''));
    await onRouter('systemctl start radvd');
    expect(await onHost('ip link show eth0')).toContain('mtu 1500');
    expect(await onHost(`cat ${MTU_FILE}`)).not.toBe('1400');
  });

  it('is ignored with accept_ra_mtu=0', async () => {
    const { onRouter, onHost } = await radvdLab(clock, config('AdvLinkMTU 1400;'));
    await onHost('sysctl -w net.ipv6.conf.eth0.accept_ra_mtu=0');
    await onRouter('systemctl start radvd');
    expect(await onHost(`cat ${MTU_FILE}`)).toBe('1500');
  });

  it('is ignored above the device MTU', async () => {
    const { onRouter, onHost } = await radvdLab(clock, config('AdvLinkMTU 1400;'));
    await onHost('ip link set eth0 mtu 1300');
    await onRouter('systemctl start radvd');
    expect(await onHost(`cat ${MTU_FILE}`)).toBe('1300');
  });

  it('makes an oversized datagram with DF fail with the advertised MTU', async () => {
    const { onRouter, onHost } = await radvdLab(clock, config('AdvLinkMTU 1400;'));
    await onRouter('systemctl start radvd');
    const peer = (await onRouter('ip -6 addr show dev eth0 scope link')).match(/inet6 (fe80::\S+?)\//)![1];
    expect(await onHost(`ping -6 -c 1 -M do -s 1440 ${peer}%eth0`)).toMatch(/local error: message too long, mtu: 1400/);
  });

  it('can be written inside the window and refused outside it', async () => {
    const { onHost } = await radvdLab(clock, null);
    await onHost(`sh -c 'echo 1350 > ${MTU_FILE}'`);
    expect(await onHost(`cat ${MTU_FILE}`)).toBe('1350');
    await onHost(`sh -c 'echo 1000 > ${MTU_FILE}'`);
    expect(await onHost(`cat ${MTU_FILE}`)).toBe('1350');
  });

  it('accept_ra_mtu is a knob of the interface, enabled by default', async () => {
    const { onHost } = await radvdLab(clock, null);
    expect(await onHost('cat /proc/sys/net/ipv6/conf/eth0/accept_ra_mtu')).toBe('1');
  });
});
