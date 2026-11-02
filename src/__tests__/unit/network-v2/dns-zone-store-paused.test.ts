/*
 * Structure — a zone the store holds can be paused ([MS-DNSP] PauseZone: "do not use this zone to answer queries ... until it is resumed"): the
 * zone stays in the store, an exact lookup (getZone, what the zone administration reads) still finds it and says it is paused, but a lookup for
 * an answer (findZone, and answer, which is built on it) goes past it to the zone above, or to none; resuming gives it back; the flag belongs to
 * the name, so a zone that is replaced in the store (a reload, a transfer) is still paused.
 * Discrimination (run on the tree before the change): every case falls, the store had no notion of a paused zone.
 */
import { describe, it, expect } from 'vitest';
import { Zone } from '@/network/dns/zone/Zone';
import { ZoneStore } from '@/network/dns/zone/ZoneStore';
import { DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import { DnsClass, RRType } from '@/network/dns/wire/RRType';
import { makeARecord, makeSoaRecord } from '@/network/dns/wire/ResourceRecord';

const soa = (origin: string) => makeSoaRecord(origin, 3600, { mname: `ns.${origin}`, rname: `hostmaster.${origin}`, serial: 1, refresh: 900, retry: 600, expire: 86400, minimum: 3600 });

function storeWith(...origins: string[]): ZoneStore {
  const store = new ZoneStore();
  for (const origin of origins) {
    const zone = new Zone(origin, soa(origin));
    zone.addRecord(makeARecord(`www.${origin}`, 300, '10.0.0.1'));
    store.addZone(zone);
  }
  return store;
}

const ask = (store: ZoneStore, qname: string) => store.answer({ qname, qtype: RRType.A, qclass: DnsClass.IN });

describe('a paused zone', () => {
  it('is not paused until it is told to be, whatever the case of its name', () => {
    const store = storeWith('corp.test');
    expect(store.isPaused('corp.test')).toBe(false);
    store.setPaused('CORP.Test', true);
    expect(store.isPaused('corp.test')).toBe(true);
    expect(store.isPaused('other.test')).toBe(false);
  });

  it('stays in the store for an exact lookup, which is what the administration reads', () => {
    const store = storeWith('corp.test');
    store.setPaused('corp.test', true);
    expect(store.getZone('corp.test')).not.toBeNull();
    expect(store.listZones().map(zone => zone.origin)).toEqual(['corp.test']);
  });

  it('is passed over by the lookup for an answer, which falls to the zone above it', () => {
    const store = storeWith('corp.test', 'sub.corp.test');
    expect(store.findZone('www.sub.corp.test')?.origin).toBe('sub.corp.test');
    store.setPaused('sub.corp.test', true);
    expect(store.findZone('www.sub.corp.test')?.origin).toBe('corp.test');
    expect(store.findZone('www.corp.test')?.origin).toBe('corp.test');
  });

  it('is found by no lookup for an answer when no zone is above it', () => {
    const store = storeWith('corp.test');
    store.setPaused('corp.test', true);
    expect(store.findZone('www.corp.test')).toBeNull();
  });

  it('makes the answer built on that lookup refuse the names of the zone, and answer them again once it is resumed', () => {
    const store = storeWith('corp.test');
    expect(ask(store, 'www.corp.test').rcode).toBe(DnsRcode.NOERROR);
    store.setPaused('corp.test', true);
    expect(ask(store, 'www.corp.test').rcode).toBe(DnsRcode.REFUSED);
    store.setPaused('corp.test', false);
    expect(ask(store, 'www.corp.test').rcode).toBe(DnsRcode.NOERROR);
  });

  it('passes over a root zone as well, and gives it back when resumed', () => {
    const store = new ZoneStore();
    store.addZone(new Zone('', soa('')));
    expect(store.findZone('anything.test')?.origin).toBe('');
    store.setPaused('', true);
    expect(store.findZone('anything.test')).toBeNull();
    store.setPaused('', false);
    expect(store.findZone('anything.test')?.origin).toBe('');
  });

  it('is still paused when the zone is replaced in the store, the flag belonging to the name', () => {
    const store = storeWith('corp.test');
    store.setPaused('corp.test', true);
    store.removeZone('corp.test');
    store.addZone(new Zone('corp.test', soa('corp.test')));
    expect(store.isPaused('corp.test')).toBe(true);
    expect(store.findZone('www.corp.test')).toBeNull();
  });

  it('is not paused by the pausing of another zone', () => {
    const store = storeWith('corp.test', 'other.test');
    store.setPaused('other.test', true);
    expect(store.findZone('www.corp.test')?.origin).toBe('corp.test');
    expect(store.findZone('www.other.test')).toBeNull();
  });
});
