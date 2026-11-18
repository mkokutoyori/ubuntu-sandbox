/**
 * Probe: a domain-joined member reads the AD site subnets of its domain for the Intranet firewall keyword, over LDAP.
 *
 * References: a third-party Active Directory firewall guide (dsinternals) says the Intranet keyword rests on the Active Directory Sites and Services subnets; MS-FASP leaves "the local intranet" unspecified.
 * The member binds to its domain controller with its computer account (the same dialogue as Test-ComputerSecureChannel) and searches CN=Subnets,CN=Sites,CN=Configuration; the read happens when the
 * firewall service starts or a rule is created, never per packet (the LDAP frames would meet the firewall filter and recurse). A domain controller reads its own directory.
 *
 * Measured before the change: a member's Intranet set held only its attached subnets; the "member does not query the directory" limit of TODO.md.
 *
 * Discrimination (git stash push -- src/network src/powershell): 2 of 4 cases fall on the base (the site subnet read, and its survival of a cut cable). The attached-subnets case and the workgroup
 * WITNESS pass either way.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, IPAddress, SubnetMask } from '@/network/core/types';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

const ps = (d: WindowsServer | WindowsPC) => PowerShellSubShell.create(d).subShell;
const run = async (sh: ReturnType<typeof ps>, l: string) => (await sh.processLine(l)).output.join('\n');

async function buildLan(): Promise<{ dc: WindowsServer; member: WindowsServer; client: WindowsPC; cDc: Cable; cMember: Cable; cClient: Cable }> {
  const dc = new WindowsServer('DC1');
  const member = new WindowsServer('SRV1');
  const client = new WindowsPC('windows-pc', 'CLIENT1');
  const sw = new GenericSwitch('switch-generic', 'SW1');
  const cDc = new Cable('c-dc'); cDc.connect(dc.getPorts()[0], sw.getPorts()[0]);
  const cMember = new Cable('c-member'); cMember.connect(member.getPorts()[0], sw.getPorts()[1]);
  const cClient = new Cable('c-client'); cClient.connect(client.getPorts()[0], sw.getPorts()[2]);

  const mask = new SubnetMask('255.255.255.0');
  dc.getPorts()[0].configureIP(new IPAddress('192.168.40.10'), mask);
  member.getPorts()[0].configureIP(new IPAddress('192.168.40.20'), mask);
  client.getPorts()[0].configureIP(new IPAddress('192.168.40.30'), mask);
  client.addHostsEntry('192.168.40.20', 'SRV1');

  dc.setCurrentUser('Administrator');
  await run(ps(dc), 'Install-WindowsFeature AD-Domain-Services');
  await run(ps(dc), 'Install-ADDSForest -DomainName lab.local -SafeModeAdministratorPassword (ConvertTo-SecureString "P@ssw0rd" -AsPlainText -Force)');
  await run(ps(dc), 'New-ADUser -Enabled $true -Name alice -AccountPassword (ConvertTo-SecureString "alicepw" -AsPlainText -Force) -DisplayName "Alice"');
  await run(ps(dc), 'New-ADGroup -Name Engineers -GroupScope Global');
  await run(ps(dc), 'Add-ADGroupMember -Identity Engineers -Members alice');

  member.setCurrentUser('Administrator');
  client.setCurrentUser('Administrator');
  return { dc, member, client, cDc, cMember, cClient };
}


const intranetOf = (machine: WindowsServer): readonly string[] =>
  (machine as unknown as { firewallAddressSets(): { intranet(): readonly string[] } }).firewallAddressSets().intranet();

describe('the Intranet keyword on a domain member', () => {
  it('a member reads the AD site subnets from its domain controller over LDAP when a rule is created', async () => {
    const { dc, member } = await buildLan();
    await run(ps(member), 'Add-Computer -DomainName lab.local -Credential "Administrator:P@ssw0rd" -Server 192.168.40.10');
    await run(ps(dc), 'New-ADReplicationSite -Name HQ');
    await run(ps(dc), 'New-ADReplicationSubnet -Name 172.31.5.0/24 -Site HQ');
    await run(ps(member), 'New-NetFirewallRule -DisplayName Probe -Direction Outbound -Action Allow -RemoteAddress Intranet | Out-Null');
    expect(intranetOf(member)).toContain('172.31.5.0/24');
  });

  it('the subnets the member is attached to are always part of it', async () => {
    const { dc, member } = await buildLan();
    await run(ps(member), 'Add-Computer -DomainName lab.local -Credential "Administrator:P@ssw0rd" -Server 192.168.40.10');
    await run(ps(member), 'New-NetFirewallRule -DisplayName Probe -Direction Outbound -Action Allow -RemoteAddress Intranet | Out-Null');
    expect(intranetOf(member)).toContain('192.168.40.0/24');
    expect(intranetOf(dc)).toContain('192.168.40.0/24');
  });

  it('the lookup crosses the network: with the cable to the DC cut, the member keeps what it read before', async () => {
    const { dc, member, cMember } = await buildLan();
    await run(ps(member), 'Add-Computer -DomainName lab.local -Credential "Administrator:P@ssw0rd" -Server 192.168.40.10');
    await run(ps(dc), 'New-ADReplicationSite -Name HQ');
    await run(ps(dc), 'New-ADReplicationSubnet -Name 172.31.5.0/24 -Site HQ');
    await run(ps(member), 'New-NetFirewallRule -DisplayName One -Direction Outbound -Action Allow -RemoteAddress Intranet | Out-Null');
    cMember.disconnect();
    await run(ps(member), 'New-NetFirewallRule -DisplayName Two -Direction Outbound -Action Allow -RemoteAddress Intranet | Out-Null');
    expect(intranetOf(member)).toContain('172.31.5.0/24');
  });

  it('WITNESS: a workgroup machine has only its own subnets', async () => {
    const { client } = await buildLan();
    await run(ps(client), 'New-NetFirewallRule -DisplayName Probe -Direction Outbound -Action Allow -RemoteAddress Intranet | Out-Null');
    expect(intranetOf(client as unknown as WindowsServer)).toEqual(['192.168.40.0/24']);
  });
});
