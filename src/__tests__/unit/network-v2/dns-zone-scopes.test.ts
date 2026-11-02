/*
 * Structure — the zone scopes a Windows DNS server holds for its zones: a scope is a name with the records it holds and the file
 * they are written to (Learn: Add-DnsServerZoneScope, "<zone name>\<scope name>.dns"); the zone's own name is the default scope and
 * is neither added nor removed (9953), a name is unique within its zone whatever its case (9951) and may repeat in another zone, a
 * scope that is not held is refused (9959, [MS-DNSP] DeleteZoneScope), a scope that a policy names cannot be removed (9989), a
 * scope that cannot be built (a zone file that does not load) is not registered, and a zone that goes takes its scopes with it.
 * A scope's records are told from a zone's own by the identity of the object that holds them (nameOf).
 * Discrimination (run on the tree before the change): every case falls, the module did not exist.
 */
import { describe, it, expect } from 'vitest';
import { Zone } from '@/network/dns/zone/Zone';
import { makeSoaRecord } from '@/network/dns/wire/ResourceRecord';
import {
  DnsZoneScopes, ZONE_SCOPE_REFUSALS, zoneScopeFileName, zoneScopeFilePath,
} from '@/network/devices/windows/server/dns/DnsZoneScopes';

const soa = (origin: string) => makeSoaRecord(origin, 3600, { mname: `ns.${origin}`, rname: `hostmaster.${origin}`, serial: 1, refresh: 900, retry: 600, expire: 86400, minimum: 3600 });
const zoneOf = (origin: string): Zone => new Zone(origin, soa(origin));
const never = () => false;

describe('the file of a scope', () => {
  it('is named after the scope and sits in the folder of the zone', () => {
    expect(zoneScopeFileName('corp_Europe')).toBe('corp_Europe.dns');
    expect(zoneScopeFilePath('corp.test', 'corp_Europe')).toBe('corp.test\\corp_Europe.dns');
  });
});

describe('the zone scopes of a zone', () => {
  it('holds none at first, and keeps a scope with the name it was written with and the file that goes with it', () => {
    const scopes = new DnsZoneScopes();
    expect(scopes.list('corp.test')).toEqual([]);
    expect(scopes.create('corp.test', 'Europe', () => zoneOf('corp.test'))).toBeNull();
    expect(scopes.list('corp.test')).toEqual([{ name: 'Europe', fileName: 'Europe.dns' }]);
  });

  it('lists the scopes in the order they were added', () => {
    const scopes = new DnsZoneScopes();
    for (const name of ['Zeta', 'Alpha', 'Mid']) scopes.create('corp.test', name, () => zoneOf('corp.test'));
    expect(scopes.list('corp.test').map(scope => scope.name)).toEqual(['Zeta', 'Alpha', 'Mid']);
  });

  it('finds a scope whatever the case of its name, and nothing else', () => {
    const scopes = new DnsZoneScopes();
    scopes.create('corp.test', 'Europe', () => zoneOf('corp.test'));
    expect(scopes.find('corp.test', 'EUROPE')).toEqual({ name: 'Europe', fileName: 'Europe.dns' });
    expect(scopes.find('corp.test', 'Asia')).toBeNull();
    expect(scopes.find('other.test', 'Europe')).toBeNull();
  });

  it('hands back the very records it was given, and tells them from the records of a zone', () => {
    const scopes = new DnsZoneScopes();
    const records = zoneOf('corp.test');
    scopes.create('corp.test', 'Europe', () => records);
    expect(scopes.recordsOf('corp.test', 'europe')).toBe(records);
    expect(scopes.recordsOf('corp.test', 'Asia')).toBeNull();
    expect(scopes.nameOf(records)).toBe('Europe');
    expect(scopes.nameOf(zoneOf('corp.test'))).toBeNull();
    expect(scopes.recordsOfAll('corp.test')).toEqual([records]);
    expect(scopes.recordsOfAll('other.test')).toEqual([]);
  });

  it('refuses the name of the zone itself whatever its case or its final dot: it is the default scope (9953)', () => {
    const scopes = new DnsZoneScopes();
    expect(scopes.isDefault('corp.test', 'CORP.TEST')).toBe(true);
    expect(scopes.isDefault('corp.test', 'corp.test.')).toBe(true);
    expect(scopes.isDefault('corp.test', 'europe')).toBe(false);
    expect(scopes.create('corp.test', 'Corp.Test', () => zoneOf('corp.test'))).toBe(ZONE_SCOPE_REFUSALS.isDefault);
    expect(scopes.list('corp.test')).toEqual([]);
  });

  it('refuses a name that is taken, whatever its case (9951), and keeps the first scope as it was', () => {
    const scopes = new DnsZoneScopes();
    const first = zoneOf('corp.test');
    scopes.create('corp.test', 'Europe', () => first);
    expect(scopes.create('corp.test', 'EUROPE', () => zoneOf('corp.test'))).toBe(ZONE_SCOPE_REFUSALS.exists);
    expect(scopes.recordsOf('corp.test', 'Europe')).toBe(first);
  });

  it('keeps the scopes of a zone under its name, whatever the case it was written with', () => {
    const scopes = new DnsZoneScopes();
    expect(scopes.create('CORP.Test', 'Europe', () => zoneOf('corp.test'))).toBeNull();
    expect(scopes.list('corp.test').map(scope => scope.name)).toEqual(['Europe']);
    expect(scopes.remove('Corp.TEST', 'Europe', never)).toBeNull();
    expect(scopes.list('corp.test')).toEqual([]);
  });

  it('lets two zones have a scope of the same name', () => {
    const scopes = new DnsZoneScopes();
    expect(scopes.create('corp.test', 'Shared', () => zoneOf('corp.test'))).toBeNull();
    expect(scopes.create('other.test', 'Shared', () => zoneOf('other.test'))).toBeNull();
    expect(scopes.recordsOf('corp.test', 'Shared')).not.toBe(scopes.recordsOf('other.test', 'Shared'));
  });

  it('does not build the records of a scope it refuses, and does not register one that cannot be built', () => {
    const scopes = new DnsZoneScopes();
    scopes.create('corp.test', 'Europe', () => zoneOf('corp.test'));
    let built = 0;
    const counting = () => { built += 1; return zoneOf('corp.test'); };
    scopes.create('corp.test', 'Europe', counting);
    scopes.create('corp.test', 'corp.test', counting);
    expect(built).toBe(0);
    expect(scopes.create('corp.test', 'Broken', () => 'The zone file "Broken.dns" is invalid.')).toBe('The zone file "Broken.dns" is invalid.');
    expect(scopes.find('corp.test', 'Broken')).toBeNull();
    expect(scopes.create('corp.test', 'Broken', () => zoneOf('corp.test'))).toBeNull();
  });
});

