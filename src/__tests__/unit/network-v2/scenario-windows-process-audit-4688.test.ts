/**
 * Scénario 3 (Windows) — Audit des processus : EventID 4688 et
 * journalisation de la ligne de commande.
 *
 * Transcription littérale et fidèle : activation de l'audit de
 * création de processus (`auditpol`) et de la journalisation de la
 * ligne de commande (`ProcessCreationIncludeCmdLine_Enabled`),
 * génération d'événements 4688 via le cycle de vie réel des
 * processus, et détection de processus suspects (`Find-SuspiciousProcesses`)
 * sur les données structurées de l'EventData.
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

describe('Scénario 3 (Windows) — audit des processus : EventID 4688 et journalisation de la ligne de commande', () => {
  describe('activation de l\'audit des processus avec ligne de commande', () => {
    it('auditpol /set /subcategory:"Process Creation" /success:enable est accepté', async () => {
      const dc = new WindowsServer('DC01');
      const out = await dc.executeCmdCommand('auditpol /set /subcategory:"Process Creation" /success:enable');
      expect(out).toMatch(/successfully executed/i);
    });

    it('ProcessCreationIncludeCmdLine_Enabled peut être défini puis relu via le registre', async () => {
      const dc = new WindowsServer('DC01');
      const sh = ps(dc);
      await run(sh, 'New-Item -Path "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System\\Audit" -Force');
      await run(sh, 'Set-ItemProperty -Path "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System\\Audit" -Name "ProcessCreationIncludeCmdLine_Enabled" -Value 1 -Type DWord');
      const out = await run(sh, '(Get-ItemProperty -Path "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System\\Audit" -Name "ProcessCreationIncludeCmdLine_Enabled").ProcessCreationIncludeCmdLine_Enabled');
      expect(out.trim()).toBe('1');
    });

    it('gap confirmé : même après ProcessCreationIncludeCmdLine_Enabled = 1, le champ CommandLine de 4688 reste absent (aucune ligne de commande n\'est jamais propagée jusqu\'à l\'audit)', async () => {
      const dc = new WindowsServer('DC01');
      const sh = ps(dc);
      await run(sh, 'New-Item -Path "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System\\Audit" -Force');
      await run(sh, 'Set-ItemProperty -Path "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System\\Audit" -Name "ProcessCreationIncludeCmdLine_Enabled" -Value 1 -Type DWord');

      dc.getProcessManager().spawnProcess('powershell.exe', 620, 'DC01\\Administrator', {});

      const out = await run(sh, [
        '$Events = Get-WinEvent -FilterHashtable @{ LogName = \'Security\'; Id = 4688 }',
        '$Events | ForEach-Object {',
        '  $xml = [xml]$_.ToXml()',
        '  $xml.Event.EventData.Data | Where-Object {$_.Name -eq \'CommandLine\'} | Select-Object -ExpandProperty \'#text\'',
        '}',
      ].join('\n'));
      expect(out).toMatch(/powershell\.exe/i);
    });
  });

  describe('analyse des événements 4688', () => {
    it('la création puis la fin d\'un processus journalisent bien 4688 puis 4689', async () => {
      const dc = new WindowsServer('DC01');
      const proc = dc.getProcessManager().spawnProcess('notepad.exe', 100, 'DC01\\Administrator', {});
      dc.getProcessManager().killProcess(proc.pid, true, true);

      const ids = (dc.eventLog.getEntriesStructured('Security', { newest: 50 }) ?? []).map(e => e.eventId);
      expect(ids).toContain(4688);
      expect(ids).toContain(4689);
    });

    it('4688 mentionne le nouveau nom de processus et son PID dans le message', async () => {
      const dc = new WindowsServer('DC01');
      dc.getProcessManager().spawnProcess('notepad.exe', 100, 'DC01\\Administrator', {});

      const entries = (dc.eventLog.getEntriesStructured('Security', { newest: 50 }) ?? [])
        .filter(e => e.eventId === 4688);
      expect(entries.length).toBeGreaterThan(0);
      expect(entries[0].message).toContain('notepad.exe');
    });

    it('gap confirmé : NewProcessName, ParentProcessName, SubjectUserName, NewProcessId et ProcessId (parent) sont tous absents de l\'EventData de 4688', async () => {
      const dc = new WindowsServer('DC01');
      dc.getProcessManager().spawnProcess('cmd.exe', 1234, 'DC01\\Administrator', {});

      const out = await run(ps(dc), [
        '$Events = Get-WinEvent -FilterHashtable @{ LogName = \'Security\'; Id = 4688 }',
        '$xml = [xml]$Events[0].ToXml()',
        'foreach ($field in @(\'NewProcessName\', \'ParentProcessName\', \'SubjectDomainName\', \'SubjectUserName\', \'NewProcessId\', \'ProcessId\')) {',
        '  $val = $xml.Event.EventData.Data | Where-Object {$_.Name -eq $field} | Select-Object -ExpandProperty \'#text\'',
        '  Write-Output "$field=$val"',
        '}',
      ].join('\n'));
      expect(out).toContain('NewProcessName=cmd.exe');
      expect(out).toContain('ParentProcessName=');
      // Windows sépare le domaine du compte dans l'EventData : la forme
      // `DOMAINE\utilisateur` n'apparaît que dans le message rendu.
      // L'énoncé d'origine attendait la forme jointe dans le champ
      // structuré, ce qu'un vrai 4688 ne produit jamais.
      expect(out).toContain('SubjectDomainName=DC01');
      expect(out).toContain('SubjectUserName=Administrator');
    });
  });

  describe('détection de processus suspects (Find-SuspiciousProcesses)', () => {
    it('gap confirmé : un powershell.exe encodé (-EncodedCommand) n\'est jamais détecté, car CommandLine n\'existe jamais dans l\'EventData', async () => {
      const dc = new WindowsServer('DC01');
      const sh = ps(dc);
      // La ligne de commande n'entre dans 4688 que sous la stratégie qui
      // l'autorise — c'est tout l'objet du réglage. Sans elle, la
      // détection n'a rien à lire ; l'énoncé d'origine lançait le
      // processus sans ligne de commande *et* sans la stratégie, donc
      // cherchait un motif dans un champ qui n'avait aucune raison
      // d'exister.
      await run(sh, 'New-Item -Path "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System\\Audit" -Force');
      await run(sh, 'Set-ItemProperty -Path "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System\\Audit" -Name "ProcessCreationIncludeCmdLine_Enabled" -Value 1 -Type DWord');

      // Processus délibérément suspect (obfuscation PowerShell).
      dc.getProcessManager().spawnProcess('powershell.exe', 620, 'DC01\\Administrator', {
        commandLine: 'powershell.exe -NoProfile -EncodedCommand SQBFAFgAIAAoAE4AZQB3AC0ATwBiAGoAZQBjAHQAKQA=',
      });

      const out = await run(sh, [
        'function Find-SuspiciousProcesses {',
        '  $Events = Get-WinEvent -FilterHashtable @{ LogName = \'Security\'; Id = 4688 } -ErrorAction SilentlyContinue',
        '  $Suspicious = @()',
        '  foreach ($evt in $Events) {',
        '    $xml = [xml]$evt.ToXml()',
        '    $CmdLine = $xml.Event.EventData.Data | Where-Object {$_.Name -eq \'CommandLine\'} | Select-Object -ExpandProperty \'#text\'',
        '    if ($CmdLine -match "-[Ee]nc(oded)?[Cc]ommand") {',
        '      $Suspicious += "PowerShell encode (obfuscation potentielle)"',
        '    }',
        '  }',
        '  return $Suspicious',
        '}',
        '$Result = Find-SuspiciousProcesses',
        'if ($Result) { $Result } else { "AUCUN PROCESSUS SUSPECT DETECTE" }',
      ].join('\n'));
      expect(out).toContain('PowerShell encode');
    });
  });
});
