import { resetCounters, IPAddress, SubnetMask, MACAddress } from '@/network/core/types';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

export function resetGpoWorld(): void {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.reset();
}

export const ROOT = 'DC=corp,DC=lab';
export const SIEGE = `OU=Siege,${ROOT}`;
export const ORDINATEURS = `OU=Ordinateurs,${SIEGE}`;
export const POSTES = `OU=Postes,${ORDINATEURS}`;
export const SERVEURS = `OU=Serveurs,${ORDINATEURS}`;

const ps = (d: WindowsServer | WindowsPC) => PowerShellSubShell.create(d).subShell;
export const run = async (d: WindowsServer | WindowsPC, l: string): Promise<string> => (await ps(d).processLine(l)).output.join('\n');

export interface Lab { dc: WindowsServer; client: WindowsPC }

export async function lab(): Promise<Lab> {
  const dc = new WindowsServer('DC01');
  const client = new WindowsPC('windows-pc', 'PC01');
  const sw = new GenericSwitch('switch-generic', 'SW1', 8, 0, 0);
  for (const d of [dc, client, sw]) d.powerOn();
  new Cable('c-dc').connect(dc.getPorts()[0], sw.getPorts()[0]);
  new Cable('c-cli').connect(client.getPorts()[0], sw.getPorts()[1]);
  const mask = new SubnetMask('255.255.255.0');
  dc.getPorts()[0].configureIP(new IPAddress('10.0.0.10'), mask);
  client.getPorts()[0].configureIP(new IPAddress('10.0.0.30'), mask);
  dc.setCurrentUser('Administrator');
  client.setCurrentUser('Administrator');
  await run(dc, 'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools');
  await run(dc, 'Install-ADDSForest -DomainName "corp.lab" -DomainNetbiosName "CORP" -SafeModeAdministratorPassword (ConvertTo-SecureString "P@ssw0rd!" -AsPlainText -Force) -Force');
  for (const [name, path] of [['Siege', ROOT], ['Ordinateurs', SIEGE], ['Postes', ORDINATEURS], ['Serveurs', ORDINATEURS]]) {
    await run(dc, `New-ADOrganizationalUnit -Name "${name}" -Path "${path}"`);
  }
  await run(client, 'Set-DnsClientServerAddress -InterfaceAlias "Ethernet 0" -ServerAddresses 10.0.0.10');
  return { dc, client };
}

export async function joinIn(l: Lab, ou: string): Promise<void> {
  await run(l.client, `Add-Computer -DomainName "corp.lab" -Credential "Administrator:P@ssw0rd!" -OUPath "${ou}"`);
}

export async function gpo(dc: WindowsServer, name: string, target: string, mode?: string, linkOptions = ''): Promise<void> {
  await run(dc, `New-GPO -Name "${name}"`);
  if (mode !== undefined) {
    await run(dc, `Set-GPRegistryValue -Name "${name}" -Key "HKLM\\SOFTWARE\\Policies\\Lab" -ValueName Mode -Type String -Value "${mode}"`);
  }
  await run(dc, `New-GPLink -Name "${name}" -Target "${target}" ${linkOptions}`);
}

export async function applied(client: WindowsPC): Promise<string> {
  await client.executeCmdCommand('gpupdate /force');
  return client.executeCmdCommand('gpresult /R');
}

export async function mode(client: WindowsPC): Promise<string> {
  await client.executeCmdCommand('gpupdate /force');
  return client.executeCmdCommand('reg query "HKLM\\SOFTWARE\\Policies\\Lab" /v Mode');
}

