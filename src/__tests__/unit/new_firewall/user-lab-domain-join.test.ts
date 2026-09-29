/*
 * The user's lab (lan_with_firewall_fortigate.topology), imported as
 * exported: WinServer1 is promoted to a domain controller for google.com —
 * the DSRM password entered through a nested `(Read-Host -AsSecureString
 * …)`, the form this branch makes interactive — and PC4, the Windows client
 * on the same HQ segment (192.168.30.0/24 behind R3), joins that domain
 * without ever being told the DC's address: it points its DNS client at the
 * DC and `Add-Computer -DomainName google.com` locates it by the
 * `_ldap._tcp.dc._msdcs.google.com` SRV record the promotion published.
 *
 * Only configuration is added; the topology and the equipment are those of
 * the imported lab. WinServer1 and PC4 hang off HQ_MAIN_SW, so they share
 * the 192.168.30.0/24 broadcast domain and reach each other directly.
 */
import { describe, it, expect } from 'vitest';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import type { InputHost, InputCompletion } from '@/shell/input';
import type { InputRequest } from '@/shell/input/types';
import { loadUserLab, type UserLab, type LabDevice } from './userLab';

const DSRM = 'DSRM@Google2025!';

function makeHost(answer: string): InputHost {
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

function windows(device: LabDevice): WindowsServer | WindowsPC {
  return device as unknown as WindowsServer | WindowsPC;
}

async function shell(device: LabDevice, l: string): Promise<string> {
  return (await PowerShellSubShell.create(windows(device)).subShell.processLine(l)).output.join('\n');
}

async function promote(device: LabDevice): Promise<string> {
  const server = windows(device) as WindowsServer;
  server.setCurrentUser('Administrator');
  const dcIp = server.getPorts()[0].getIPAddress();
  if (!dcIp) throw new Error('WinServer1 has no address to promote on');
  await shell(device, 'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools');
  const interactive = PowerShellSubShell.create(server).subShell;
  interactive.setInputHost(makeHost(DSRM));
  await interactive.processLine(
    'Install-ADDSForest -DomainName "google.com" -DomainNetbiosName "GOOGLE" '
    + '-DomainMode "WinThreshold" -ForestMode "WinThreshold" -InstallDns:$true '
    + '-SafeModeAdministratorPassword (Read-Host -AsSecureString "Entrez le mot de passe DSRM") -Force');
  await shell(device, 'New-ADUser -Name jdupont -AccountPassword (ConvertTo-SecureString "Passw0rd!" -AsPlainText -Force) -Enabled $true');
  return dcIp.toString();
}

async function domainReadyLab(): Promise<{ lab: UserLab; dcIp: string }> {
  const lab = await loadUserLab();
  const dcIp = await promote(lab.WinServer1);
  const client = windows(lab.PC4) as WindowsPC;
  client.setCurrentUser('Administrator');
  await lab.PC4.executeCommand('ipconfig /renew');
  await shell(lab.PC4, `Set-DnsClientServerAddress -InterfaceAlias "Ethernet 0" -ServerAddresses ${dcIp}`);
  return { lab, dcIp };
}

describe('user lab — WinServer1 devient contrôleur de domaine google.com', () => {
  it('la promotion via (Read-Host) publie le SRV du localisateur de DC', async () => {
    const lab = await loadUserLab();
    const dcIp = await promote(lab.WinServer1);
    expect((windows(lab.WinServer1) as WindowsServer).getDirectoryStore()).not.toBeNull();
    const srv = await lab.WinServer1.executeCommand(`nslookup -type=SRV _ldap._tcp.dc._msdcs.google.com ${dcIp}`);
    expect(srv).toContain('389');
    expect(srv).toMatch(/google\.com/i);
  });

  it('PC4 rejoint google.com sans qu on lui nomme le DC', async () => {
    const { lab } = await domainReadyLab();
    const out = await shell(lab.PC4, 'Add-Computer -DomainName "google.com" -Credential "Administrator:DSRM@Google2025!"');
    expect(out).not.toMatch(/could not be contacted|not recognized/i);
    expect((windows(lab.PC4) as WindowsPC).getDomainMembership()?.dnsName).toBe('google.com');
    expect((windows(lab.WinServer1) as WindowsServer).getDirectoryStore()!.getComputer('PC4')).not.toBeNull();
  });

  it('un utilisateur du domaine ouvre une session sur PC4 une fois joint', async () => {
    const { lab } = await domainReadyLab();
    await shell(lab.PC4, 'Add-Computer -DomainName "google.com" -Credential "Administrator:DSRM@Google2025!"');
    const res = (windows(lab.PC4) as WindowsPC).logonDomain('GOOGLE\\jdupont', 'Passw0rd!');
    expect(res.ok).toBe(true);
    expect((windows(lab.PC4) as WindowsPC).getDomainSession()?.sam).toBe('jdupont');
  });
});
