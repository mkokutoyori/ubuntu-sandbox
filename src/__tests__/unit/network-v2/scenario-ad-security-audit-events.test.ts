/**
 * Scénario 9 — Audit des événements de sécurité AD : connexions,
 * modifications et accès.
 *
 * Transcription littérale et fidèle : activation de l'audit via
 * auditpol (Credential Validation, Kerberos Authentication Service,
 * User/Computer/Security Group Account Management, Directory Service
 * Changes, Logon), génération d'événements 4720/4722/4725/4726/4728/4738
 * lors d'opérations de cycle de vie de compte/groupe, collecte via
 * Get-WinEvent -FilterHashtable, et rapport d'audit corrélé
 * (Get-ADSecurityReport).
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
  await run(ps(dc), 'New-ADGroup -Name "GRP-IT-Admin" -GroupScope Global -GroupCategory Security');
  return dc;
}

describe('Scénario 9 — audit des événements de sécurité AD (mandeng.lan)', () => {
  describe('activation de l\'audit via GPO (auditpol)', () => {
    it('auditpol /set active les 7 sous-catégories requises pour l\'audit AD', async () => {
      const dc = await promotedDc();
      const subcats = [
        'Credential Validation',
        'Kerberos Authentication Service',
        'User Account Management',
        'Computer Account Management',
        'Security Group Management',
        'Directory Service Changes',
        'Logon',
      ];
      for (const subcat of subcats) {
        const out = await dc.executeCmdCommand(`auditpol /set /subcategory:"${subcat}" /success:enable /failure:enable`);
        expect(out).toMatch(/successfully executed/i);
      }
    });

    it('auditpol /get /category:* affiche la politique d\'audit système avec Kerberos Authentication et Credential Validation', async () => {
      const dc = await promotedDc();
      await dc.executeCmdCommand('auditpol /set /subcategory:"Kerberos Authentication Service" /success:enable /failure:enable');
      await dc.executeCmdCommand('auditpol /set /subcategory:"Credential Validation" /success:enable /failure:enable');

      const out = await dc.executeCmdCommand('auditpol /get /category:*');
      expect(out).toContain('Kerberos Authentication Service');
      expect(out).toContain('Credential Validation');
    });
  });

  describe('génération et collecte des événements AD', () => {
    it('New-ADUser génère EventID 4720 (compte créé)', async () => {
      const dc = await promotedDc();
      const sh = ps(dc);
      await run(sh, 'New-ADUser -Name "Audit Test" -SamAccountName "audittest" -Path "OU=Utilisateurs,OU=Mandeng,DC=mandeng,DC=lan" -Enabled $true -AccountPassword (ConvertTo-SecureString "Test@2025!" -AsPlainText -Force)');

      const out = await run(sh, "Get-WinEvent -FilterHashtable @{ LogName = 'Security'; Id = 4720; StartTime = (Get-Date).AddMinutes(-10) }");
      expect(out).toContain('4720');
      expect(out).toMatch(/audittest/);
    });

    it('Set-ADUser -Department -Title génère EventID 4738 (compte modifié)', async () => {
      const dc = await promotedDc();
      const sh = ps(dc);
      await run(sh, 'New-ADUser -Name "Audit Test" -SamAccountName "audittest" -Path "OU=Utilisateurs,OU=Mandeng,DC=mandeng,DC=lan" -Enabled $true -AccountPassword (ConvertTo-SecureString "Test@2025!" -AsPlainText -Force)');
      await run(sh, 'Set-ADUser "audittest" -Department "Finance" -Title "Analyste"');

      const out = await run(sh, "Get-WinEvent -FilterHashtable @{ LogName = 'Security'; Id = 4738; StartTime = (Get-Date).AddMinutes(-10) }");
      expect(out).toContain('4738');
    });

    it('Add-ADGroupMember vers un groupe de sécurité global génère EventID 4728', async () => {
      const dc = await promotedDc();
      const sh = ps(dc);
      await run(sh, 'New-ADUser -Name "Audit Test" -SamAccountName "audittest" -Path "OU=Utilisateurs,OU=Mandeng,DC=mandeng,DC=lan" -Enabled $true -AccountPassword (ConvertTo-SecureString "Test@2025!" -AsPlainText -Force)');
      await run(sh, 'Add-ADGroupMember -Identity "GRP-IT-Admin" -Members "audittest"');

      const out = await run(sh, "Get-WinEvent -FilterHashtable @{ LogName = 'Security'; Id = 4728; StartTime = (Get-Date).AddMinutes(-10) }");
      expect(out).toContain('4728');
    });

    it('Disable-ADAccount génère EventID 4725 (compte désactivé)', async () => {
      const dc = await promotedDc();
      const sh = ps(dc);
      await run(sh, 'New-ADUser -Name "Audit Test" -SamAccountName "audittest" -Path "OU=Utilisateurs,OU=Mandeng,DC=mandeng,DC=lan" -Enabled $true -AccountPassword (ConvertTo-SecureString "Test@2025!" -AsPlainText -Force)');
      await run(sh, 'Disable-ADAccount "audittest"');

      const out = await run(sh, "Get-WinEvent -FilterHashtable @{ LogName = 'Security'; Id = 4725; StartTime = (Get-Date).AddMinutes(-10) }");
      expect(out).toContain('4725');
    });

    it('Remove-ADUser génère EventID 4726 (compte supprimé)', async () => {
      const dc = await promotedDc();
      const sh = ps(dc);
      await run(sh, 'New-ADUser -Name "Audit Test" -SamAccountName "audittest" -Path "OU=Utilisateurs,OU=Mandeng,DC=mandeng,DC=lan" -Enabled $true -AccountPassword (ConvertTo-SecureString "Test@2025!" -AsPlainText -Force)');
      await run(sh, 'Remove-ADUser "audittest" -Confirm:$false');

      const out = await run(sh, "Get-WinEvent -FilterHashtable @{ LogName = 'Security'; Id = 4726; StartTime = (Get-Date).AddMinutes(-10) }");
      expect(out).toContain('4726');
    });

    it('la collecte corrélée liste chaque action AD avec sa Cible et son EffectuéPar (SubjectUserName/TargetUserName)', async () => {
      const dc = await promotedDc();
      const sh = ps(dc);
      await run(sh, 'New-ADUser -Name "Audit Test" -SamAccountName "audittest" -Path "OU=Utilisateurs,OU=Mandeng,DC=mandeng,DC=lan" -Enabled $true -AccountPassword (ConvertTo-SecureString "Test@2025!" -AsPlainText -Force)');
      await run(sh, 'Set-ADUser "audittest" -Department "Finance" -Title "Analyste"');
      await run(sh, 'Add-ADGroupMember -Identity "GRP-IT-Admin" -Members "audittest"');
      await run(sh, 'Remove-ADUser "audittest" -Confirm:$false');

      const out = await run(sh, [
        '$StartTime = (Get-Date).AddMinutes(-10)',
        '$AuditEvents = Get-WinEvent -FilterHashtable @{ LogName = \'Security\'; Id = @(4720, 4722, 4725, 4726, 4728, 4738); StartTime = $StartTime } | ForEach-Object {',
        '  $xml = [xml]$_.ToXml()',
        '  [PSCustomObject]@{',
        '    Heure = $_.TimeCreated',
        '    EventID = $_.Id',
        '    Cible = $xml.Event.EventData.Data | Where-Object {$_.Name -eq \'TargetUserName\'} | Select-Object -ExpandProperty \'#text\'',
        '    EffectuePar = $xml.Event.EventData.Data | Where-Object {$_.Name -eq \'SubjectUserName\'} | Select-Object -ExpandProperty \'#text\'',
        '  }',
        '}',
        '$AuditEvents | Format-Table -AutoSize',
      ].join('\n'));
      expect(out).toContain('4720');
      expect(out).toContain('4726');
      expect(out).toMatch(/audittest/);
    });
  });

  describe('rapport d\'audit corrélé (Get-ADSecurityReport)', () => {
    it('le rapport liste les sections CONNEXIONS ÉCHOUÉES, MODIFICATIONS DE COMPTES et GROUPES À PRIVILÈGES', async () => {
      const dc = await promotedDc();
      const sh = ps(dc);
      const out = await run(sh, [
        'function Get-ADSecurityReport {',
        '  param([int]$HeuresPassees = 24)',
        '  $StartTime = (Get-Date).AddHours(-$HeuresPassees)',
        '  Write-Host "RAPPORT D\'AUDIT AD"',
        '  Write-Host "-- 1. CONNEXIONS ECHOUEES --"',
        '  $FailedLogins = Get-WinEvent -FilterHashtable @{ LogName = \'Security\'; Id = @(4625, 4771); StartTime = $StartTime } -ErrorAction SilentlyContinue',
        '  $FailedLogins | Group-Object { $xml = [xml]$_.ToXml(); $xml.Event.EventData.Data | Where-Object {$_.Name -eq \'TargetUserName\'} | Select-Object -ExpandProperty \'#text\' } | Sort-Object Count -Descending | Select-Object -First 10 | ForEach-Object { Write-Host "  $($_.Name): $($_.Count) echec(s)" }',
        '  Write-Host "-- 2. MODIFICATIONS DE COMPTES --"',
        '  Get-WinEvent -FilterHashtable @{ LogName = \'Security\'; Id = @(4720, 4726, 4738); StartTime = $StartTime } -ErrorAction SilentlyContinue | Select-Object TimeCreated, Id | Format-Table -AutoSize',
        '  Write-Host "-- 3. GROUPES A PRIVILEGES --"',
        '  Get-WinEvent -FilterHashtable @{ LogName = \'Security\'; Id = @(4728, 4732, 4756); StartTime = $StartTime } -ErrorAction SilentlyContinue | ForEach-Object {',
        '    $xml = [xml]$_.ToXml()',
        '    $group = $xml.Event.EventData.Data | Where-Object {$_.Name -eq \'TargetUserName\'} | Select-Object -ExpandProperty \'#text\'',
        '    $member = $xml.Event.EventData.Data | Where-Object {$_.Name -eq \'MemberName\'} | Select-Object -ExpandProperty \'#text\'',
        '    Write-Host "  $($_.TimeCreated): Ajout de $member dans $group"',
        '  }',
        '}',
        'Get-ADSecurityReport -HeuresPassees 24',
      ].join('\n'));
      expect(out).toContain('CONNEXIONS ECHOUEES');
      expect(out).toContain('MODIFICATIONS DE COMPTES');
      expect(out).toContain('GROUPES A PRIVILEGES');
    });
  });
});
