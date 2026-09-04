/**
 * Scénario 8 (Windows) — Collecte et centralisation des logs via
 * PowerShell et export.
 *
 * Transcription littérale et fidèle : export EVTX (`wevtutil epl`),
 * export CSV/JSON (`Export-Csv`/`ConvertTo-Json`), collecte
 * multi-machines via `Invoke-Command -ComputerName`, et planification
 * de l'archivage (`Register-ScheduledTask`).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, IPAddress, SubnetMask } from '@/network/core/types';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

const ps = (d: WindowsPC) => PowerShellSubShell.create(d).subShell;
const run = async (sh: ReturnType<typeof ps>, l: string) => (await sh.processLine(l)).output.join('\n');

async function buildLan() {
  const dc01 = new WindowsServer('DC01');
  const srvWeb = new WindowsServer('SRV-WEB');
  const client = new WindowsPC('windows-pc', 'PC-WIN-01');
  const sw = new GenericSwitch('switch-generic', 'SW1');
  new Cable('c-dc').connect(dc01.getPorts()[0], sw.getPorts()[0]);
  new Cable('c-web').connect(srvWeb.getPorts()[0], sw.getPorts()[1]);
  new Cable('c-client').connect(client.getPorts()[0], sw.getPorts()[2]);

  const mask = new SubnetMask('255.255.255.0');
  dc01.getPorts()[0].configureIP(new IPAddress('192.168.10.10'), mask);
  srvWeb.getPorts()[0].configureIP(new IPAddress('192.168.10.50'), mask);
  client.getPorts()[0].configureIP(new IPAddress('192.168.10.60'), mask);
  client.addHostsEntry('192.168.10.10', 'DC01');
  client.addHostsEntry('192.168.10.50', 'SRV-WEB');

  dc01.setCurrentUser('Administrator');
  srvWeb.setCurrentUser('Administrator');
  client.setCurrentUser('Administrator');

  return { dc01, srvWeb, client };
}

describe('Scénario 8 (Windows) — collecte et centralisation des logs', () => {
  describe('export des journaux dans différents formats', () => {
    it('gap confirmé : wevtutil epl (export-log) n\'est pas implémenté — il retombe sur le texte d\'aide générique au lieu d\'exporter', async () => {
      const dc = new WindowsServer('DC01');
      const out = await dc.executeCmdCommand('wevtutil epl Security C:\\AuditExports\\Security.evtx');
      expect(out).not.toMatch(/Windows Events Command Line Utility/i);
    });

    it('Export-Csv puis Import-Csv permettent réellement d\'exporter/relire les événements Security en CSV', async () => {
      const dc = new WindowsServer('DC01');
      const sh = ps(dc);
      dc.getUserManager().checkPassword('Administrator', 'wrong-on-purpose');

      // `Export-Csv` ne CREE pas le repertoire manquant, sur une vraie
      // machine comme ici : il echoue par « Could not find a part of the
      // path ». L'operateur le cree, ce que ce laboratoire omettait.
      await run(sh, 'New-Item -ItemType Directory -Path "C:\\AuditExports" -Force');

      await run(sh, [
        '$Events = Get-WinEvent -FilterHashtable @{ LogName = \'Security\'; Id = @(4624, 4625); StartTime = (Get-Date).AddDays(-1) }',
        '$Events | Select-Object TimeCreated, Id, LevelDisplayName | Export-Csv -Path "C:\\AuditExports\\SecurityEvents.csv" -NoTypeInformation',
      ].join('\n'));

      const out = await run(sh, '(Import-Csv "C:\\AuditExports\\SecurityEvents.csv").Count');
      expect(Number(out.trim())).toBeGreaterThan(0);
    });

    it('ConvertTo-Json produit un JSON valide et ré-analysable à partir des événements exportés', async () => {
      const dc = new WindowsServer('DC01');
      const sh = ps(dc);
      dc.getUserManager().checkPassword('Administrator', 'wrong-on-purpose');

      const out = await run(sh, [
        '$Events = Get-WinEvent -FilterHashtable @{ LogName = \'Security\'; Id = 4625; StartTime = (Get-Date).AddDays(-1) }',
        '$Events | Select-Object Id | ConvertTo-Json -Depth 5',
      ].join('\n'));
      expect(() => JSON.parse(out)).not.toThrow();
    });
  });

  describe('collecte multi-machines via PowerShell Remoting', () => {
    it('Invoke-Command -ComputerName sur plusieurs cibles tague chaque résultat avec le bon PSComputerName', async () => {
      const { dc01, srvWeb, client } = await buildLan();
      await dc01.executeCmdCommand('winrm quickconfig');
      await srvWeb.executeCmdCommand('winrm quickconfig');

      const out = await run(ps(client), 'Invoke-Command -ComputerName DC01,SRV-WEB -Credential bob -ScriptBlock { [PSCustomObject]@{ Heure = Get-Date } } | Select-Object PSComputerName');
      expect(out).not.toMatch(/failed|WinRM cannot complete/i);
      expect(out).toContain('DC01');
      expect(out).toContain('SRV-WEB');
    });

    it('Invoke-Command peut exécuter Get-WinEvent à distance et récupérer les événements du journal Security de la machine cible', async () => {
      const { dc01, client } = await buildLan();
      await dc01.executeCmdCommand('winrm quickconfig');
      dc01.getUserManager().checkPassword('bob', 'wrong-on-purpose');

      const out = await run(ps(client), [
        'Invoke-Command -ComputerName DC01 -Credential bob -ScriptBlock {',
        '  Get-WinEvent -FilterHashtable @{ LogName = \'Security\'; Id = 4625; StartTime = (Get-Date).AddDays(-1) } | Select-Object Id',
        '}',
      ].join('\n'));
      expect(out).toContain('4625');
    });

    it('la collecte échoue proprement quand WinRM n\'est pas activé sur la cible', async () => {
      const { client } = await buildLan();
      const out = await run(ps(client), 'Invoke-Command -ComputerName SRV-WEB -Credential bob -ScriptBlock { 1 }');
      expect(out).toMatch(/WinRM cannot complete the operation/i);
    });
  });

  describe('archivage automatique et rotation des journaux', () => {
    it('Register-ScheduledTask planifie réellement une tâche d\'archivage quotidienne', async () => {
      const dc = new WindowsServer('DC01');
      const sh = ps(dc);
      await run(sh, [
        '$Action = New-ScheduledTaskAction -Execute "PowerShell.exe" -Argument "-NonInteractive -Command Export-WindowsLogs"',
        '$Trigger = New-ScheduledTaskTrigger -Daily -At "11:00PM"',
        'Register-ScheduledTask -TaskName "Archive-WindowsLogs" -Action $Action -Trigger $Trigger -RunLevel Highest',
      ].join('\n'));

      const out = await run(sh, 'Get-ScheduledTask -TaskName "Archive-WindowsLogs"');
      expect(out).toContain('Archive-WindowsLogs');
    });
  });
});
