/*
 * The user's lab, imported as exported: PC2 (LAN 192.168.1.0/24) is a member
 * of google.com, whose DC WinServer1 (HQ 192.168.30.0/24) also hosts the DNS
 * role. A domain administrator logged on at PC2 manages that DNS server with
 * -ComputerName: the command travels as real WinRM frames (TCP/5985) through
 * FW1, authenticated by a Kerberos service ticket presented as an AP-REQ and
 * checked by the target against its own computer-account key. FW1's policy 1
 * (LAN_SUBNET -> HQ_ADDRESS, service ALL, NAT) is rewritten through its CLI:
 *
 *   - policy 1 as imported: the remote read and the remote write cross;
 *   - a domain user who is not an administrator is refused ("Access is denied.")
 *     and nothing is written;
 *   - a session with no domain logon has no ticket: "Access is denied.";
 *   - policy 1 narrowed to DNS: TCP/5985 is dropped and the command fails;
 *     reopened with a custom WinRM service it crosses again.
 *
 * Only configuration is added; topology and equipment are the lab's.
 */
import { describe, it, expect } from 'vitest';
import type { WindowsServer } from '@/network/devices/WindowsServer';
import type { WindowsPC } from '@/network/devices/WindowsPC';
import { addRoutesToHq, loadUserLab, type UserLab } from './userLab';
import { taper } from './fortigateBatteryHarness';
import { AD_SERVICES, ADMIN_CREDENTIAL, DSRM, pointDnsAt, promoteDomainController, shell, windows } from './userLabDomain';

const DC = 'WinServer1.google.com';

async function remoteLab(): Promise<UserLab> {
  const lab = await loadUserLab();
  await addRoutesToHq(lab);
  const dcIp = await promoteDomainController(lab.WinServer1);
  await lab.PC2.executeCommand('ipconfig /renew');
  await pointDnsAt(lab.PC2, dcIp);
  await shell(lab.PC2, `Add-Computer -DomainName "google.com" -Credential "${ADMIN_CREDENTIAL}"`);
  await shell(lab.WinServer1, 'Enable-PSRemoting -Force');
  await shell(lab.PC2, 'Add-WindowsCapability -Online -Name "Rsat.Dns.Tools~~~~0.0.1.0"');
  await shell(lab.WinServer1, 'New-ADUser -Name mdupuis -AccountPassword (ConvertTo-SecureString "Passw0rd!" -AsPlainText -Force) -Enabled $true');
  return lab;
}

const pc2 = (lab: UserLab): WindowsPC => windows(lab.PC2) as WindowsPC;

function logon(lab: UserLab, user: string, password: string): void {
  expect(pc2(lab).logonDomain(`GOOGLE\\${user}`, password).ok).toBe(true);
}

describe('user lab — administration DNS à distance depuis PC2 à travers FW1', () => {
  it('sans les outils RSAT DNS, PC2 ne connaît pas le module ; Add/Remove-WindowsCapability le pose et le retire', async () => {
    const lab = await remoteLab();
    await shell(lab.PC2, 'Remove-WindowsCapability -Online -Name "Rsat.Dns.Tools~~~~0.0.1.0"');
    expect(await shell(lab.PC2, 'Get-DnsServerZone')).toMatch(/not recognized/);
    expect(await shell(lab.PC2, 'Get-WindowsCapability -Online -Name Rsat.Dns*')).toMatch(/NotPresent/);
    await shell(lab.PC2, 'Add-WindowsCapability -Online -Name "Rsat.Dns.Tools~~~~0.0.1.0"');
    expect(await shell(lab.PC2, 'Get-WindowsCapability -Online -Name Rsat.Dns*')).toMatch(/Installed/);
  });

  it('TÉMOIN : le serveur DNS de WinServer1 porte bien la zone google.com', async () => {
    const lab = await remoteLab();
    expect(await shell(lab.WinServer1, 'Get-DnsServerZone')).toContain('google.com');
  });

  it('un administrateur de domaine lit puis écrit la zone à distance', async () => {
    const lab = await remoteLab();
    logon(lab, 'Administrator', DSRM);
    const zones = await shell(lab.PC2, `Get-DnsServerZone -ComputerName ${DC}`);
    expect(zones).toContain('google.com');
    await shell(lab.PC2, `Add-DnsServerResourceRecordA -ZoneName google.com -Name intranet -IPv4Address 192.168.30.90 -ComputerName ${DC}`);
    expect(await shell(lab.WinServer1, 'Get-DnsServerResourceRecord -ZoneName google.com -Name intranet')).toContain('192.168.30.90');
  });

  it('un utilisateur de domaine non administrateur est refusé et rien n est écrit', async () => {
    const lab = await remoteLab();
    logon(lab, 'mdupuis', 'Passw0rd!');
    const out = await shell(lab.PC2, `Add-DnsServerResourceRecordA -ZoneName google.com -Name evil -IPv4Address 6.6.6.6 -ComputerName ${DC}`);
    expect(out).toMatch(/Access is denied/);
    expect(await shell(lab.WinServer1, 'Get-DnsServerResourceRecord -ZoneName google.com')).not.toContain('6.6.6.6');
  });

  it('sans ouverture de session de domaine, pas de ticket : accès refusé', async () => {
    const lab = await remoteLab();
    windows(lab.PC2).setCurrentUser('Administrator');
    expect(await shell(lab.PC2, `Get-DnsServerZone -ComputerName ${DC}`)).toMatch(/Access is denied/);
  });

  it('la policy 1 limitée à DNS et Kerberos coupe TCP/5985, rouverte au service WinRM elle repasse', async () => {
    const lab = await remoteLab();
    logon(lab, 'Administrator', DSRM);
    await taper(lab.FW1, [
      ...AD_SERVICES,
      'config firewall policy', 'edit 1', 'set service "DNS" "AD-KERBEROS" "AD-LDAP" "AD-SMB-RPC"', 'next', 'end',
    ]);
    expect(await shell(lab.PC2, `Get-DnsServerZone -ComputerName ${DC}`)).toMatch(/WinRM cannot complete the operation/);
    await taper(lab.FW1, [
      'config firewall service custom', 'edit "WINRM"', 'set tcp-portrange 5985', 'next', 'end',
      'config firewall policy', 'edit 1', 'set service "DNS" "WINRM" "AD-KERBEROS" "AD-LDAP" "AD-SMB-RPC"', 'next', 'end',
    ]);
    expect(await shell(lab.PC2, `Get-DnsServerZone -ComputerName ${DC}`)).toContain('google.com');
  });
});
