import { describe, it, expect } from 'vitest';
import {
  encodeDnsHeaderFlags, decodeDnsHeaderFlags,
  DnsOpcode, DnsRcode,
} from '@/network/dns/wire/DnsHeaderFlags';

describe('DnsHeaderFlags — bit-packing (RFC 1035 §4.1.1, RFC 4035 AD/CD)', () => {
  describe('encodeDnsHeaderFlags', () => {
    it('encodes a standard recursive query (RD=1, everything else 0)', () => {
      const word = encodeDnsHeaderFlags({
        qr: false, opcode: DnsOpcode.QUERY, aa: false, tc: false, rd: true,
        ra: false, ad: false, cd: false, rcode: DnsRcode.NOERROR,
      });
      expect(word).toBe(0x0100);
    });

    it('encodes a successful recursive response (QR=1, RD=1, RA=1)', () => {
      const word = encodeDnsHeaderFlags({
        qr: true, opcode: DnsOpcode.QUERY, aa: false, tc: false, rd: true,
        ra: true, ad: false, cd: false, rcode: DnsRcode.NOERROR,
      });
      expect(word).toBe(0x8180);
    });

    it('encodes an authoritative answer (AA=1)', () => {
      const word = encodeDnsHeaderFlags({
        qr: true, opcode: DnsOpcode.QUERY, aa: true, tc: false, rd: false,
        ra: false, ad: false, cd: false, rcode: DnsRcode.NOERROR,
      });
      expect(word).toBe(0x8400);
    });

    it('encodes a truncated response (TC=1)', () => {
      const word = encodeDnsHeaderFlags({
        qr: true, opcode: DnsOpcode.QUERY, aa: false, tc: true, rd: true,
        ra: true, ad: false, cd: false, rcode: DnsRcode.NOERROR,
      });
      expect(word).toBe(0x8380);
    });

    it('encodes NXDOMAIN (RCODE=3) in the low 4 bits', () => {
      const word = encodeDnsHeaderFlags({
        qr: true, opcode: DnsOpcode.QUERY, aa: false, tc: false, rd: true,
        ra: true, ad: false, cd: false, rcode: DnsRcode.NXDOMAIN,
      });
      expect(word & 0x000f).toBe(3);
    });

    it('encodes AD=1 (authenticated data, RFC 4035 §3.1.6)', () => {
      const word = encodeDnsHeaderFlags({
        qr: true, opcode: DnsOpcode.QUERY, aa: false, tc: false, rd: true,
        ra: true, ad: true, cd: false, rcode: DnsRcode.NOERROR,
      });
      expect((word >> 5) & 1).toBe(1);
    });

    it('encodes CD=1 (checking disabled, RFC 4035 §3.2.2)', () => {
      const word = encodeDnsHeaderFlags({
        qr: false, opcode: DnsOpcode.QUERY, aa: false, tc: false, rd: true,
        ra: false, ad: false, cd: true, rcode: DnsRcode.NOERROR,
      });
      expect((word >> 4) & 1).toBe(1);
    });

    it('encodes a non-zero opcode (IQUERY=1) in bits 11-14', () => {
      const word = encodeDnsHeaderFlags({
        qr: false, opcode: DnsOpcode.IQUERY, aa: false, tc: false, rd: false,
        ra: false, ad: false, cd: false, rcode: DnsRcode.NOERROR,
      });
      expect((word >> 11) & 0x0f).toBe(DnsOpcode.IQUERY);
    });

    it('rejects an opcode outside the 4-bit range', () => {
      expect(() => encodeDnsHeaderFlags({
        qr: false, opcode: 16, aa: false, tc: false, rd: false,
        ra: false, ad: false, cd: false, rcode: 0,
      })).toThrow(/opcode/i);
    });

    it('rejects an rcode outside the 4-bit range (use EDNS extended rcode instead)', () => {
      expect(() => encodeDnsHeaderFlags({
        qr: false, opcode: 0, aa: false, tc: false, rd: false,
        ra: false, ad: false, cd: false, rcode: 16,
      })).toThrow(/rcode/i);
    });

    it('rejects a negative rcode', () => {
      expect(() => encodeDnsHeaderFlags({
        qr: false, opcode: 0, aa: false, tc: false, rd: false,
        ra: false, ad: false, cd: false, rcode: -1,
      })).toThrow(/rcode/i);
    });
  });

  describe('decodeDnsHeaderFlags', () => {
    it('is the exact inverse of encodeDnsHeaderFlags for every boolean combination', () => {
      for (let mask = 0; mask < 64; mask++) {
        const flags = {
          qr: !!(mask & 1), opcode: DnsOpcode.QUERY, aa: !!(mask & 2), tc: !!(mask & 4),
          rd: !!(mask & 8), ra: !!(mask & 16), ad: !!(mask & 32), cd: false,
          rcode: DnsRcode.NOERROR,
        };
        const roundTripped = decodeDnsHeaderFlags(encodeDnsHeaderFlags(flags));
        expect(roundTripped).toEqual(flags);
      }
    });

    it('decodes the reserved Z bit as always false regardless of stray input bits', () => {
      // Bit 9 (Z) must be treated as reserved/ignored on decode even if a
      // non-conformant sender set it — RFC 1035 mandates senders set it to
      // zero, but a receiver must not choke on it.
      const decoded = decodeDnsHeaderFlags(0x0300);
      expect(decoded.rd).toBe(true);
      expect(decoded.opcode).toBe(DnsOpcode.QUERY);
    });

    it('round-trips every 4-bit opcode value', () => {
      for (let op = 0; op <= 15; op++) {
        const word = encodeDnsHeaderFlags({
          qr: false, opcode: op, aa: false, tc: false, rd: false,
          ra: false, ad: false, cd: false, rcode: 0,
        });
        expect(decodeDnsHeaderFlags(word).opcode).toBe(op);
      }
    });

    it('round-trips every 4-bit rcode value', () => {
      for (let rc = 0; rc <= 15; rc++) {
        const word = encodeDnsHeaderFlags({
          qr: true, opcode: 0, aa: false, tc: false, rd: false,
          ra: false, ad: false, cd: false, rcode: rc,
        });
        expect(decodeDnsHeaderFlags(word).rcode).toBe(rc);
      }
    });
  });

  describe('well-known rcode/opcode constants', () => {
    it('exposes the standard RFC 1035 §4.1.1 rcodes', () => {
      expect(DnsRcode.NOERROR).toBe(0);
      expect(DnsRcode.FORMERR).toBe(1);
      expect(DnsRcode.SERVFAIL).toBe(2);
      expect(DnsRcode.NXDOMAIN).toBe(3);
      expect(DnsRcode.NOTIMP).toBe(4);
      expect(DnsRcode.REFUSED).toBe(5);
    });

    it('exposes the standard opcodes', () => {
      expect(DnsOpcode.QUERY).toBe(0);
      expect(DnsOpcode.IQUERY).toBe(1);
      expect(DnsOpcode.STATUS).toBe(2);
      expect(DnsOpcode.NOTIFY).toBe(4);
      expect(DnsOpcode.UPDATE).toBe(5);
    });
  });
});
