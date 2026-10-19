/**
 * L'ordre des destinations a UN proprietaire : `layers/internet/DestinationSelection.ts`, que le `ping` de Linux et celui de Windows
 * appelleront pour choisir entre le A et le AAAA d'un nom (lots suivants). Il porte deux profils sur un seul algorithme : celui de la
 * RFC 6724 §6 (Windows, dont la table `netsh interface ipv6 show prefixpolicies` est celle de §2.1) et celui de glibc 2.35
 * (`rfc3484_sort`, que Linux execute dans `getaddrinfo`), qui differe par ses tables (RFC 3484 : l'IPv4-mappee a 10, une ULA sans ligne
 * propre donc a 40, le Teredo a l'etiquette 7), par la regle 9 de l'IPv4 (un prefixe commun n'existe qu'a l'interieur du sous-reseau
 * de la source) et par les regles 6 et 8, qui s'appliquent aussi a deux destinations sans source. La sonde lit le module sans machine :
 * les tables, les portees de §3.1 et §3.2 (une adresse IPv4 privee est globale), la longueur de prefixe commun de §2.2 et les dix
 * regles de §6, dont les regles 3, 4 et 7 qui lisent les faits que la source porte (adresse depreciee, adresse mere, interface native).
 *
 * Mesure de depart (5797b862, un LinuxPC et un WindowsPC relies par `fd00::/64` et `10.0.0.0/24`, un fichier hosts qui donne un A
 * et un AAAA au nom `twin`) : aucun module n'ordonne des destinations. `ping -c 1 localhost` va a 127.0.0.1 au lieu de ::1
 * (precedence 50 contre 35), `ping twin` va a l'IPv4 sous Linux comme sous Windows, et le `-6` de Windows ne choisit rien :
 * `ping -n 1 -6 twin` repond `Pinging twin [10.0.0.1]`.
 *
 * Autorites : RFC 6724 §2.1 (table de politique), §2.2 (CommonPrefixLen), §3.1 et §3.2 (portees) et §6 (regles), lue sur
 * rfc-editor.org -- le texte n'est pas dans `docs/rfc` ; ses exemples de §10.2 (les neuf), §10.3, §10.4 et §10.6 sont repris tels
 * quels, dans les deux ordres d'entree. Pour Linux, le code de glibc 2.35 (`sysdeps/posix/getaddrinfo.c` : `default_labels`,
 * `default_precedence`, `default_scopes`, `get_scope`, `match_prefix`, `rfc3484_sort` ; `sysdeps/unix/sysv/linux/check_pf.c` pour les
 * drapeaux d'adresse deprecie/optimiste et mere ; `check_native.c` pour le type d'interface), lu sur GitHub. Aucune capture d'une
 * machine reelle : l'ordre exact d'un `getaddrinfo` de Windows au dela de la RFC n'est pas fige.
 *
 * Discrimination : tous les cas, dont aucun ne peut passer contre 5797b862 : le module n'y existe pas, la sonde ne se charge pas
 * (« Cannot find package »). Aucun temoin de banc ici, parce qu'aucun cas n'est un refus : chacun affirme un resultat (une
 * precedence, une portee, une longueur, un ordre), et les cas des tables personnalisees et des deux profils prouvent que la table et
 * le profil sont lus au lieu d'etre retenus.
 */
import { describe, it, expect } from 'vitest';
import { IPAddress, IPv6Address } from '@/network/core/types';
import {
  addressScope, commonPrefixLength, DEFAULT_POLICY_TABLE, GLIBC_POLICY, labelOf, orderDestinations, policyFromTable, policyOf,
  precedenceOf, RFC6724_POLICY,
  type DestinationPolicy, type DestinationSelectionPort, type Ipv4Scope, type PolicyEntry, type SelectableAddress, type SourceFacts,
} from '@/network/layers/internet/DestinationSelection';

