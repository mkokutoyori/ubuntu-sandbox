/**
 * Debug run — services, processes & scheduled tasks.
 *
 * Drives a Windows Server through `Get-Service`/`Get-Process` family
 * cmdlets, including state changes (Start/Stop/Restart-Service,
 * Stop-Process), event-log probing and complex pipelines.
 * Transcript → `debug-output/ps-services-processes_results_debug.txt`.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { runAndDump, createPSRunner, type DebugCommandInput } from './_dump';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

describe('debug — PowerShell services & processes', () => {
  it('runs service/process cmdlets on PC + Server', async () => {
    const pc = new WindowsPC('windows-pc', 'WIN-SVC-DBG');
    const srv = new WindowsPC('windows-server', 'SRV-SVC-DBG');
    pc.setCurrentUser('Administrator');
    srv.setCurrentUser('Administrator');
    const psPc = createPSRunner(pc);
    const psSrv = createPSRunner(srv);

    const commands: DebugCommandInput[] = [
      // ── 1. service enumeration ────────────────────────────────────
      { section: 'service enumeration', cmd: 'Get-Service' },
      'Get-Service | Format-Table Name, Status, StartType -AutoSize',
      'Get-Service | Sort-Object Name',
      'Get-Service | Sort-Object Status',
      'Get-Service | Where-Object { $_.Status -eq "Running" }',
      'Get-Service | Where-Object { $_.Status -eq "Stopped" }',
      'Get-Service | Where-Object { $_.StartType -eq "Automatic" }',
      'Get-Service | Where-Object { $_.StartType -eq "Manual" }',
      'Get-Service | Where-Object { $_.StartType -eq "Disabled" }',
      '(Get-Service).Count',
      '(Get-Service | Where-Object { $_.Status -eq "Running" }).Count',
      'Get-Service | Group-Object Status | Format-Table Name, Count -AutoSize',
      'Get-Service | Group-Object StartType | Sort-Object Count -Descending',
      'Get-Service -Name Spooler',
      'Get-Service Spooler',
      'gsv Spooler',
      'Get-Service -DisplayName "Print Spooler"',
      'Get-Service -Name "S*"',
      'Get-Service -Name "*log*"',
      'Get-Service | Select-Object -First 5 Name, Status',
      'Get-Service | Select-Object -Last 5 Name, Status',
      '(Get-Service -Name Spooler).Status',
      '(Get-Service -Name Spooler).StartType',
      '(Get-Service -Name Spooler).DisplayName',

      // ── 2. service state changes ──────────────────────────────────
      { section: 'state changes', cmd: 'Stop-Service -Name Spooler -ErrorAction SilentlyContinue' },
      '(Get-Service -Name Spooler).Status',
      'Start-Service -Name Spooler',
      '(Get-Service -Name Spooler).Status',
      'Restart-Service -Name Spooler',
      '(Get-Service -Name Spooler).Status',
      'Stop-Service -Name bthserv -ErrorAction SilentlyContinue',
      'Start-Service -Name bthserv',
      '(Get-Service -Name bthserv).Status',
      'Stop-Service -Name bthserv',
      '(Get-Service -Name bthserv).Status',
      'Set-Service -Name bthserv -StartupType Manual',
      '(Get-Service -Name bthserv).StartType',
      'Set-Service -Name bthserv -StartupType Disabled',
      '(Get-Service -Name bthserv).StartType',
      'Set-Service -Name bthserv -StartupType Automatic',
      '(Get-Service -Name bthserv).StartType',
      'Stop-Service -Name winlogon -ErrorAction SilentlyContinue',

      // ── 3. process enumeration ────────────────────────────────────
      { section: 'process enumeration', cmd: 'Get-Process' },
      'Get-Process | Format-Table Id, ProcessName, CPU -AutoSize',
      'Get-Process | Sort-Object CPU -Descending | Select-Object -First 5',
      'Get-Process | Sort-Object WS -Descending | Select-Object -First 5 Name, Id, WS',
      'Get-Process | Where-Object { $_.CPU -gt 0 }',
      'Get-Process | Where-Object { $_.ProcessName -like "svc*" }',
      'Get-Process explorer -ErrorAction SilentlyContinue',
      'Get-Process -Name svchost -ErrorAction SilentlyContinue',
      '(Get-Process).Count',
      'Get-Process | Group-Object ProcessName | Sort-Object Count -Descending | Select-Object -First 5',
      'Get-Process | Select-Object Id, ProcessName, Handles, WS, CPU | Sort-Object CPU -Descending | Select-Object -First 10',
      'Get-Process | Measure-Object -Property CPU -Sum',
      'Get-Process | Measure-Object -Property WS -Sum -Average -Max',
      'ps',
      'gps',

      // ── 4. process lifecycle ──────────────────────────────────────
      { section: 'process lifecycle', cmd: 'Start-Process notepad.exe' },
      'Get-Process -Name notepad -ErrorAction SilentlyContinue',
      'Start-Process -FilePath calc.exe',
      'Get-Process -Name calc -ErrorAction SilentlyContinue',
      'Stop-Process -Name notepad -ErrorAction SilentlyContinue',
      'Get-Process -Name notepad -ErrorAction SilentlyContinue',
      'Stop-Process -Name calc -ErrorAction SilentlyContinue',
      'Start-Process notepad.exe',
      'Start-Process notepad.exe',
      'Start-Process notepad.exe',
      'Get-Process -Name notepad',
      'Get-Process -Name notepad | Stop-Process',
      'Get-Process -Name notepad -ErrorAction SilentlyContinue',

      // ── 5. complex service-process pipelines ──────────────────────
      { section: 'complex pipelines',
        cmd: 'Get-Service | Where-Object { $_.Status -eq "Running" } | Sort-Object Name | Select-Object -First 5 | Format-Table Name, Status, DisplayName' },
      'Get-Service | Group-Object StartType | ForEach-Object { "$($_.Name): $($_.Count)" }',
      'Get-Service | Where-Object { $_.Status -eq "Running" -and $_.StartType -eq "Automatic" } | Measure-Object',
      'Get-Process | Where-Object { $_.WS -gt 0 } | Sort-Object WS -Descending | Select-Object -First 3 | Format-List Name, Id, WS, CPU',
      'Get-Process | Sort-Object ProcessName | Select-Object -Unique ProcessName | Select-Object -First 10',
      'Get-Service | Where-Object { $_.Name -match "^(W|S)" } | Format-Table Name, Status -AutoSize',
      '"Spooler","bthserv","wuauserv" | ForEach-Object { Get-Service -Name $_ -ErrorAction SilentlyContinue } | Format-Table Name, Status, StartType -AutoSize',
      'Get-Service | ForEach-Object { [pscustomobject]@{ N=$_.Name; S=$_.Status } } | Sort-Object N | Select-Object -First 5',

      // ── 6. event log probes ───────────────────────────────────────
      { section: 'event logs', cmd: 'Get-EventLog -List -ErrorAction SilentlyContinue' },
      'Get-EventLog -LogName System -Newest 5 -ErrorAction SilentlyContinue',
      'Get-EventLog -LogName Application -Newest 5 -ErrorAction SilentlyContinue',
      'Get-EventLog -LogName Security -Newest 5 -ErrorAction SilentlyContinue',
      'Get-WinEvent -LogName System -MaxEvents 5 -ErrorAction SilentlyContinue',
      'Get-WinEvent -LogName Application -MaxEvents 5 -ErrorAction SilentlyContinue',
      'Get-WinEvent -ListLog * -ErrorAction SilentlyContinue | Select-Object -First 5',

      // ── 7. scheduled tasks ────────────────────────────────────────
      { section: 'scheduled tasks', cmd: 'Get-ScheduledTask -ErrorAction SilentlyContinue' },
      'Get-ScheduledTask | Format-Table TaskName, State -AutoSize',
      'Get-ScheduledTask | Where-Object { $_.State -eq "Ready" }',
      '(Get-ScheduledTask | Measure-Object).Count',
      'Register-ScheduledTask -TaskName "DebugTask1" -Action (New-ScheduledTaskAction -Execute "calc.exe") -Trigger (New-ScheduledTaskTrigger -Daily -At "09:00") -Force',
      'Register-ScheduledTask -TaskName "DebugTask2" -Action (New-ScheduledTaskAction -Execute "notepad.exe") -Trigger (New-ScheduledTaskTrigger -Daily -At "10:30") -Force',
      'Get-ScheduledTask | Where-Object { $_.TaskName -like "DebugTask*" }',
      'Unregister-ScheduledTask -TaskName DebugTask1 -Confirm:$false',
      'Unregister-ScheduledTask -TaskName DebugTask2 -Confirm:$false',
      'Get-ScheduledTask | Where-Object { $_.TaskName -like "DebugTask*" }',

      // ── 8. final cleanup / state summary ──────────────────────────
      { section: 'summary', cmd: 'Get-Service | Group-Object Status | Sort-Object Name' },
      'Get-Process | Measure-Object -Property Handles -Sum -Average',
      'Get-Service -Name Spooler | Format-List *',
      'Stop-Service -Name bthserv -ErrorAction SilentlyContinue',

      // ── 9. extra probes ──────────────────────────────────────────
      { section: 'extra probes', cmd: 'Get-Service | Where-Object { $_.DisplayName -match "Print" }' },
      'Get-Service | Sort-Object DisplayName | Select-Object -First 5 DisplayName, Name, Status',
      'Get-Process | Where-Object { $_.Name -like "s*" } | Select-Object Name, Id -First 5',
      'Get-Process | Sort-Object Id | Select-Object -First 5',
      'Get-Process | Where-Object { $_.Handles -gt 100 } | Select-Object Name, Id, Handles -First 5',
    ];

    await runAndDump('ps-services-processes-pc', commands, psPc,
      'host=WIN-SVC-DBG (windows-pc)');
    await runAndDump('ps-services-processes-server', commands, psSrv,
      'host=SRV-SVC-DBG (windows-server)');
    expect(commands.length).toBeGreaterThanOrEqual(100);
  }, 240_000);
});
