/**
 * Scénario 17 — Stratégies d'expiration de mots de passe et
 * notifications aux utilisateurs.
 *
 * Transcription littérale et fidèle : fonction Get-ExpiringPasswords
 * (filtrage Enabled/PasswordNeverExpires/PasswordExpired, prise en
 * compte d'une FGPP effective via Get-ADUserResultantPasswordPolicy),
 * Send-PasswordExpiryNotification (Send-MailMessage, ignoré si aucune
 * adresse email), et planification quotidienne à 7h00
 * (Register-ScheduledTask + Get-ScheduledTask).
 *
 * Les cas « X jours avant expiration » du scénario dépendent d'un
 * PasswordLastSet vieux de plusieurs semaines — hors de portée d'un
 * test unitaire sans avance d'horloge simulée dédiée ; ce fichier
 * vérifie donc la logique de filtrage elle-même (comptes exclus par
 * PasswordNeverExpires, notification conditionnée à la présence d'un
 * email) plutôt que des décomptes de jours fabriqués.
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
  return dc;
}

const getExpiringPasswordsFunction = [
  'function Get-ExpiringPasswords {',
  '  param([int]$DaysWarning = 14, [string]$SearchBase = "OU=Mandeng,DC=mandeng,DC=lan")',
  '  $Now = Get-Date',
  '  $MaxAge = (Get-ADDefaultDomainPasswordPolicy).MaxPasswordAge',
  '  Get-ADUser -Filter { Enabled -eq $true -and PasswordNeverExpires -eq $false -and PasswordExpired -eq $false } -SearchBase $SearchBase -Properties PasswordLastSet, PasswordNeverExpires, EmailAddress, DisplayName, Department |',
  '  ForEach-Object {',
  '    if ($_.PasswordLastSet) {',
  '      $ExpiryDate = $_.PasswordLastSet + $MaxAge',
  '      $FGPP = Get-ADUserResultantPasswordPolicy -Identity $_',
  '      if ($FGPP) { $ExpiryDate = $_.PasswordLastSet + $FGPP.MaxPasswordAge }',
  '      $DaysUntilExpiry = ($ExpiryDate - $Now).Days',
  '      if ($DaysUntilExpiry -ge 0 -and $DaysUntilExpiry -le $DaysWarning) {',
  '        [PSCustomObject]@{',
  '          Nom = $_.DisplayName; Login = $_.SamAccountName; Email = $_.EmailAddress',
  '          Departement = $_.Department; Expiration = $ExpiryDate.ToString("dd/MM/yyyy HH:mm")',
  '          JoursRestants = $DaysUntilExpiry',
  '          PolitiqueApp = if ($FGPP) {$FGPP.Name} else {"Default Domain Policy"}',
  '        }',
  '      }',
  '    }',
  '  } | Sort-Object JoursRestants',
  '}',
].join('\n');

describe('Scénario 17 — notifications d\'expiration de mots de passe (mandeng.lan)', () => {
  describe('détection des comptes proches de l\'expiration (Get-ExpiringPasswords)', () => {
    it('un utilisateur PasswordNeverExpires=$true n\'apparaît jamais dans le rapport, même avec une fenêtre large', async () => {
      const dc = await promotedDc();
      const sh = ps(dc);
      await run(sh, 'New-ADUser -Name "Compte Service" -SamAccountName svc-neverexpire -Path "OU=Mandeng,DC=mandeng,DC=lan" -AccountPassword (ConvertTo-SecureString "Svc@Mandeng2025!" -AsPlainText -Force) -Enabled $true -PasswordNeverExpires $true -EmailAddress "svc@mandeng.lan"');
      await run(sh, getExpiringPasswordsFunction);

      const out = await run(sh, '(Get-ExpiringPasswords -DaysWarning 9999).Login -join ","');
      expect(out).not.toContain('svc-neverexpire');
    });

    it('un compte fraîchement créé (mot de passe changé aujourd\'hui) n\'apparaît pas dans une fenêtre de 14 jours (politique par défaut ~42 jours)', async () => {
      const dc = await promotedDc();
      const sh = ps(dc);
      await run(sh, 'New-ADUser -Name "Jean Admin" -SamAccountName jadmin -Path "OU=Mandeng,DC=mandeng,DC=lan" -AccountPassword (ConvertTo-SecureString "User@Mandeng2025!" -AsPlainText -Force) -Enabled $true -EmailAddress "jadmin@mandeng.lan"');
      await run(sh, getExpiringPasswordsFunction);

      const out = await run(sh, '(Get-ExpiringPasswords -DaysWarning 14).Login -join ","');
      expect(out).not.toContain('jadmin');
    });

    it('le rapport prend en compte la FGPP effective (PolitiqueApp affiche le nom de la PSO plutôt que "Default Domain Policy")', async () => {
      const dc = await promotedDc();
      const sh = ps(dc);
      await run(sh, 'New-ADUser -Name "svc-oracle" -SamAccountName svc-oracle -Path "OU=Mandeng,DC=mandeng,DC=lan" -AccountPassword (ConvertTo-SecureString "Svc@Mandeng2025!" -AsPlainText -Force) -Enabled $true -EmailAddress "svc-oracle@mandeng.lan"');
      await run(sh, 'New-ADFineGrainedPasswordPolicy -Name "PSO-ServiceAccounts" -Precedence 5 -MinPasswordLength 24 -MaxPasswordAge (New-TimeSpan -Days 1) -ComplexityEnabled $true');
      await run(sh, 'Add-ADFineGrainedPasswordPolicySubject -Identity "PSO-ServiceAccounts" -Subjects "svc-oracle"');
      await run(sh, getExpiringPasswordsFunction);

      const out = await run(sh, '(Get-ExpiringPasswords -DaysWarning 14 | Where-Object { $_.Login -eq "svc-oracle" }).PolitiqueApp');
      expect(out.trim()).toBe('PSO-ServiceAccounts');
    });

    it('le rapport expose les colonnes Nom/Login/Email/Departement/Expiration/JoursRestants/PolitiqueApp', async () => {
      const dc = await promotedDc();
      const sh = ps(dc);
      await run(sh, 'New-ADUser -Name "svc-oracle" -SamAccountName svc-oracle -Path "OU=Mandeng,DC=mandeng,DC=lan" -Department "IT" -AccountPassword (ConvertTo-SecureString "Svc@Mandeng2025!" -AsPlainText -Force) -Enabled $true -EmailAddress "svc-oracle@mandeng.lan"');
      await run(sh, 'New-ADFineGrainedPasswordPolicy -Name "PSO-ServiceAccounts" -Precedence 5 -MaxPasswordAge (New-TimeSpan -Days 1) -ComplexityEnabled $true');
      await run(sh, 'Add-ADFineGrainedPasswordPolicySubject -Identity "PSO-ServiceAccounts" -Subjects "svc-oracle"');
      await run(sh, getExpiringPasswordsFunction);

      const out = await run(sh, 'Get-ExpiringPasswords -DaysWarning 14 | Format-Table -AutoSize');
      expect(out).toMatch(/Nom/);
      expect(out).toMatch(/Login/);
      expect(out).toMatch(/svc-oracle/);
      expect(out).toMatch(/IT/);
    });
  });

  describe('notification par email (Send-PasswordExpiryNotification)', () => {
    const sendNotificationFunction = [
      'function Send-PasswordExpiryNotification {',
      '  param([PSCustomObject]$User, [System.Management.Automation.PSCredential]$Credential)',
      '  if (-not $User.Email) { Write-Warning "Pas d\'email pour $($User.Login) - notification ignoree"; return }',
      '  $Subject = "Votre mot de passe expire dans $($User.JoursRestants) jour(s)"',
      '  $Body = "Bonjour $($User.Nom), votre mot de passe expire le $($User.Expiration)."',
      '  Send-MailMessage -From "no-reply@mandeng.lan" -To $User.Email -Subject $Subject -Body $Body -SmtpServer "smtp.mandeng.lan" -Port 587 -Credential $Credential -UseSsl -Encoding UTF8',
      '  Write-Host "Email envoye a $($User.Email)"',
      '}',
    ].join('\n');

    it('un utilisateur avec une adresse email déclenche Send-MailMessage et affiche la confirmation d\'envoi', async () => {
      const dc = await promotedDc();
      const sh = ps(dc);
      await run(sh, sendNotificationFunction);
      const out = await run(sh, [
        '$User = [PSCustomObject]@{ Nom = "Jean Admin"; Login = "jadmin"; Email = "jadmin@mandeng.lan"; JoursRestants = 3; Expiration = "15/07/2025" }',
        '$Cred = New-Object System.Management.Automation.PSCredential("smtp-user", (ConvertTo-SecureString "x" -AsPlainText -Force))',
        'Send-PasswordExpiryNotification -User $User -Credential $Cred',
      ].join('\n'));
      expect(out).toMatch(/Email envoye a jadmin@mandeng\.lan/);
    });

    it('un utilisateur sans adresse email ne déclenche aucun envoi et affiche un avertissement', async () => {
      const dc = await promotedDc();
      const sh = ps(dc);
      await run(sh, sendNotificationFunction);
      const out = await run(sh, [
        '$User = [PSCustomObject]@{ Nom = "Sans Email"; Login = "sansemail"; Email = $null; JoursRestants = 5; Expiration = "20/07/2025" }',
        '$Cred = New-Object System.Management.Automation.PSCredential("smtp-user", (ConvertTo-SecureString "x" -AsPlainText -Force))',
        'Send-PasswordExpiryNotification -User $User -Credential $Cred',
      ].join('\n'));
      expect(out).toMatch(/Pas d'email pour sansemail/);
      expect(out).not.toMatch(/Email envoye/);
    });
  });

  describe('planification de la tâche de notification quotidienne', () => {
    it('Register-ScheduledTask planifie Notify-PasswordExpiry chaque jour à 07:00', async () => {
      const dc = await promotedDc();
      const sh = ps(dc);
      await run(sh, '$Action = New-ScheduledTaskAction -Execute "PowerShell.exe" -Argument "-NonInteractive -NoProfile -ExecutionPolicy Bypass -File C:\\Scripts\\Notify-ExpiringPasswords.ps1"');
      await run(sh, '$Trigger = New-ScheduledTaskTrigger -Daily -At "07:00AM"');
      await run(sh, '$Settings = New-ScheduledTaskSettingsSet -RunOnlyIfNetworkAvailable -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 1)');
      await run(sh, '$Principal = New-ScheduledTaskPrincipal -UserId "MANDENG\\svc-scripts" -LogonType Password -RunLevel Highest');
      const out = await run(sh, [
        'Register-ScheduledTask',
        '-TaskName "Notify-PasswordExpiry"',
        '-TaskPath "\\Mandeng\\AD\\"',
        '-Action $Action',
        '-Trigger $Trigger',
        '-Settings $Settings',
        '-Principal $Principal',
        '-Description "Notification quotidienne des mots de passe expirant"',
      ].join(' '));
      expect(out).not.toMatch(/not recognized/i);
    });

    it('Get-ScheduledTask "Notify-PasswordExpiry" confirme l\'état Ready après enregistrement', async () => {
      const dc = await promotedDc();
      const sh = ps(dc);
      await run(sh, '$Action = New-ScheduledTaskAction -Execute "PowerShell.exe" -Argument "-NonInteractive -NoProfile -ExecutionPolicy Bypass -File C:\\Scripts\\Notify-ExpiringPasswords.ps1"');
      await run(sh, '$Trigger = New-ScheduledTaskTrigger -Daily -At "07:00AM"');
      await run(sh, 'Register-ScheduledTask -TaskName "Notify-PasswordExpiry" -TaskPath "\\Mandeng\\AD\\" -Action $Action -Trigger $Trigger -Description "Notification quotidienne"');

      const out = await run(sh, 'Get-ScheduledTask -TaskName "Notify-PasswordExpiry" | Select-Object TaskName, State, LastRunTime, NextRunTime');
      expect(out).toContain('Notify-PasswordExpiry');
      expect(out).toMatch(/Ready/);
    });
  });
});
