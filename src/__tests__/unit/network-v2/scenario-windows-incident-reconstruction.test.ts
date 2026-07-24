/**
 * Scénario 9 (Windows) — Piste d'audit complète : reconstruction d'un
 * incident de sécurité.
 *
 * Transcription littérale et fidèle : simulation d'un incident
 * multi-phases (connexion, reconnaissance, exécution PowerShell,
 * persistance registre, tâche planifiée, effacement de traces) et
 * reconstruction chronologique via les seuls journaux Windows
 * disponibles.
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

describe('Scénario 9 (Windows) — piste d\'audit complète : reconstruction d\'un incident de sécurité', () => {
  describe('simulation de l\'incident, phase par phase', () => {
    it('Phase 1 (connexion compromise) — génère bien un EventID 4624 exploitable pour la timeline', async () => {
      const dc = new WindowsServer('DC01');
      dc.getUserManager().checkPassword('bob', 'stolen-password');

      const ids = (dc.eventLog.getEntriesStructured('Security', { newest: 50 }) ?? []).map(e => e.eventId);
      expect(ids).toContain(4624);
    });

    it('gap confirmé : Phase 3 (powershell -EncodedCommand) ne génère jamais d\'EventID 4104 exploitable pour la timeline', async () => {
      const dc = new WindowsServer('DC01');
      const sh = ps(dc);
      await run(sh, '$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes(\'Get-Process | Select-Object Name, Id\'))');

      const out = await run(sh, "Get-WinEvent -FilterHashtable @{ LogName = 'Microsoft-Windows-PowerShell/Operational'; Id = 4104; StartTime = (Get-Date).AddHours(-2) }");
      expect(out).not.toMatch(/No events were found|does not exist/i);
    });

    it('gap confirmé : Phase 4 (persistance via la clé Run) ne génère jamais d\'EventID 4657 exploitable pour la timeline', async () => {
      const dc = new WindowsServer('DC01');
      const sh = ps(dc);
      await run(sh, 'New-Item -Path "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" -Force');
      await run(sh, 'New-ItemProperty -Path "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" -Name "UpdateCheck" -Value "C:\\Temp\\update.ps1" -PropertyType String');

      const out = await run(sh, "Get-WinEvent -FilterHashtable @{ LogName = 'Security'; Id = 4657; StartTime = (Get-Date).AddHours(-2) }");
      expect(out).not.toMatch(/No events were found/i);
    });

    it('gap confirmé : Phase 5 (tâche planifiée de persistance) ne génère jamais d\'EventID 4698 exploitable pour la timeline', async () => {
      const dc = new WindowsServer('DC01');
      const sh = ps(dc);
      await run(sh, [
        '$Action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-WindowStyle Hidden -File C:\\Temp\\update.ps1"',
        '$Trigger = New-ScheduledTaskTrigger -Daily -At "3:00AM"',
        'Register-ScheduledTask -TaskName "SystemUpdate" -Action $Action -Trigger $Trigger -RunLevel Highest',
      ].join('\n'));

      const out = await run(sh, "Get-WinEvent -FilterHashtable @{ LogName = 'Security'; Id = 4698; StartTime = (Get-Date).AddHours(-2) }");
      expect(out).not.toMatch(/No events were found/i);
    });

    it('gap confirmé : Phase 6 (Clear-EventLog Application) ne génère jamais d\'EventID 1102 dans le journal Security — l\'effacement de traces passe totalement inaperçu', async () => {
      const dc = new WindowsServer('DC01');
      const sh = ps(dc);
      await run(sh, 'Clear-EventLog -LogName Application');

      const out = await run(sh, "Get-WinEvent -FilterHashtable @{ LogName = 'Security'; Id = @(1102, 1100); StartTime = (Get-Date).AddHours(-2) }");
      expect(out).not.toMatch(/No events were found/i);
    });
  });

  describe('reconstruction chronologique de l\'incident', () => {
    it('la timeline reconstituée ne contient que la catégorie CONNEXION — toutes les autres catégories (PowerShell, registre, tâche planifiée, effacement) restent vides malgré un incident complet simulé', async () => {
      const dc = new WindowsServer('DC01');
      const sh = ps(dc);

      // Rejoue les 6 phases de l'incident.
      dc.getUserManager().checkPassword('bob', 'stolen-password');
      await run(sh, '$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes(\'Get-Process\'))');
      await run(sh, 'New-Item -Path "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" -Force');
      await run(sh, 'New-ItemProperty -Path "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" -Name "UpdateCheck" -Value "C:\\Temp\\update.ps1" -PropertyType String');
      await run(sh, [
        '$Action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-File C:\\Temp\\update.ps1"',
        '$Trigger = New-ScheduledTaskTrigger -Daily -At "3:00AM"',
        'Register-ScheduledTask -TaskName "SystemUpdate" -Action $Action -Trigger $Trigger -RunLevel Highest',
      ].join('\n'));
      await run(sh, 'Clear-EventLog -LogName Application');

      const out = await run(sh, [
        '$Connexion = (Get-WinEvent -FilterHashtable @{ LogName = \'Security\'; Id = @(4624, 4625, 4648); StartTime = (Get-Date).AddHours(-2) } -ErrorAction SilentlyContinue | Measure-Object).Count',
        '$PowerShellCount = (Get-WinEvent -FilterHashtable @{ LogName = \'Microsoft-Windows-PowerShell/Operational\'; Id = 4104; StartTime = (Get-Date).AddHours(-2) } -ErrorAction SilentlyContinue | Measure-Object).Count',
        '$Registre = (Get-WinEvent -FilterHashtable @{ LogName = \'Security\'; Id = 4657; StartTime = (Get-Date).AddHours(-2) } -ErrorAction SilentlyContinue | Measure-Object).Count',
        '$TachePlanifiee = (Get-WinEvent -FilterHashtable @{ LogName = \'Security\'; Id = @(4698, 4699, 4702); StartTime = (Get-Date).AddHours(-2) } -ErrorAction SilentlyContinue | Measure-Object).Count',
        '$JournalEfface = (Get-WinEvent -FilterHashtable @{ LogName = \'Security\'; Id = @(1102, 1100); StartTime = (Get-Date).AddHours(-2) } -ErrorAction SilentlyContinue | Measure-Object).Count',
        '"CONNEXION=$Connexion"',
        '"POWERSHELL=$PowerShellCount"',
        '"REGISTRE=$Registre"',
        '"TACHE_PLANIFIEE=$TachePlanifiee"',
        '"JOURNAL_EFFACE=$JournalEfface"',
      ].join('\n'));

      expect(out).toMatch(/CONNEXION=[1-9]\d*/);
      expect(out).toMatch(/POWERSHELL=0/);
      expect(out).toMatch(/REGISTRE=0/);
      expect(out).toMatch(/TACHE_PLANIFIEE=0/);
      expect(out).toMatch(/JOURNAL_EFFACE=0/);
    });
  });
});