const v6 = (text: string): IPv6Address => new IPv6Address(text);
const v4 = (text: string): IPAddress => new IPAddress(text);
const address = (text: string): SelectableAddress => (text.includes(':') ? v6(text) : v4(text));

type SourceSpec = string | null | (Omit<SourceFacts, 'address'> & { readonly address: string });

const portWith = (sources: Record<string, SourceSpec>): DestinationSelectionPort => ({
  sourceFor: (destination) => {
    const spec = sources[destination.toString()];
    if (spec === undefined || spec === null) return null;
    return typeof spec === 'string' ? { address: address(spec) } : { ...spec, address: address(spec.address) };
  },
});

const order = (
  candidates: SelectableAddress[], sources: Record<string, SourceSpec>, policy?: DestinationPolicy,
): string[] =>
  orderDestinations(candidates, (candidate) => candidate, portWith(sources), policy).map((candidate) => candidate.toString());

const entry = (prefix: string, length: number, precedence: number, label: number): PolicyEntry =>
  ({ prefix: v6(prefix), length, precedence, label });

const preferIpv4Table: readonly PolicyEntry[] = DEFAULT_POLICY_TABLE.map((row) =>
  row.length === 96 && row.prefix.equals(v6('::ffff:0:0')) ? { ...row, precedence: 100 } : row);
const preferIpv4 = policyFromTable(preferIpv4Table);

const preferGlobalOverLinkLocal = policyFromTable([...DEFAULT_POLICY_TABLE, entry('fe80::', 10, 33, 1)]);

const siteUlaTable = policyFromTable([...DEFAULT_POLICY_TABLE, entry('fd11:1111:1111::', 48, 45, 14)]);

describe('the default policy table of RFC 6724 §2.1', () => {
  it.each([
    ['::1', 50, 0],
    ['2001:db8::1', 40, 1],
    ['2002:c000:204::1', 30, 2],
    ['2001:0:4136:e378::1', 5, 5],
    ['2001:0:8000::1', 5, 5],
    ['2001:1::1', 40, 1],
    ['fd00::1', 3, 13],
    ['::2', 1, 3],
    ['::8000:1', 1, 3],
    ['fec0::1', 1, 11],
    ['fee0::1', 1, 11],
    ['3ffe::1', 1, 12],
    ['3ffe:8000::1', 1, 12],
    ['3fff::1', 40, 1],
  ])('%s has precedence %i and label %i', (text, precedence, label) => {
    expect(policyOf(v6(text))).toMatchObject({ precedence, label });
  });

  it('an IPv4 address is looked up as its IPv4-mapped IPv6 address', () => {
    expect(policyOf(v4('192.0.2.1'))).toMatchObject({ precedence: 35, label: 4 });
    expect(policyOf(v4('127.0.0.1'))).toMatchObject({ precedence: 35, label: 4 });
  });

  it('the longest matching prefix decides, whatever the order of the table', () => {
    const reversed = [...DEFAULT_POLICY_TABLE].reverse();
    expect(policyOf(v6('::1'), reversed)).toMatchObject({ precedence: 50, label: 0 });
    expect(policyOf(v6('fd00::1'), reversed)).toMatchObject({ precedence: 3, label: 13 });
    expect(policyOf(v6('2001:db8::1'), reversed)).toMatchObject({ precedence: 40, label: 1 });
  });

  it('a table that has no entry for an address gives it neither precedence nor a label that can match', () => {
    const onlyLoopback = DEFAULT_POLICY_TABLE.filter((row) => row.length === 128);
    expect(policyOf(v6('2001:db8::1'), onlyLoopback)).toMatchObject({ precedence: 0, label: -1 });
  });
});

