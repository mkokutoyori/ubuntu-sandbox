/**
 * Scénario 5 (Windows) — Audit des privilèges et élévations : EventIDs
 * 4672, 4673 et UAC.
 *
 * Transcription littérale et fidèle : activation de l'audit des
 * privilèges (`auditpol`), analyse des sessions à privilèges spéciaux
 * (4672), et distinction élévation UAC / connexion administrateur
 * directe via `TokenElevationType` sur 4688.
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

describe('Scénario 5 (Windows) — audit des privilèges et élévations : 4672, 4673 et UAC', () => {
  describe('activation et compréhension de l\'audit des privilèges', () => {
    it('auditpol /set active Sensitive Privilege Use, Non Sensitive Privilege Use et Special Logon', async () => {
      const dc = new WindowsServer('DC01');
      for (const subcat of ['Sensitive Privilege Use', 'Non Sensitive Privilege Use', 'Special Logon']) {
        const out = await dc.executeCmdCommand(`auditpol /set /subcategory:"${subcat}" /success:enable /failure:enable`);
        expect(out).toMatch(/successfully executed/i);
      }
    });

    it('auditpol /get /subcategory:"Special Logon" reflète la politique après activation', async () => {
      const dc = new WindowsServer('DC01');
      await dc.executeCmdCommand('auditpol /set /subcategory:"Special Logon" /success:enable /failure:enable');
      const out = await dc.executeCmdCommand('auditpol /get /subcategory:"Special Logon"');
      expect(out).toContain('Special Logon');
      expect(out).toMatch(/Success and Failure/);
    });
  });

  describe('analyse des événements 4672 (privilèges spéciaux à la nouvelle session)', () => {
    it('gap confirmé : une connexion administrateur réelle (checkPassword) ne génère jamais dynamiquement d\'EventID 4672 — seules deux entrées statiques de démonstration existent au démarrage', async () => {
      const dc = new WindowsServer('DC01');
      const before = (dc.eventLog.getEntriesStructured('Security', { newest: 50 }) ?? [])
        .filter(e => e.eventId === 4672).length;

      dc.getUserManager().checkPassword('Administrator', 'Admin@2025!');

      const after = (dc.eventLog.getEntriesStructured('Security', { newest: 50 }) ?? [])
        .filter(e => e.eventId === 4672).length;
      expect(after).toBeGreaterThan(before);
    });

    it('gap confirmé : le champ structuré PrivilegeList (SeDebugPrivilege, SeImpersonatePrivilege, ...) n\'existe jamais dans l\'EventData, même sur les entrées statiques de 4672', async () => {
      const dc = new WindowsServer('DC01');
      const out = await run(ps(dc), [
        '$Events = Get-WinEvent -FilterHashtable @{ LogName = \'Security\'; Id = 4672 }',
        '$Events | ForEach-Object {',
        '  $xml = [xml]$_.ToXml()',
        '  $xml.Event.EventData.Data | Where-Object {$_.Name -eq \'PrivilegeList\'} | Select-Object -ExpandProperty \'#text\'',
        '}',
      ].join('\n'));
      expect(out).toMatch(/SeDebugPrivilege|SeImpersonatePrivilege/);
    });
  });

  describe('événements UAC et élévations', () => {
    it('gap confirmé : EventID 4673 (appel de service privilégié) n\'existe pas du tout dans le simulateur', async () => {
      const dc = new WindowsServer('DC01');
      const out = await run(ps(dc), "Get-WinEvent -FilterHashtable @{ LogName = 'Security'; Id = 4673; StartTime = (Get-Date).AddHours(-24) }");
      expect(out).not.toMatch(/No events were found/i);
    });

    it('gap confirmé : EventID 4688 ne contient jamais MandatoryLabel ni TokenElevationType — impossible de distinguer une élévation UAC d\'une connexion administrateur directe', async () => {
      const dc = new WindowsServer('DC01');
      dc.getProcessManager().spawnProcess('powershell.exe', 620, 'DC01\\Administrator', {});

      const out = await run(ps(dc), [
        '$Events = Get-WinEvent -FilterHashtable @{ LogName = \'Security\'; Id = 4688 }',
        '$xml = [xml]$Events[0].ToXml()',
        'foreach ($field in @(\'MandatoryLabel\', \'TokenElevationType\')) {',
        '  $val = $xml.Event.EventData.Data | Where-Object {$_.Name -eq $field} | Select-Object -ExpandProperty \'#text\'',
        '  Write-Output "$field=$val"',
        '}',
      ].join('\n'));
      expect(out).toContain('TokenElevationType=%%1937');
    });
  });
});
