/**
 * Scénario 7 (Windows) — Journalisation PowerShell : Module Logging et
 * Script Block Logging.
 *
 * Transcription littérale et fidèle : activation des clés de registre
 * GPO (Module Logging, Script Block Logging, Transcription), puis
 * vérification de la génération réelle d'EventID 4104 dans
 * `Microsoft-Windows-PowerShell/Operational` et de fichiers de
 * transcription.
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

describe('Scénario 7 (Windows) — journalisation PowerShell : Module Logging et Script Block Logging', () => {
  describe('activation de la journalisation PowerShell (registre)', () => {
    it('les trois clés de stratégie (ModuleLogging, ScriptBlockLogging, Transcription) peuvent être créées et lues via le registre générique', async () => {
      const dc = new WindowsServer('DC01');
      const sh = ps(dc);
      await run(sh, 'New-Item -Path "HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\PowerShell\\ModuleLogging" -Force');
      await run(sh, 'Set-ItemProperty -Path "HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\PowerShell\\ModuleLogging" -Name "EnableModuleLogging" -Value 1');
      await run(sh, 'New-Item -Path "HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\PowerShell\\ScriptBlockLogging" -Force');
      await run(sh, 'Set-ItemProperty -Path "HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\PowerShell\\ScriptBlockLogging" -Name "EnableScriptBlockLogging" -Value 1');

      const out = await run(sh, [
        '$Module = (Get-ItemProperty "HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\PowerShell\\ModuleLogging").EnableModuleLogging',
        '$SBL = (Get-ItemProperty "HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\PowerShell\\ScriptBlockLogging").EnableScriptBlockLogging',
        '"Module=$Module SBL=$SBL"',
      ].join('\n'));
      expect(out.trim()).toBe('Module=1 SBL=1');
    });

    it('gap confirmé : le journal Microsoft-Windows-PowerShell/Operational n\'existe pas — Get-WinEvent -ListLog ne le retourne jamais', async () => {
      const dc = new WindowsServer('DC01');
      const out = await run(ps(dc), "Get-WinEvent -ListLog * | Select-Object -ExpandProperty LogName");
      expect(out).toContain('Microsoft-Windows-PowerShell/Operational');
    });
  });

  describe('analyse du Script Block Logging (EventID 4104)', () => {
    it('gap confirmé : exécuter des commandes PowerShell (y compris un contenu Base64 suspect) ne génère jamais d\'EventID 4104', async () => {
      const dc = new WindowsServer('DC01');
      const sh = ps(dc);
      await run(sh, 'New-Item -Path "HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\PowerShell\\ScriptBlockLogging" -Force');
      await run(sh, 'Set-ItemProperty -Path "HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\PowerShell\\ScriptBlockLogging" -Name "EnableScriptBlockLogging" -Value 1');
      await run(sh, 'Get-Process | Where-Object {$_.CPU -gt 10}');
      await run(sh, '$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes("Get-Process"))');

      const out = await run(sh, "Get-WinEvent -FilterHashtable @{ LogName = 'Microsoft-Windows-PowerShell/Operational'; Id = 4104; StartTime = (Get-Date).AddHours(-1) }");
      expect(out).not.toMatch(/No events were found|does not exist|not.*found/i);
    });
  });

  describe('transcriptions PowerShell', () => {
    it('gap confirmé : activer EnableTranscripting et exécuter des commandes ne crée jamais de fichier PowerShell_transcript.*.txt', async () => {
      const dc = new WindowsServer('DC01');
      const sh = ps(dc);
      await run(sh, 'New-Item -Path "HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\PowerShell\\Transcription" -Force');
      await run(sh, 'Set-ItemProperty -Path "HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\PowerShell\\Transcription" -Name "EnableTranscripting" -Value 1');
      await run(sh, 'Set-ItemProperty -Path "HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\PowerShell\\Transcription" -Name "OutputDirectory" -Value "C:\\PSTranscripts"');
      await run(sh, 'New-Item -Path "C:\\PSTranscripts" -ItemType Directory -Force');
      await run(sh, 'Get-Date');

      const out = await run(sh, 'Get-ChildItem "C:\\PSTranscripts" -Filter "*.txt"');
      expect(out).toMatch(/PowerShell_transcript/);
    });
  });
});
