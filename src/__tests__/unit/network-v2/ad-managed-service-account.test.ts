/**
 * (Group) Managed Service Accounts (MS-ADTS §3.1.1.8): the DC generates
 * and rotates the account's password rather than an admin, and gates
 * read access to the constructed `msDS-ManagedPassword` attribute over a
 * real LDAP search to only a principal listed (directly, or via a group
 * it's a direct member of) in `PrincipalsAllowedToRetrieveManagedPassword`
 * — validated against a real wired topology, not a local shortcut.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, IPAddress, SubnetMask } from '@/network/core/types';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { dialLdap } from '@/network/devices/windows/server/ad/ldap/LdapClient';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

const ps = (d: WindowsServer) => PowerShellSubShell.create(d).subShell;
const run = async (sh: ReturnType<typeof ps>, l: string) => (await sh.processLine(l)).output.join('\n');

async function buildLan(): Promise<{ dc: WindowsServer; client: LinuxServer }> {
  const dc = new WindowsServer('DC1');
  const client = new LinuxServer('linux-server', 'CLIENT1');
  const sw = new GenericSwitch('switch-generic', 'SW1');
  new Cable('c-dc').connect(dc.getPorts()[0], sw.getPorts()[0]);
  new Cable('c-client').connect(client.getPorts()[0], sw.getPorts()[1]);
  const mask = new SubnetMask('255.255.255.0');
  dc.getPorts()[0].configureIP(new IPAddress('192.168.75.10'), mask);
  client.getPorts()[0].configureIP(new IPAddress('192.168.75.20'), mask);

  dc.setCurrentUser('Administrator');
  await run(ps(dc), 'Install-WindowsFeature AD-Domain-Services');
  await run(ps(dc), 'Install-ADDSForest -DomainName lab.local -SafeModeAdministratorPassword (ConvertTo-SecureString "P@ssw0rd" -AsPlainText -Force)');
  return { dc, client };
}

describe('DirectoryStore — (Group) Managed Service Accounts', () => {
  it('creates a group-managed service account with a generated password and objectSid', async () => {
    const { dc } = await buildLan();
    const store = dc.getDirectoryStore()!;
    const res = store.newServiceAccount('svc1', { isGroupManaged: true, principals: ['Domain Admins'] });
    expect(res.ok).toBe(true);

    const msa = store.getServiceAccount('svc1')!;
    expect(msa.sam).toBe('svc1$');
    expect(msa.isGroupManaged).toBe(true);
    expect(msa.managedPassword.length).toBeGreaterThan(0);
    expect(msa.objectSid).toMatch(/^S-1-5-21-/);
    expect(msa.principalsAllowedToRetrieveManagedPassword).toEqual(['Domain Admins']);
  });

  it('refuses to create a duplicate service account', async () => {
    const { dc } = await buildLan();
    const store = dc.getDirectoryStore()!;
    store.newServiceAccount('svc1', { isGroupManaged: true, principals: ['Domain Admins'] });
    const res = store.newServiceAccount('svc1', { isGroupManaged: true, principals: ['Domain Admins'] });
    expect(res.ok).toBe(false);
  });

  it('rotates the managed password, advancing passwordLastSet', async () => {
    const { dc } = await buildLan();
    const store = dc.getDirectoryStore()!;
    store.newServiceAccount('svc1', { isGroupManaged: true, principals: ['Domain Admins'] });
    const before = store.getServiceAccount('svc1')!;

    const res = store.resetManagedPassword('svc1');
    expect(res.ok).toBe(true);
    const after = store.getServiceAccount('svc1')!;
    expect(after.managedPassword).not.toBe(before.managedPassword);
    expect(after.passwordLastSet).toBeGreaterThanOrEqual(before.passwordLastSet);
  });

  it('replicates a service account to a second DC like any other AD object', async () => {
    const dc1 = new WindowsServer('DC1');
    const dc2 = new WindowsServer('DC2');
    const sw = new GenericSwitch('switch-generic', 'SW1');
    new Cable('c-dc1').connect(dc1.getPorts()[0], sw.getPorts()[0]);
    new Cable('c-dc2').connect(dc2.getPorts()[0], sw.getPorts()[1]);
    const mask = new SubnetMask('255.255.255.0');
    dc1.getPorts()[0].configureIP(new IPAddress('192.168.76.10'), mask);
    dc2.getPorts()[0].configureIP(new IPAddress('192.168.76.11'), mask);

    dc1.setCurrentUser('Administrator');
    await run(ps(dc1), 'Install-WindowsFeature AD-Domain-Services');
    await run(ps(dc1), 'Install-ADDSForest -DomainName lab.local -SafeModeAdministratorPassword (ConvertTo-SecureString "P@ssw0rd" -AsPlainText -Force)');
    dc2.setCurrentUser('Administrator');
    await run(ps(dc2), 'Install-WindowsFeature AD-Domain-Services');
    await run(ps(dc2), 'Install-ADDSForest -DomainName lab.local -SafeModeAdministratorPassword (ConvertTo-SecureString "P@ssw0rd" -AsPlainText -Force)');

    dc1.getDirectoryStore()!.newServiceAccount('svc1', { isGroupManaged: true, principals: ['Domain Admins'] });
    const result = dc2.replicateFrom('192.168.76.10');
    expect(result.ok).toBe(true);

    const replicated = dc2.getDirectoryStore()!.getServiceAccount('svc1');
    expect(replicated).not.toBeNull();
    expect(replicated!.managedPassword).toBe(dc1.getDirectoryStore()!.getServiceAccount('svc1')!.managedPassword);
  });
});

describe('LDAP msDS-ManagedPassword retrieval — gated over a real TCP/389 search', () => {
  it('returns the managed password to a principal listed via direct group membership', async () => {
    const { dc, client } = await buildLan();
    const store = dc.getDirectoryStore()!;
    store.newServiceAccount('svc1', { isGroupManaged: true, principals: ['Domain Admins'] });
    const msa = store.getServiceAccount('svc1')!;

    const conn = dialLdap(client.getTcpStack(), '192.168.75.10');
    expect(conn.ok).toBe(true);
    const ldap = conn.client!;
    const bind = ldap.bind('Administrator', 'P@ssw0rd');
    expect(bind.ok).toBe(true);

    const result = ldap.search(msa.dn, 'base', { kind: 'equalityMatch', attr: 'objectClass', value: 'msDS-GroupManagedServiceAccount' }, ['msDS-ManagedPassword']);
    ldap.unbind();
    expect(result.ok).toBe(true);
    const attr = result.entries[0]?.attributes.find(a => a.type.toLowerCase() === 'msds-managedpassword');
    expect(attr?.values[0]).toBe(msa.managedPassword);
  });

  it('omits the managed password for a principal not listed (directly or via group)', async () => {
    const { dc, client } = await buildLan();
    const store = dc.getDirectoryStore()!;
    store.newUser('bob', { password: 'bobpw' });
    store.newServiceAccount('svc1', { isGroupManaged: true, principals: ['Domain Admins'] });
    const msa = store.getServiceAccount('svc1')!;

    const conn = dialLdap(client.getTcpStack(), '192.168.75.10');
    const ldap = conn.client!;
    const bind = ldap.bind('bob', 'bobpw');
    expect(bind.ok).toBe(true);

    const result = ldap.search(msa.dn, 'base', { kind: 'equalityMatch', attr: 'objectClass', value: 'msDS-GroupManagedServiceAccount' }, ['msDS-ManagedPassword']);
    ldap.unbind();
    expect(result.ok).toBe(true);
    const attr = result.entries[0]?.attributes.find(a => a.type.toLowerCase() === 'msds-managedpassword');
    expect(attr).toBeUndefined();
  });

  it('omits the managed password for an anonymous bind', async () => {
    const { dc, client } = await buildLan();
    const store = dc.getDirectoryStore()!;
    store.newServiceAccount('svc1', { isGroupManaged: true, principals: ['Domain Admins'] });
    const msa = store.getServiceAccount('svc1')!;

    const conn = dialLdap(client.getTcpStack(), '192.168.75.10');
    const ldap = conn.client!;
    const bind = ldap.bind('', '');
    expect(bind.ok).toBe(true);

    const result = ldap.search(msa.dn, 'base', { kind: 'equalityMatch', attr: 'objectClass', value: 'msDS-GroupManagedServiceAccount' }, ['msDS-ManagedPassword']);
    ldap.unbind();
    const attr = result.entries[0]?.attributes.find(a => a.type.toLowerCase() === 'msds-managedpassword');
    expect(attr).toBeUndefined();
  });
});
