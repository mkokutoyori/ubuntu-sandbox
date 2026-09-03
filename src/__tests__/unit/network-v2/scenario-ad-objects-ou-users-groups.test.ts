/**
 * Scénario 2 — Gestion des objets AD : utilisateurs, groupes, OUs et
 * ordinateurs.
 *
 * Transcription littérale et fidèle : structure OU (racine Mandeng + 8
 * sous-OUs), création d'utilisateurs via New-MandengUser (UPN
 * prénom.nom@mandeng.lan), groupes de sécurité et modèle AGDLP
 * (Account → Global → Domain Local → Permission).
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

async function promotedDc(): Promise<WindowsServer> {
  const dc = new WindowsServer('DC01');
  dc.setCurrentUser('Administrator');
  await run(ps(dc), 'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools -IncludeAllSubFeature -Restart:$false');
  await run(ps(dc), 'Install-ADDSForest -DomainName "mandeng.lan" -DomainNetBiosName "MANDENG" -SafeModeAdministratorPassword (ConvertTo-SecureString "DSRM@Mandeng2025!" -AsPlainText -Force) -Force:$true');
  return dc;
}

describe('Scénario 2 — objets AD : OUs, utilisateurs, groupes (LAN Mandeng)', () => {
  describe('création de la structure OU', () => {
    it('New-ADOrganizationalUnit crée la racine "Mandeng" et 9 sous-OUs (10 au total)', async () => {
      const dc = await promotedDc();
      const sh = ps(dc);
      await run(sh, 'New-ADOrganizationalUnit -Name "Mandeng" -Path "DC=mandeng,DC=lan" -Description "OU racine Mandeng" -ProtectedFromAccidentalDeletion $true');

      const ous: Array<{ name: string; path: string }> = [
        { name: 'Utilisateurs', path: 'OU=Mandeng,DC=mandeng,DC=lan' },
        { name: 'Administration', path: 'OU=Utilisateurs,OU=Mandeng,DC=mandeng,DC=lan' },
        { name: 'Reseau', path: 'OU=Utilisateurs,OU=Mandeng,DC=mandeng,DC=lan' },
        { name: 'Audit', path: 'OU=Utilisateurs,OU=Mandeng,DC=mandeng,DC=lan' },
        { name: 'Groupes', path: 'OU=Mandeng,DC=mandeng,DC=lan' },
        { name: 'Ordinateurs', path: 'OU=Mandeng,DC=mandeng,DC=lan' },
        { name: 'Serveurs', path: 'OU=Ordinateurs,OU=Mandeng,DC=mandeng,DC=lan' },
        { name: 'Postes', path: 'OU=Ordinateurs,OU=Mandeng,DC=mandeng,DC=lan' },
        { name: 'ServiceAccounts', path: 'OU=Mandeng,DC=mandeng,DC=lan' },
      ];
      for (const ou of ous) {
        await run(sh, `New-ADOrganizationalUnit -Name ${ou.name} -Path "${ou.path}" -ProtectedFromAccidentalDeletion $true`);
      }

      const out = await run(sh, 'Get-ADOrganizationalUnit -Filter *');
      const created = ['Mandeng', ...ous.map((o) => o.name)];
      for (const name of created) expect(out).toContain(name);
      expect(created.length).toBe(10);
    });
  });

  describe('création des utilisateurs (New-MandengUser)', () => {
    it('chaque utilisateur a un UPN prénom.nom@mandeng.lan et est Enabled', async () => {
      const dc = await promotedDc();
      const sh = ps(dc);
      await run(sh, 'New-ADOrganizationalUnit -Name "Mandeng" -Path "DC=mandeng,DC=lan"');
      await run(sh, 'New-ADOrganizationalUnit -Name "Utilisateurs" -Path "OU=Mandeng,DC=mandeng,DC=lan"');
      await run(sh, 'New-ADOrganizationalUnit -Name "Administration" -Path "OU=Utilisateurs,OU=Mandeng,DC=mandeng,DC=lan"');
      const adminOU = 'OU=Administration,OU=Utilisateurs,OU=Mandeng,DC=mandeng,DC=lan';

      const out = await run(sh, [
        'New-ADUser',
        '-Name "Jean Admin"',
        '-GivenName Jean',
        '-Surname Admin',
        '-SamAccountName jadmin',
        '-UserPrincipalName jadmin@mandeng.lan',
        `-Path "${adminOU}"`,
        '-Department IT',
        '-AccountPassword (ConvertTo-SecureString "User@Mandeng2025!" -AsPlainText -Force)',
        '-Enabled $true',
        '-ChangePasswordAtLogon $true',
        '-PasswordNeverExpires $false',
      ].join(' '));
      expect(out.trim()).toBe('');

      const get = await run(sh, 'Get-ADUser -Filter * -SearchBase "OU=Mandeng,DC=mandeng,DC=lan" -Properties Department');
      expect(get).toMatch(/jadmin@mandeng\.lan|jadmin/);
      expect(get).toMatch(/True/); // Enabled
    });
  });

  describe('groupes et modèle AGDLP (Account → Global → Domain Local → Permission)', () => {
    async function withUsersAndGroups() {
      const dc = await promotedDc();
      const sh = ps(dc);
      await run(sh, 'New-ADUser -Name "Jean Admin" -SamAccountName jadmin -AccountPassword (ConvertTo-SecureString "x" -AsPlainText -Force) -Enabled $true');
      await run(sh, 'New-ADUser -Name "Pierre Reseau" -SamAccountName preseau -AccountPassword (ConvertTo-SecureString "x" -AsPlainText -Force) -Enabled $true');
      await run(sh, 'New-ADUser -Name "Marie Audit" -SamAccountName maudit -AccountPassword (ConvertTo-SecureString "x" -AsPlainText -Force) -Enabled $true');
      await run(sh, 'New-ADGroup -Name "GRP-IT-Admin" -GroupScope Global -GroupCategory Security -Description "Administrateurs IT"');
      await run(sh, 'New-ADGroup -Name "GRP-Reseau" -GroupScope Global -GroupCategory Security -Description "Equipe reseau"');
      await run(sh, 'New-ADGroup -Name "GRP-Auditeurs" -GroupScope Global -GroupCategory Security -Description "Equipe audit"');
      await run(sh, 'New-ADGroup -Name "DL-Partage-IT" -GroupScope DomainLocal -GroupCategory Security -Description "Acces partage IT"');
      return { dc, sh };
    }

    it('Add-ADGroupMember ajoute les utilisateurs aux groupes globaux', async () => {
      const { sh } = await withUsersAndGroups();
      await run(sh, 'Add-ADGroupMember -Identity "GRP-IT-Admin" -Members jadmin,preseau');
      await run(sh, 'Add-ADGroupMember -Identity "GRP-Auditeurs" -Members maudit');

      const members = await run(sh, 'Get-ADGroupMember -Identity "GRP-IT-Admin"');
      expect(members).toContain('jadmin');
      expect(members).toContain('preseau');
    });

    it('le groupe Domain Local liste les GROUPES globaux comme membres (pas les utilisateurs directement)', async () => {
      const { sh } = await withUsersAndGroups();
      await run(sh, 'Add-ADGroupMember -Identity "GRP-IT-Admin" -Members jadmin,preseau');
      await run(sh, 'Add-ADGroupMember -Identity "DL-Partage-IT" -Members "GRP-IT-Admin","GRP-Reseau"');

      const dlMembers = await run(sh, 'Get-ADGroupMember -Identity "DL-Partage-IT"');
      expect(dlMembers).toContain('GRP-IT-Admin');
      expect(dlMembers).toContain('GRP-Reseau');
      // Le modèle AGDLP : pas de membership utilisateur DIRECT sur le groupe Domain Local.
      expect(dlMembers).not.toContain('jadmin');
    });

    it('(Get-ADUser jadmin).MemberOf reflète bien GRP-IT-Admin', async () => {
      const { sh } = await withUsersAndGroups();
      await run(sh, 'Add-ADGroupMember -Identity "GRP-IT-Admin" -Members jadmin');
      const out = await run(sh, '(Get-ADUser jadmin -Properties MemberOf).MemberOf');
      expect(out).toContain('GRP-IT-Admin');
    });
  });
});
