import { WindowsServer } from '@/network/devices/WindowsServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import type { InputHost, InputCompletion } from '@/shell/input';
import type { InputRequest } from '@/shell/input/types';
import type { LabDevice } from './userLab';

export const DSRM = 'DSRM@Google2025!';
export const ADMIN_CREDENTIAL = `Administrator:${DSRM}`;

export function answeringHost(answer: string): InputHost {
  let pending: ((o: InputCompletion) => void) | null = null;
  return {
    requestInput(_req: InputRequest, complete) {
      pending = complete;
      setTimeout(() => { const cb = pending; pending = null; cb?.({ status: 'submitted', value: answer }); }, 0);
    },
    cancelRequest() { pending = null; },
    emit() {},
    attachStream() { return { id: 'x', description: '', active: true, cancel() {} }; },
    detachAllStreams() {},
    capabilities() { return { interactive: true, maskedSupported: true, streaming: true }; },
  };
}

export function windows(device: LabDevice): WindowsServer | WindowsPC {
  return device as unknown as WindowsServer | WindowsPC;
}

export async function shell(device: LabDevice, line: string): Promise<string> {
  return (await PowerShellSubShell.create(windows(device)).subShell.processLine(line)).output.join('\n');
}

export async function promoteDomainController(device: LabDevice): Promise<string> {
  const server = windows(device) as WindowsServer;
  server.setCurrentUser('Administrator');
  const address = server.getPorts()[0].getIPAddress();
  if (!address) throw new Error(`${device.getName()} has no address to promote on`);
  await shell(device, 'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools');
  const interactive = PowerShellSubShell.create(server).subShell;
  interactive.setInputHost(answeringHost(DSRM));
  await interactive.processLine(
    'Install-ADDSForest -DomainName "google.com" -DomainNetbiosName "GOOGLE" '
    + '-DomainMode "WinThreshold" -ForestMode "WinThreshold" -InstallDns:$true '
    + '-SafeModeAdministratorPassword (Read-Host -AsSecureString "Entrez le mot de passe DSRM") -Force');
  await shell(device, 'New-ADUser -Name jdupont -AccountPassword (ConvertTo-SecureString "Passw0rd!" -AsPlainText -Force) -Enabled $true');
  return address.toString();
}

export async function pointDnsAt(device: LabDevice, dcAddress: string): Promise<void> {
  windows(device).setCurrentUser('Administrator');
  await shell(device, `Set-DnsClientServerAddress -InterfaceAlias "Ethernet 0" -ServerAddresses ${dcAddress}`);
}
