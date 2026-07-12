/**
 * `Get-ADReplicationAttributeMetadata`-equivalent — introspection over
 * the per-attribute replication stamps (`AttributeReplStamp`, added in
 * the per-attribute replication metadata upgrade) that were previously
 * only usable internally by the replication engine itself.
 */
import { describe, it, expect } from 'vitest';
import { resetCounters, IPAddress, SubnetMask } from '@/network/core/types';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

function reset() {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
}

const ps = (d: WindowsServer) => PowerShellSubShell.create(d).subShell;
const run = async (sh: ReturnType<typeof ps>, l: string) => (await sh.processLine(l)).output.join('\n');

describe('DirectoryStore — replication attribute metadata introspection', () => {
  it('reflects a real write with an incrementing version', async () => {
    reset();
    const dc = new WindowsServer('DC1');
    dc.setCurrentUser('Administrator');
    await run(ps(dc), 'Install-WindowsFeature AD-Domain-Services');
    await run(ps(dc), 'Install-ADDSForest -DomainName lab.local -SafeModeAdministratorPassword (ConvertTo-SecureString "P@ssw0rd" -AsPlainText -Force)');
    const store = dc.getDirectoryStore()!;
    store.newUser('alice', { password: 'alicepw', fullName: 'Alice' });

    const dn = store.getUser('alice')!.dn;
    const metadata = store.getReplicationMetadataFor(dn)!;
    const displayNameStamp = metadata.find(m => m.attributeName === 'displayname')!;
    expect(displayNameStamp.version).toBe(1);
    expect(displayNameStamp.originatingInvocationId).toBe(store.getInvocationId());

    store.setUser('alice', { fullName: 'Alice Renamed' });
    const afterUpdate = store.getReplicationMetadataFor(dn)!.find(m => m.attributeName === 'displayname')!;
    expect(afterUpdate.version).toBe(2);
  });

  it('returns null for an unknown DN', async () => {
    reset();
    const dc = new WindowsServer('DC1');
    dc.setCurrentUser('Administrator');
    await run(ps(dc), 'Install-WindowsFeature AD-Domain-Services');
    await run(ps(dc), 'Install-ADDSForest -DomainName lab.local -SafeModeAdministratorPassword (ConvertTo-SecureString "P@ssw0rd" -AsPlainText -Force)');
    const store = dc.getDirectoryStore()!;
    expect(store.getReplicationMetadataFor('CN=ghost,CN=Users,DC=lab,DC=local')).toBeNull();
  });

  it('two DCs converge to matching per-attribute stamps for a synced attribute', async () => {
    reset();
    const dc1 = new WindowsServer('DC1');
    const dc2 = new WindowsServer('DC2');
    const sw = new GenericSwitch('switch-generic', 'SW1');
    new Cable('c-dc1').connect(dc1.getPorts()[0], sw.getPorts()[0]);
    new Cable('c-dc2').connect(dc2.getPorts()[0], sw.getPorts()[1]);
    const mask = new SubnetMask('255.255.255.0');
    dc1.getPorts()[0].configureIP(new IPAddress('192.168.87.10'), mask);
    dc2.getPorts()[0].configureIP(new IPAddress('192.168.87.11'), mask);

    dc1.setCurrentUser('Administrator');
    await run(ps(dc1), 'Install-WindowsFeature AD-Domain-Services');
    await run(ps(dc1), 'Install-ADDSForest -DomainName lab.local -SafeModeAdministratorPassword (ConvertTo-SecureString "P@ssw0rd" -AsPlainText -Force)');
    dc2.setCurrentUser('Administrator');
    await run(ps(dc2), 'Install-WindowsFeature AD-Domain-Services');
    await run(ps(dc2), 'Install-ADDSForest -DomainName lab.local -SafeModeAdministratorPassword (ConvertTo-SecureString "P@ssw0rd" -AsPlainText -Force)');

    const store1 = dc1.getDirectoryStore()!;
    store1.newUser('alice', { password: 'alicepw', fullName: 'Alice' });
    const dn = store1.getUser('alice')!.dn;

    const result = dc2.replicateFrom('192.168.87.10');
    expect(result.ok).toBe(true);

    const store2 = dc2.getDirectoryStore()!;
    const stamp1 = store1.getReplicationMetadataFor(dn)!.find(m => m.attributeName === 'displayname')!;
    const stamp2 = store2.getReplicationMetadataFor(dn)!.find(m => m.attributeName === 'displayname')!;
    expect(stamp2.originatingInvocationId).toBe(stamp1.originatingInvocationId);
    expect(stamp2.version).toBe(stamp1.version);
    expect(stamp2.originatingUsn).toBe(stamp1.originatingUsn);
  });
});
