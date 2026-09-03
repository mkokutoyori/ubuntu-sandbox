/**
 * Scénario 15 — Corbeille AD : activation et restauration d'objets
 * supprimés.
 *
 * Transcription littérale et fidèle : activation irréversible de la
 * corbeille (Enable-ADOptionalFeature "Recycle Bin Feature" -Scope
 * ForestOrConfigurationSet), configuration de la rétention
 * (msDS-DeletedObjectLifetime), suppression d'un utilisateur et d'un
 * groupe de test, recherche dans la corbeille
 * (Get-ADObject -IncludeDeletedObjects), et restauration
 * (Restore-ADObject) avec vérification de l'intégrité des attributs
 * (Department, Title, EmailAddress) et du membership de groupe restauré.
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
  await run(ps(dc), 'New-ADOrganizationalUnit -Name "Mandeng" -Path "DC=mandeng,DC=lan"');
  await run(ps(dc), 'New-ADOrganizationalUnit -Name "Utilisateurs" -Path "OU=Mandeng,DC=mandeng,DC=lan"');
  await run(ps(dc), 'New-ADOrganizationalUnit -Name "Groupes" -Path "OU=Mandeng,DC=mandeng,DC=lan"');
  return dc;
}

describe('Scénario 15 — corbeille AD : activation et restauration (mandeng.lan)', () => {
  describe('activation de la corbeille AD', () => {
    it('Get-ADOptionalFeature "Recycle Bin Feature" a un EnabledScopes vide avant activation', async () => {
      const dc = await promotedDc();
      const out = await run(ps(dc), 'Get-ADOptionalFeature -Filter {Name -eq "Recycle Bin Feature"} | Select-Object Name, EnabledScopes');
      expect(out).toContain('Recycle Bin Feature');
      expect(out).not.toMatch(/CN=Partitions/);
    });

    it('Enable-ADOptionalFeature -Scope ForestOrConfigurationSet active la corbeille au niveau de la forêt', async () => {
      const dc = await promotedDc();
      const sh = ps(dc);
      const out = await run(sh, 'Enable-ADOptionalFeature -Identity "Recycle Bin Feature" -Scope ForestOrConfigurationSet -Target "mandeng.lan" -Confirm:$false');
      expect(out).not.toMatch(/not recognized/i);

      const check = await run(sh, 'Get-ADOptionalFeature -Filter {Name -eq "Recycle Bin Feature"} | Select-Object Name, EnabledScopes');
      expect(check).toMatch(/CN=Partitions,CN=Configuration,DC=mandeng,DC=lan/);
    });

    it('Set-ADObject configure msDS-DeletedObjectLifetime à 180 jours sur CN=Directory Service', async () => {
      const dc = await promotedDc();
      const sh = ps(dc);
      await run(sh, 'Enable-ADOptionalFeature -Identity "Recycle Bin Feature" -Scope ForestOrConfigurationSet -Target "mandeng.lan" -Confirm:$false');

      const out = await run(sh, [
        '$ConfigNC = (Get-ADRootDSE).configurationNamingContext',
        '$DeletedObjectsLifetime = 180',
        'Set-ADObject -Identity "CN=Directory Service,CN=Windows NT,CN=Services,$ConfigNC" -Replace @{msDS-DeletedObjectLifetime = $DeletedObjectsLifetime}',
      ].join('\n'));
      expect(out).not.toMatch(/not recognized/i);

      const check = await run(sh, [
        '$ConfigNC = (Get-ADRootDSE).configurationNamingContext',
        'Get-ADObject -Identity "CN=Directory Service,CN=Windows NT,CN=Services,$ConfigNC" -Properties msDS-DeletedObjectLifetime | Select-Object -ExpandProperty msDS-DeletedObjectLifetime',
      ].join('\n'));
      expect(check.trim()).toBe('180');
    });
  });

  describe('suppression puis restauration d\'un utilisateur', () => {
    async function labWithRecycleBinAndDeletedUser(): Promise<{ dc: WindowsServer; sh: ReturnType<typeof ps> }> {
      const dc = await promotedDc();
      const sh = ps(dc);
      await run(sh, 'Enable-ADOptionalFeature -Identity "Recycle Bin Feature" -Scope ForestOrConfigurationSet -Target "mandeng.lan" -Confirm:$false');
      await run(sh, [
        'New-ADUser',
        '-Name "Utilisateur A Supprimer"',
        '-SamAccountName "user-suppr"',
        '-Path "OU=Utilisateurs,OU=Mandeng,DC=mandeng,DC=lan"',
        '-Department "Finance"',
        '-Title "Analyste Senior"',
        '-EmailAddress "user.suppr@mandeng.lan"',
        '-Enabled $true',
        '-AccountPassword (ConvertTo-SecureString "Test@2025!" -AsPlainText -Force)',
      ].join(' '));
      await run(sh, 'Remove-ADUser "user-suppr" -Confirm:$false');
      return { dc, sh };
    }

    it('l\'utilisateur supprimé n\'apparaît plus dans une recherche AD normale', async () => {
      const { sh } = await labWithRecycleBinAndDeletedUser();
      const out = await run(sh, 'Get-ADUser -Filter {SamAccountName -eq "user-suppr"}');
      expect(out.trim()).toBe('');
    });

    it('Get-ADObject -IncludeDeletedObjects retrouve l\'utilisateur supprimé avec Department/EmailAddress intacts', async () => {
      const { sh } = await labWithRecycleBinAndDeletedUser();
      const out = await run(sh, 'Get-ADObject -Filter {SamAccountName -eq "user-suppr"} -IncludeDeletedObjects -Properties * | Select-Object DistinguishedName, Department, EmailAddress, Title');
      expect(out).toContain('CN=Utilisateur A Supprimer,CN=Deleted Objects,DC=mandeng,DC=lan');
      expect(out).toContain('Finance');
      expect(out).toContain('Analyste Senior');
      expect(out).toContain('user.suppr@mandeng.lan');
    });

    it('Get-ADObject -Filter {isDeleted -eq $true} liste les objets supprimés récemment sous CN=Deleted Objects', async () => {
      const { sh } = await labWithRecycleBinAndDeletedUser();
      const out = await run(sh, [
        'Get-ADObject -Filter {isDeleted -eq $true} -IncludeDeletedObjects -SearchBase "CN=Deleted Objects,DC=mandeng,DC=lan" -Properties whenChanged, LastKnownParent, SamAccountName |',
        'Where-Object {$_.whenChanged -gt (Get-Date).AddDays(-7)} |',
        'Select-Object Name, ObjectClass, whenChanged, LastKnownParent | Format-Table -AutoSize',
      ].join('\n'));
      expect(out).toContain('Utilisateur A Supprimer');
      expect(out).toContain('OU=Utilisateurs,OU=Mandeng,DC=mandeng,DC=lan');
    });

    it('Restore-ADObject restaure l\'utilisateur avec Department/Title/EmailAddress préservés', async () => {
      const { sh } = await labWithRecycleBinAndDeletedUser();
      await run(sh, [
        '$DeletedUser = Get-ADObject -Filter {SamAccountName -eq "user-suppr"} -IncludeDeletedObjects',
        'Restore-ADObject -Identity $DeletedUser',
      ].join('\n'));

      const out = await run(sh, 'Get-ADUser "user-suppr" -Properties Department, Title, EmailAddress | Select-Object Name, Department, Title, EmailAddress');
      expect(out).toContain('Finance');
      expect(out).toContain('Analyste Senior');
      expect(out).toContain('user.suppr@mandeng.lan');
    });

    it('après restauration, l\'utilisateur retrouve son DistinguishedName d\'origine sous OU=Utilisateurs', async () => {
      const { sh } = await labWithRecycleBinAndDeletedUser();
      await run(sh, [
        '$DeletedUser = Get-ADObject -Filter {SamAccountName -eq "user-suppr"} -IncludeDeletedObjects',
        'Restore-ADObject -Identity $DeletedUser',
      ].join('\n'));

      const out = await run(sh, 'Get-ADUser "user-suppr" | Select-Object -ExpandProperty DistinguishedName');
      expect(out).toContain('OU=Utilisateurs,OU=Mandeng,DC=mandeng,DC=lan');
    });
  });

  describe('suppression puis restauration d\'un groupe avec son membership', () => {
    async function labWithDeletedGroup(): Promise<{ dc: WindowsServer; sh: ReturnType<typeof ps> }> {
      const dc = await promotedDc();
      const sh = ps(dc);
      await run(sh, 'Enable-ADOptionalFeature -Identity "Recycle Bin Feature" -Scope ForestOrConfigurationSet -Target "mandeng.lan" -Confirm:$false');
      await run(sh, 'New-ADUser -Name "Utilisateur A Supprimer" -SamAccountName "user-suppr" -Path "OU=Utilisateurs,OU=Mandeng,DC=mandeng,DC=lan" -Enabled $true -AccountPassword (ConvertTo-SecureString "Test@2025!" -AsPlainText -Force)');
      await run(sh, 'New-ADGroup -Name "GRP-A-Supprimer" -Path "OU=Groupes,OU=Mandeng,DC=mandeng,DC=lan" -GroupScope Global -Description "Groupe de test a supprimer"');
      await run(sh, 'Add-ADGroupMember -Identity "GRP-A-Supprimer" -Members "user-suppr"');
      await run(sh, 'Remove-ADGroup "GRP-A-Supprimer" -Confirm:$false');
      return { dc, sh };
    }

    it('Restore-ADObject -TargetPath restaure le groupe supprimé dans l\'OU indiquée', async () => {
      const { sh } = await labWithDeletedGroup();
      const out = await run(sh, [
        '$DeletedGroup = Get-ADObject -Filter {Name -eq "GRP-A-Supprimer"} -IncludeDeletedObjects',
        'Restore-ADObject -Identity $DeletedGroup -TargetPath "OU=Groupes,OU=Mandeng,DC=mandeng,DC=lan"',
      ].join('\n'));
      expect(out).not.toMatch(/not recognized/i);

      const check = await run(sh, 'Get-ADGroup "GRP-A-Supprimer" | Select-Object -ExpandProperty DistinguishedName');
      expect(check).toContain('OU=Groupes,OU=Mandeng,DC=mandeng,DC=lan');
    });

    it('après restauration, user-suppr est de nouveau membre de GRP-A-Supprimer (membership restauré automatiquement)', async () => {
      const { sh } = await labWithDeletedGroup();
      await run(sh, [
        '$DeletedGroup = Get-ADObject -Filter {Name -eq "GRP-A-Supprimer"} -IncludeDeletedObjects',
        'Restore-ADObject -Identity $DeletedGroup -TargetPath "OU=Groupes,OU=Mandeng,DC=mandeng,DC=lan"',
      ].join('\n'));

      const out = await run(sh, 'Get-ADGroupMember "GRP-A-Supprimer"');
      expect(out).toContain('user-suppr');
    });
  });
});
