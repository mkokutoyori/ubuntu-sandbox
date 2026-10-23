/**
 * Probe: the LDP label filters of the Cisco IOS Multiprotocol Label Switching Command Reference
 * (official_docs/cisco/mp-cr-book.pdf: mpls ldp advertise-labels [for prefix-acl [to peer-acl]],
 * mpls ldp neighbor A labels accept acl), each checked for its EFFECT on the Label Mapping
 * messages that cross the wire and on the bindings the peer stores (CLAUDE.md rule 6).
 * Lab: R1 owns the loopback 1.1.1.1/32, the connected 10.99.0.0/24 and 10.12.0.0/24 and routes 2.2.2.2/32, R2 is its LDP neighbour.
 * Rules checked from the book: with no command every label goes to every peer; the bare
 * `no mpls ldp advertise-labels` advertises none; the first command whose prefix ACL permits the
 * prefix decides, a denying or absent match advertises nothing once any command exists, and a
 * `to` ACL restricts the receiving peers by LDP router ID. The inbound filter keeps only the
 * permitted prefixes of one neighbour.
 * Before the change 7 of the 9 cases fail; the 2 that pass either way are the witnesses: the unfiltered lab (R2 learns all four
 * prefixes) and the unknown-keyword refusal.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';
import { LdpIdentifier } from '@/network/ldp/LdpIdentifier';
import { IPAddress } from '@/network/core/types';

let clock: VirtualTimeScheduler;
beforeEach(() => { clock = new VirtualTimeScheduler(); __setDefaultScheduler(clock); });
afterEach(() => vi.restoreAllMocks());

async function config(router: CiscoRouter, ...lines: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const line of ['enable', 'configure terminal', ...lines, 'end']) out.push(await router.executeCommand(line));
  return out.slice(2, -1);
}

async function pair(before: (r1: CiscoRouter, r2: CiscoRouter) => Promise<void> = async () => {}) {
  const r1 = new CiscoRouter('R1');
  const r2 = new CiscoRouter('R2');
  new Cable('c').connect(r1.getPort('GigabitEthernet0/0')!, r2.getPort('GigabitEthernet0/0')!);
  await config(r1, 'interface Loopback0', 'ip address 1.1.1.1 255.255.255.255', 'exit',
    'interface Loopback1', 'ip address 10.99.0.1 255.255.255.0', 'exit',
    'interface GigabitEthernet0/0', 'ip address 10.12.0.1 255.255.255.0', 'no shutdown', 'exit',
    'ip route 2.2.2.2 255.255.255.255 10.12.0.2', 'mpls ldp router-id Loopback0 force');
  await config(r2, 'interface Loopback0', 'ip address 2.2.2.2 255.255.255.255', 'exit',
    'interface GigabitEthernet0/0', 'ip address 10.12.0.2 255.255.255.0', 'no shutdown', 'exit',
    'ip route 1.1.1.1 255.255.255.255 10.12.0.1', 'ip route 10.99.0.0 255.255.255.0 10.12.0.1');
  await before(r1, r2);
  await config(r1, 'interface GigabitEthernet0/0', 'mpls ip');
  await config(r2, 'interface GigabitEthernet0/0', 'mpls ip');
  clock.advance(8000);
  return { r1, r2 };
}

const learned = (router: CiscoRouter, peer = '1.1.1.1') =>
  [...router.getLdpEngine().remoteBindings(LdpIdentifier.of(new IPAddress(peer), 0)).keys()].sort();

const EVERYTHING = ['1.1.1.1/32', '10.12.0.0/24', '10.99.0.0/24', '2.2.2.2/32'];

const ACLS = ['access-list 10 permit 1.1.1.1 0.0.0.0', 'access-list 20 permit 10.99.0.0 0.0.0.255', 'access-list 30 permit 2.2.2.2 0.0.0.0', 'access-list 31 permit 9.9.9.9 0.0.0.0'];

describe('mpls ldp advertise-labels', () => {
  it('WITNESS: with no command R2 learns every prefix of R1', async () => {
    const { r2 } = await pair();
    expect(learned(r2)).toEqual(EVERYTHING);
  });

  it('for ACL: only the permitted prefix is advertised, and the other label never crosses the wire', async () => {
    const { r2 } = await pair(async r1 => { await config(r1, ...ACLS, 'mpls ldp advertise-labels for 10'); });
    expect(learned(r2)).toEqual(['1.1.1.1/32']);
  });

  it('the no form of a for rule restores the full advertisement only after the bare command', async () => {
    const { r1, r2 } = await pair(async r1 => { await config(r1, ...ACLS, 'mpls ldp advertise-labels for 10'); });
    await config(r1, 'no mpls ldp advertise-labels for 10');
    clock.advance(3000);
    expect(learned(r2)).toEqual([]);
    await config(r1, 'mpls ldp advertise-labels');
    clock.advance(3000);
    expect(learned(r2)).toEqual(EVERYTHING);
  });

  it('bare no advertises nothing and withdraws what was advertised', async () => {
    const { r1, r2 } = await pair();
    await config(r1, 'no mpls ldp advertise-labels');
    clock.advance(3000);
    expect(learned(r2)).toEqual([]);
  });

  it('for ... to ACL: the peer ACL decides on the LDP router ID of the receiver', async () => {
    const permitted = await pair(async r1 => { await config(r1, ...ACLS, 'mpls ldp advertise-labels for 10 to 30'); });
    expect(learned(permitted.r2)).toEqual(['1.1.1.1/32']);
    const denied = await pair(async r1 => { await config(r1, ...ACLS, 'mpls ldp advertise-labels for 10 to 31'); });
    expect(learned(denied.r2)).toEqual([]);
  });

  it('the first command whose prefix ACL permits the prefix is the one that applies', async () => {
    const { r2 } = await pair(async r1 => {
      await config(r1, ...ACLS, 'mpls ldp advertise-labels for 10 to 31', 'mpls ldp advertise-labels for 20 to 30');
    });
    expect(learned(r2)).toEqual(['10.99.0.0/24']);
  });

  it('shows in running-config, bare no included', async () => {
    const { r1 } = await pair(async r1 => { await config(r1, ...ACLS, 'mpls ldp advertise-labels for 10 to 30'); });
    expect(await r1.executeCommand('show running-config')).toContain('mpls ldp advertise-labels for 10 to 30');
    await config(r1, 'no mpls ldp advertise-labels for 10 to 30');
    expect(await r1.executeCommand('show running-config')).toContain('no mpls ldp advertise-labels');
  });
});

describe('mpls ldp neighbor labels accept', () => {
  it('keeps only the permitted prefixes of the neighbour, and removes a stored one when the filter arrives', async () => {
    const { r2 } = await pair(async (_r1, r2) => { await config(r2, ...ACLS, 'mpls ldp neighbor 1.1.1.1 labels accept 10'); });
    expect(learned(r2)).toEqual(['1.1.1.1/32']);
    const late = await pair();
    expect(learned(late.r2)).toEqual(EVERYTHING);
    await config(late.r2, ...ACLS, 'mpls ldp neighbor 1.1.1.1 labels accept 20');
    expect(learned(late.r2)).toEqual(['10.99.0.0/24']);
    expect(await late.r2.executeCommand('show running-config')).toContain('mpls ldp neighbor 1.1.1.1 labels accept 20');
  });

  it('WITNESS: a keyword the engine does not evaluate (vrf) is refused', async () => {
    const { r1 } = await pair();
    const [out] = await config(r1, 'mpls ldp advertise-labels vrf RED');
    expect(out).toContain('Invalid input');
  });
});
