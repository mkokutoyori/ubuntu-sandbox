/*
 * Structure — AuthoritativeServer takes the RA bit of every response it builds from the policy hook
 * `recursionAvailable` (RFC 1035 4.1.1: a property of the server, so the same on an answer, a NXDOMAIN, a REFUSED, a
 * FORMERR, a NOTIMP and a BADVERS), reads it again at each response, and keeps RA=0 when the owner gives no hook (the
 * default every other caller of the engine relies on). Discrimination (run on the tree before the change): 7 of 14
 * cases fall — the six that expect RA=1 from the hook and the one that reads the hook again, the hook did not exist.
 * The 7 that pass either way: the six "clears RA when the hook says recursion is not available" cases are
 * NON-REGRESSION (RA was always 0), and "without a hook RA stays clear" is the CONTROL.
 */
import { describe, it, expect } from 'vitest';
import { RRType, DnsClass } from '@/network/dns/wire/RRType';
import { DnsOpcode, DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import { Zone } from '@/network/dns/zone/Zone';
import { makeARecord, makeNsRecord, makeSoaRecord } from '@/network/dns/wire/ResourceRecord';
import { ZoneStore } from '@/network/dns/zone/ZoneStore';
import { AuthoritativeServer } from '@/network/dns/resolver/AuthoritativeServer';
import { makeOptRecord, DEFAULT_EDNS_PAYLOAD_SIZE } from '@/network/dns/wire/EdnsOptRecord';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';

function store(): ZoneStore {
  const zone = new Zone('example.com', makeSoaRecord('example.com', 3600, {
    mname: 'ns1.example.com', rname: 'hostmaster.example.com',
    serial: 1, refresh: 7200, retry: 3600, expire: 1209600, minimum: 300,
  }));
  zone.addRecord(makeNsRecord('example.com', 86400, 'ns1.example.com'));
  zone.addRecord(makeARecord('ns1.example.com', 3600, '192.0.2.1'));
  zone.addRecord(makeARecord('www.example.com', 3600, '192.0.2.10'));
  const zones = new ZoneStore();
  zones.addZone(zone);
  return zones;
}

function query(qnames: readonly string[], overrides: Partial<DnsMessage['flags']> = {}, additionals: DnsMessage['additionals'] = []): DnsMessage {
  return {
    id: 7,
    flags: { qr: false, opcode: DnsOpcode.QUERY, aa: false, tc: false, rd: true, ra: false, ad: false, cd: false, rcode: DnsRcode.NOERROR, ...overrides },
    questions: qnames.map((qname) => ({ qname, qtype: RRType.A, qclass: DnsClass.IN })),
    answers: [], authorities: [], additionals: [...additionals],
  };
}

const RESPONSES: ReadonlyArray<readonly [string, () => DnsMessage, number]> = [
  ['an answer', () => query(['www.example.com']), DnsRcode.NOERROR],
  ['a NXDOMAIN', () => query(['absent.example.com']), DnsRcode.NXDOMAIN],
  ['a REFUSED outside every zone', () => query(['www.elsewhere.test']), DnsRcode.REFUSED],
  ['a FORMERR for two questions', () => query(['www.example.com', 'ns1.example.com']), DnsRcode.FORMERR],
  ['a NOTIMP for an opcode that is not QUERY', () => query(['www.example.com'], { opcode: DnsOpcode.STATUS }), DnsRcode.NOTIMP],
  ['a response to an EDNS version the server does not speak', () => query(['www.example.com'], {}, [makeOptRecord(DEFAULT_EDNS_PAYLOAD_SIZE, { version: 1 })]), DnsRcode.NOERROR],
];

describe('AuthoritativeServer — the recursionAvailable hook', () => {
  it.each(RESPONSES)('%s carries RA when the hook says recursion is available', (_label, build) => {
    const server = new AuthoritativeServer(store(), { recursionAvailable: () => true });
    const response = server.answer(build());
    expect(response.flags.qr).toBe(true);
    expect(response.flags.ra).toBe(true);
  });

  it.each(RESPONSES)('%s clears RA when the hook says recursion is not available', (_label, build, rcode) => {
    const server = new AuthoritativeServer(store(), { recursionAvailable: () => false });
    const response = server.answer(build());
    expect(response.flags.ra).toBe(false);
    if (rcode !== DnsRcode.NOERROR) expect(response.flags.rcode).toBe(rcode);
  });

  it('CONTROL: without a hook RA stays clear on the same responses', () => {
    const server = new AuthoritativeServer(store());
    for (const [, build] of RESPONSES) expect(server.answer(build()).flags.ra).toBe(false);
  });

  it('reads the hook again at every response', () => {
    let available = true;
    const server = new AuthoritativeServer(store(), { recursionAvailable: () => available });
    const first = server.answer(query(['www.example.com']));
    available = false;
    const second = server.answer(query(['www.example.com']));
    expect([first.flags.ra, second.flags.ra]).toEqual([true, false]);
    expect(second.answers.map((record) => record.name)).toEqual(['www.example.com']);
  });
});