describe('the built-in tables of glibc 2.35 (getaddrinfo.c)', () => {
  it.each([
    ['::1', 50, 0],
    ['2001:db8::1', 40, 1],
    ['2002:c000:204::1', 30, 2],
    ['2001:0:4136:e378::1', 40, 7],
    ['fd00::1', 40, 6],
    ['fec0::1', 40, 5],
    ['::2', 20, 3],
    ['::ffff:10.0.0.1', 10, 4],
  ])('%s has precedence %i and label %i', (text, precedence, label) => {
    expect(precedenceOf(v6(text), GLIBC_POLICY)).toBe(precedence);
    expect(labelOf(v6(text), GLIBC_POLICY)).toBe(label);
  });

  it('an IPv4 address is looked up as its IPv4-mapped IPv6 address: precedence 10, label 4', () => {
    expect(precedenceOf(v4('192.0.2.1'), GLIBC_POLICY)).toBe(10);
    expect(labelOf(v4('192.0.2.1'), GLIBC_POLICY)).toBe(4);
    expect(precedenceOf(v4('192.0.2.1'), RFC6724_POLICY)).toBe(35);
  });
});

describe('scopes (RFC 6724 §3.1, §3.2)', () => {
  it.each([
    ['127.0.0.1', 2], ['127.8.9.10', 2], ['169.254.13.78', 2],
    ['10.0.0.1', 14], ['172.16.0.1', 14], ['192.168.1.1', 14], ['192.0.2.1', 14],
    ['10.254.0.1', 14], ['169.1.1.1', 14], ['128.8.8.8', 14],
  ])('IPv4 %s has scope %i', (text, scope) => {
    expect(addressScope(v4(text))).toBe(scope);
  });

  it.each([
    ['::1', 2], ['fe80::1', 2], ['fec0::1', 5], ['fee0::1', 5], ['fd00::1', 14], ['2001:db8::1', 14],
    ['ff02::1', 2], ['ff05::1', 5], ['ff0e::1', 14], ['ff01::1', 1],
  ])('IPv6 %s has scope %i', (text, scope) => {
    expect(addressScope(v6(text))).toBe(scope);
  });

  it('a scopev4 table of its own replaces the defaults, the longest prefix deciding', () => {
    const scopes: Ipv4Scope[] = [
      { address: v4('10.0.0.0'), length: 8, scope: 5 },
      { address: v4('10.1.0.0'), length: 16, scope: 2 },
      { address: v4('0.0.0.0'), length: 0, scope: 14 },
    ];
    expect(addressScope(v4('10.9.9.9'), scopes)).toBe(5);
    expect(addressScope(v4('10.1.9.9'), scopes)).toBe(2);
    expect(addressScope(v4('11.1.9.9'), scopes)).toBe(14);
    expect(addressScope(v4('127.0.0.1'), scopes)).toBe(14);
  });
});

describe('CommonPrefixLen (RFC 6724 §2.2)', () => {
  it('counts the leading bits two addresses share', () => {
    expect(commonPrefixLength(v6('2001:db8:1::1'), v6('2001:db8:1::1'))).toBe(128);
    expect(commonPrefixLength(v6('2001:db8:1::1'), v6('2001:db8:2::1'))).toBe(46);
    expect(commonPrefixLength(v6('2001:db8::1'), v6('fd00::1'))).toBe(0);
  });

  it('an IPv4 pair shares its 96 mapped bits and then its own leading bits', () => {
    expect(commonPrefixLength(v4('10.0.0.1'), v4('10.0.0.129'))).toBe(96 + 24);
    expect(commonPrefixLength(v4('10.0.0.1'), v4('11.0.0.1'))).toBe(96 + 7);
    expect(commonPrefixLength(v4('10.1.0.1'), v4('10.2.0.1'))).toBe(96 + 14);
    expect(commonPrefixLength(v4('10.0.1.1'), v4('10.0.2.1'))).toBe(96 + 22);
    expect(commonPrefixLength(v4('10.0.0.1'), v4('10.0.0.1'))).toBe(128);
  });
});

