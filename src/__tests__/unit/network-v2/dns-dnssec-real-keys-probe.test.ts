/**
 * Sonde du DNSSEC réel hors vecteurs de la RFC 4035 : algorithmes 5, 8 et 13,
 * DS SHA-1 et SHA-256, octets DNSKEY/RRSIG/DS réellement sur le fil,
 * RFC 4035 §2.2 (le NS d'une délégation et la colle ne sont pas signés) et
 * §2.3 (la chaîne NSEC omet la colle).
 *
 * Avant : toutes les clés étaient « sim-… » et les signatures des empreintes
 * FNV ; les octets DNSKEY sur le fil étaient le texte de la chaîne, et
 * chaque RRset de la zone était signé, y compris délégations et colle. Les cas
 * tombent tous, sauf le témoin « un RRset authoritatif est signé ».
 */
import { describe, it, expect } from 'vitest';
import { RRType } from '@/network/dns/wire/RRType';
import { DnsOpcode, DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import { encodeDnsMessage, decodeDnsMessage } from '@/network/dns/wire/DnsMessageCodec';
import {
  makeARecord, makeSoaRecord, makeNsRecord,
} from '@/network/dns/wire/ResourceRecord';
import type { DnskeyRecordData, DsRecordData, RrsigRecordData } from '@/network/dns/wire/ResourceRecord';
import { Zone } from '@/network/dns/zone/Zone';
import {
  generateZoneKey, makeDsForKey, dsMatchesKey, keyTagOf, DnssecAlgorithm, DnssecDigestType,
} from '@/network/dns/dnssec/DnsKey';
import { signRRSet, verifySignature, signZone, defaultSignatureWindow } from '@/network/dns/dnssec/DnsSigner';
import { base64ToBytes } from '@/crypto/encoding';

const NOW = Math.floor(Date.now() / 1000);
const window = defaultSignatureWindow(NOW);

describe.each([
  ['ECDSAP256SHA256', DnssecAlgorithm.ECDSAP256SHA256, 64],
  ['RSASHA256', DnssecAlgorithm.RSASHA256, 128],
  ['RSASHA1', DnssecAlgorithm.RSASHA1, 128],
])('algorithme %s', (_name, algorithm, signatureOctets) => {
  const key = generateZoneKey('example.com', 'zsk', 3600, algorithm);
  const rrset = [makeARecord('www.example.com', 300, '192.0.2.1')];

  it('la signature fait la taille de l’algorithme et se vérifie', () => {
    const rrsig = signRRSet(rrset, 'example.com', key, window);
    const data = rrsig.data as RrsigRecordData;
    expect(base64ToBytes(data.signature).length).toBe(signatureOctets);
    expect(verifySignature(rrset, data, key.data, NOW)).toBe(true);
  });

  it('une autre clé du même algorithme ne vérifie pas', () => {
    const other = generateZoneKey('example.com', 'zsk', 3600, algorithm, 'autre');
    const rrsig = signRRSet(rrset, 'example.com', key, window).data as RrsigRecordData;
    expect(verifySignature(rrset, { ...rrsig, keyTag: keyTagOf(other.data) }, other.data, NOW)).toBe(false);
  });

  it('une signature tronquée d’un octet est rejetée', () => {
    const data = signRRSet(rrset, 'example.com', key, window).data as RrsigRecordData;
    const shorter = Buffer.from(base64ToBytes(data.signature).slice(1)).toString('base64');
    expect(verifySignature(rrset, { ...data, signature: shorter }, key.data, NOW)).toBe(false);
  });

  it('DNSKEY et RRSIG traversent le fil en octets bruts', () => {
    const rrsig = signRRSet(rrset, 'example.com', key, window);
    const message = decodeDnsMessage(encodeDnsMessage({
      id: 1, flags: { qr: true, opcode: DnsOpcode.QUERY, aa: true, tc: false, rd: false, ra: false, ad: false, cd: false, rcode: DnsRcode.NOERROR },
      questions: [{ qname: 'example.com', qtype: RRType.DNSKEY, qclass: 1 }],
      answers: [key, rrsig], authorities: [], additionals: [],
    }));
    expect((message.answers[0].data as DnskeyRecordData).publicKey).toBe(key.data.publicKey);
    const again = message.answers[1].data as RrsigRecordData;
    expect(verifySignature(rrset, again, key.data, NOW)).toBe(true);
  });

  it.each([DnssecDigestType.SHA1, DnssecDigestType.SHA256])('DS de type %i : correspond à sa clé seulement', (digestType) => {
    const ds = makeDsForKey('example.com', 3600, key, digestType);
    expect((ds.data as DsRecordData).digest.length).toBe(digestType === 1 ? 40 : 64);
    expect(dsMatchesKey('example.com', ds.data, key.data)).toBe(true);
    const other = generateZoneKey('example.com', 'zsk', 3600, algorithm, 'autre');
    expect(dsMatchesKey('example.com', ds.data, other.data)).toBe(false);
  });
});

describe('signature de zone (RFC 4035 §2.2, §2.3)', () => {
  const zone = new Zone('example.com', makeSoaRecord('example.com', 3600, {
    mname: 'ns1.example.com', rname: 'h.example.com', serial: 1, refresh: 7200, retry: 3600, expire: 1209600, minimum: 300,
  }));
  zone.addRecord(makeNsRecord('example.com', 3600, 'ns1.example.com'));
  zone.addRecord(makeARecord('ns1.example.com', 3600, '192.0.2.1'));
  zone.addRecord(makeNsRecord('sub.example.com', 3600, 'ns.sub.example.com'));
  zone.addRecord(makeARecord('ns.sub.example.com', 3600, '192.0.2.53'));
  signZone(zone, {
    zsk: generateZoneKey('example.com', 'zsk', 3600), ksk: generateZoneKey('example.com', 'ksk', 3600),
  });
  const signed = (name: string, type: number) =>
    (zone.getRRSet(name, RRType.RRSIG) ?? []).some((sig) => (sig.data as RrsigRecordData).typeCovered === type);

  it('témoin : un RRset authoritatif est signé', () => {
    expect(signed('ns1.example.com', RRType.A)).toBe(true);
  });
  it('le NS d’une délégation n’est pas signé', () => {
    expect(signed('sub.example.com', RRType.NS)).toBe(false);
  });
  it('la colle n’est pas signée', () => {
    expect(signed('ns.sub.example.com', RRType.A)).toBe(false);
  });
  it('la chaîne NSEC omet la colle mais garde le point de délégation', () => {
    expect(zone.getRRSet('ns.sub.example.com', RRType.NSEC)).toBeUndefined();
    expect(zone.getRRSet('sub.example.com', RRType.NSEC)).toBeDefined();
  });
});
