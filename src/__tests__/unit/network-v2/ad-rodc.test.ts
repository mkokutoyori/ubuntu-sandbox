/**
 * Read-Only Domain Controller (RODC, MS-ADTS §3.1.1.1.11) — refuses
 * every local/LDAP-originated write on its own `DirectoryTree` while
 * still absorbing ordinary replication pulls, and filters a user's
 * real `userPassword` out of what it caches locally unless that user is
 * covered by its Password Replication Policy.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, IPAddress, SubnetMask } from '@/network/core/types';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { dialLdap } from '@/network/devices/windows/server/ad/ldap/LdapClient';
import { LdapResultCode } from '@/network/devices/windows/server/ad/ldap/LdapMessage';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

const ps = (d: WindowsServer) => PowerShellSubShell.create(d).subShell;
const run = async (sh: ReturnType<typeof ps>, l: string) => (await sh.processLine(l)).output.join('\n');

async function buildRootDcAndRodc(): Promise<{ dc1: WindowsServer; dc2: WindowsServer }> {
  const dc1 = new WindowsServer('DC1');
  const dc2 = new WindowsServer('DC2');
  const sw = new GenericSwitch('switch-generic', 'SW1');
  new Cable('c-dc1').connect(dc1.getPorts()[0], sw.getPorts()[0]);
  new Cable('c-dc2').connect(dc2.getPorts()[0], sw.getPorts()[1]);
  const mask = new SubnetMask('255.255.255.0');
  dc1.getPorts()[0].configureIP(new IPAddress('192.168.80.10'), mask);
  dc2.getPorts()[0].configureIP(new IPAddress('192.168.80.11'), mask);

  dc1.setCurrentUser('Administrator');
  await run(ps(dc1), 'Install-WindowsFeature AD-Domain-Services');
  await run(ps(dc1), 'Install-ADDSForest -DomainName lab.local -SafeModeAdministratorPassword (ConvertTo-SecureString "P@ssw0rd" -AsPlainText -Force)');

  dc2.setCurrentUser('Administrator');
  await run(ps(dc2), 'Install-WindowsFeature AD-Domain-Services');
  const promote = dc2.installADDSDomainController(
    'lab.local', undefined, '192.168.80.10', 'Administrator', 'P@ssw0rd', 'P@ssw0rd', true,
  );
  expect(promote.ok).toBe(true);

  return { dc1, dc2 };
}

describe('RODC promotion', () => {
  it('marks the new DC read-only while the source stays writable', async () => {
    const { dc1, dc2 } = await buildRootDcAndRodc();
    expect(dc1.getDirectoryStore()!.isReadOnly()).toBe(false);
    expect(dc2.getDirectoryStore()!.isReadOnly()).toBe(true);
  });

  it('still creates its own computer account locally despite being read-only', async () => {
    const { dc2 } = await buildRootDcAndRodc();
    expect(dc2.getDirectoryStore()!.getComputer('DC2')).not.toBeNull();
  });

  it('refuses a local write (New-ADUser) against its own directory', async () => {
    const { dc2 } = await buildRootDcAndRodc();
    const res = dc2.getDirectoryStore()!.newUser('carol', { password: 'x' });
    expect(res.ok).toBe(false);
  });

  it('refuses a remote LDAP write with unwillingToPerform', async () => {
    const { dc1, dc2 } = await buildRootDcAndRodc();
    // Bound as the RODC's own computer account — its secret is always
    // cached locally (created via the promotion bootstrap bypass, never
    // subject to the Password Replication Policy), unlike Administrator's,
    // which was correctly *not* cached by the initial sync (empty PRP then).
    const dc2Secret = dc2.getDirectoryStore()!.getComputerSecret('DC2')!;
    const conn = dialLdap(dc1.getTcpStack(), '192.168.80.11');
    expect(conn.ok).toBe(true);
    const ldap = conn.client!;
    const bind = ldap.bind('DC2$', dc2Secret);
    expect(bind.ok).toBe(true);
    const res = ldap.add('CN=carol,CN=Users,DC=lab,DC=local', [
      { type: 'objectClass', values: ['top', 'person', 'organizationalPerson', 'user'] },
      { type: 'cn', values: ['carol'] },
    ]);
    ldap.unbind();
    expect(res.ok).toBe(false);
    expect(res.result.resultCode).toBe(LdapResultCode.unwillingToPerform);
  });
});

describe('RODC Password Replication Policy', () => {
  it('caches a covered user\'s password but not an uncovered one\'s, on a later replication cycle', async () => {
    const { dc1, dc2 } = await buildRootDcAndRodc();
    const dc2Store = dc2.getDirectoryStore()!;
    dc2Store.setPasswordReplicationPolicy(['bob'], []);

    const dc1Store = dc1.getDirectoryStore()!;
    dc1Store.newUser('alice', { password: 'alicepw', fullName: 'Alice' });
    dc1Store.newUser('bob', { password: 'bobpw', fullName: 'Bob' });

    const result = dc2.replicateFrom('192.168.80.10');
    expect(result.ok).toBe(true);

    const alice = dc2Store.getUser('alice')!;
    const bob = dc2Store.getUser('bob')!;
    expect(alice.fullName).toBe('Alice');
    expect(alice.password).toBe('');
    expect(bob.fullName).toBe('Bob');
    expect(bob.password).toBe('bobpw');
  });

  it('an explicit deny wins over an allow, for the same principal', async () => {
    const { dc1, dc2 } = await buildRootDcAndRodc();
    const dc2Store = dc2.getDirectoryStore()!;
    dc2Store.setPasswordReplicationPolicy(['bob'], ['bob']);
    expect(dc2Store.getPasswordReplicationPolicy()).toEqual({ allowed: ['bob'], denied: ['bob'] });

    dc1.getDirectoryStore()!.newUser('bob', { password: 'bobpw', fullName: 'Bob' });
    dc2.replicateFrom('192.168.80.10');

    const bob = dc2Store.getUser('bob')!;
    expect(bob.fullName).toBe('Bob');
    expect(bob.password).toBe('');
  });
});
