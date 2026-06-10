/**
 * BGP best-path decision process — pure ordering conformance
 * (RFC 4271 §9.1.1/§9.1.2.2 + Cisco weight step).
 */
import { describe, it, expect } from 'vitest';
import {
  compareBgpPaths, selectBestPath,
  BGP_DEFAULT_LOCAL_PREF,
  type BgpPathCandidate,
} from '@/network/bgp/bestPath';
import { IPAddress, SubnetMask } from '@/network/core/types';

function candidate(over: Partial<BgpPathCandidate>): BgpPathCandidate {
  return {
    route: {
      network: new IPAddress('172.16.0.0'),
      mask: new SubnetMask('255.255.255.0'),
      nextHop: new IPAddress('10.0.0.2'),
      iface: 'Gi0/0',
      protocol: 'bgp', adminDistance: 20, metric: 0,
    },
    weight: 0,
    localPref: BGP_DEFAULT_LOCAL_PREF,
    locallyOriginated: false,
    asPath: [65002],
    origin: 'igp',
    med: 0,
    isEbgp: true,
    peerRouterId: '2.2.2.2',
    peerIp: '10.0.0.2',
    ...over,
  };
}

describe('compareBgpPaths — decision order', () => {
  it('1. highest weight wins over everything else', () => {
    const heavy = candidate({ weight: 100, asPath: [1, 2, 3, 4] });
    const light = candidate({ weight: 0, asPath: [1] });
    expect(compareBgpPaths(heavy, light)).toBeLessThan(0);
  });

  it('2. highest LOCAL_PREF wins next', () => {
    const high = candidate({ localPref: 200, asPath: [1, 2] });
    const low = candidate({ localPref: 100, asPath: [1] });
    expect(compareBgpPaths(high, low)).toBeLessThan(0);
  });

  it('3. locally originated beats learned', () => {
    const local = candidate({ locallyOriginated: true });
    const learned = candidate({ locallyOriginated: false });
    expect(compareBgpPaths(local, learned)).toBeLessThan(0);
  });

  it('4. shorter AS_PATH wins', () => {
    const short = candidate({ asPath: [65002] });
    const long = candidate({ asPath: [65003, 65004] });
    expect(compareBgpPaths(short, long)).toBeLessThan(0);
  });

  it('5. lower origin wins (IGP < EGP < incomplete)', () => {
    const igp = candidate({ origin: 'igp' });
    const incomplete = candidate({ origin: 'incomplete' });
    expect(compareBgpPaths(igp, incomplete)).toBeLessThan(0);
  });

  it('6. lower MED wins only within the same neighbouring AS', () => {
    const lowMed = candidate({ med: 10, asPath: [65002] });
    const highMed = candidate({ med: 50, asPath: [65002] });
    expect(compareBgpPaths(lowMed, highMed)).toBeLessThan(0);

    // Different first AS ⇒ MED not comparable ⇒ falls to later steps.
    const otherAs = candidate({ med: 5, asPath: [65009], peerRouterId: '9.9.9.9' });
    const cheap = candidate({ med: 50, asPath: [65002], peerRouterId: '1.1.1.1' });
    expect(compareBgpPaths(cheap, otherAs)).toBeLessThan(0); // RID decides
  });

  it('7. eBGP beats iBGP', () => {
    const ebgp = candidate({ isEbgp: true, asPath: [65002] });
    const ibgp = candidate({ isEbgp: false, asPath: [65002] });
    expect(compareBgpPaths(ebgp, ibgp)).toBeLessThan(0);
  });

  it('9. lowest router-id breaks ties', () => {
    const ridLow = candidate({ peerRouterId: '1.1.1.1' });
    const ridHigh = candidate({ peerRouterId: '2.2.2.2' });
    expect(compareBgpPaths(ridLow, ridHigh)).toBeLessThan(0);
  });

  it('10. lowest peer IP is the final tiebreak', () => {
    const ipLow = candidate({ peerIp: '10.0.0.2' });
    const ipHigh = candidate({ peerIp: '10.0.1.2' });
    expect(compareBgpPaths(ipLow, ipHigh)).toBeLessThan(0);
  });
});

describe('selectBestPath', () => {
  it('returns null for no candidates', () => {
    expect(selectBestPath([])).toBeNull();
  });

  it('single candidate is the best path', () => {
    const only = candidate({});
    expect(selectBestPath([only])).toBe(only);
  });

  it('does not mutate the input array', () => {
    const a = candidate({ peerRouterId: '9.9.9.9' });
    const b = candidate({ peerRouterId: '1.1.1.1' });
    const input = [a, b];
    selectBestPath(input);
    expect(input[0]).toBe(a);
  });
});
