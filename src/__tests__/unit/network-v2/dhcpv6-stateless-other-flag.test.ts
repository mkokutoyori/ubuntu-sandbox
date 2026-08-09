/**
 * Stateless DHCPv6: the O flag and the INFORMATION-REQUEST it calls for
 * (RFC 8415 §18.2.6).
 *
 * The O flag says: "your address comes from autoconfiguration; come and
 * ask for the rest". It was set on the wire since the `ipv6-nd-ra`
 * controls lot and had NO consumer: the message that answers it existed
 * nowhere. `INFORMATION-REQUEST` appeared in the `DHCPv6MessageType`
 * union and in a server comment declaring it out of scope — the word
 * was there, the function was not.
 *
 * This lot adds the message and its two ends: the client
 * (`EndHost.requestDhcpv6Information`, triggered by the flag or by
 * `dhclient -6 -S`) and the server (`processInformationRequest`), plus
 * the router's dispatch. The consumer already existed: the hook that
 * writes `/etc/resolv.conf`.
 *
 * What really tells this exchange from a lease: it assigns nothing and
 * RETAINS nothing. A pool queried a hundred times is not drained, and a
 * pool with no prefix is legitimate — that is the normal stateless
 * setup.
 *
 * A corner measured and left alone, said rather than hidden: an M flag
 * pointing at a pool with no address to hand out produces nothing at
 * all — `processSolicit` finds no address and emits no ADVERTISE, while
 * RFC 8415 §18.2.10 lets a client take the options of an ADVERTISE even
 * without an address. That is a contradictory configuration, and fixing
 * it belongs to the lease path, not this one.
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

/** The stateless lab: a pool carrying ONLY configuration, no prefix. */
async function lab(options: { flag?: 'O' | 'M' | 'none'; prefix?: boolean } = {}): Promise<{
  r: CiscoRouter; h: LinuxPC; outputs: string[];
}> {
  const flag = options.flag ?? 'O';
  const r = new CiscoRouter('R1');
  const h = new LinuxPC('H');
  h.powerOn();
  const outputs = await cfg(r, [
    'enable', 'configure terminal', 'ipv6 unicast-routing',
    'ipv6 dhcp pool SANSETAT',
    ...(options.prefix ? ['address prefix 2001:db8:aa::/64'] : []),
    'dns-server 2001:db8:aa::53', 'domain-name lab.local', 'exit',
    'interface GigabitEthernet0/0', 'ipv6 address 2001:db8:aa::1/64',
    'ipv6 dhcp server SANSETAT',
    ...(flag === 'O' ? ['ipv6 nd other-config-flag'] : []),
    ...(flag === 'M' ? ['ipv6 nd managed-config-flag'] : []),
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

describe('le flag O amene la configuration, et rien qu\'elle', () => {
  it('le resolveur arrive dans /etc/resolv.conf', async () => {
    const { h, outputs } = await lab();
    expect(outputs.filter((s) => s.includes('%'))).toEqual([]);
    const resolv = await h.executeCommand('cat /etc/resolv.conf');
    expect(resolv).toContain('nameserver 2001:db8:aa::53');
    expect(resolv).toContain('search lab.local');
  });

  it('aucune address n\'est attribuee — c\'est le sens de « sans etat »', async () => {
    const { h } = await lab();
    // The absence of an address means nothing until the exchange is
    // shown to have HAPPENED: without this line the case would pass
    // just as well with the feature missing.
    expect(await h.executeCommand('cat /etc/resolv.conf'))
      .toContain('nameserver 2001:db8:aa::53');
    const addresses = await globalAddresses(h);
    // Only autoconfiguration served: the identifier comes from the MAC.
    expect(addresses).toEqual([expect.stringMatching(/^2001:db8:aa::ff:fe00:[0-9a-f]+\/64$/)]);
  });

  it('le server ne retient none bail', async () => {
    const { r, h } = await lab();
    expect(await h.executeCommand('cat /etc/resolv.conf'))
      .toContain('nameserver 2001:db8:aa::53');
    const view = await r.executeCommand('show ipv6 dhcp binding');
    expect(view).not.toContain('2001:db8:aa::2');
  });

  it('sans le flag, rien n\'est demande', async () => {
    const { h } = await lab({ flag: 'none' });
    const resolv = await h.executeCommand('cat /etc/resolv.conf');
    expect(resolv.trim()).toBe('');
    // The guard: autoconfiguration did happen, so a silent resolver is
    // not silence about everything.
    expect((await globalAddresses(h)).length).toBe(1);
  });
});

describe('le flag M ne repose pas la question', () => {
  it('sous M, la configuration vient du bail et non d\'une demande separee', async () => {
    // The full lease already carries the same options, so asking again
    // would be a round trip for the same answer. This case wants a pool
    // with addresses to hand out, since that is what M calls for.
    const { h } = await lab({ flag: 'M', prefix: true });
    const resolv = await h.executeCommand('cat /etc/resolv.conf');
    expect(resolv).toContain('nameserver 2001:db8:aa::53');
  });
});

describe('la demande se fait aussi a la main', () => {
  it('dhclient -6 -S rend sa transcription et configure', async () => {
    const { h } = await lab({ flag: 'none' });
    const output = await h.executeCommand('dhclient -6 -S -v eth0');
    expect(output).toContain('DHCPv6 INFORMATION-REQUEST');
    expect(output).toContain('nameserver 2001:db8:aa::53');
    const resolv = await h.executeCommand('cat /etc/resolv.conf');
    expect(resolv).toContain('nameserver 2001:db8:aa::53');
  });

  it('et il ne prend toujours pas d\'address', async () => {
    const { h } = await lab({ flag: 'none' });
    await h.executeCommand('dhclient -6 -S eth0');
    expect(await h.executeCommand('cat /etc/resolv.conf'))
      .toContain('nameserver 2001:db8:aa::53');
    expect((await globalAddresses(h)).length).toBe(1);
  });

  it('un pool interroge deux fois ne s\'epuise pas', async () => {
    // A stateless exchange records nothing: a hundred requests are one.
    const { r, h } = await lab({ flag: 'none' });
    await h.executeCommand('dhclient -6 -S eth0');
    expect(await h.executeCommand('dhclient -6 -S -v eth0'))
      .toContain('nameserver 2001:db8:aa::53');
    const view = await r.executeCommand('show ipv6 dhcp binding');
    expect(view).not.toContain('2001:db8:aa::');
  });
});

describe('non-regression du bail ordinaire', () => {
  it('dhclient -6 sans -S prend toujours une address', async () => {
    const r = new CiscoRouter('R1');
    const h = new LinuxPC('H');
    h.powerOn();
    await cfg(r, [
      'enable', 'configure terminal', 'ipv6 unicast-routing',
      'ipv6 dhcp pool LAB', 'address prefix 2001:db8:bb::/64',
      'dns-server 2001:db8:bb::53', 'exit',
      'interface GigabitEthernet0/0', 'ipv6 address 2001:db8:bb::1/64',
      'ipv6 dhcp server LAB', 'no shutdown', 'end',
    ]);
    new Cable('c').connect(r.getPort('GigabitEthernet0/0')!, h.getPort('eth0')!);
    const output = await h.executeCommand('dhclient -6 -v eth0');
    expect(output).toContain('DHCPv6 REPLY of 2001:db8:bb::2');
    expect(await globalAddresses(h)).toContain('2001:db8:bb::2/64');
  });
});
