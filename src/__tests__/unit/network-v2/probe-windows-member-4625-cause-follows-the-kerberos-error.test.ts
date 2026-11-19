/*
 * Probe: on a domain MEMBER, a network logon by a domain account that fails wrote a 4625 whose cause was guessed:
 * bindLdapWithKerberos collapsed the KDC's answer into "bad-credential", so the server wrote "unknown-user" whenever no
 * local account of that name existed and "bad-password" otherwise. The cause now follows the Kerberos error the AS exchange
 * returned (RFC 4120 section 7.5.9: KDC_ERR_C_PRINCIPAL_UNKNOWN 6, KDC_ERR_CLIENT_REVOKED 18, KDC_ERR_PREAUTH_FAILED 24):
 * 6 -> SubStatus 0xC0000064 (unknown user), 24 -> 0xC000006A (wrong password), 18 -> Status 0xC0000072 (account disabled; the
 * repository already writes a disabled account that way for local logons, see FAILURE_STATUS).
 *
 * Discriminated with git stash on src: 2 of 4 fall before the fix; two pass either way and are named: the witness (a right
 * password is accepted) and "an unknown domain account is unknown" (no local account of that name, so the old guess was right).
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

beforeEach(() => { resetCounters(); resetDeviceCounters(); Logger.reset(); });

const ps = (d: WindowsServer | WindowsPC) => PowerShellSubShell.create(d).subShell;
const run = async (sh: ReturnType<typeof ps>, l: string) => (await sh.processLine(l)).output.join('\n');

async function lab() {
  const dc = new WindowsServer('DC1');
  const member = new WindowsServer('SRV1');
  const client = new WindowsPC('windows-pc', 'CLIENT1');
  const sw = new GenericSwitch('switch-generic', 'SW1');
  new Cable('c-dc').connect(dc.getPorts()[0], sw.getPorts()[0]);
  new Cable('c-member').connect(member.getPorts()[0], sw.getPorts()[1]);
  new Cable('c-client').connect(client.getPorts()[0], sw.getPorts()[2]);
  const mask = new SubnetMask('255.255.255.0');
  dc.getPorts()[0].configureIP(new IPAddress('192.168.40.10'), mask);
  member.getPorts()[0].configureIP(new IPAddress('192.168.40.20'), mask);
  client.getPorts()[0].configureIP(new IPAddress('192.168.40.30'), mask);
  dc.setCurrentUser('Administrator'); member.setCurrentUser('Administrator'); client.setCurrentUser('Administrator');
  await run(ps(dc), 'Install-WindowsFeature AD-Domain-Services');
  await run(ps(dc), 'Install-ADDSForest -DomainName lab.local -SafeModeAdministratorPassword (ConvertTo-SecureString "P@ssw0rd" -AsPlainText -Force)');
  await run(ps(dc), 'New-ADUser -Enabled $true -Name alice -AccountPassword (ConvertTo-SecureString "alicepw" -AsPlainText -Force)');
  await run(ps(dc), 'New-ADUser -Enabled $false -Name dora -AccountPassword (ConvertTo-SecureString "dorapw" -AsPlainText -Force)');
  await run(ps(member), 'Add-Computer -DomainName lab.local -Credential "Administrator:P@ssw0rd" -Server 192.168.40.10');
  await member.executeCmdCommand('net share Data=C:\\Data');
  await run(ps(member), 'New-LocalUser -Name alice -Password (ConvertTo-SecureString "LocalPw1!" -AsPlainText -Force) | Out-Null');
  return { member, client };
}

const fieldOf = (name: string) => async (member: WindowsServer) => {
  const xml = await run(ps(member), '(Get-WinEvent -FilterHashtable @{LogName="Security"; Id=4625})[0].ToXml()');
  return new RegExp(`Name=['"]${name}['"]>([^<]*)<`).exec(xml)?.[1] ?? xml.slice(0, 300);
};
const subStatusOf = fieldOf('SubStatus');
const statusOf = fieldOf('Status');

const connect = (client: WindowsPC, user: string, password: string) =>
  client.executeCmdCommand(`net use Z: \\\\192.168.40.20\\Data ${password} /user:${user}`);

describe('4625 on a member follows the KDC error', () => {
  it('witness: a domain account with the right password connects', async () => {
    const { client } = await lab();
    expect(await connect(client, 'LAB\\alice', 'alicepw')).toContain('The command completed successfully.');
  });

  it('an unknown domain account is unknown', async () => {
    const { member, client } = await lab();
    await connect(client, 'LAB\\ghost', 'x');
    expect(await subStatusOf(member)).toBe('0xC0000064');
  });

  it('a wrong password for a domain account that also exists locally is a bad password, not the local verdict', async () => {
    const { member, client } = await lab();
    await connect(client, 'LAB\\alice', 'wrong');
    expect(await subStatusOf(member)).toBe('0xC000006A');
  });

  it('a disabled domain account is reported as disabled', async () => {
    const { member, client } = await lab();
    await connect(client, 'LAB\\dora', 'dorapw');
    expect(await statusOf(member)).toBe('0xC0000072');
  });
});
