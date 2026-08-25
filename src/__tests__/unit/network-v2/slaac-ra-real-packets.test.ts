/**
 * Stateless IPv6 autoconfiguration (SLAAC, RFC 4862) happens.
 *
 * The whole chain was written and neither of its two triggers was, so
 * it was never reached: `EndHost.sendRouterSolicitation` is complete
 * and its only caller in the repo was Windows' `ipconfig /renew6`
 * (RFC 4861 §6.3.7), and the router sent no unsolicited advertisement
 * either — `configureRA`'s timer is armed by nobody and nothing
 * advertised when a prefix was configured (§6.2.4).
 *
 * This lot writes no protocol logic; it wires the two missing triggers.
 *
 * Starting measurement: a host cabled to a router carrying
 * `ipv6 address 2001:db8::1/64` got ONLY its link-local address, and a
 * single frame crossed the wire — a CDP.
 */

import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { IPv6Packet, ICMPv6Packet } from '@/network/core/types';
import type { Equipment } from '@/network/equipment/Equipment';

/** The NDP messages actually sent, read off each machine's own ports. */
function observeNdp(...sources: Equipment[]): Array<{ deviceId: string; type: string; dst: string }> {
  const seen: Array<{ deviceId: string; type: string; dst: string }> = [];
  for (const source of sources) {
    source.attachCapture(({ direction, frame }) => {
      if (direction !== 'out') return;
      const ip = frame.payload as IPv6Packet | undefined;
      if (!ip || ip.type !== 'ipv6') return;
      const icmp = ip.payload as ICMPv6Packet | undefined;
      if (!icmp?.icmpType) return;
      seen.push({
        deviceId: source.getId(),
        type: String(icmp.icmpType),
        dst: ip.destinationIP.toString(),
      });
    });
  }
  return seen;
}

const cfg = async (r: CiscoRouter, lines: string[]): Promise<void> => {
  for (const l of lines) await r.executeCommand(l);
};

async function lab(options: { cablerAvant?: boolean } = {}): Promise<{
  r: CiscoRouter; h: LinuxPC; ndp: ReturnType<typeof observeNdp>;
}> {
  const r = new CiscoRouter('R1');
  const h = new LinuxPC('H');
  h.powerOn();
  const ndp = observeNdp(r, h);
  const cabler = (): void => {
    new Cable('c').connect(r.getPort('GigabitEthernet0/0')!, h.getPort('eth0')!);
  };
  if (options.cablerAvant) cabler();
  await cfg(r, [
    'enable', 'configure terminal', 'ipv6 unicast-routing',
    'interface GigabitEthernet0/0', 'ipv6 address 2001:db8::1/64',
    'no shutdown', 'end',
  ]);
  if (!options.cablerAvant) cabler();
  return { r, h, ndp };
}

describe('the host autoconfigures', () => {
  it('it gets a global address from the advertised prefix', async () => {
    const { h } = await lab();
    const output = await h.executeCommand('ip -6 addr show');
    expect(output).toMatch(/inet6 2001:db8::[0-9a-f:]+\/64 scope global/);
  });

  it('it keeps its link-local address, which does not come from the router', async () => {
    const { h } = await lab();
    const output = await h.executeCommand('ip -6 addr show');
    expect(output).toMatch(/inet6 fe80::[0-9a-f:]+\/64 scope link/);
  });

  it('it installs the prefix route and a default route', async () => {
    const { h } = await lab();
    const routes = await h.executeCommand('ip -6 route show');
    expect(routes).toContain('2001:db8::/64 dev eth0');
    expect(routes).toMatch(/^default via fe80::/m);
  });

  it('and it really reaches the router', async () => {
    const { h } = await lab();
    const ping = await h.executeCommand('ping6 -c 1 2001:db8::1');
    expect(ping).toMatch(/, 0% packet loss/);
  });
});

describe('these are real NDP messages', () => {
  it('the host solicits routers when the link comes up', async () => {
    const { h, ndp } = await lab();
    const rs = ndp.filter((m) => m.type === 'router-solicitation');
    expect(rs.length).toBeGreaterThan(0);
    expect(rs.every((m) => m.deviceId === h.getId())).toBe(true);
    // RFC 4861 §6.3.7: the solicitation goes to the all-routers group.
    expect(rs.every((m) => m.dst === 'ff02::2')).toBe(true);
  });

  it('the router advertises, to the all-nodes group', async () => {
    const { r, ndp } = await lab();
    const ra = ndp.filter((m) => m.type === 'router-advertisement');
    expect(ra.length).toBeGreaterThan(0);
    expect(ra.every((m) => m.deviceId === r.getId())).toBe(true);
    expect(ra.some((m) => m.dst === 'ff02::1')).toBe(true);
  });
});

describe('the order of operations does not change the result', () => {
  it('cable first, address after: the advertisement follows the configuration', async () => {
    const { h } = await lab({ cablerAvant: true });
    const output = await h.executeCommand('ip -6 addr show');
    expect(output).toMatch(/inet6 2001:db8::[0-9a-f:]+\/64 scope global/);
  });
});

describe('what the router does not advertise', () => {
  it('with no IPv6 routing, nothing is advertised and the host stays link-local', async () => {
    const r = new CiscoRouter('R1');
    const h = new LinuxPC('H');
    h.powerOn();
    const ndp = observeNdp(r, h);
    // No `ipv6 unicast-routing`: the machine is not a router.
    await cfg(r, ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
      'ipv6 address 2001:db8::1/64', 'no shutdown', 'end']);
    new Cable('c').connect(r.getPort('GigabitEthernet0/0')!, h.getPort('eth0')!);

    expect(ndp.filter((m) => m.type === 'router-advertisement')).toEqual([]);
    const output = await h.executeCommand('ip -6 addr show');
    expect(output).not.toMatch(/inet6 2001:db8::[0-9a-f:]+\/64 scope global/);
  });
});

describe('the zone index never travels', () => {
  it('the default route names the HOST interface, not the router one', async () => {
    const { h } = await lab();
    const routes = await h.executeCommand('ip -6 route show');
    const line = routes.split('\n').find((l) => l.startsWith('default via'));
    expect(line).toBeDefined();
    // The zone index is not part of the 128 bits and means nothing to a
    // peer: taking the router's gave the host a route naming an
    // interface it does not have.
    expect(line).toContain('%eth0');
    expect(line).not.toContain('GigabitEthernet');
  });
});