describe('destination ordering (RFC 6724 §6)', () => {
  it('rule 1: a destination without a source is last, whatever its precedence', () => {
    expect(order([v6('2001:db8::1'), v4('10.0.0.1')], { '2001:db8::1': null, '10.0.0.1': '10.0.0.2' }))
      .toEqual(['10.0.0.1', '2001:db8::1']);
    expect(order([v4('10.0.0.1'), v6('2001:db8::1')], { '2001:db8::1': null, '10.0.0.1': '10.0.0.2' }))
      .toEqual(['10.0.0.1', '2001:db8::1']);
  });

  it('rule 1 leaves two destinations without a source to rules 6 and 8, which need no source', () => {
    const sources = { '2001:db8::1': null, '10.0.0.1': null };
    expect(order([v6('2001:db8::1'), v4('10.0.0.1')], sources)).toEqual(['2001:db8::1', '10.0.0.1']);
    expect(order([v4('10.0.0.1'), v6('2001:db8::1')], sources)).toEqual(['2001:db8::1', '10.0.0.1']);
    const sameRank = { '2001:db8::1': null, '2001:db8::2': null };
    expect(order([v6('2001:db8::2'), v6('2001:db8::1')], sameRank)).toEqual(['2001:db8::2', '2001:db8::1']);
    const scopes = { '2001:db8::1': null, 'fe80::1': null };
    expect(order([v6('2001:db8::1'), v6('fe80::1')], scopes)).toEqual(['fe80::1', '2001:db8::1']);
  });

  it('rule 2: a destination whose source has the same scope beats one whose source has not', () => {
    const sources = { '2001:db8::1': 'fe80::1', '2001:db8::2': '2001:db8::3' };
    expect(order([v6('2001:db8::1'), v6('2001:db8::2')], sources)).toEqual(['2001:db8::2', '2001:db8::1']);
    expect(order([v6('2001:db8::2'), v6('2001:db8::1')], sources)).toEqual(['2001:db8::2', '2001:db8::1']);
  });

  it('rule 3: a destination whose source is deprecated comes after one whose source is not', () => {
    const sources = {
      '2001:db8:1::1': { address: '2001:db8:1::2', deprecated: true },
      '2001:db8:3::1': '2001:db8:3::2',
    };
    expect(order([v6('2001:db8:1::1'), v6('2001:db8:3::1')], sources)).toEqual(['2001:db8:3::1', '2001:db8:1::1']);
    expect(order([v6('2001:db8:3::1'), v6('2001:db8:1::1')], sources)).toEqual(['2001:db8:3::1', '2001:db8:1::1']);
    const both = {
      '2001:db8:1::1': { address: '2001:db8:1::2', deprecated: true },
      '2001:db8:3::1': { address: '2001:db8:3::2', deprecated: true },
    };
    expect(order([v6('2001:db8:1::1'), v6('2001:db8:3::1')], both)).toEqual(['2001:db8:1::1', '2001:db8:3::1']);
  });

  it('rule 4: a destination whose source is a home address comes first', () => {
    const sources = {
      '2001:db8:1::1': '2001:db8:1::2',
      '2001:db8:3::1': { address: '2001:db8:3::2', home: true },
    };
    expect(order([v6('2001:db8:1::1'), v6('2001:db8:3::1')], sources)).toEqual(['2001:db8:3::1', '2001:db8:1::1']);
    expect(order([v6('2001:db8:3::1'), v6('2001:db8:1::1')], sources)).toEqual(['2001:db8:3::1', '2001:db8:1::1']);
  });

  it('rule 5: a destination whose source has its own label beats a higher precedence whose source has not', () => {
    const sources = { '2001:db8::1': '2002:c633:6401::2', '2002:c633:6401::1': '2002:c633:6401::2' };
    expect(order([v6('2001:db8::1'), v6('2002:c633:6401::1')], sources)).toEqual(['2002:c633:6401::1', '2001:db8::1']);
  });

  it('rule 6: IPv4 beats a unique local address under RFC 6724, and loses to it under glibc', () => {
    const sources = { 'fd00::1': 'fd00::2', '10.0.0.1': '10.0.0.2' };
    expect(order([v6('fd00::1'), v4('10.0.0.1')], sources)).toEqual(['10.0.0.1', 'fd00::1']);
    expect(order([v4('10.0.0.1'), v6('fd00::1')], sources)).toEqual(['10.0.0.1', 'fd00::1']);
    expect(order([v4('10.0.0.1'), v6('fd00::1')], sources, GLIBC_POLICY)).toEqual(['fd00::1', '10.0.0.1']);
    expect(order([v6('fd00::1'), v4('10.0.0.1')], sources, GLIBC_POLICY)).toEqual(['fd00::1', '10.0.0.1']);
  });

  it('rule 6: a global IPv6 address beats IPv4, and the IPv6 loopback beats the IPv4 one, under both profiles', () => {
    const global = { '2001:db8::1': '2001:db8::2', '10.0.0.1': '10.0.0.2' };
    const loopback = { '::1': '::1', '127.0.0.1': '127.0.0.1' };
    for (const policy of [RFC6724_POLICY, GLIBC_POLICY]) {
      expect(order([v4('10.0.0.1'), v6('2001:db8::1')], global, policy)).toEqual(['2001:db8::1', '10.0.0.1']);
      expect(order([v4('127.0.0.1'), v6('::1')], loopback, policy)).toEqual(['::1', '127.0.0.1']);
    }
  });

  it('rule 6: a 6to4 destination beats IPv4 under glibc (30 over 10) and loses to it under RFC 6724 (30 under 35)', () => {
    const sources = { '2002:c633:6401::1': '2002:c633:6401::2', '10.0.0.1': '10.0.0.2' };
    expect(order([v4('10.0.0.1'), v6('2002:c633:6401::1')], sources, GLIBC_POLICY)).toEqual(['2002:c633:6401::1', '10.0.0.1']);
    expect(order([v6('2002:c633:6401::1'), v4('10.0.0.1')], sources)).toEqual(['10.0.0.1', '2002:c633:6401::1']);
  });

  it('rule 6: a custom table changes the answer, so the table is read and not remembered', () => {
    const sources = { '2001:db8::1': '2001:db8::2', '10.0.0.1': '10.0.0.2' };
    expect(order([v6('2001:db8::1'), v4('10.0.0.1')], sources)).toEqual(['2001:db8::1', '10.0.0.1']);
    expect(order([v6('2001:db8::1'), v4('10.0.0.1')], sources, preferIpv4)).toEqual(['10.0.0.1', '2001:db8::1']);
    expect(order([v6('2001:db8::1'), v4('10.0.0.1')], sources)).toEqual(['2001:db8::1', '10.0.0.1']);
  });

  it('rule 7: a destination reached through a native interface beats one reached through a tunnel', () => {
    const sources = {
      '2001:db8:1::1': { address: '2001:db8:1::2', interfaceIndex: 3, native: false },
      '2001:db8:2::1': { address: '2001:db8:2::2', interfaceIndex: 2, native: true },
    };
    expect(order([v6('2001:db8:1::1'), v6('2001:db8:2::1')], sources)).toEqual(['2001:db8:2::1', '2001:db8:1::1']);
    expect(order([v6('2001:db8:2::1'), v6('2001:db8:1::1')], sources)).toEqual(['2001:db8:2::1', '2001:db8:1::1']);
  });

  it('rule 7 says nothing when both destinations leave by the same interface, whatever the interface is', () => {
    const sources = {
      '2001:db8:1::1': { address: '2001:db8:1::2', interfaceIndex: 3, native: false },
      '2001:db8:2::1': { address: '2001:db8:2::2', interfaceIndex: 3, native: true },
    };
    expect(order([v6('2001:db8:1::1'), v6('2001:db8:2::1')], sources)).toEqual(['2001:db8:1::1', '2001:db8:2::1']);
  });

  it('rule 8: when everything else ties, the smaller scope comes first', () => {
    const sources = { '2001:db8::1': '2001:db8::2', 'fe80::1': 'fe80::2' };
    expect(order([v6('2001:db8::1'), v6('fe80::1')], sources)).toEqual(['fe80::1', '2001:db8::1']);
    expect(order([v6('fe80::1'), v6('2001:db8::1')], sources)).toEqual(['fe80::1', '2001:db8::1']);
  });

  it('rule 9: between two addresses of one family, the longer common prefix with the source wins', () => {
    const sources = { '10.0.0.1': '10.0.0.129', '10.1.0.1': '10.0.0.129' };
    expect(order([v4('10.1.0.1'), v4('10.0.0.1')], sources)).toEqual(['10.0.0.1', '10.1.0.1']);
    expect(order([v4('10.0.0.1'), v4('10.1.0.1')], sources)).toEqual(['10.0.0.1', '10.1.0.1']);
  });

  it('rule 9 does not compare across families', () => {
    const tied = policyFromTable(DEFAULT_POLICY_TABLE.map((row) => (row.length === 0 ? { ...row, precedence: 35, label: 4 } : row)));
    const sources = { '2001:db8::1': '2001:db8::2', '10.0.0.1': '10.0.0.129' };
    expect(order([v6('2001:db8::1'), v4('10.0.0.1')], sources, tied)).toEqual(['2001:db8::1', '10.0.0.1']);
    expect(order([v4('10.0.0.1'), v6('2001:db8::1')], sources, tied)).toEqual(['10.0.0.1', '2001:db8::1']);
  });

  it('rule 9 for IPv4: glibc counts a common prefix only inside the subnet of the source, RFC 6724 counts the mapped bits', () => {
    const sources = {
      '172.16.0.1': { address: '192.168.0.2', prefixLength: 24 },
      '10.200.0.1': { address: '192.168.0.2', prefixLength: 24 },
    };
    expect(order([v4('10.200.0.1'), v4('172.16.0.1')], sources, GLIBC_POLICY)).toEqual(['10.200.0.1', '172.16.0.1']);
    expect(order([v4('10.200.0.1'), v4('172.16.0.1')], sources)).toEqual(['172.16.0.1', '10.200.0.1']);
    const inside = {
      '10.0.1.1': { address: '10.0.0.2', prefixLength: 24 },
      '10.0.0.9': { address: '10.0.0.2', prefixLength: 24 },
    };
    expect(order([v4('10.0.1.1'), v4('10.0.0.9')], inside, GLIBC_POLICY)).toEqual(['10.0.0.9', '10.0.1.1']);
    expect(order([v4('10.0.0.9'), v4('10.0.1.1')], inside, GLIBC_POLICY)).toEqual(['10.0.0.9', '10.0.1.1']);
  });

  it('rule 10: candidates that no rule separates keep the order they came in', () => {
    const sources = { '10.0.0.1': '10.0.0.129', '10.0.0.2': '10.0.0.129' };
    expect(order([v4('10.0.0.1'), v4('10.0.0.2')], sources)).toEqual(['10.0.0.1', '10.0.0.2']);
    expect(order([v4('10.0.0.2'), v4('10.0.0.1')], sources)).toEqual(['10.0.0.2', '10.0.0.1']);
  });

  it('the candidates are returned as they were given, with whatever else they carry', () => {
    const candidates = [{ name: 'a', address: v6('fd00::1') }, { name: 'b', address: v4('10.0.0.1') }];
    const sources = { 'fd00::1': 'fd00::2', '10.0.0.1': '10.0.0.2' };
    const ordered = orderDestinations(candidates, (candidate) => candidate.address, portWith(sources));
    expect(ordered.map((candidate) => candidate.name)).toEqual(['b', 'a']);
    expect(ordered[0]).toBe(candidates[1]);
    expect(candidates.map((candidate) => candidate.name)).toEqual(['a', 'b']);
  });

  it('an empty list and a single candidate come back unchanged', () => {
    expect(order([], {})).toEqual([]);
    expect(order([v6('fd00::1')], { 'fd00::1': 'fd00::2' })).toEqual(['fd00::1']);
  });
});

