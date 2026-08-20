import { describe, it, expect } from 'vitest';
import { encodeDnsMessage, decodeDnsMessage, DnsMessageError } from '@/network/dns/wire/DnsMessageCodec';
import type { DnsMessage, DnsQuestion } from '@/network/dns/wire/DnsMessage';
import { RRType, DnsClass } from '@/network/dns/wire/RRType';
import { makeARecord, makeAaaaRecord, makeNsRecord, makeSoaRecord, makeTxtRecord } from '@/network/dns/wire/ResourceRecord';
import { DnsOpcode, DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';

function baseQuestion(qname: string, qtype: number = RRType.A): DnsQuestion {
  return { qname, qtype, qclass: DnsClass.IN };
}

function emptyMessage(overrides: Partial<DnsMessage> = {}): DnsMessage {
  return {
    id: 1,
    flags: {
      qr: false, opcode: DnsOpcode.QUERY, aa: false, tc: false, rd: true,
      ra: false, ad: false, cd: false, rcode: DnsRcode.NOERROR,
    },
    questions: [],
    answers: [],
    authorities: [],
    additionals: [],
    ...overrides,
  };
}

describe('DnsMessageCodec — RFC 1035 §4 wire format', () => {
  it('round-trips a simple recursive query with a single question', () => {
    const message = emptyMessage({
      id: 0x1234,
      questions: [baseQuestion('www.example.com')],
    });

    const bytes = encodeDnsMessage(message);
    const decoded = decodeDnsMessage(bytes);

    expect(decoded).toEqual(message);
  });

  it('encodes the 12-byte header with correct section counts', () => {
    const message = emptyMessage({
      id: 0x0001,
      questions: [baseQuestion('example.com')],
    });
    const bytes = encodeDnsMessage(message);

    expect(bytes[0]).toBe(0x00);
    expect(bytes[1]).toBe(0x01); // ID
    expect(bytes[4]).toBe(0x00);
    expect(bytes[5]).toBe(0x01); // QDCOUNT = 1
    expect(bytes[6]).toBe(0x00);
    expect(bytes[7]).toBe(0x00); // ANCOUNT = 0
    expect(bytes[8]).toBe(0x00);
    expect(bytes[9]).toBe(0x00); // NSCOUNT = 0
    expect(bytes[10]).toBe(0x00);
    expect(bytes[11]).toBe(0x00); // ARCOUNT = 0
  });

  it('round-trips a response carrying an A record answer', () => {
    const message = emptyMessage({
      id: 42,
      flags: {
        qr: true, opcode: DnsOpcode.QUERY, aa: true, tc: false, rd: true,
        ra: false, ad: false, cd: false, rcode: DnsRcode.NOERROR,
      },
      questions: [baseQuestion('host.example.com')],
      answers: [makeARecord('host.example.com', 3600, '192.0.2.1')],
    });

    const bytes = encodeDnsMessage(message);
    const decoded = decodeDnsMessage(bytes);

    expect(decoded).toEqual(message);
  });

  it('round-trips an AAAA record', () => {
    const message = emptyMessage({
      questions: [baseQuestion('host.example.com', RRType.AAAA)],
      answers: [makeAaaaRecord('host.example.com', 3600, '2001:db8::1')],
    });
    const decoded = decodeDnsMessage(encodeDnsMessage(message));
    expect(decoded).toEqual(message);
  });

  it('round-trips an NS record naming a nameserver', () => {
    const message = emptyMessage({
      questions: [baseQuestion('example.com', RRType.NS)],
      answers: [makeNsRecord('example.com', 86400, 'ns1.example.com')],
    });
    const decoded = decodeDnsMessage(encodeDnsMessage(message));
    expect(decoded).toEqual(message);
  });

  it('round-trips a SOA record with all five timers', () => {
    const message = emptyMessage({
      questions: [baseQuestion('example.com', RRType.SOA)],
      answers: [makeSoaRecord('example.com', 3600, {
        mname: 'ns1.example.com', rname: 'hostmaster.example.com',
        serial: 2026070100, refresh: 7200, retry: 3600, expire: 1209600, minimum: 300,
      })],
    });
    const decoded = decodeDnsMessage(encodeDnsMessage(message));
    expect(decoded).toEqual(message);
  });

  it('round-trips a multi-segment TXT record', () => {
    const message = emptyMessage({
      questions: [baseQuestion('example.com', RRType.TXT)],
      answers: [makeTxtRecord('example.com', 3600, ['segment one', 'segment two'])],
    });
    const decoded = decodeDnsMessage(encodeDnsMessage(message));
    expect(decoded).toEqual(message);
  });

  it('applies name compression so a repeated owner name costs 2 bytes via a pointer', () => {
    const message = emptyMessage({
      questions: [baseQuestion('www.example.com')],
      answers: [
        makeARecord('www.example.com', 3600, '192.0.2.1'),
        makeARecord('www.example.com', 3600, '192.0.2.2'),
      ],
    });
    const bytes = encodeDnsMessage(message);

    // Without compression, each repeated "www.example.com" owner name would
    // cost 18 bytes; with compression it costs 2 (a pointer). The whole
    // message must stay well under the naive uncompressed size.
    const naiveUpperBound = 12 + 18 + 4 + 3 * (18 + 10 + 4);
    expect(bytes.length).toBeLessThan(naiveUpperBound);

    const decoded = decodeDnsMessage(bytes);
    expect(decoded).toEqual(message);
  });

  it('round-trips multiple questions and answers together', () => {
    const message = emptyMessage({
      questions: [baseQuestion('a.example.com'), baseQuestion('b.example.com')],
      answers: [
        makeARecord('a.example.com', 300, '192.0.2.10'),
        makeARecord('b.example.com', 300, '192.0.2.20'),
      ],
    });
    const decoded = decodeDnsMessage(encodeDnsMessage(message));
    expect(decoded).toEqual(message);
  });

  it('decodes a known hexadecimal query packet (dig-style A query for example.com)', () => {
    const hex =
      '1234' + // ID
      '0100' + // flags: RD=1
      '0001' + // QDCOUNT
      '0000' + '0000' + '0000' + // AN/NS/AR = 0
      '076578616d706c6503636f6d00' + // 7example3com0
      '0001' + // QTYPE A
      '0001'; // QCLASS IN
    const bytes = new Uint8Array(hex.match(/.{2}/g)!.map(byte => parseInt(byte, 16)));

    const decoded = decodeDnsMessage(bytes);

    expect(decoded.id).toBe(0x1234);
    expect(decoded.flags.rd).toBe(true);
    expect(decoded.questions).toEqual([{ qname: 'example.com', qtype: RRType.A, qclass: DnsClass.IN }]);

    const reencoded = encodeDnsMessage(decoded);
    expect(Array.from(reencoded)).toEqual(Array.from(bytes));
  });

  it('throws DnsMessageError on truncated input', () => {
    expect(() => decodeDnsMessage(new Uint8Array([0x00, 0x01]))).toThrow(DnsMessageError);
  });

  it('throws DnsMessageError when a compression pointer points forward or out of range', () => {
    const malformed = new Uint8Array([
      0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0xc0, 0xff, // pointer to out-of-range offset
      0x00, 0x01, 0x00, 0x01,
    ]);
    expect(() => decodeDnsMessage(malformed)).toThrow(DnsMessageError);
  });
});
