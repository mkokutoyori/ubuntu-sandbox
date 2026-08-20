/**
 * Scénario 8 — Délégation de contrôle dans l'AD : administration
 * distribuée.
 *
 * Transcription littérale et fidèle : manipulation directe des ACL AD
 * (Get-ACL/Set-ACL sur le PSDrive AD:, ActiveDirectoryAccessRule) pour
 * déléguer la gestion des utilisateurs de OU=Reseau à `preseau` et la
 * réinitialisation de mots de passe sur OU=Audit à `jadmin`, puis
 * vérification fonctionnelle des permissions effectives (création
 * autorisée dans le périmètre délégué, "Access is denied" hors
 * périmètre).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters } from '@/network/core/types';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

const ps = (d: WindowsServer) => PowerShellSubShell.create(d).subShell;
const run = async (sh: ReturnType<typeof ps>, l: string) => (await sh.processLine(l)).output.join('\n');

async function buildLan(): Promise<WindowsServer> {
  const dc = new WindowsServer('DC01');
  dc.setCurrentUser('Administrator');
  const sh = ps(dc);
  await run(sh, 'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools -IncludeAllSubFeature -Restart:$false');
  await run(sh, 'Install-ADDSForest -DomainName "mandeng.lan" -DomainNetBiosName "MANDENG" -SafeModeAdministratorPassword (ConvertTo-SecureString "DSRM@Mandeng2025!" -AsPlainText -Force) -Force:$true');
  await run(sh, 'New-ADOrganizationalUnit -Name "Mandeng" -Path "DC=mandeng,DC=lan"');
  await run(sh, 'New-ADOrganizationalUnit -Name "Utilisateurs" -Path "OU=Mandeng,DC=mandeng,DC=lan"');
  await run(sh, 'New-ADOrganizationalUnit -Name "Reseau" -Path "OU=Utilisateurs,OU=Mandeng,DC=mandeng,DC=lan"');
  await run(sh, 'New-ADOrganizationalUnit -Name "Administration" -Path "OU=Utilisateurs,OU=Mandeng,DC=mandeng,DC=lan"');
  await run(sh, 'New-ADOrganizationalUnit -Name "Audit" -Path "OU=Utilisateurs,OU=Mandeng,DC=mandeng,DC=lan"');
  await run(sh, 'New-ADUser -Name "Pierre Reseau" -SamAccountName preseau -AccountPassword (ConvertTo-SecureString "User@Mandeng2025!" -AsPlainText -Force) -Enabled $true');
  await run(sh, 'New-ADUser -Name "Jean Admin" -SamAccountName jadmin -AccountPassword (ConvertTo-SecureString "User@Mandeng2025!" -AsPlainText -Force) -Enabled $true');
  return dc;
}

describe('Scénario 8 — délégation de contrôle sur des OUs (mandeng.lan)', () => {
  describe('délégation via PowerShell (manipulation directe des ACL AD)', () => {
    it('preseau reçoit CreateChild/WriteProperty/DeleteChild (User) sur OU=Reseau via Set-ACL', async () => {
      const dc = await buildLan();
      const sh = ps(dc);
      const OUReseau = 'OU=Reseau,OU=Utilisateurs,OU=Mandeng,DC=mandeng,DC=lan';

      const out = await run(sh, [
        '$UserPreseau = Get-ADUser "preseau"',
        '$UserSID = [System.Security.Principal.SecurityIdentifier]$UserPreseau.SID',
        `$ADOU = Get-ADOrganizationalUnit "${OUReseau}"`,
        '$Path = "AD:\\$($ADOU.DistinguishedName)"',
        '$ACL = Get-ACL -Path $Path',
        '$ACE_Create = New-Object System.DirectoryServices.ActiveDirectoryAccessRule($UserSID, "CreateChild", "Allow", [GUID]"bf967aba-0de6-11d0-a285-00aa003049e2", "None", [GUID]::Empty)',
        '$ACL.AddAccessRule($ACE_Create)',
        '$ACE_Write = New-Object System.DirectoryServices.ActiveDirectoryAccessRule($UserSID, "WriteProperty", "Allow", [GUID]::Empty, "Descendents", [GUID]"bf967aba-0de6-11d0-a285-00aa003049e2")',
        '$ACL.AddAccessRule($ACE_Write)',
        '$ACE_Delete = New-Object System.DirectoryServices.ActiveDirectoryAccessRule($UserSID, "DeleteChild", "Allow", [GUID]"bf967aba-0de6-11d0-a285-00aa003049e2", "None", [GUID]::Empty)',
        '$ACL.AddAccessRule($ACE_Delete)',
        'Set-ACL -Path $Path -AclObject $ACL',
      ].join('\n'));
      expect(out).not.toMatch(/not recognized/i);
    });
  });

  describe('délégation de réinitialisation de mot de passe uniquement', () => {
    it('jadmin reçoit le droit étendu Reset Password (ExtendedRight) sur OU=Audit via Set-ACL', async () => {
      const dc = await buildLan();
      const sh = ps(dc);
      const OUAudit = 'OU=Audit,OU=Utilisateurs,OU=Mandeng,DC=mandeng,DC=lan';

      const out = await run(sh, [
        '$UserJadmin = Get-ADUser "jadmin"',
        '$JadminSID = [System.Security.Principal.SecurityIdentifier]$UserJadmin.SID',
        `$ADOU_Audit = Get-ADOrganizationalUnit "${OUAudit}"`,
        '$PathAudit = "AD:\\$($ADOU_Audit.DistinguishedName)"',
        '$ACL_Audit = Get-ACL -Path $PathAudit',
        '$ACE_ResetPwd = New-Object System.DirectoryServices.ActiveDirectoryAccessRule($JadminSID, "ExtendedRight", "Allow", [GUID]"00299570-246d-11d0-a768-00aa006e0529", "Descendents", [GUID]"bf967aba-0de6-11d0-a285-00aa003049e2")',
        '$ACL_Audit.AddAccessRule($ACE_ResetPwd)',
        'Set-ACL -Path $PathAudit -AclObject $ACL_Audit',
      ].join('\n'));
      expect(out).not.toMatch(/not recognized/i);
    });
  });

  describe('vérification des permissions déléguées', () => {
    it('Get-ACL sur OU=Reseau montre l\'ACE ajoutée avec IdentityReference=preseau', async () => {
      const dc = await buildLan();
      const sh = ps(dc);
      const OUReseau = 'OU=Reseau,OU=Utilisateurs,OU=Mandeng,DC=mandeng,DC=lan';
      await run(sh, [
        '$UserPreseau = Get-ADUser "preseau"',
        '$UserSID = [System.Security.Principal.SecurityIdentifier]$UserPreseau.SID',
        `$ADOU = Get-ADOrganizationalUnit "${OUReseau}"`,
        '$Path = "AD:\\$($ADOU.DistinguishedName)"',
        '$ACL = Get-ACL -Path $Path',
        '$ACE_Create = New-Object System.DirectoryServices.ActiveDirectoryAccessRule($UserSID, "CreateChild", "Allow", [GUID]"bf967aba-0de6-11d0-a285-00aa003049e2", "None", [GUID]::Empty)',
        '$ACL.AddAccessRule($ACE_Create)',
        'Set-ACL -Path $Path -AclObject $ACL',
      ].join('\n'));

      const out = await run(sh, `(Get-ACL -Path "AD:\\${OUReseau}").Access | Where-Object {$_.IdentityReference -like "*preseau*"} | Select-Object IdentityReference, ActiveDirectoryRights, AccessControlType, InheritanceType | Format-List`);
      expect(out).toContain('preseau');
    });

    it('preseau peut créer un utilisateur dans OU=Reseau (périmètre délégué)', async () => {
      const dc = await buildLan();
      const sh = ps(dc);
      const OUReseau = 'OU=Reseau,OU=Utilisateurs,OU=Mandeng,DC=mandeng,DC=lan';
      await run(sh, [
        '$UserPreseau = Get-ADUser "preseau"',
        '$UserSID = [System.Security.Principal.SecurityIdentifier]$UserPreseau.SID',
        `$ADOU = Get-ADOrganizationalUnit "${OUReseau}"`,
        '$Path = "AD:\\$($ADOU.DistinguishedName)"',
        '$ACL = Get-ACL -Path $Path',
        '$ACE_Create = New-Object System.DirectoryServices.ActiveDirectoryAccessRule($UserSID, "CreateChild", "Allow", [GUID]"bf967aba-0de6-11d0-a285-00aa003049e2", "None", [GUID]::Empty)',
        '$ACL.AddAccessRule($ACE_Create)',
        'Set-ACL -Path $Path -AclObject $ACL',
      ].join('\n'));

      const out = await run(sh, [
        '$Cred = "preseau:User@Mandeng2025!"',
        'New-ADUser -Name "Test Delegation" -SamAccountName "test-deleg" -Path "OU=Reseau,OU=Utilisateurs,OU=Mandeng,DC=mandeng,DC=lan" -Enabled $false -Credential $Cred -Server "DC01.mandeng.lan"',
      ].join('\n'));
      expect(out).not.toMatch(/Access is denied/i);
      const check = await run(sh, 'Get-ADUser "test-deleg"');
      expect(check).toContain('test-deleg');
    });

    it('preseau NE PEUT PAS créer un utilisateur dans OU=Administration (hors périmètre) — "Access is denied"', async () => {
      const dc = await buildLan();
      const sh = ps(dc);
      const out = await run(sh, [
        '$Cred = "preseau:User@Mandeng2025!"',
        'New-ADUser -Name "Test Hors Perimetre" -SamAccountName "test-hors" -Path "OU=Administration,OU=Utilisateurs,OU=Mandeng,DC=mandeng,DC=lan" -Enabled $false -Credential $Cred',
      ].join('\n'));
      expect(out).toMatch(/Access is denied/i);
    });

    it('jadmin peut réinitialiser le mot de passe d\'un utilisateur dans OU=Audit mais ne peut pas changer son displayName', async () => {
      const dc = await buildLan();
      const sh = ps(dc);
      const OUAudit = 'OU=Audit,OU=Utilisateurs,OU=Mandeng,DC=mandeng,DC=lan';
      await run(sh, [
        '$UserJadmin = Get-ADUser "jadmin"',
        '$JadminSID = [System.Security.Principal.SecurityIdentifier]$UserJadmin.SID',
        `$ADOU_Audit = Get-ADOrganizationalUnit "${OUAudit}"`,
        '$PathAudit = "AD:\\$($ADOU_Audit.DistinguishedName)"',
        '$ACL_Audit = Get-ACL -Path $PathAudit',
        '$ACE_ResetPwd = New-Object System.DirectoryServices.ActiveDirectoryAccessRule($JadminSID, "ExtendedRight", "Allow", [GUID]"00299570-246d-11d0-a768-00aa006e0529", "Descendents", [GUID]"bf967aba-0de6-11d0-a285-00aa003049e2")',
        '$ACL_Audit.AddAccessRule($ACE_ResetPwd)',
        'Set-ACL -Path $PathAudit -AclObject $ACL_Audit',
      ].join('\n'));
      await run(sh, 'New-ADUser -Name "Marie Audit" -SamAccountName maudit -Path "OU=Audit,OU=Utilisateurs,OU=Mandeng,DC=mandeng,DC=lan" -AccountPassword (ConvertTo-SecureString "x" -AsPlainText -Force) -Enabled $true');

      const resetOut = await run(sh, [
        '$Cred = "jadmin:User@Mandeng2025!"',
        'Set-ADAccountPassword -Identity "maudit" -Reset -NewPassword (ConvertTo-SecureString "NewPass2025!" -AsPlainText -Force) -Credential $Cred',
      ].join('\n'));
      expect(resetOut).not.toMatch(/Access is denied/i);

      const renameOut = await run(sh, [
        '$Cred = "jadmin:User@Mandeng2025!"',
        'Set-ADUser -Identity "maudit" -DisplayName "Hacked Name" -Credential $Cred',
      ].join('\n'));
      expect(renameOut).toMatch(/Access is denied/i);
    });
  });
});
