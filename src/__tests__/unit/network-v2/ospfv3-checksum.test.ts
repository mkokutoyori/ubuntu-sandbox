/**
 * OSPFv3 LSA Fletcher checksum — GAP §3.5 follow-up.
 *
 * Verifies that Link-LSA (0x0008) and Intra-Area-Prefix-LSA (0x2009)
 * carry deterministic non-zero Fletcher-16 checksums (RFC 5340 §A.4.5,
 * same algorithm as RFC 2328 Annex C) instead of the prior hardcoded
 * `checksum: 0`.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { OSPFv3Engine } from '@/network/ospf/OSPFv3Engine';
import {
  computeOSPFv3LSAChecksum, verifyOSPFv3LSAChecksum,
} from '@/network/ospf/checksum';
import type {
  OSPFv3LinkLSA, OSPFv3IntraAreaPrefixLSA, OSPFv3Prefix,
} from '@/network/ospf/types';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

function makePrefix(prefix: string, prefixLen: number, metric: number): OSPFv3Prefix {
  return { prefix, prefixLen, metric, prefixOptions: 0 };
}

function freshLinkLSA(): OSPFv3LinkLSA {
  return {
    lsAge: 0, lsType: 0x0008,
    linkStateId: '1', advertisingRouter: '1.1.1.1',
    lsSequenceNumber: 0x80000001, checksum: 0,
    length: 48, priority: 1, options: 0x13,
    linkLocalAddress: 'fe80::1',
    prefixes: [makePrefix('2001:db8::', 64, 10)],
  };
}

function freshIntraPrefixLSA(): OSPFv3IntraAreaPrefixLSA {
  return {
    lsAge: 0, lsType: 0x2009,
    linkStateId: '0', advertisingRouter: '1.1.1.1',
    lsSequenceNumber: 0x80000001, checksum: 0,
    length: 32, numPrefixes: 1,
    referencedLSType: 0x2001, referencedLSId: '0', referencedAdvRouter: '1.1.1.1',
    prefixes: [makePrefix('2001:db8::', 64, 10)],
  };
}

describe('computeOSPFv3LSAChecksum', () => {
  it('returns a non-zero 16-bit value for a Link-LSA', () => {
    const c = computeOSPFv3LSAChecksum(freshLinkLSA());
    expect(c).toBeGreaterThan(0);
    expect(c).toBeLessThanOrEqual(0xFFFF);
  });

  it('returns a non-zero 16-bit value for an Intra-Area-Prefix-LSA', () => {
    const c = computeOSPFv3LSAChecksum(freshIntraPrefixLSA());
    expect(c).toBeGreaterThan(0);
    expect(c).toBeLessThanOrEqual(0xFFFF);
  });

  it('is deterministic (same input → same output)', () => {
    const a = freshLinkLSA();
    const b = freshLinkLSA();
    expect(computeOSPFv3LSAChecksum(a)).toBe(computeOSPFv3LSAChecksum(b));
  });

  it('ignores the lsAge field (advertising router still affects it)', () => {
    const a = freshLinkLSA();
    const b = { ...freshLinkLSA(), lsAge: 1800 };
    expect(computeOSPFv3LSAChecksum(a)).toBe(computeOSPFv3LSAChecksum(b));
  });

  it('changes when the advertising router changes', () => {
    const a = freshLinkLSA();
    const b = { ...freshLinkLSA(), advertisingRouter: '2.2.2.2' };
    expect(computeOSPFv3LSAChecksum(a)).not.toBe(computeOSPFv3LSAChecksum(b));
  });

  it('changes when a prefix changes', () => {
    const a = freshLinkLSA();
    const b: OSPFv3LinkLSA = { ...freshLinkLSA(), prefixes: [makePrefix('2001:db8:1::', 64, 10)] };
    expect(computeOSPFv3LSAChecksum(a)).not.toBe(computeOSPFv3LSAChecksum(b));
  });

  it('changes when the sequence number bumps', () => {
    const a = freshLinkLSA();
    const b = { ...freshLinkLSA(), lsSequenceNumber: 0x80000002 };
    expect(computeOSPFv3LSAChecksum(a)).not.toBe(computeOSPFv3LSAChecksum(b));
  });

  it('treats the stored checksum field as zero during recomputation', () => {
    const a = freshLinkLSA();
    const computed = computeOSPFv3LSAChecksum(a);
    a.checksum = computed;
    // Recomputing must yield the same value — the function zeroes the
    // field before hashing.
    expect(computeOSPFv3LSAChecksum(a)).toBe(computed);
  });
});

describe('verifyOSPFv3LSAChecksum', () => {
  it('rejects a freshly-built LSA whose checksum is still 0', () => {
    expect(verifyOSPFv3LSAChecksum(freshLinkLSA())).toBe(false);
  });

  it('accepts an LSA carrying a checksum computed by computeOSPFv3LSAChecksum', () => {
    const lsa = freshLinkLSA();
    lsa.checksum = computeOSPFv3LSAChecksum(lsa);
    expect(verifyOSPFv3LSAChecksum(lsa)).toBe(true);
  });

  it('rejects an LSA whose contents drifted after the checksum was set', () => {
    const lsa = freshLinkLSA();
    lsa.checksum = computeOSPFv3LSAChecksum(lsa);
    lsa.priority = 99;
    expect(verifyOSPFv3LSAChecksum(lsa)).toBe(false);
  });
});

describe('OSPFv3Engine wires real checksums into freshly-originated LSAs', () => {
  it('originateLinkLSA stamps a verifiable Fletcher checksum', () => {
    const v3 = new OSPFv3Engine({ routerId: '1.1.1.1', processId: 1 } as never);
    v3.activateInterface('GigabitEthernet0/0', '0', { ipAddress: 'fe80::1' });
    const lsa = v3.originateLinkLSA('GigabitEthernet0/0', 'fe80::1', [
      { prefix: '2001:db8::', prefixLen: 64, metric: 10, prefixOptions: 0 },
    ]);
    expect(lsa.checksum).not.toBe(0);
    expect(verifyOSPFv3LSAChecksum(lsa)).toBe(true);
  });

  it('originateIntraAreaPrefixLSA stamps a verifiable Fletcher checksum', () => {
    const v3 = new OSPFv3Engine({ routerId: '1.1.1.1', processId: 1 } as never);
    const lsa = v3.originateIntraAreaPrefixLSA('0', [
      { prefix: '2001:db8::', prefixLen: 64, metric: 10, prefixOptions: 0 },
    ]);
    expect(lsa.checksum).not.toBe(0);
    expect(verifyOSPFv3LSAChecksum(lsa)).toBe(true);
  });
});
