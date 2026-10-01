/**
 * DNSSEC réel contre les vecteurs publiés de la RFC 4035, Annexe A.
 *
 * La zone « example. » de l'annexe est signée en RSASHA1 (algorithme 5) par
 * une vraie paire de clés : les étiquettes de clé 38519 (ZSK) et 9465 (KSK),
 * et les RRSIG sont ceux du texte de la RFC, recopiés tels quels. Les vérifier
 * ici prouve d'un coup la canonicalisation de la RFC 4034 §6 (noms en
 * minuscules, TTL d'origine, tri des RDATA), le calcul d'étiquette de clé de
 * l'annexe B, l'analyse de la clé RSA de la RFC 3110 et PKCS#1 v1.5 sur SHA-1.
 *
 * Avant : la signature était une empreinte FNV-1a, l'étiquette de clé un FNV
 * et les clés des chaînes « sim-… » ; aucune signature de la RFC ne pouvait
 * se vérifier (tous les cas tombent, dont le témoin de sens inverse). Le
 * témoin « un octet de RDATA change » prouve que le verdict n'est pas
 * un « true » de complaisance.
 */

import { describe, it, expect } from 'vitest';
import { RRType } from '@/network/dns/wire/RRType';
import {
  makeDnskeyRecord, makeRrsigRecord, makeSoaRecord, makeNsRecord, makeMxRecord, makeARecord,
  makeAaaaRecord, makeNsecRecord,
} from '@/network/dns/wire/ResourceRecord';
import type { ResourceRecord, ResourceRecordData } from '@/network/dns/wire/ResourceRecord';
import { keyTagOf } from '@/network/dns/dnssec/DnsKey';
import { verifySignature } from '@/network/dns/dnssec/DnsSigner';

const INCEPTION = Date.UTC(2004, 3, 9, 18, 36, 19) / 1000;
const EXPIRATION = Date.UTC(2004, 4, 9, 18, 36, 19) / 1000;
const NOW = Date.UTC(2004, 3, 20, 12, 0, 0) / 1000;

const join = (...lines: string[]): string => lines.join('');

const ZSK = makeDnskeyRecord('example', 3600, {
  flags: 256, algorithm: 5, publicKey: join(
    'AQOy1bZVvpPqhg4j7EJoM9rI3ZmyEx2OzDBVrZy/lvI5CQePxXHZS4i8dANH4DX3tbHol61e',
    'k8EFMcsGXxKciJFHyhl94C+NwILQdzsUlSFovBZsyl/NX6yEbtw/xN9ZNcrbYvgjjZ/UVPZI',
    'ySFNsgEYvh0z2542lzMKR4Dh8uZffQ=='),
});

const KSK = makeDnskeyRecord('example', 3600, {
  flags: 257, algorithm: 5, publicKey: join(
    'AQOeX7+baTmvpVHb2CcLnL1dMRWbuscRvHXlLnXwDzvqp4tZVKp1sZMepFb8MvxhhW3y/0QZ',
    'syCjczGJ1qk8vJe52iOhInKROVLRwxGpMfzPRLMlGybr51bOV/1se0ODacj3DomyB4QB5gKT',
    'Yot/K9alk5/j8vfd4jWCWD+E1Sze0Q=='),
});

function sig(
  owner: string, type: number, labels: number, keyTag: number, signature: string,
) {
  return makeRrsigRecord(owner, 3600, {
    typeCovered: type, algorithm: 5, labels, originalTtl: 3600,
    expiration: EXPIRATION, inception: INCEPTION, keyTag, signerName: 'example', signature,
  }).data;
}

type Rr = ResourceRecord<ResourceRecordData>;
const asSet = (...records: Rr[]): Rr[] => records;

describe('étiquettes de clé (RFC 4034 annexe B) sur les clés de la RFC 4035', () => {
  it('la ZSK porte l’étiquette 38519', () => {
    expect(keyTagOf(ZSK.data)).toBe(38519);
  });
  it('la KSK porte l’étiquette 9465', () => {
    expect(keyTagOf(KSK.data)).toBe(9465);
  });
});

