/**
 * Debug run — cmd ↔ PowerShell services & processes coherence.
 *
 * Both shells point at the SAME service manager / process table on
 * the device.  Therefore `sc start X` from cmd MUST be observed as
 * `Running` by `Get-Service X` in PS, and vice versa.  Same goes
 * for processes (`tasklist` / `Get-Process`, `taskkill` / `Stop-Process`).
 *
 * Transcripts →
 *   debug-output/coherence-services-processes-pc_results_debug.txt
 *   debug-output/coherence-services-processes-server_results_debug.txt
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import {
  runCoherenceDump,
  createPSRunner,
  createCmdRunner,
  type CoherenceCommand,
} from './_dump';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

describe('debug — cmd ↔ PowerShell services & processes coherence', () => {
  it('exercises services & processes from both shells', async () => {
    const pc = new WindowsPC('windows-pc', 'WIN-SP-DBG');
    const srv = new WindowsPC('windows-server', 'SRV-SP-DBG');
    pc.setCurrentUser('Administrator');
    srv.setCurrentUser('Administrator');

    const commands: CoherenceCommand[] = [
      // ── 1. baseline service enumeration ──────────────────────────
      { section: 'baseline services', shell: 'cmd', cmd: 'sc query type= service state= all' },
      { shell: 'cmd', cmd: 'sc query' },
      { shell: 'cmd', cmd: 'net start' },
      { shell: 'ps',  cmd: 'Get-Service' },
      { shell: 'ps',  cmd: 'Get-Service | Format-Table Name, Status, StartType -AutoSize' },
      { shell: 'ps',  cmd: '(Get-Service).Count' },
      { shell: 'ps',  cmd: '(Get-Service | Where-Object { $_.Status -eq "Running" }).Count' },
      { shell: 'cmd', cmd: 'sc query Spooler' },
      { shell: 'ps',  cmd: 'Get-Service -Name Spooler' },
      { shell: 'ps',  cmd: '(Get-Service -Name Spooler).Status' },

      // ── 2. stop Spooler via cmd, observe from ps ─────────────────
      { section: 'sc stop (cmd) → Get-Service (ps)',
        shell: 'cmd', cmd: 'sc stop Spooler' },
      { shell: 'cmd', cmd: 'sc query Spooler' },
      { shell: 'ps',  cmd: '(Get-Service -Name Spooler).Status' },
      { shell: 'ps',  cmd: 'Get-Service Spooler | Format-List Name, Status, StartType' },

      // ── 3. start Spooler via ps, observe from cmd ────────────────
      { section: 'Start-Service (ps) → sc query (cmd)',
        shell: 'ps',  cmd: 'Start-Service -Name Spooler' },
      { shell: 'cmd', cmd: 'sc query Spooler' },
      { shell: 'cmd', cmd: 'net start | findstr /i Spooler' },
      { shell: 'ps',  cmd: '(Get-Service -Name Spooler).Status' },

      // ── 4. net stop / net start coherence ────────────────────────
      { section: 'net stop / net start',
        shell: 'cmd', cmd: 'net stop Spooler' },
      { shell: 'ps',  cmd: '(Get-Service Spooler).Status' },
      { shell: 'cmd', cmd: 'net start Spooler' },
      { shell: 'ps',  cmd: '(Get-Service Spooler).Status' },
      { shell: 'ps',  cmd: 'Stop-Service -Name Spooler -ErrorAction SilentlyContinue' },
      { shell: 'cmd', cmd: 'sc query Spooler | findstr STATE' },
      { shell: 'ps',  cmd: 'Restart-Service -Name Spooler' },
      { shell: 'cmd', cmd: 'sc query Spooler | findstr STATE' },

      // ── 5. start type changes ────────────────────────────────────
      { section: 'startup type coherence',
        shell: 'cmd', cmd: 'sc config Spooler start= demand' },
      { shell: 'ps',  cmd: '(Get-Service Spooler).StartType' },
      { shell: 'ps',  cmd: 'Set-Service -Name Spooler -StartupType Automatic' },
      { shell: 'cmd', cmd: 'sc qc Spooler' },
      { shell: 'ps',  cmd: 'Set-Service -Name Spooler -StartupType Disabled' },
      { shell: 'cmd', cmd: 'sc qc Spooler' },
      { shell: 'ps',  cmd: 'Set-Service -Name Spooler -StartupType Manual' },

      // ── 6. service queries by name patterns ──────────────────────
      { section: 'name patterns',
        shell: 'cmd', cmd: 'sc query | findstr SERVICE_NAME' },
      { shell: 'ps',  cmd: 'Get-Service -Name "S*" | Format-Table Name, Status' },
      { shell: 'ps',  cmd: 'Get-Service -Name "*log*" | Format-Table Name, Status' },
      { shell: 'cmd', cmd: 'sc query bthserv' },
      { shell: 'ps',  cmd: 'Get-Service -Name bthserv' },

      // ── 7. baseline process enumeration ──────────────────────────
      { section: 'baseline processes',
        shell: 'cmd', cmd: 'tasklist' },
      { shell: 'cmd', cmd: 'tasklist /v' },
      { shell: 'cmd', cmd: 'tasklist /fo csv /nh' },
      { shell: 'ps',  cmd: 'Get-Process' },
      { shell: 'ps',  cmd: 'Get-Process | Format-Table Id, ProcessName, CPU -AutoSize' },
      { shell: 'ps',  cmd: '(Get-Process).Count' },
      { shell: 'ps',  cmd: 'ps' },
      { shell: 'ps',  cmd: 'gps' },

      // ── 8. start process via cmd, observe via ps ─────────────────
      { section: 'start (cmd) → Get-Process (ps)',
        shell: 'cmd', cmd: 'start notepad.exe' },
      { shell: 'cmd', cmd: 'tasklist /fi "imagename eq notepad.exe"' },
      { shell: 'ps',  cmd: 'Get-Process -Name notepad -ErrorAction SilentlyContinue' },
      { shell: 'cmd', cmd: 'start calc.exe' },
      { shell: 'ps',  cmd: 'Get-Process -Name calc -ErrorAction SilentlyContinue' },

      // ── 9. start process via ps, observe via cmd ─────────────────
      { section: 'Start-Process (ps) → tasklist (cmd)',
        shell: 'ps',  cmd: 'Start-Process notepad.exe' },
      { shell: 'cmd', cmd: 'tasklist /fi "imagename eq notepad.exe"' },
      { shell: 'ps',  cmd: 'Start-Process -FilePath cmd.exe' },
      { shell: 'cmd', cmd: 'tasklist /fi "imagename eq cmd.exe"' },

      // ── 10. taskkill ↔ Stop-Process ─────────────────────────────
      { section: 'taskkill (cmd) → check (ps)',
        shell: 'cmd', cmd: 'taskkill /im notepad.exe /f' },
      { shell: 'ps',  cmd: 'Get-Process -Name notepad -ErrorAction SilentlyContinue' },
      { shell: 'ps',  cmd: 'Stop-Process -Name calc -ErrorAction SilentlyContinue' },
      { shell: 'cmd', cmd: 'tasklist /fi "imagename eq calc.exe"' },

      // ── 11. process count coherence ──────────────────────────────
      { section: 'process counts',
        shell: 'cmd', cmd: 'tasklist | find /c "exe"' },
      { shell: 'ps',  cmd: '(Get-Process).Count' },
      { shell: 'cmd', cmd: 'tasklist /fi "imagename eq svchost.exe"' },
      { shell: 'ps',  cmd: '(Get-Process -Name svchost -ErrorAction SilentlyContinue).Count' },

      // ── 12. PID lookup coherence ─────────────────────────────────
      { section: 'PID lookup',
        shell: 'ps',  cmd: 'Start-Process notepad.exe' },
      { shell: 'ps',  cmd: 'Get-Process -Name notepad | Select-Object -First 1 Id, Name' },
      { shell: 'cmd', cmd: 'tasklist /fi "imagename eq notepad.exe" /fo csv /nh' },
      { shell: 'cmd', cmd: 'taskkill /im notepad.exe /f' },
      { shell: 'ps',  cmd: 'Get-Process -Name notepad -ErrorAction SilentlyContinue' },

      // ── 13. scheduled tasks (best-effort, cmd vs ps) ─────────────
      { section: 'scheduled tasks',
        shell: 'cmd', cmd: 'schtasks /query' },
      { shell: 'ps',  cmd: 'Get-ScheduledTask -ErrorAction SilentlyContinue | Select-Object -First 5 TaskName, State' },
      { shell: 'ps',  cmd: 'Register-ScheduledTask -TaskName "CohTask" -Action (New-ScheduledTaskAction -Execute "calc.exe") -Trigger (New-ScheduledTaskTrigger -Daily -At "09:00") -Force' },
      { shell: 'cmd', cmd: 'schtasks /query /tn CohTask' },
      { shell: 'cmd', cmd: 'schtasks /delete /tn CohTask /f' },
      { shell: 'ps',  cmd: 'Get-ScheduledTask -TaskName CohTask -ErrorAction SilentlyContinue' },

      // ── 14. event logs cross-shell ───────────────────────────────
      { section: 'event logs',
        shell: 'cmd', cmd: 'wevtutil el' },
      { shell: 'ps',  cmd: 'Get-EventLog -List -ErrorAction SilentlyContinue' },
      { shell: 'cmd', cmd: 'wevtutil qe System /c:3 /f:text' },
      { shell: 'ps',  cmd: 'Get-EventLog -LogName System -Newest 3 -ErrorAction SilentlyContinue' },
      { shell: 'ps',  cmd: 'Get-WinEvent -LogName System -MaxEvents 3 -ErrorAction SilentlyContinue' },

      // ── 15. service display name / description ──────────────────
      { section: 'service display name',
        shell: 'ps',  cmd: '(Get-Service -Name Spooler).DisplayName' },
      { shell: 'cmd', cmd: 'sc qdescription Spooler' },
      { shell: 'cmd', cmd: 'sc query Spooler | findstr DISPLAY_NAME' },
      { shell: 'ps',  cmd: 'Get-Service -DisplayName "Print Spooler"' },

      // ── 16. utility / discovery ─────────────────────────────────
      { section: 'discovery',
        shell: 'ps',  cmd: 'Get-Command -Noun Service -ErrorAction SilentlyContinue | Select-Object -First 5 Name' },
      { shell: 'ps',  cmd: 'gcm Get-Process' },
      { shell: 'ps',  cmd: 'gcm Stop-Service' },
      { shell: 'ps',  cmd: 'Get-Alias gsv' },
      { shell: 'ps',  cmd: 'Get-Alias ps' },
      { shell: 'ps',  cmd: 'Get-Alias kill' },
      { shell: 'ps',  cmd: 'Get-Help Get-Service -ErrorAction SilentlyContinue' },
      { shell: 'ps',  cmd: 'Get-Member -InputObject (Get-Service | Select-Object -First 1) -ErrorAction SilentlyContinue | Select-Object -First 5 Name, MemberType' },
      { shell: 'cmd', cmd: 'help sc' },
      { shell: 'cmd', cmd: 'help tasklist' },

      // ── 17. summary state ────────────────────────────────────────
      { section: 'summary',
        shell: 'cmd', cmd: 'sc query | find /c "SERVICE_NAME"' },
      { shell: 'ps',  cmd: '(Get-Service).Count' },
      { shell: 'cmd', cmd: 'tasklist | find /c "."' },
      { shell: 'ps',  cmd: 'Get-Process | Measure-Object | Select-Object Count' },
      { shell: 'ps',  cmd: 'Get-Service | Group-Object Status | Format-Table Name, Count -AutoSize' },
      { shell: 'ps',  cmd: 'Get-Service | Group-Object StartType | Sort-Object Count -Descending' },
      { shell: 'cmd', cmd: 'sc query | findstr STATE | find /c "RUNNING"' },
      { shell: 'ps',  cmd: 'Get-Process | Sort-Object WS -Descending | Select-Object -First 3 Name, Id, WS' },
      { shell: 'cmd', cmd: 'tasklist /fo csv /nh | find /c ","' },
    ];

    expect(commands.length).toBeGreaterThanOrEqual(100);

    const psPc = createPSRunner(pc);
    const cmdPc = createCmdRunner(pc);
    await runCoherenceDump('coherence-services-processes-pc', commands, psPc, cmdPc,
      'host=WIN-SP-DBG (windows-pc)');

    const psSrv = createPSRunner(srv);
    const cmdSrv = createCmdRunner(srv);
    await runCoherenceDump('coherence-services-processes-server', commands, psSrv, cmdSrv,
      'host=SRV-SP-DBG (windows-server)');
  }, 240_000);
});
