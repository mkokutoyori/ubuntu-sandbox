/*
 * The user's lab, imported as exported: the directory of google.com, run
 * on WinServer1 (HQ, 192.168.30.0/24). An OU tree, users and groups are
 * created through PowerShell, PC4 joins the domain over the wire, and the
 * cmdlets this branch adds — Move-ADObject and Get-ADPrincipalGroupMembership
 * — move the joined machine into its OU and answer which groups an account
 * belongs to.
 *
 * Only configuration is added; topology and equipment are the lab's.
 */
import { describe, it, expect } from 'vitest';
import { loadUserLab, type UserLab } from './userLab';
import { ADMIN_CREDENTIAL, pointDnsAt, promoteDomainController, shell } from './userLabDomain';

async function directoryLab(): Promise<UserLab> {
  const lab = await loadUserLab();
  const dcIp = await promoteDomainController(lab.WinServer1);
  for (const line of [
    'New-ADOrganizationalUnit -Name "Siege" -Path "DC=google,DC=com"',
    'New-ADOrganizationalUnit -Name "Postes" -Path "OU=Siege,DC=google,DC=com"',
    'New-ADOrganizationalUnit -Name "Utilisateurs" -Path "OU=Siege,DC=google,DC=com"',
    'New-ADGroup -Name "Auditeurs" -GroupScope Global',
    'New-ADGroup -Name "RSSI" -GroupScope Global',
    'Add-ADGroupMember -Identity "Auditeurs" -Members jdupont',
  ]) await shell(lab.WinServer1, line);
  await lab.PC4.executeCommand('ipconfig /renew');
  await pointDnsAt(lab.PC4, dcIp);
  await shell(lab.PC4, `Add-Computer -DomainName "google.com" -Credential "${ADMIN_CREDENTIAL}"`);
  return lab;
}

describe('user lab — annuaire google.com', () => {
  it("l'arbre d'OU est créé sous le domaine", async () => {
    const lab = await directoryLab();
    const dns = await shell(lab.WinServer1, '(Get-ADOrganizationalUnit -Filter *).DistinguishedName');
    expect(dns).toMatch(/OU=Postes,OU=Siege,DC=google,DC=com/i);
    expect(dns).toMatch(/OU=Utilisateurs,OU=Siege,DC=google,DC=com/i);
  });

  it('un compte machine joint atterrit dans Computers puis se range dans son OU', async () => {
    const lab = await directoryLab();
    expect(await shell(lab.WinServer1, '(Get-ADComputer PC4).DistinguishedName'))
      .toMatch(/CN=PC4,CN=Computers,DC=google,DC=com/i);
    await shell(lab.WinServer1, 'Move-ADObject -Identity "CN=PC4,CN=Computers,DC=google,DC=com" -TargetPath "OU=Postes,OU=Siege,DC=google,DC=com"');
    expect(await shell(lab.WinServer1, '(Get-ADComputer PC4).DistinguishedName'))
      .toMatch(/CN=PC4,OU=Postes,OU=Siege,DC=google,DC=com/i);
  });

  it("un utilisateur se range dans l'OU Utilisateurs et garde ses groupes", async () => {
    const lab = await directoryLab();
    await shell(lab.WinServer1, 'Move-ADObject -Identity "CN=jdupont,CN=Users,DC=google,DC=com" -TargetPath "OU=Utilisateurs,OU=Siege,DC=google,DC=com"');
    expect(await shell(lab.WinServer1, '(Get-ADUser jdupont).DistinguishedName'))
      .toMatch(/CN=jdupont,OU=Utilisateurs,OU=Siege,DC=google,DC=com/i);
    const groups = await shell(lab.WinServer1, '(Get-ADPrincipalGroupMembership -Identity jdupont).Name');
    expect(groups).toMatch(/Auditeurs/);
    expect(groups).toMatch(/Domain Users/);
  });

  it("l'appartenance suit Add-ADGroupMember et Remove-ADGroupMember", async () => {
    const lab = await directoryLab();
    await shell(lab.WinServer1, 'Add-ADGroupMember -Identity "RSSI" -Members jdupont');
    expect(await shell(lab.WinServer1, '(Get-ADPrincipalGroupMembership -Identity jdupont).Name')).toMatch(/RSSI/);
    await shell(lab.WinServer1, 'Remove-ADGroupMember -Identity "RSSI" -Members jdupont -Confirm:$false');
    expect(await shell(lab.WinServer1, '(Get-ADPrincipalGroupMembership -Identity jdupont).Name')).not.toMatch(/RSSI/);
  });
});