describe('the removal of a zone scope', () => {
  it('removes a scope, which is then neither listed nor found, and may be added again', () => {
    const scopes = new DnsZoneScopes();
    scopes.create('corp.test', 'Europe', () => zoneOf('corp.test'));
    scopes.create('corp.test', 'Asia', () => zoneOf('corp.test'));
    expect(scopes.remove('corp.test', 'europe', never)).toBeNull();
    expect(scopes.list('corp.test').map(scope => scope.name)).toEqual(['Asia']);
    expect(scopes.recordsOf('corp.test', 'Europe')).toBeNull();
    expect(scopes.create('corp.test', 'Europe', () => zoneOf('corp.test'))).toBeNull();
  });

  it('refuses the default scope before it looks for anything else (9953)', () => {
    const scopes = new DnsZoneScopes();
    expect(scopes.remove('corp.test', 'corp.test', () => true)).toBe(ZONE_SCOPE_REFUSALS.isDefault);
  });

  it('refuses a scope that is not held, in its zone as in any other (9959)', () => {
    const scopes = new DnsZoneScopes();
    scopes.create('corp.test', 'Europe', () => zoneOf('corp.test'));
    expect(scopes.remove('corp.test', 'Asia', never)).toBe(ZONE_SCOPE_REFUSALS.missing);
    expect(scopes.remove('other.test', 'Europe', never)).toBe(ZONE_SCOPE_REFUSALS.missing);
    expect(scopes.find('corp.test', 'Europe')).not.toBeNull();
  });

  it('asks the owner of the policies about the name the scope was written with, and keeps a scope that is named (9989)', () => {
    const scopes = new DnsZoneScopes();
    scopes.create('corp.test', 'Europe', () => zoneOf('corp.test'));
    const asked: string[] = [];
    expect(scopes.remove('corp.test', 'EUROPE', name => { asked.push(name); return true; })).toBe(ZONE_SCOPE_REFUSALS.referenced);
    expect(asked).toEqual(['Europe']);
    expect(scopes.find('corp.test', 'Europe')).not.toBeNull();
  });

  it('checks that the scope is held before it asks whether a policy names it', () => {
    const scopes = new DnsZoneScopes();
    let asked = 0;
    expect(scopes.remove('corp.test', 'Ghost', () => { asked += 1; return true; })).toBe(ZONE_SCOPE_REFUSALS.missing);
    expect(asked).toBe(0);
  });

  it('drops every scope of a zone with the zone, and the scopes of the others stay', () => {
    const scopes = new DnsZoneScopes();
    scopes.create('corp.test', 'Europe', () => zoneOf('corp.test'));
    scopes.create('other.test', 'Europe', () => zoneOf('other.test'));
    scopes.dropZone('CORP.TEST');
    expect(scopes.list('corp.test')).toEqual([]);
    expect(scopes.list('other.test')).toHaveLength(1);
  });
});

describe('the texts of the refusals', () => {
  it('are the ones of the Windows message table and of [MS-DNSP]', () => {
    expect(ZONE_SCOPE_REFUSALS).toEqual({
      missing: 'The scope does not exist.',
      absent: 'The scope does not exist for the zone.',
      exists: 'The scope already exists for the zone.',
      isDefault: 'The scope is the same as the default zone scope.',
      invalidName: 'The scope name contains invalid characters.',
      referenced: 'The zone scope cannot be deleted because it is referenced by a DNS Policy.',
    });
  });
});
