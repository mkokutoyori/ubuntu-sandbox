/**
 * VTP MD5 digest byte-layout fidelity (docs/PRD-VTP.md §3 Phase 3), the VTP
 * counterpart to `tcpdump-byte-slice-vlan-filters.test.ts` on the 802.1Q
 * side: instead of exercising a byte-offset filter, this pins `hashPassword`
 * to the actual byte layout Cisco's Summary Advertisement uses, sourced
 * from Wireshark's `packet-vtp.c` dissector (field offsets/sizes) and the
 * Yersinia VTP packet-crafting tool's `vtp_generate_md5()` (the password-MD5
 * "sandwich" construction) — not the `${domain}|${password}` string
 * concatenation this used to be.
 */
import { describe, it, expect } from 'vitest';
import { hashPassword } from '@/network/vtp/types';
import { md5, utf8ToBytes, bytesToHex } from '@/crypto';

const VTP_DOMAIN_FIELD_BYTES = 32;

function buildExpectedDigest(domain: string, password: string, revision: number): string {
  const secret = md5(utf8ToBytes(password));
  const domainField = new Uint8Array(VTP_DOMAIN_FIELD_BYTES);
  domainField.set(utf8ToBytes(domain).slice(0, VTP_DOMAIN_FIELD_BYTES));
  const revisionField = new Uint8Array([
    (revision >>> 24) & 0xff, (revision >>> 16) & 0xff, (revision >>> 8) & 0xff, revision & 0xff,
  ]);
  const body = new Uint8Array(secret.length + domainField.length + revisionField.length + secret.length);
  let offset = 0;
  body.set(secret, offset); offset += secret.length;
  body.set(domainField, offset); offset += domainField.length;
  body.set(revisionField, offset); offset += revisionField.length;
  body.set(secret, offset);
  return bytesToHex(md5(body));
}

describe('VTP MD5 digest — byte-exact construction against the real Summary Advertisement layout', () => {
  it('matches a from-scratch reconstruction of the Wireshark/Yersinia field layout', () => {
    expect(hashPassword('LAB', 'cisco', 7)).toBe(buildExpectedDigest('LAB', 'cisco', 7));
    expect(hashPassword('CORP-DOMAIN', 'S3cr3t!', 42)).toBe(buildExpectedDigest('CORP-DOMAIN', 'S3cr3t!', 42));
  });

  it('the domain field is a fixed 32-byte zero-padded slot, so trailing padding never leaks into the digest', () => {
    const short = hashPassword('LAB', 'cisco', 1);
    const paddedManually = buildExpectedDigest('LAB\x00\x00\x00', 'cisco', 1);
    expect(short).toBe(paddedManually);
  });

  it('a domain longer than 32 bytes is truncated to the field width, exactly like the real 32-byte slot', () => {
    const longDomain = 'A'.repeat(40);
    const truncated = longDomain.slice(0, VTP_DOMAIN_FIELD_BYTES);
    expect(hashPassword(longDomain, 'cisco', 1)).toBe(hashPassword(truncated, 'cisco', 1));
  });

  it('the revision field is 4 bytes big-endian, so 0x000000FF and 0x0000FF00 hash differently', () => {
    const low = hashPassword('LAB', 'cisco', 0x000000ff);
    const high = hashPassword('LAB', 'cisco', 0x0000ff00);
    expect(low).not.toBe(high);
  });

  it('the same domain and password produce a different digest per revision — real VTP\'s own documented behavior', () => {
    const rev1 = hashPassword('LAB', 'cisco', 1);
    const rev2 = hashPassword('LAB', 'cisco', 2);
    expect(rev1).not.toBe(rev2);
  });

  it('an empty password never computes a digest, matching "no VTP authentication configured"', () => {
    expect(hashPassword('LAB', '', 5)).toBe('');
  });

  it('omitting revision defaults to 0, preserving every pre-Phase-3 2-argument call site', () => {
    expect(hashPassword('LAB', 'cisco')).toBe(hashPassword('LAB', 'cisco', 0));
  });
});
