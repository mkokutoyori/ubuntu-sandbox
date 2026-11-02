/*
 * Structure — the imputed name an authoritative answer carries, which [MS-DNSP] DNS_RPC_RRL_PARAMS and ISC-TN-2012-1 3.1
 * define as the name Response Rate Limiting counts a response under: the wildcard when the answer was made from one, the zone
 * name when the name does not exist (every nonexistent name of a zone is told the same thing), the name asked otherwise,
 * and nothing (the root) when no zone answered or the query was refused before any zone was looked up. The name is
 * normalised: lower case, no final dot. AuthoritativeServer.respond hands it out with the message, and answer() is
 * respond().message. Discrimination (run on the tree before the change): every case falls, neither the field nor the
 * method existed.
 */
import { describe, it, expect } from 'vitest';
import { RRType, DnsClass } from '@/network/dns/wire/RRType';
import { DnsOpcode, DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import { Zone } from '@/network/dns/zone/Zone';
import { ZoneStore } from '@/network/dns/zone/ZoneStore';
import { AuthoritativeServer } from '@/network/dns/resolver/AuthoritativeServer';
import { makeARecord, makeCnameRecord, makeNsRecord, makeSoaRecord, makeTxtRecord } from '@/network/dns/wire/ResourceRecord';
import { makeOptRecord } from '@/network/dns/wire/EdnsOptRecord';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';

function store(): ZoneStore {
  const zone = new Zone('corp.test', makeSoaRecord('corp.test', 3600, {
    mname: 'ns1.corp.test', rname: 'hostmaster.corp.test', serial: 1, refresh: 7200, retry: 3600, expire: 1209600, minimum: 300,
  }));
  zone.addRecord(makeNsRecord('corp.test', 86400, 'ns1.corp.test'));
  zone.addRecord(makeARecord('ns1.corp.test', 3600, '192.0.2.1'));
  zone.addRecord(makeARecord('web.corp.test', 3600, '192.0.2.10'));
  zone.addRecord(makeCnameRecord('alias.corp.test', 3600, 'web.corp.test'));
  zone.addRecord(makeARecord('*.wild.corp.test', 3600, '192.0.2.20'));
  zone.addRecord(makeCnameRecord('*.cn.corp.test', 3600, 'web.corp.test'));
  zone.addRecord(makeNsRecord('sub.corp.test', 3600, 'ns.sub.corp.test'));
  zone.addRecord(makeARecord('ns.sub.corp.test', 3600, '192.0.2.30'));
  zone.addRecord(makeTxtRecord('text.corp.test', 3600, ['hello']));
  const zones = new ZoneStore();
  zones.addZone(zone);
  return zones;
}

const ask = (qname: string, qtype: number = RRType.A) => ({ qname, qtype, qclass: DnsClass.IN });

function query(qname: string, qtype: number = RRType.A, overrides: Partial<DnsMessage> = {}): DnsMessage {
  return {
    id: 7,
    flags: { qr: false, opcode: DnsOpcode.QUERY, aa: false, tc: false, rd: true, ra: false, ad: false, cd: false, rcode: DnsRcode.NOERROR },
    questions: [ask(qname, qtype)],
    answers: [], authorities: [], additionals: [],
    ...overrides,
  };
}

describe('the imputed name of a zone store answer', () => {
  it.each([
    ['an answer', 'web.corp.test', RRType.A, 'web.corp.test'],
    ['an answer asked in capitals with a final dot', 'WEB.Corp.Test.', RRType.A, 'web.corp.test'],
    ['an answer made from a wildcard', 'anything.wild.corp.test', RRType.A, '*.wild.corp.test'],
    ['a CNAME made from a wildcard', 'anything.cn.corp.test', RRType.A, '*.cn.corp.test'],
    ['a CNAME of the zone', 'alias.corp.test', RRType.A, 'alias.corp.test'],
    ['an answer that does not exist for the type', 'web.corp.test', RRType.AAAA, 'web.corp.test'],
    ['a name that does not exist', 'nowhere.corp.test', RRType.A, 'corp.test'],
    ['a name that does not exist, asked in capitals', 'Nowhere.CORP.test.', RRType.A, 'corp.test'],
    ['a name under a delegation', 'host.sub.corp.test', RRType.A, 'host.sub.corp.test'],
    ['a name outside every zone', 'host.other.test', RRType.A, ''],
  ])('is the right name for %s', (_label, qname, qtype, expected) => {
    expect(store().answer(ask(qname, qtype)).imputedName).toBe(expected);
  });

  it('is the zone name for a name the global query block list hides', () => {
    expect(store().answer(ask('web.corp.test'), { blocked: () => true }).imputedName).toBe('corp.test');
  });

  it('is the root when no zone answered', () => {
    const answer = store().answer(ask('host.other.test'));
    expect(answer.rcode).toBe(DnsRcode.REFUSED);
    expect(answer.imputedName).toBe('');
  });
});

describe('the imputed name of an authoritative response', () => {
  const server = () => new AuthoritativeServer(store());

  it('carries the name of the zone store answer along with the message', () => {
    const response = server().respond(query('anything.wild.corp.test'));
    expect(response.imputedName).toBe('*.wild.corp.test');
    expect(response.message.answers).toHaveLength(1);
    expect(response.message.flags.rcode).toBe(DnsRcode.NOERROR);
  });

  it('is the zone name for a name error', () => {
    const response = server().respond(query('nowhere.corp.test'));
    expect(response.message.flags.rcode).toBe(DnsRcode.NXDOMAIN);
    expect(response.imputedName).toBe('corp.test');
  });

  it('is the root for a query refused before any zone is looked up', () => {
    const none = { ...query('web.corp.test'), questions: [] };
    const two = { ...query('web.corp.test'), questions: [ask('web.corp.test'), ask('mail.corp.test')] };
    const notQuery = query('web.corp.test', RRType.A, { flags: { ...query('x').flags, opcode: DnsOpcode.STATUS } });
    const badVersion = query('web.corp.test', RRType.A, { additionals: [makeOptRecord(1232, { version: 1 })] });
    expect(server().respond(none).imputedName).toBe('');
    expect(server().respond(two).imputedName).toBe('');
    expect(server().respond(notQuery).imputedName).toBe('');
    expect(server().respond(badVersion).imputedName).toBe('');
    expect(server().respond(two).message.flags.rcode).toBe(DnsRcode.FORMERR);
    expect(server().respond(notQuery).message.flags.rcode).toBe(DnsRcode.NOTIMP);
  });

  it('is the root for a query that fails the EDNS checks', () => {
    const withTwoOpts = query('web.corp.test', RRType.A, { additionals: [makeOptRecord(1232), makeOptRecord(1232)] });
    expect(server().respond(withTwoOpts).message.flags.rcode).toBe(DnsRcode.FORMERR);
    expect(server().respond(withTwoOpts).imputedName).toBe('');
    const refusingEdns = new AuthoritativeServer(store(), { acceptsEdns: () => false });
    const withOpt = query('web.corp.test', RRType.A, { additionals: [makeOptRecord(1232)] });
    expect(refusingEdns.respond(withOpt).message.flags.rcode).toBe(DnsRcode.FORMERR);
    expect(refusingEdns.respond(withOpt).imputedName).toBe('');
  });

  it('answer() is the message of respond()', () => {
    for (const asked of [query('web.corp.test'), query('nowhere.corp.test'), query('host.other.test')]) {
      expect(server().answer(asked)).toEqual(server().respond(asked).message);
    }
  });
});
