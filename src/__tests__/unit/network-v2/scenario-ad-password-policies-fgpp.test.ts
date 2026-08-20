/**
 * Scénario 6 — Politique de mots de passe du domaine et Fine-Grained
 * Password Policy (FGPP).
 *
 * Transcription littérale et fidèle : Default Domain Policy via
 * Get/Set-ADDefaultDomainPasswordPolicy, création de PSO via
 * New-ADFineGrainedPasswordPolicy + Add-ADFineGrainedPasswordPolicySubject
 * (PSO-Administrateurs Precedence=10, PSO-ServiceAccounts Precedence=5),
 * et résolution de la politique effective par compte via
 * Get-ADUserResultantPasswordPolicy (priorité = Precedence le plus faible).
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

describe('Scénario 6 — politique de mots de passe et FGPP (mandeng.lan)', () => {
  describe('politique de mot de passe du domaine (Default Domain Policy)', () => {
    it('Get-ADDefaultDomainPasswordPolicy retourne les valeurs par défaut du domaine', async () => {
      const dc = await promotedDc();
      const out = await run(ps(dc), 'Get-ADDefaultDomainPasswordPolicy');
      expect(out).toMatch(/ComplexityEnabled\s*:\s*True/);
      expect(out).toMatch(/MinPasswordLength\s*:\s*7/);
      expect(out).toMatch(/LockoutThreshold\s*:\s*5/);
      expect(out).toMatch(/PasswordHistoryCount\s*:\s*24/);
      expect(out).toMatch(/ReversibleEncryptionEnabled\s*:\s*False/);
    });

    it('Set-ADDefaultDomainPasswordPolicy modifie MinPasswordLength à 12 et MaxPasswordAge à 90 jours', async () => {
      const dc = await promotedDc();
      const sh = ps(dc);
      await run(sh, [
        'Set-ADDefaultDomainPasswordPolicy',
        '-Identity "mandeng.lan"',
        '-MinPasswordLength 12',
        '-PasswordHistoryCount 24',
        '-MaxPasswordAge (New-TimeSpan -Days 90)',
        '-MinPasswordAge (New-TimeSpan -Days 1)',
        '-LockoutThreshold 5',
        '-LockoutDuration (New-TimeSpan -Minutes 30)',
        '-LockoutObservationWindow (New-TimeSpan -Minutes 30)',
        '-ComplexityEnabled $true',
      ].join(' '));

      // Select-Object with 4+ properties renders as a table, not a Key : Value list.
      // MaxPasswordAge is a real [TimeSpan] (as in actual AD PowerShell), so it
      // renders via TimeSpan.ToString()'s default "d.hh:mm:ss" format.
      const out = await run(sh, 'Get-ADDefaultDomainPasswordPolicy | Select-Object MinPasswordLength, MaxPasswordAge, LockoutThreshold, ComplexityEnabled');
      expect(out).toMatch(/12\s+90\.00:00:00\s+5\s+True/);
    });
  });

  describe('Fine-Grained Password Policies (FGPP)', () => {
    async function withGroupsAndUsers(dc: WindowsServer) {
      const sh = ps(dc);
      await run(sh, 'New-ADUser -Name "Jean Admin" -SamAccountName jadmin -AccountPassword (ConvertTo-SecureString "User@Mandeng2025!" -AsPlainText -Force) -Enabled $true');
      await run(sh, 'New-ADUser -Name "svc-oracle" -SamAccountName svc-oracle -AccountPassword (ConvertTo-SecureString "Svc@Mandeng2025!" -AsPlainText -Force) -Enabled $true');
      await run(sh, 'New-ADGroup -Name "GRP-IT-Admin" -GroupScope Global -GroupCategory Security');
      await run(sh, 'Add-ADGroupMember -Identity "GRP-IT-Admin" -Members jadmin');
      return sh;
    }

    it('New-ADFineGrainedPasswordPolicy PSO-Administrateurs (Precedence=10) + Add-ADFineGrainedPasswordPolicySubject sur GRP-IT-Admin', async () => {
      const dc = await promotedDc();
      const sh = await withGroupsAndUsers(dc);
      await run(sh, [
        'New-ADFineGrainedPasswordPolicy',
        '-Name "PSO-Administrateurs"',
        '-Precedence 10',
        '-MinPasswordLength 16',
        '-PasswordHistoryCount 48',
        '-MaxPasswordAge (New-TimeSpan -Days 60)',
        '-MinPasswordAge (New-TimeSpan -Days 1)',
        '-LockoutThreshold 3',
        '-LockoutDuration (New-TimeSpan -Hours 1)',
        '-LockoutObservationWindow (New-TimeSpan -Minutes 30)',
        '-ComplexityEnabled $true',
        '-ReversibleEncryptionEnabled $false',
        '-Description "Politique renforcee pour les admins"',
      ].join(' '));
      const link = await run(sh, 'Add-ADFineGrainedPasswordPolicySubject -Identity "PSO-Administrateurs" -Subjects "GRP-IT-Admin"');
      expect(link).not.toMatch(/not recognized/i);

      const out = await run(sh, 'Get-ADFineGrainedPasswordPolicy -Filter *');
      expect(out).toContain('PSO-Administrateurs');
    });

    it('New-ADFineGrainedPasswordPolicy PSO-ServiceAccounts (Precedence=5, MaxPasswordAge=0) + Add-ADFineGrainedPasswordPolicySubject sur svc-oracle', async () => {
      const dc = await promotedDc();
      const sh = await withGroupsAndUsers(dc);
      await run(sh, [
        'New-ADFineGrainedPasswordPolicy',
        '-Name "PSO-ServiceAccounts"',
        '-Precedence 5',
        '-MinPasswordLength 24',
        '-PasswordHistoryCount 48',
        '-MaxPasswordAge (New-TimeSpan -Days 0)',
        '-MinPasswordAge (New-TimeSpan -Days 0)',
        '-LockoutThreshold 0',
        '-ComplexityEnabled $true',
        '-Description "Politique pour les comptes de service (jamais expire)"',
      ].join(' '));
      const link = await run(sh, 'Add-ADFineGrainedPasswordPolicySubject -Identity "PSO-ServiceAccounts" -Subjects "svc-oracle"');
      expect(link).not.toMatch(/not recognized/i);

      const subjects = await run(sh, 'Get-ADFineGrainedPasswordPolicySubject -Identity "PSO-ServiceAccounts"');
      expect(subjects).toContain('svc-oracle');
    });
  });

  describe('vérification de la politique effective par compte (Get-ADUserResultantPasswordPolicy)', () => {
    async function fullSetup(): Promise<{ dc: WindowsServer; sh: ReturnType<typeof ps> }> {
      const dc = await promotedDc();
      const sh = ps(dc);
      await run(sh, 'New-ADUser -Name "Jean Admin" -SamAccountName jadmin -AccountPassword (ConvertTo-SecureString "User@Mandeng2025!" -AsPlainText -Force) -Enabled $true');
      await run(sh, 'New-ADUser -Name "svc-oracle" -SamAccountName svc-oracle -AccountPassword (ConvertTo-SecureString "Svc@Mandeng2025!" -AsPlainText -Force) -Enabled $true');
      await run(sh, 'New-ADGroup -Name "GRP-IT-Admin" -GroupScope Global -GroupCategory Security');
      await run(sh, 'Add-ADGroupMember -Identity "GRP-IT-Admin" -Members jadmin');
      await run(sh, 'New-ADFineGrainedPasswordPolicy -Name "PSO-Administrateurs" -Precedence 10 -MinPasswordLength 16 -MaxPasswordAge (New-TimeSpan -Days 60) -ComplexityEnabled $true');
      await run(sh, 'Add-ADFineGrainedPasswordPolicySubject -Identity "PSO-Administrateurs" -Subjects "GRP-IT-Admin"');
      await run(sh, 'New-ADFineGrainedPasswordPolicy -Name "PSO-ServiceAccounts" -Precedence 5 -MinPasswordLength 24 -MaxPasswordAge (New-TimeSpan -Days 0) -LockoutThreshold 0 -ComplexityEnabled $true');
      await run(sh, 'Add-ADFineGrainedPasswordPolicySubject -Identity "PSO-ServiceAccounts" -Subjects "svc-oracle"');
      return { dc, sh };
    }

    it('jadmin (membre de GRP-IT-Admin, soumis à PSO-Administrateurs) → Get-ADUserResultantPasswordPolicy retourne PSO-Administrateurs', async () => {
      const { sh } = await fullSetup();
      const out = await run(sh, 'Get-ADUserResultantPasswordPolicy -Identity "jadmin"');
      expect(out).toContain('PSO-Administrateurs');
    });

    it('quand un compte est sujet de deux PSO, celle avec la Precedence LA PLUS BASSE gagne (5 < 10)', async () => {
      const { sh } = await fullSetup();
      // svc-oracle est sujet direct de PSO-ServiceAccounts (Precedence=5) ;
      // on l'ajoute aussi au groupe GRP-IT-Admin (sujet de PSO-Administrateurs, Precedence=10)
      // pour vérifier que la politique de plus basse Precedence (5) l'emporte.
      await run(sh, 'Add-ADGroupMember -Identity "GRP-IT-Admin" -Members svc-oracle');
      const out = await run(sh, 'Get-ADUserResultantPasswordPolicy -Identity "svc-oracle"');
      expect(out).toContain('PSO-ServiceAccounts');
      expect(out).not.toContain('PSO-Administrateurs');
    });

    it('un compte non couvert par une FGPP hérite de la Default Domain Policy — Get-ADUserResultantPasswordPolicy retourne $null', async () => {
      const dc = await promotedDc();
      const sh = ps(dc);
      await run(sh, 'New-ADUser -Name "Pierre Reseau" -SamAccountName preseau -AccountPassword (ConvertTo-SecureString "User@Mandeng2025!" -AsPlainText -Force) -Enabled $true');
      const out = await run(sh, '$ResultantPSO = Get-ADUserResultantPasswordPolicy -Identity "preseau"; if ($ResultantPSO) { "PSO: $($ResultantPSO.Name)" } else { "Politique appliquee: Default Domain Policy" }');
      expect(out).toContain('Default Domain Policy');
    });

    it('MaxPasswordAge=0 dans PSO-ServiceAccounts signifie que le mot de passe de svc-oracle n\'expire jamais (PasswordNeverExpires)', async () => {
      const { sh } = await fullSetup();
      const out = await run(sh, 'Get-ADUser -Identity svc-oracle -Properties PasswordNeverExpires | Select-Object -ExpandProperty PasswordNeverExpires');
      expect(out.trim()).toBe('True');
    });

    it('Get-ADFineGrainedPasswordPolicy -Filter * liste les deux PSO avec leur Precedence et leurs sujets', async () => {
      const { sh } = await fullSetup();
      const out = await run(sh, [
        'Get-ADFineGrainedPasswordPolicy -Filter * | ForEach-Object {',
        '  $pso = $_',
        '  $subjects = Get-ADFineGrainedPasswordPolicySubject -Identity $pso.Name',
        '  [PSCustomObject]@{ Nom = $pso.Name; Priorite = $pso.Precedence; MinLength = $pso.MinPasswordLength; Sujets = ($subjects.Name -join ", ") }',
        '} | Format-Table -AutoSize',
      ].join('\n'));
      expect(out).toContain('PSO-Administrateurs');
      expect(out).toContain('PSO-ServiceAccounts');
    });
  });
});
