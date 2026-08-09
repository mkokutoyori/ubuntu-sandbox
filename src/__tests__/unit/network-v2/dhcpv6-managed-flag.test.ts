/**
 * The M flag of a router advertisement really triggers DHCPv6.
 *
 * What the measurement corrected in my own reading, worth writing down:
 * this repo has a DHCPv6 server AND a complete client
 * (`EndHost.requestDhcpv6Lease` — a real SOLICIT / ADVERTISE / REQUEST
 * / REPLY, verified end to end). I had announced the opposite in the
 * coordination journal, on the strength of a grep that found no client
 * "file" — there is no file, there is a method.
 *
 * The real gap is narrower and quite present: the client was triggered
 * ONLY by a hand-typed `dhclient -6`. The M flag — "go fetch your
 * address by DHCPv6", RFC 4861 §4.2 — travelled the wire with nobody
 * executing it.
 *
 * The prefix's A flag stays independent (RFC 4862 §5.5.3): a host
 * legitimately carries both addresses under an advertisement setting M
 * and A together, and that is what is observed here.
 */

import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';

const cfg = async (r: CiscoRouter, lines: string[]): Promise<string[]> => {
  const out: string[] = [];
  for (const l of lines) out.push(await r.executeCommand(l));
  return out;
};

/** A router serving a DHCPv6 pool, cabled to a host. */
async function lab(options: { managed?: boolean; server?: boolean } = {}): Promise<{
  r: CiscoRouter; h: LinuxPC; outputs: string[];
}> {
  const r = new CiscoRouter('R1');
  const h = new LinuxPC('H');
  h.powerOn();
  const outputs = await cfg(r, [
    'enable', 'configure terminal', 'ipv6 unicast-routing',
    ...(options.server === false ? [] : [
      'ipv6 dhcp pool LAB', 'address prefix 2001:db8:aa::/64', 'exit',
    ]),
    'interface GigabitEthernet0/0', 'ipv6 address 2001:db8:aa::1/64',
    ...(options.server === false ? [] : ['ipv6 dhcp server LAB']),
    ...(options.managed ? ['ipv6 nd managed-config-flag'] : []),
    'no shutdown', 'end',
  ]);
  new Cable('c').connect(r.getPort('GigabitEthernet0/0')!, h.getPort('eth0')!);
  return { r, h, outputs };
}

const globalAddresses = async (h: LinuxPC): Promise<string[]> => {
  const output = await h.executeCommand('ip -6 addr show');
  return output.split('\n')
    .filter((l) => l.includes('inet6') && l.includes('scope global'))
    .map((l) => l.trim().split(/\s+/)[1]);
};

describe('the M flag triggers the client', () => {
  it('the host gets a lease without anyone typing dhclient', async () => {
    const { h } = await lab({ managed: true });
    // `::2` is the pool's first address: it cannot come from
    // autoconfiguration, which derives the identifier from the MAC.
    expect(await globalAddresses(h)).toContain('2001:db8:aa::2/64');
  });

  it('and it ALSO keeps its autoconfigured address', async () => {
    // The prefix's A flag is independent of the M flag.
    const { h } = await lab({ managed: true });
    const addresses = await globalAddresses(h);
    expect(addresses.some((a) => a.startsWith('2001:db8:aa::ff:fe00:'))).toBe(true);
  });

  it('without the flag, no lease is requested', async () => {
    const { h } = await lab({ managed: false });
    const addresses = await globalAddresses(h);
    expect(addresses).not.toContain('2001:db8:aa::2/64');
    // The guard: autoconfiguration did happen, so the absence of a lease
    // is not the absence of everything.
    expect(addresses.some((a) => a.startsWith('2001:db8:aa::ff:fe00:'))).toBe(true);
  });

  it('the flag without a server breaks nothing', async () => {
    const { h } = await lab({ managed: true, server: false });
    const addresses = await globalAddresses(h);
    expect(addresses).not.toContain('2001:db8:aa::2/64');
    expect(addresses.some((a) => a.startsWith('2001:db8:aa::ff:fe00:'))).toBe(true);
  });
});

describe('the request is not repeated', () => {
  it('a second round of advertisements does not take a second lease', async () => {
    // An advertisement arrives on every solicitation and every link-up:
    // without a guard the host would ask again each time.
    const { h } = await lab({ managed: true });
    await h.executeCommand('ip link set eth0 down');
    await h.executeCommand('ip link set eth0 up');
    const leases = (await globalAddresses(h))
      .filter((a) => /^2001:db8:aa::\d+\/64$/.test(a));
    expect(leases).toEqual(['2001:db8:aa::2/64']);
  });
});

describe('the client still answers the command', () => {
  it('dhclient -6 still works and returns its transcript', async () => {
    const { h } = await lab({ managed: false });
    const output = await h.executeCommand('dhclient -6 -v eth0');
    expect(output).toContain('DHCPv6 SOLICIT');
    expect(output).toContain('DHCPv6 REPLY of 2001:db8:aa::2');
  });
});
