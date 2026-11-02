/*
 * Structure — the cases of the zone lifecycle that the lab of the probe cannot reach, on the role itself: a role that has no DNS directory to
 * write to says so when it is asked to export a zone, and restoring a primary zone that the directory holds reloads nothing (the directory is
 * the server's own store here, and no zone file is there to read), whatever the zone file name the zone would have had.
 * Discrimination (run on the tree before the change): every case falls, the operations did not exist.
 */
import { describe, it, expect } from 'vitest';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { WindowsDnsServerRole } from '@/network/devices/windows/server/dns/WindowsDnsServerRole';

describe('a role with no DNS directory', () => {
  it('says so when it is asked to export a zone, and leaves the zone as it is', () => {
    const role = new WindowsDnsServerRole(new WindowsServer('SRV1'));
    expect(role.addPrimaryZone('corp.test').ok).toBe(true);
    expect(role.exportZone('corp.test', 'out.dns')).toEqual({ ok: false, message: 'The DNS directory is not available on this server.' });
    expect(role.getZone('corp.test')?.name).toBe('corp.test');
  });
});

describe('restoring a primary zone that the directory holds', () => {
  it('reloads nothing and succeeds, the records being as they were', () => {
    const role = new WindowsDnsServerRole(new WindowsServer('SRV1'), { directoryAvailable: () => true });
    expect(role.addPrimaryZone('ad.test', { dsIntegrated: true }).ok).toBe(true);
    expect(role.addARecord('ad.test', 'host', '10.0.0.7').ok).toBe(true);
    expect(role.restorePrimaryZone('ad.test')).toEqual({ ok: true, message: '' });
    expect(role.getRecords('ad.test', 'host', 'A')?.map(record => record.text)).toEqual(['10.0.0.7']);
  });

  it('is refused for a zone that the server does not hold, and for a secondary zone', () => {
    const role = new WindowsDnsServerRole(new WindowsServer('SRV1'));
    expect(role.restorePrimaryZone('nope.test')).toEqual({ ok: false, message: 'Zone "nope.test" does not exist on this server.' });
    expect(role.addSecondaryZone('sec.test', ['10.0.0.9']).ok).toBe(true);
    expect(role.restorePrimaryZone('sec.test')).toEqual({ ok: false, message: 'Zone "sec.test" is not a primary zone.' });
  });
});
