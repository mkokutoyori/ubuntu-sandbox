/*
 * The user's lab, imported as exported: WinServer1 is the domain controller
 * of google.com (HQ, 192.168.30.0/24), PC2 the Windows client of the LAN
 * (192.168.1.0/24) — every Group Policy refresh PC2 makes crosses Router2,
 * FW1 and R3, over LDAP and Kerberos, under FW1's policy 1.
 *
 *   - a GPO linked to OU=Siege reaches PC2, which is joined in
 *     OU=Postes,OU=Ordinateurs,OU=Siege — two levels down;
 *   - policy 1 narrowed to DNS: the refresh fails on connectivity and PC2
 *     keeps the last policy it applied, as a real client does;
 *   - policy 1 given the AD services again: the refresh crosses, and the
 *     value of a GPO deleted meanwhile is withdrawn from PC2's registry;
 *   - policy 1 disabled: nothing crosses.
 *
 * Only configuration is added; topology and equipment are the lab's.
 */
import { describe, it, expect } from 'vitest';
import type { WindowsPC } from '@/network/devices/WindowsPC';
import { addRoutesToHq, loadUserLab, type UserLab } from './userLab';
import { taper } from './fortigateBatteryHarness';
import { AD_SERVICES, ADMIN_CREDENTIAL, pointDnsAt, promoteDomainController, shell, windows } from './userLabDomain';

const ROOT = 'DC=google,DC=com';
const SIEGE = `OU=Siege,${ROOT}`;
const ORDINATEURS = `OU=Ordinateurs,${SIEGE}`;
const POSTES = `OU=Postes,${ORDINATEURS}`;
const POLICY_KEY = 'HKLM\\SOFTWARE\\Policies\\Google';

async function gpoLab(): Promise<UserLab> {
  const lab = await loadUserLab();
  await addRoutesToHq(lab);
  const dcIp = await promoteDomainController(lab.WinServer1);
  for (const line of [
    `New-ADOrganizationalUnit -Name "Siege" -Path "${ROOT}"`,
    `New-ADOrganizationalUnit -Name "Ordinateurs" -Path "${SIEGE}"`,
    `New-ADOrganizationalUnit -Name "Postes" -Path "${ORDINATEURS}"`,
    'New-GPO -Name "Baseline-Siege" -Comment "Socle du siege"',
    `Set-GPRegistryValue -Name "Baseline-Siege" -Key "${POLICY_KEY}" -ValueName Profil -Type String -Value "siege"`,
    `New-GPLink -Name "Baseline-Siege" -Target "${SIEGE}"`,
  ]) await shell(lab.WinServer1, line);
  await lab.PC2.executeCommand('ipconfig /renew');
  await pointDnsAt(lab.PC2, dcIp);
  await shell(lab.PC2, `Add-Computer -DomainName "google.com" -Credential "${ADMIN_CREDENTIAL}" -OUPath "${POSTES}"`);
  return lab;
}

const pc2 = (lab: UserLab): WindowsPC => windows(lab.PC2) as WindowsPC;
const refresh = (lab: UserLab): Promise<string> => pc2(lab).executeCmdCommand('gpupdate /force');
const profile = (lab: UserLab): Promise<string> => pc2(lab).executeCmdCommand(`reg query "${POLICY_KEY}" /v Profil`);

describe('user lab — Group Policy de google.com à travers FW1', () => {
  it("TÉMOIN : PC2 est joint dans l'OU imbriquée", async () => {
    const lab = await gpoLab();
    expect(pc2(lab).getDomainMembership()?.dnsName).toBe('google.com');
    expect(await shell(lab.WinServer1, '(Get-ADComputer PC2).DistinguishedName')).toContain(`CN=PC2,${POSTES}`);
  });

  it("une GPO liée à OU=Siege atteint PC2 deux niveaux plus bas, à travers FW1", async () => {
    const lab = await gpoLab();
    expect(await refresh(lab)).toMatch(/completed successfully/i);
    expect(await pc2(lab).executeCmdCommand('gpresult /R')).toContain('Baseline-Siege');
    expect(await profile(lab)).toContain('siege');
  });

  it("la policy 1 limitée à DNS coupe le rafraîchissement, PC2 garde sa dernière politique", async () => {
    const lab = await gpoLab();
    await refresh(lab);
    await taper(lab.FW1, ['config firewall policy', 'edit 1', 'set service "DNS"', 'next', 'end']);
    expect(await refresh(lab)).toMatch(/lack of network connectivity/i);
    expect(await profile(lab)).toContain('siege');
  });

  it("rouverte aux services AD, le rafraîchissement retire la valeur de la GPO supprimée entre-temps", async () => {
    const lab = await gpoLab();
    await refresh(lab);
    await taper(lab.FW1, ['config firewall policy', 'edit 1', 'set service "DNS"', 'next', 'end']);
    await shell(lab.WinServer1, 'Remove-GPO -Name "Baseline-Siege"');
    expect(await refresh(lab)).toMatch(/lack of network connectivity/i);
    expect(await profile(lab)).toContain('siege');
    await taper(lab.FW1, [
      ...AD_SERVICES,
      'config firewall policy', 'edit 1', 'set service "DNS" "AD-KERBEROS" "AD-LDAP" "AD-SMB-RPC"', 'next', 'end',
    ]);
    expect(await refresh(lab)).toMatch(/completed successfully/i);
    expect(await profile(lab)).not.toContain('siege');
  });

  it("la policy 1 désactivée ne laisse rien passer", async () => {
    const lab = await gpoLab();
    await taper(lab.FW1, ['config firewall policy', 'edit 1', 'set status disable', 'next', 'end']);
    expect(await refresh(lab)).toMatch(/lack of network connectivity/i);
    expect(await profile(lab)).not.toContain('siege');
  });
});
