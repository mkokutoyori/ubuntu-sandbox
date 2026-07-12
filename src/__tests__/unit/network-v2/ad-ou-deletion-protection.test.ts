/**
 * Organizational Unit deletion + "protected from accidental deletion"
 * (real AD's `New-ADOrganizationalUnit` default) — this simulator had no
 * OU deletion path at all until now. `DirectoryTree.deleteEntry` refuses
 * unconditionally while the flag is set, whether the delete is attempted
 * locally or via a real remote LDAP `delRequest`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, IPAddress, SubnetMask } from '@/network/core/types';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { dialLdap } from '@/network/devices/windows/server/ad/ldap/LdapClient';
import { LdapResultCode } from '@/network/devices/windows/server/ad/ldap/LdapMessage';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

const ps = (d: WindowsServer) => PowerShellSubShell.create(d).subShell;
const run = async (sh: ReturnType<typeof ps>, l: string) => (await sh.processLine(l)).output.join('\n');

async function buildDc(): Promise<WindowsServer> {
  const dc = new WindowsServer('DC1');
  dc.getPorts()[0].configureIP(new IPAddress('192.168.82.10'), new SubnetMask('255.255.255.0'));
  dc.setCurrentUser('Administrator');
  await run(ps(dc), 'Install-WindowsFeature AD-Domain-Services');
  dc.installADDSForest('lab.local', 'LAB', 'P@ssw0rd');
  return dc;
}

describe('DirectoryStore — OU creation, deletion, and accidental-deletion protection', () => {
  it('defaults a new OU to protected from accidental deletion', async () => {
    const dc = await buildDc();
    const store = dc.getDirectoryStore()!;
    expect(store.newOrgUnit('Sales').ok).toBe(true);
    expect(store.getOrgUnit('Sales')!.protectedFromAccidentalDeletion).toBe(true);
  });

  it('refuses to delete a protected OU', async () => {
    const dc = await buildDc();
    const store = dc.getDirectoryStore()!;
    store.newOrgUnit('Sales');
    const res = store.removeOrgUnit('Sales');
    expect(res.ok).toBe(false);
    expect(store.getOrgUnit('Sales')).not.toBeNull();
  });

  it('deletes successfully once unprotected', async () => {
    const dc = await buildDc();
    const store = dc.getDirectoryStore()!;
    store.newOrgUnit('Sales');
    expect(store.setOuProtectedFromAccidentalDeletion('Sales', false).ok).toBe(true);
    expect(store.getOrgUnit('Sales')!.protectedFromAccidentalDeletion).toBe(false);
    expect(store.removeOrgUnit('Sales').ok).toBe(true);
    expect(store.getOrgUnit('Sales')).toBeNull();
  });

  it('can be created unprotected up front and deleted immediately', async () => {
    const dc = await buildDc();
    const store = dc.getDirectoryStore()!;
    store.newOrgUnit('Temp', { protectedFromAccidentalDeletion: false });
    expect(store.removeOrgUnit('Temp').ok).toBe(true);
  });

  it('refuses to delete a non-leaf OU regardless of protection', async () => {
    const dc = await buildDc();
    const store = dc.getDirectoryStore()!;
    store.newOrgUnit('Sales', { protectedFromAccidentalDeletion: false });
    store.newOrgUnit('Sales/EU', { protectedFromAccidentalDeletion: false });
    const res = store.removeOrgUnit('Sales');
    expect(res.ok).toBe(false);
  });
});

describe('LDAP delRequest against a protected OU — real TCP/389 refusal', () => {
  it('returns insufficientAccessRights over the wire', async () => {
    const dc = await buildDc();
    const store = dc.getDirectoryStore()!;
    store.newOrgUnit('Sales');

    const client = new WindowsServer('CLIENT1');
    client.getPorts()[0].configureIP(new IPAddress('192.168.82.20'), new SubnetMask('255.255.255.0'));
    const sw = new GenericSwitch('switch-generic', 'SW1');
    new Cable('c-dc').connect(dc.getPorts()[0], sw.getPorts()[0]);
    new Cable('c-client').connect(client.getPorts()[0], sw.getPorts()[1]);

    const conn = dialLdap(client.getTcpStack(), '192.168.82.10');
    expect(conn.ok).toBe(true);
    const ldap = conn.client!;
    const bind = ldap.bind('Administrator', 'P@ssw0rd');
    expect(bind.ok).toBe(true);
    const res = ldap.delete('OU=Sales,DC=lab,DC=local');
    ldap.unbind();
    expect(res.ok).toBe(false);
    expect(res.result.resultCode).toBe(LdapResultCode.insufficientAccessRights);
  });
});