interface Example {
  readonly sources: Record<string, SourceSpec>;
  readonly expected: readonly string[];
  readonly policy?: DestinationPolicy;
}

const inBothOrders = (example: Example): string[][] => {
  const forward = order(example.expected.map(address), example.sources, example.policy);
  const backward = order([...example.expected].reverse().map(address), example.sources, example.policy);
  return [forward, backward];
};

describe('the examples of RFC 6724 §10.2 give the answers the standard prints', () => {
  it.each<[string, Example]>([
    ['prefer matching scope (a global IPv6 source, a link-local IPv4 source)', {
      sources: { '2001:db8:1::1': '2001:db8:1::2', '198.51.100.121': '169.254.13.78' },
      expected: ['2001:db8:1::1', '198.51.100.121'],
    }],
    ['prefer matching scope (a link-local IPv6 source, a global IPv4 source)', {
      sources: { '2001:db8:1::1': 'fe80::1', '198.51.100.121': '198.51.100.117' },
      expected: ['198.51.100.121', '2001:db8:1::1'],
    }],
    ['prefer higher precedence (IPv6 over IPv4)', {
      sources: { '2001:db8:1::1': '2001:db8:1::2', '10.1.2.3': '10.1.2.4' },
      expected: ['2001:db8:1::1', '10.1.2.3'],
    }],
    ['prefer smaller scope', {
      sources: { '2001:db8:1::1': '2001:db8:1::2', 'fe80::1': 'fe80::2' },
      expected: ['fe80::1', '2001:db8:1::1'],
    }],
    ['prefer home address', {
      sources: { '2001:db8:1::1': { address: '2001:db8:3::1', home: true }, 'fe80::1': 'fe80::2' },
      expected: ['2001:db8:1::1', 'fe80::1'],
    }],
    ['avoid deprecated addresses', {
      sources: { '2001:db8:1::1': '2001:db8:1::2', 'fe80::1': { address: 'fe80::2', deprecated: true } },
      expected: ['2001:db8:1::1', 'fe80::1'],
    }],
    ['longest matching prefix', {
      sources: { '2001:db8:1::1': '2001:db8:1::2', '2001:db8:3ffe::1': '2001:db8:3f44::2' },
      expected: ['2001:db8:1::1', '2001:db8:3ffe::1'],
    }],
    ['prefer matching label', {
      sources: { '2002:c633:6401::1': '2002:c633:6401::2', '2001:db8:1::1': '2002:c633:6401::2' },
      expected: ['2002:c633:6401::1', '2001:db8:1::1'],
    }],
    ['prefer higher precedence (native over 6to4)', {
      sources: { '2002:c633:6401::1': '2002:c633:6401::2', '2001:db8:1::1': '2001:db8:1::2' },
      expected: ['2001:db8:1::1', '2002:c633:6401::1'],
    }],
  ])('%s', (_name, example) => {
    const [forward, backward] = inBothOrders(example);
    expect(forward).toEqual(example.expected);
    expect(backward).toEqual(example.expected);
  });
});

