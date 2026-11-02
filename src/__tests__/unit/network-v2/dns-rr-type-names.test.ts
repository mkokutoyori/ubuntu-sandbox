/*
 * Structure — the IANA table of resource record type mnemonics that the DNS wire layer carries, one table for every reader
 * (the packet decoder of tcpdump, the record types of the zone statistics of the Windows server, the QType criterion of a
 * DNS policy): a number gives its mnemonic, a mnemonic gives its number whatever its case, a text that is no mnemonic gives
 * nothing, and the table holds one name per number and one number per name so that the two directions agree.
 * Discrimination (run on the tree before the change): every case falls, the module did not exist.
 */
import { describe, it, expect } from 'vitest';
import { RR_TYPE_NAMES, rrTypeNumber } from '@/network/dns/wire/RRTypeNames';

describe('the mnemonic of a type number', () => {
  it.each([
    [1, 'A'], [2, 'NS'], [5, 'CNAME'], [6, 'SOA'], [12, 'PTR'], [15, 'MX'], [16, 'TXT'], [28, 'AAAA'], [33, 'SRV'],
    [43, 'DS'], [46, 'RRSIG'], [47, 'NSEC'], [48, 'DNSKEY'], [52, 'TLSA'], [64, 'SVCB'], [65, 'HTTPS'], [255, 'ANY'], [257, 'CAA'],
  ])('names type %i %s', (number, mnemonic) => {
    expect(RR_TYPE_NAMES[number]).toBe(mnemonic);
  });

  it.each([0, 100000, 65280])('names nothing for the number %i', number => {
    expect(RR_TYPE_NAMES[number]).toBeUndefined();
  });
});

describe('the number of a type mnemonic', () => {
  it.each([
    ['A', 1], ['a', 1], ['AAAA', 28], ['aaaa', 28], ['Txt', 16], ['SRV', 33], ['dnskey', 48], ['ANY', 255], ['Caa', 257],
  ])('numbers %s %i', (mnemonic, number) => {
    expect(rrTypeNumber(mnemonic)).toBe(number);
  });

  it.each(['', 'ZORGLUB', '16', ' A', 'A ', 'TYPE16', 'A,AAAA'])('numbers nothing for %j', text => {
    expect(rrTypeNumber(text)).toBeNull();
  });
});

describe('the two directions of the table', () => {
  it('hold one name per number', () => {
    const names = Object.values(RR_TYPE_NAMES);
    expect(new Set(names).size).toBe(names.length);
  });

  it('agree: every mnemonic gives back the number it was found under', () => {
    const entries = Object.entries(RR_TYPE_NAMES);
    expect(entries.length).toBeGreaterThan(80);
    for (const [number, mnemonic] of entries) expect(rrTypeNumber(mnemonic), mnemonic).toBe(Number(number));
  });
});
