/**
 * Scénario 6 (Windows) — Audit des changements de configuration :
 * registre, services et tâches planifiées.
 *
 * Transcription littérale et fidèle : audit du registre (EventID
 * 4657 avec OldValue/NewValue), services installés (EventID 7045
 * dans le journal Système), et tâches planifiées créées (EventID
 * 4698).
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

describe('Scénario 6 (Windows) — audit des changements de configuration : registre, services, tâches planifiées', () => {
  describe('audit du registre', () => {
    it('auditpol /set /subcategory:"Registry" est accepté', async () => {
      const dc = new WindowsServer('DC01');
      const out = await dc.executeCmdCommand('auditpol /set /subcategory:"Registry" /success:enable /failure:enable');
      expect(out).toMatch(/successfully executed/i);
    });

    it('Set-ItemProperty sur la clé Run persiste réellement la valeur (mécanisme du registre lui-même)', async () => {
      const dc = new WindowsServer('DC01');
      const sh = ps(dc);
      await run(sh, 'New-Item -Path "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run" -Force');
      await run(sh, 'Set-ItemProperty -Path "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run" -Name "MandengTest" -Value "C:\\Temp\\test.exe" -Type String');
      const out = await run(sh, '(Get-ItemProperty -Path "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run" -Name "MandengTest").MandengTest');
      expect(out.trim()).toBe('C:\\Temp\\test.exe');
    });

    it('gap confirmé : Set-ItemProperty sur une clé de persistance (Run) ne génère jamais d\'EventID 4657 — seul le changement de compte de service est audité', async () => {
      const dc = new WindowsServer('DC01');
      const sh = ps(dc);
      await run(sh, 'New-Item -Path "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run" -Force');
      await run(sh, 'Set-ItemProperty -Path "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run" -Name "MandengTest" -Value "C:\\Temp\\test.exe" -Type String');

      const out = await run(sh, "Get-WinEvent -FilterHashtable @{ LogName = 'Security'; Id = 4657; StartTime = (Get-Date).AddMinutes(-1) }");
      expect(out).not.toMatch(/No events were found/i);
    });

    it('gap confirmé : même dans le seul cas réellement audité (changement de compte de service), les champs OldValue/NewValue sont absents de l\'EventData — seul le texte libre du message les mentionne', async () => {
      const dc = new WindowsServer('DC01');
      const sh = ps(dc);
      await dc.executeCmdCommand('auditpol /set /subcategory:"Registry" /success:enable /failure:enable');
      dc.getServiceManager().createService('TestSvc', { binaryPath: 'C:\\svc.exe' }, true, 'Administrator');
      dc.getServiceManager().setAccount('TestSvc', 'DC01\\svcaccount', true, 'Administrator');

      const before4657 = (dc.eventLog.getEntriesStructured('Security', { newest: 50 }) ?? [])
        .filter(e => e.eventId === 4657);
      expect(before4657.length).toBeGreaterThan(0);

      const out = await run(sh, [
        '$Events = Get-WinEvent -FilterHashtable @{ LogName = \'Security\'; Id = 4657 }',
        '$Events | ForEach-Object {',
        '  $xml = [xml]$_.ToXml()',
        '  $xml.Event.EventData.Data | Where-Object {$_.Name -eq \'NewValue\'} | Select-Object -ExpandProperty \'#text\'',
        '}',
      ].join('\n'));
      expect(out).toContain('svcaccount');
    });
  });

  describe('audit des services et tâches planifiées', () => {
    it('New-Service journalise bien EventID 7045 dans le journal Système avec le nom du service dans le message', async () => {
      const dc = new WindowsServer('DC01');
      await run(ps(dc), 'New-Service -Name "MandengSvc" -BinaryPathName "C:\\Temp\\svc.exe" -StartupType Automatic');

      const entries = (dc.eventLog.getEntriesStructured('System', { newest: 50 }) ?? [])
        .filter(e => e.eventId === 7045);
      expect(entries.length).toBeGreaterThan(0);
      expect(entries[0].message).toContain('MandengSvc');
      expect(entries[0].message).toContain('C:\\Temp\\svc.exe');
    });

    it('gap confirmé : EventID 7045 n\'a pas d\'EventData structurée — Data[0]/Data[1]/Data[2]/Data[3] (nom, binaire, démarrage, compte) sont inaccessibles en XML', async () => {
      const dc = new WindowsServer('DC01');
      await run(ps(dc), 'New-Service -Name "MandengSvc" -BinaryPathName "C:\\Temp\\svc.exe" -StartupType Automatic');

      const out = await run(ps(dc), [
        '$Events = Get-WinEvent -FilterHashtable @{ LogName = \'System\'; Id = 7045 }',
        '$xml = [xml]$Events[0].ToXml()',
        '$xml.Event.EventData.Data[0].\'#text\'',
      ].join('\n'));
      expect(out.trim()).toBe('MandengSvc');
    });

    it('gap confirmé : Register-ScheduledTask ne génère jamais d\'EventID 4698, aucune tâche planifiée n\'est jamais auditée', async () => {
      const dc = new WindowsServer('DC01');
      const sh = ps(dc);
      await run(sh, [
        '$Action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-File C:\\Temp\\update.ps1"',
        '$Trigger = New-ScheduledTaskTrigger -Daily -At "3:00AM"',
        'Register-ScheduledTask -TaskName "SystemUpdate" -Action $Action -Trigger $Trigger -RunLevel Highest',
      ].join('\n'));

      const out = await run(sh, "Get-WinEvent -FilterHashtable @{ LogName = 'Security'; Id = 4698; StartTime = (Get-Date).AddHours(-24) }");
      expect(out).not.toMatch(/No events were found/i);
    });
  });
});