describe('the examples of RFC 6724 §10.3, §10.4 and §10.6 show the table being changed', () => {
  it('§10.3: preferring IPv4 leaves the two scope results unchanged and flips the precedence one', () => {
    const scopeMatch: Example = {
      sources: { '2001:db8::1': '2001:db8::2', '198.51.100.121': '169.254.13.78' },
      expected: ['2001:db8::1', '198.51.100.121'],
      policy: preferIpv4,
    };
    const scopeMismatch: Example = {
      sources: { '2001:db8::1': 'fe80::1', '198.51.100.121': '198.51.100.117' },
      expected: ['198.51.100.121', '2001:db8::1'],
      policy: preferIpv4,
    };
    const precedence: Example = {
      sources: { '2001:db8::1': '2001:db8::2', '10.1.2.3': '10.1.2.4' },
      expected: ['10.1.2.3', '2001:db8::1'],
      policy: preferIpv4,
    };
    for (const example of [scopeMatch, scopeMismatch, precedence]) {
      const [forward, backward] = inBothOrders(example);
      expect(forward).toEqual(example.expected);
      expect(backward).toEqual(example.expected);
    }
    expect(order([v6('2001:db8::1'), v4('10.1.2.3')], precedence.sources)).toEqual(['2001:db8::1', '10.1.2.3']);
  });

  it('§10.4: giving link-local destinations 33 puts a global one first, and the default table does not', () => {
    const sources = { '2001:db8::1': '2001:db8::2', 'fe80::1': 'fe80::2' };
    const expected = ['2001:db8::1', 'fe80::1'];
    expect(order(expected.map(address), sources, preferGlobalOverLinkLocal)).toEqual(expected);
    expect(order([...expected].reverse().map(address), sources, preferGlobalOverLinkLocal)).toEqual(expected);
    expect(order(expected.map(address), sources)).toEqual(['fe80::1', '2001:db8::1']);
  });

  it('§10.4: a deprecated global source still sends the link-local destination first', () => {
    const [forward, backward] = inBothOrders({
      sources: { '2001:db8::1': { address: '2001:db8::2', deprecated: true }, 'fe80::1': 'fe80::2' },
      expected: ['fe80::1', '2001:db8::1'],
      policy: preferGlobalOverLinkLocal,
    });
    expect(forward).toEqual(['fe80::1', '2001:db8::1']);
    expect(backward).toEqual(['fe80::1', '2001:db8::1']);
  });

  it('§10.6: by default a global IPv6 address comes before a unique local one', () => {
    const [forward, backward] = inBothOrders({
      sources: { '2001:db8:2::2': '2001:db8:1::1', 'fd22:2222:2222:2::2': 'fd11:1111:1111:1::1' },
      expected: ['2001:db8:2::2', 'fd22:2222:2222:2::2'],
    });
    expect(forward).toEqual(['2001:db8:2::2', 'fd22:2222:2222:2::2']);
    expect(backward).toEqual(['2001:db8:2::2', 'fd22:2222:2222:2::2']);
  });

  it('§10.6: the site table leaves that answer unchanged for a foreign ULA', () => {
    const [forward, backward] = inBothOrders({
      sources: { '2001:db8:2::2': '2001:db8:1::1', 'fd22:2222:2222:2::2': 'fd11:1111:1111:1::1' },
      expected: ['2001:db8:2::2', 'fd22:2222:2222:2::2'],
      policy: siteUlaTable,
    });
    expect(forward).toEqual(['2001:db8:2::2', 'fd22:2222:2222:2::2']);
    expect(backward).toEqual(['2001:db8:2::2', 'fd22:2222:2222:2::2']);
  });

  it('§10.6: the site table puts the ULA of the site first, and the default table does not', () => {
    const sources = { '2001:db8:2::2': '2001:db8:1::1', 'fd11:1111:1111:2::2': 'fd11:1111:1111:1::1' };
    const expected = ['fd11:1111:1111:2::2', '2001:db8:2::2'];
    expect(order(expected.map(address), sources, siteUlaTable)).toEqual(expected);
    expect(order([...expected].reverse().map(address), sources, siteUlaTable)).toEqual(expected);
    expect(order(expected.map(address), sources)).toEqual(['2001:db8:2::2', 'fd11:1111:1111:2::2']);
  });
});
