/**
 * The commands that govern the router advertisement.
 *
 * They only meant anything once the advertisement really happened, and
 * the measurement taken right after showed half of them were decoration:
 *
 *   - `ipv6 nd managed-config-flag` and `other-config-flag` were stored
 *     on an ad-hoc port property NOBODY read — the advertisement is
 *     built from `raConfig`, a different store — so both bits always
 *     went out as zero.
 *   - `ipv6 nd ra suppress`, the command that turns it off, did not
 *     exist: `% Invalid input detected`.
 *   - The router lifetime was frozen at 1800 s with no command to set
 *     it, though zero has a precise meaning.
 *
 * git-stash discrimination: 5 of 11 fall before the fix. The other 6
 * pass either way, and that is expected rather than satisfying — the
 * refusal cases passed because the whole command was refused, and the
 * `no` cases because nothing was set anyway. They guard the parser,
 * they do not prove the feature.
 */

import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { IPv6Packet, ICMPv6Packet, NDPRouterAdvertisement } from '@/network/core/types';
import type { Equipment } from '@/network/equipment/Equipment';

/** The advertisements actually sent, read off this router's own ports. */
function observeAdvertisements(source: Equipment): NDPRouterAdvertisement[] {
  const vues: NDPRouterAdvertisement[] = [];
  source.attachCapture(({ direction, frame }) => {
    if (direction !== 'out') return;
    const ip = frame.payload as IPv6Packet | undefined;
    const icmp = ip?.payload as ICMPv6Packet | undefined;
    if (icmp?.icmpType === 'router-advertisement') {
      vues.push(icmp.ndp as NDPRouterAdvertisement);
    }
  });
  return vues;
}

const cfg = async (r: CiscoRouter, lines: string[]): Promise<string[]> => {
  const out: string[] = [];
  for (const l of lines) out.push(await r.executeCommand(l));
  return out;
};

/** A configured router, then cabled to a host. */
async function lab(ndCommands: string[]): Promise<{
  r: CiscoRouter; h: LinuxPC; annonces: NDPRouterAdvertisement[]; outputs: string[];
}> {
  const r = new CiscoRouter('R1');
  const h = new LinuxPC('H');
  h.powerOn();
  const annonces = observeAdvertisements(r);
  const outputs = await cfg(r, [
    'enable', 'configure terminal', 'ipv6 unicast-routing',
    'interface GigabitEthernet0/0', 'ipv6 address 2001:db8::1/64',
    ...ndCommands,
    'no shutdown', 'end',
  ]);
  new Cable('c').connect(r.getPort('GigabitEthernet0/0')!, h.getPort('eth0')!);
  return { r, h, annonces, outputs };
}

const refusals = (outputs: string[]): string[] => outputs.filter((s) => s.includes('%'));

describe('the M and O flags reach the wire', () => {
  it('by default they are zero', async () => {
    const { annonces } = await lab([]);
    expect(annonces.length).toBeGreaterThan(0);
    expect(annonces.every((a) => a.managedFlag === false)).toBe(true);
    expect(annonces.every((a) => a.otherConfigFlag === false)).toBe(true);
  });

  it('once configured, they are one', async () => {
    const { annonces, outputs } = await lab([
      'ipv6 nd managed-config-flag', 'ipv6 nd other-config-flag',
    ]);
    expect(refusals(outputs)).toEqual([]);
    expect(annonces.length).toBeGreaterThan(0);
    expect(annonces.every((a) => a.managedFlag === true)).toBe(true);
    expect(annonces.every((a) => a.otherConfigFlag === true)).toBe(true);
  });

  it('the `no` form puts them back to zero', async () => {
    const { annonces } = await lab([
      'ipv6 nd managed-config-flag', 'no ipv6 nd managed-config-flag',
    ]);
    expect(annonces.length).toBeGreaterThan(0);
    expect(annonces.every((a) => a.managedFlag === false)).toBe(true);
  });
});

describe('suppressing the advertisement suppresses it', () => {
  it('`suppress` silences the unsolicited advertisement', async () => {
    const { annonces, outputs } = await lab(['ipv6 nd ra suppress']);
    expect(refusals(outputs)).toEqual([]);
    // Anything left can only be an answer to a solicitation.
    expect(annonces.length).toBeLessThanOrEqual(1);
  });

  it('but the host still autoconfigures, because it solicits', async () => {
    const { h } = await lab(['ipv6 nd ra suppress']);
    const output = await h.executeCommand('ip -6 addr show');
    expect(output).toMatch(/inet6 2001:db8::[0-9a-f:]+\/64 scope global/);
  });

  it('`suppress all` silences the answer too, and the host stays without an address', async () => {
    const { h, annonces, outputs } = await lab(['ipv6 nd ra suppress all']);
    expect(refusals(outputs)).toEqual([]);
    expect(annonces).toEqual([]);
    const output = await h.executeCommand('ip -6 addr show');
    expect(output).not.toMatch(/inet6 2001:db8::[0-9a-f:]+\/64 scope global/);
  });

  it('the `no` form gives the router its voice back', async () => {
    const { h } = await lab(['ipv6 nd ra suppress all', 'no ipv6 nd ra suppress']);
    const output = await h.executeCommand('ip -6 addr show');
    expect(output).toMatch(/inet6 2001:db8::[0-9a-f:]+\/64 scope global/);
  });

  it('an unknown keyword after `suppress` is refused', async () => {
    const { outputs } = await lab(['ipv6 nd ra suppress nimportequoi']);
    expect(refusals(outputs).length).toBe(1);
  });
});

describe('a zero lifetime is not a default router', () => {
  it('the value set is the value sent', async () => {
    const { annonces } = await lab(['ipv6 nd ra lifetime 600']);
    expect(annonces.length).toBeGreaterThan(0);
    expect(annonces.every((a) => a.routerLifetime === 600)).toBe(true);
  });

  it('at zero, the host keeps its address and installs NO default route', async () => {
    // RFC 4861 §4.2: the lifetime governs the default-router role only,
    // not autoconfiguration from the prefix.
    const { h } = await lab(['ipv6 nd ra lifetime 0']);
    const adr = await h.executeCommand('ip -6 addr show');
    const routes = await h.executeCommand('ip -6 route show');
    expect(adr).toMatch(/inet6 2001:db8::[0-9a-f:]+\/64 scope global/);
    expect(routes).toContain('2001:db8::/64 dev eth0');
    expect(routes).not.toMatch(/^default via/m);
  });

  it('an out-of-range value is refused, and a missing one too', async () => {
    const { outputs } = await lab(['ipv6 nd ra lifetime 99999', 'ipv6 nd ra lifetime']);
    expect(refusals(outputs).length).toBe(2);
  });
});
