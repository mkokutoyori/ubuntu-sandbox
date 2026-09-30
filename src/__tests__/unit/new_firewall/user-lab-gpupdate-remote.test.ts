/*
 * The user's lab, imported as exported: a domain administrator logged on at PC2
 * (LAN 192.168.1.0/24, with the RSAT Group Policy tools) refreshes the policy of
 * PC4 (HQ 192.168.30.0/24) with Invoke-GPUpdate -Computer. The request is a
 * WinRM session (TCP/5985) authenticated by a Kerberos service ticket, crossing
 * FW1; PC4 then pulls its policy from the DC over LDAP. FW1's policy 1 is
 * rewritten through its CLI. As on Windows the request only schedules the
 * refresh (the target runs it once the session is over), so the tests let the
 * event loop turn before reading PC4:
 *
 *   - policy 1 as imported: the refresh crosses and PC4 gets the GPO's value;
 *   - policy 1 narrowed to DNS + the AD services (no WinRM): PC2 is told WinRM
 *     cannot complete, and PC4 keeps its old policy;
 *   - a domain user who is not an administrator is refused.
 *
 * Only configuration is added; topology and equipment are the lab's.
 */
import { describe, it, expect } from 'vitest';
import type { WindowsPC } from '@/network/devices/WindowsPC';
import { addRoutesToHq, loadUserLab, type UserLab } from './userLab';
import { taper } from './fortigateBatteryHarness';
import { AD_SERVICES, ADMIN_CREDENTIAL, DSRM, pointDnsAt, promoteDomainController, shell, windows } from './userLabDomain';

const JOIN = `Add-Computer -DomainName "google.com" -Credential "${ADMIN_CREDENTIAL}"`;
const POLICY_KEY = 'HKLM\\SOFTWARE\\Policies\\Lab';

async function gpLab(): Promise<UserLab> {
  const lab = await loadUserLab();
  await addRoutesToHq(lab);
  const dcIp = await promoteDomainController(lab.WinServer1);
  for (const pc of [lab.PC2, lab.PC4]) {
    await pc.executeCommand('ipconfig /renew');
    await pointDnsAt(pc, dcIp);
    await shell(pc, JOIN);
  }
  await shell(lab.PC4, 'Enable-PSRemoting -Force');
  await shell(lab.PC2, 'Add-WindowsCapability -Online -Name "Rsat.GroupPolicy.Management.Tools~~~~0.0.1.0"');
  await shell(lab.WinServer1, 'New-ADUser -Name mdupuis -AccountPassword (ConvertTo-SecureString "Passw0rd!" -AsPlainText -Force) -Enabled $true');
  await shell(lab.WinServer1, 'New-GPO -Name "Remote"');
  await shell(lab.WinServer1, `Set-GPRegistryValue -Name "Remote" -Key "${POLICY_KEY}" -ValueName Mode -Type String -Value "fromDC"`);
  await shell(lab.WinServer1, 'New-GPLink -Name "Remote" -Target "DC=google,DC=com"');
  return lab;
}

const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 100));
const policyOn = async (lab: UserLab) => { await settle(); return lab.PC4.executeCommand(`reg query "${POLICY_KEY}" /v Mode`); };
const refresh = (lab: UserLab) => shell(lab.PC2, 'Invoke-GPUpdate -Computer PC4.google.com -Target Computer -RandomDelayInMinutes 0');

describe('user lab — Invoke-GPUpdate -Computer depuis PC2 vers PC4 à travers FW1', () => {
  it('un administrateur de domaine rafraîchit la stratégie de PC4 à distance', async () => {
    const lab = await gpLab();
    expect(await policyOn(lab)).not.toMatch(/fromDC/);
    expect((windows(lab.PC2) as WindowsPC).logonDomain('GOOGLE\\Administrator', DSRM).ok).toBe(true);
    expect(await refresh(lab)).toBe('');
    expect(await policyOn(lab)).toMatch(/fromDC/);
  });

  it('sans WinRM autorisé par FW1, PC4 garde son ancienne stratégie', async () => {
    const lab = await gpLab();
    (windows(lab.PC2) as WindowsPC).logonDomain('GOOGLE\\Administrator', DSRM);
    await taper(lab.FW1, [
      ...AD_SERVICES,
      'config firewall policy', 'edit 1', 'set service "DNS" "AD-KERBEROS" "AD-LDAP" "AD-SMB-RPC"', 'next', 'end',
    ]);
    expect(await refresh(lab)).toMatch(/WinRM cannot complete the operation/);
    expect(await policyOn(lab)).not.toMatch(/fromDC/);
  });

  it('un utilisateur de domaine non administrateur est refusé', async () => {
    const lab = await gpLab();
    (windows(lab.PC2) as WindowsPC).logonDomain('GOOGLE\\mdupuis', 'Passw0rd!');
    expect(await refresh(lab)).toMatch(/Access is denied/);
    expect(await policyOn(lab)).not.toMatch(/fromDC/);
  });
});