describe('signatures RSASHA1 de la RFC 4035, annexe A', () => {
  it('SOA de example.', () => {
    const soa = makeSoaRecord('example', 3600, {
      mname: 'ns1.example', rname: 'bugs.x.w.example', serial: 1081539377, refresh: 3600,
      retry: 300, expire: 3600000, minimum: 3600,
    });
    const rrsig = sig('example', RRType.SOA, 1, 38519, join(
      'ONx0k36rcjaxYtcNgq6iQnpNV5+drqYAsC9h7TSJaHCqbhE67Sr6aH2xDUGcqQWu/n0UVzrF',
      'vkgO9ebarZ0GWDKcuwlM6eNB5SiX2K74l5LWDA7S/Un/IbtDq4Ay8NMNLQI7Dw7n4p8/rjkB',
      'jV7j86HyQgM5e7+miRAz8V01b0I='));
    expect(verifySignature([soa], rrsig, ZSK.data, NOW)).toBe(true);
  });

  it('NS de example. (les RDATA sont triés, les noms en minuscules)', () => {
    const rrsig = sig('example', RRType.NS, 1, 38519, join(
      'gl13F00f2U0R+SWiXXLHwsMY+qStYy5k6zfdEuivWc+wd1fmbNCyql0Tk7lHTX6UOxc8AgNf',
      '4ISFve8XqF4q+o9qlnqIzmppU3LiNeKT4FZ8RO5urFOvoMRTbQxW3U0hXWuggE4g3ZpsHv48',
      '0HjMeRaZB/FRPGfJPajngcq6Kwg='));
    const ns = asSet(makeNsRecord('example', 3600, 'ns2.example'), makeNsRecord('example', 3600, 'ns1.example'));
    expect(verifySignature(ns, rrsig, ZSK.data, NOW)).toBe(true);
  });

  it('NS avec un nom en majuscules : même condensé, la forme canonique met en minuscules', () => {
    const rrsig = sig('example', RRType.NS, 1, 38519, join(
      'gl13F00f2U0R+SWiXXLHwsMY+qStYy5k6zfdEuivWc+wd1fmbNCyql0Tk7lHTX6UOxc8AgNf',
      '4ISFve8XqF4q+o9qlnqIzmppU3LiNeKT4FZ8RO5urFOvoMRTbQxW3U0hXWuggE4g3ZpsHv48',
      '0HjMeRaZB/FRPGfJPajngcq6Kwg='));
    const ns = asSet(makeNsRecord('EXAMPLE', 3600, 'NS1.Example'), makeNsRecord('example', 3600, 'ns2.example'));
    expect(verifySignature(ns, rrsig, ZSK.data, NOW)).toBe(true);
  });

  it('MX de example.', () => {
    const rrsig = sig('example', RRType.MX, 1, 38519, join(
      'HyDHYVT5KHSZ7HtO/vypumPmSZQrcOP3tzWB2qaKkHVPfau/DgLgS/IKENkYOGL95G4N+NzE',
      'VyNU8dcTOckT+ChPcGeVjguQ7a3Ao9Z/ZkUO6gmmUW4b89rz1PUxW4jzUxj66PTwoVtUU/iM',
      'W6OISukd1EQt7a0kygkg+PEDxdI='));
    expect(verifySignature([makeMxRecord('example', 3600, 1, 'xx.example')], rrsig, ZSK.data, NOW)).toBe(true);
  });

  it('NSEC de example. (le nom suivant et la bitmap de types)', () => {
    const rrsig = sig('example', RRType.NSEC, 1, 38519, join(
      'O0k558jHhyrC97ISHnislm4kLMW48C7U7cBmFTfhke5iVqNRVTB1STLMpgpbDIC9hcryoO0V',
      'Z9ME5xPzUEhbvGnHd5sfzgFVeGxr5Nyyq4tWSDBgIBiLQUv1ivy29vhXy7WgR62dPrZ0PWvm',
      'jfFJ5arXf4nPxp/kEowGgBRzY/U='));
    const nsec = makeNsecRecord('example', 3600, 'a.example', [
      RRType.NS, RRType.SOA, RRType.MX, RRType.RRSIG, RRType.NSEC, RRType.DNSKEY,
    ]);
    expect(verifySignature([nsec], rrsig, ZSK.data, NOW)).toBe(true);
  });

  it('DNSKEY de example., signé par la KSK 9465 puis par la ZSK 38519', () => {
    const keys = asSet(ZSK, KSK);
    const byKsk = sig('example', RRType.DNSKEY, 1, 9465, join(
      'ZxgauAuIj+k1YoVEOSlZfx41fcmKzTFHoweZxYnz99JVQZJ33wFS0Q0jcP7VXKkaElXk9nYJ',
      'XevO/7nAbo88iWsMkSpSR6jWzYYKwfrBI/L9hjYmyVO9m6FjQ7uwM4dCP/bIuV/DKqOAK9NY',
      'NC3AHfvCV1Tp4VKDqxqG7R5tTVM='));
    const byZsk = sig('example', RRType.DNSKEY, 1, 38519, join(
      'eGL0s90glUqcOmloo/2y+bSzyEfKVOQViD9ZDNhLz/Yn9CQZlDVRJffACQDAUhXpU/oP34ri',
      'bKBpysRXosczFrKqS5Oa0bzMOfXCXup9qHApeFIku28Vqfr8Nt7cigZLxjK+u0Ws/4lIRjKk',
      '7z5OXogYVaFzHKillDt3HRxHIZM='));
    expect(verifySignature(keys, byKsk, KSK.data, NOW)).toBe(true);
    expect(verifySignature(keys, byZsk, ZSK.data, NOW)).toBe(true);
  });

  it('A et AAAA de ai.example.', () => {
    const a = sig('ai.example', RRType.A, 2, 38519, join(
      'pAOtzLP2MU0tDJUwHOKE5FPIIHmdYsCgTb5BERGgpnJluA9ixOyf6xxVCgrEJW0WNZSsJicd',
      'hBHXfDmAGKUajUUlYSAH8tS4ZnrhyymIvk3uArDu2wfT130e9UHnumaHHMpUTosKe22PblOy',
      '6zrTpg9FkS0XGVmYRvOTNYx2HvQ='));
    const aaaa = sig('ai.example', RRType.AAAA, 2, 38519, join(
      'nLcpFuXdT35AcE+EoafOUkl69KB+/e56XmFKkewXG2IadYLKAOBIoR5+VoQV3XgTcofTJNsh',
      '1rnF6Eav2zpZB3byI6yo2bwY8MNkr4A7cL9TcMmDwV/hWFKsbGBsj8xSCN/caEL2CWY/5XP2',
      'sZM6QjBBLmukH30+w1z3h8PUP2o='));
    expect(verifySignature([makeARecord('ai.example', 3600, '192.0.2.9')], a, ZSK.data, NOW)).toBe(true);
    expect(verifySignature([makeAaaaRecord('ai.example', 3600, '2001:db8::f00:baa9')], aaaa, ZSK.data, NOW)).toBe(true);
  });

  it('MX du générique *.w.example. (étiquettes 2) et sa synthèse pour a.w.example.', () => {
    const rrsig = sig('*.w.example', RRType.MX, 2, 38519, join(
      'OMK8rAZlepfzLWW75Dxd63jy2wswESzxDKG2f9AMN1CytCd10cYISAxfAdvXSZ7xujKAtPbc',
      'tvOQ2ofO7AZJ+d01EeeQTVBPq4/6KCWhqe2XTjnkVLNvvhnc0u28aoSsG0+4InvkkOHknKxw',
      '4kX18MMR34i8lC36SR5xBni8vHI='));
    expect(verifySignature([makeMxRecord('*.w.example', 3600, 1, 'ai.example')], rrsig, ZSK.data, NOW)).toBe(true);
    expect(verifySignature([makeMxRecord('a.w.example', 3600, 1, 'ai.example')], rrsig, ZSK.data, NOW)).toBe(true);
  });

  it('MX de x.w.example. (étiquettes 3)', () => {
    const rrsig = sig('x.w.example', RRType.MX, 3, 38519, join(
      'Il2WTZ+Bkv+OytBx4LItNW5mjB4RCwhOO8y1XzPHZmZUTVYL7LaA63f6T9ysVBzJRI3KRjAP',
      'H3U1qaYnDoN1DrWqmi9RJe4FoObkbcdm7P3Ikx70ePCoFgRz1Yq+bVVXCvGuAU4xALv3W/Y1',
      'jNSlwZ2mSWKHfxFQxPtLj8s32+k='));
    expect(verifySignature([makeMxRecord('x.w.example', 3600, 1, 'xx.example')], rrsig, ZSK.data, NOW)).toBe(true);
  });

  it('témoin : un octet de RDATA modifié invalide la signature', () => {
    const rrsig = sig('ai.example', RRType.A, 2, 38519, join(
      'pAOtzLP2MU0tDJUwHOKE5FPIIHmdYsCgTb5BERGgpnJluA9ixOyf6xxVCgrEJW0WNZSsJicd',
      'hBHXfDmAGKUajUUlYSAH8tS4ZnrhyymIvk3uArDu2wfT130e9UHnumaHHMpUTosKe22PblOy',
      '6zrTpg9FkS0XGVmYRvOTNYx2HvQ='));
    expect(verifySignature([makeARecord('ai.example', 3600, '192.0.2.10')], rrsig, ZSK.data, NOW)).toBe(false);
  });

  it('témoin : hors de la fenêtre de validité, la signature est rejetée', () => {
    const rrsig = sig('ai.example', RRType.A, 2, 38519, join(
      'pAOtzLP2MU0tDJUwHOKE5FPIIHmdYsCgTb5BERGgpnJluA9ixOyf6xxVCgrEJW0WNZSsJicd',
      'hBHXfDmAGKUajUUlYSAH8tS4ZnrhyymIvk3uArDu2wfT130e9UHnumaHHMpUTosKe22PblOy',
      '6zrTpg9FkS0XGVmYRvOTNYx2HvQ='));
    expect(verifySignature([makeARecord('ai.example', 3600, '192.0.2.9')], rrsig, ZSK.data, EXPIRATION + 1)).toBe(false);
  });
});
