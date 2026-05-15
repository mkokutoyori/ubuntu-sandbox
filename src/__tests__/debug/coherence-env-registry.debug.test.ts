/**
 * Debug run — cmd ↔ PowerShell environment-variable & registry coherence.
 *
 * Interleaves cmd.exe and PowerShell against the SAME Windows device.
 * Environment variables set via `set X=Y` MUST be readable via
 * `$env:X`, and PowerShell scope changes MUST surface to cmd's `set`.
 * Registry mutations (reg add / Set-ItemProperty) MUST be visible on
 * both sides.  Each "do" is paired with a "read-back" from the other
 * shell so the transcript can be eyeballed for divergence.
 *
 * Two machines are instantiated (`windows-pc`, `windows-server`) and
 * the same command list runs on each.
 *
 * Transcripts →
 *   debug-output/coherence-env-registry-pc_results_debug.txt
 *   debug-output/coherence-env-registry-server_results_debug.txt
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

describe('debug — cmd ↔ PowerShell env & registry coherence', () => {
  it('exercises env/registry from both shells on PC + Server', async () => {
    const pc = new WindowsPC('windows-pc', 'WIN-ENV-DBG');
    const srv = new WindowsPC('windows-server', 'SRV-ENV-DBG');
    pc.setCurrentUser('Administrator');
    srv.setCurrentUser('Administrator');

    const commands: CoherenceCommand[] = [
      // ── 1. baseline env enumeration ──────────────────────────────
      { section: 'baseline env', shell: 'cmd', cmd: 'set' },
      { shell: 'cmd', cmd: 'echo %PATH%' },
      { shell: 'cmd', cmd: 'echo %USERNAME%' },
      { shell: 'cmd', cmd: 'echo %COMPUTERNAME%' },
      { shell: 'cmd', cmd: 'echo %SystemRoot%' },
      { shell: 'cmd', cmd: 'echo %TEMP%' },
      { shell: 'cmd', cmd: 'echo %USERPROFILE%' },
      { shell: 'ps',  cmd: '$env:PATH' },
      { shell: 'ps',  cmd: '$env:USERNAME' },
      { shell: 'ps',  cmd: '$env:COMPUTERNAME' },
      { shell: 'ps',  cmd: '$env:SystemRoot' },
      { shell: 'ps',  cmd: '$env:TEMP' },
      { shell: 'ps',  cmd: '$env:USERPROFILE' },
      { shell: 'ps',  cmd: 'Get-ChildItem Env: | Sort-Object Name | Select-Object -First 10' },
      { shell: 'ps',  cmd: '(Get-ChildItem Env:).Count' },

      // ── 2. coherence: %USERNAME% ↔ $env:USERNAME ─────────────────
      { section: 'identity coherence',
        shell: 'cmd', cmd: 'whoami' },
      { shell: 'ps',  cmd: 'whoami' },
      { shell: 'ps',  cmd: '[Environment]::UserName' },
      { shell: 'cmd', cmd: 'hostname' },
      { shell: 'ps',  cmd: 'hostname' },
      { shell: 'ps',  cmd: '[Environment]::MachineName' },

      // ── 3. set in cmd → read in ps ───────────────────────────────
      { section: 'set (cmd) → read (ps)',
        shell: 'cmd', cmd: 'set DBG_FROM_CMD=hello' },
      { shell: 'cmd', cmd: 'set DBG_FROM_CMD' },
      { shell: 'cmd', cmd: 'echo %DBG_FROM_CMD%' },
      { shell: 'ps',  cmd: '$env:DBG_FROM_CMD' },
      { shell: 'ps',  cmd: 'Get-Item Env:DBG_FROM_CMD' },
      { shell: 'cmd', cmd: 'set DBG_FROM_CMD=updated' },
      { shell: 'ps',  cmd: '$env:DBG_FROM_CMD' },
      { shell: 'cmd', cmd: 'set DBG_FROM_CMD=' },
      { shell: 'ps',  cmd: '$env:DBG_FROM_CMD' },

      // ── 4. Set-Item Env: in ps → read in cmd ─────────────────────
      { section: 'Set-Item Env: (ps) → read (cmd)',
        shell: 'ps',  cmd: 'Set-Item -Path Env:DBG_FROM_PS -Value "world"' },
      { shell: 'ps',  cmd: '$env:DBG_FROM_PS' },
      { shell: 'cmd', cmd: 'echo %DBG_FROM_PS%' },
      { shell: 'cmd', cmd: 'set DBG_FROM_PS' },
      { shell: 'ps',  cmd: '$env:DBG_FROM_PS = "world2"' },
      { shell: 'cmd', cmd: 'echo %DBG_FROM_PS%' },
      { shell: 'ps',  cmd: 'Remove-Item Env:DBG_FROM_PS' },
      { shell: 'cmd', cmd: 'echo %DBG_FROM_PS%' },

      // ── 5. PATH manipulation cross-shell ─────────────────────────
      { section: 'PATH manipulation',
        shell: 'cmd', cmd: 'set PATH=%PATH%;C:\\AddedByCmd' },
      { shell: 'ps',  cmd: '$env:Path -split ";" | Where-Object { $_ -like "*AddedByCmd*" }' },
      { shell: 'ps',  cmd: '$env:Path += ";C:\\AddedByPs"' },
      { shell: 'cmd', cmd: 'echo %PATH%' },
      { shell: 'cmd', cmd: 'set PATH | findstr AddedByPs' },

      // ── 6. setx-style persistent (best-effort) ───────────────────
      { section: 'setx (persistent best-effort)',
        shell: 'cmd', cmd: 'setx DBG_PERSIST_CMD "persist-from-cmd"' },
      { shell: 'ps',  cmd: '[Environment]::GetEnvironmentVariable("DBG_PERSIST_CMD","User")' },
      { shell: 'ps',  cmd: '[Environment]::SetEnvironmentVariable("DBG_PERSIST_PS","persist-from-ps","User")' },
      { shell: 'cmd', cmd: 'reg query "HKCU\\Environment" /v DBG_PERSIST_PS' },
      { shell: 'ps',  cmd: '[Environment]::SetEnvironmentVariable("DBG_PERSIST_CMD",$null,"User")' },
      { shell: 'ps',  cmd: '[Environment]::SetEnvironmentVariable("DBG_PERSIST_PS",$null,"User")' },

      // ── 7. baseline registry enumeration ─────────────────────────
      { section: 'baseline registry',
        shell: 'cmd', cmd: 'reg query HKCU\\Software' },
      { shell: 'ps',  cmd: 'Get-ChildItem HKCU:\\Software -ErrorAction SilentlyContinue | Select-Object -First 5' },
      { shell: 'ps',  cmd: 'Test-Path HKCU:\\Software' },
      { shell: 'ps',  cmd: 'Test-Path HKLM:\\Software' },
      { shell: 'cmd', cmd: 'reg query HKLM\\Software' },

      // ── 8. reg add via cmd → read in ps ──────────────────────────
      { section: 'reg add (cmd) → read (ps)',
        shell: 'cmd', cmd: 'reg add HKCU\\Software\\CohReg /f' },
      { shell: 'cmd', cmd: 'reg query HKCU\\Software\\CohReg' },
      { shell: 'ps',  cmd: 'Test-Path HKCU:\\Software\\CohReg' },
      { shell: 'cmd', cmd: 'reg add HKCU\\Software\\CohReg /v Version /t REG_SZ /d "1.0.0" /f' },
      { shell: 'cmd', cmd: 'reg add HKCU\\Software\\CohReg /v Build /t REG_DWORD /d 42 /f' },
      { shell: 'cmd', cmd: 'reg query HKCU\\Software\\CohReg' },
      { shell: 'ps',  cmd: 'Get-ItemProperty -Path HKCU:\\Software\\CohReg' },
      { shell: 'ps',  cmd: '(Get-ItemProperty -Path HKCU:\\Software\\CohReg).Version' },
      { shell: 'ps',  cmd: '(Get-ItemProperty -Path HKCU:\\Software\\CohReg).Build' },

      // ── 9. Set-ItemProperty via ps → read in cmd ─────────────────
      { section: 'Set-ItemProperty (ps) → read (cmd)',
        shell: 'ps',  cmd: 'Set-ItemProperty -Path HKCU:\\Software\\CohReg -Name "InstallPath" -Value "C:\\CohReg"' },
      { shell: 'ps',  cmd: 'Set-ItemProperty -Path HKCU:\\Software\\CohReg -Name "Enabled" -Value 1 -Type DWord' },
      { shell: 'cmd', cmd: 'reg query HKCU\\Software\\CohReg /v InstallPath' },
      { shell: 'cmd', cmd: 'reg query HKCU\\Software\\CohReg /v Enabled' },
      { shell: 'cmd', cmd: 'reg query HKCU\\Software\\CohReg' },

      // ── 10. nested keys and round-trips ──────────────────────────
      { section: 'nested keys',
        shell: 'ps',  cmd: 'New-Item -Path HKCU:\\Software\\CohReg\\Sub -Force' },
      { shell: 'ps',  cmd: 'Set-ItemProperty -Path HKCU:\\Software\\CohReg\\Sub -Name "Lang" -Value "fr-FR"' },
      { shell: 'cmd', cmd: 'reg query HKCU\\Software\\CohReg\\Sub /v Lang' },
      { shell: 'cmd', cmd: 'reg add HKCU\\Software\\CohReg\\Sub /v Theme /t REG_SZ /d "dark" /f' },
      { shell: 'ps',  cmd: '(Get-ItemProperty HKCU:\\Software\\CohReg\\Sub).Theme' },
      { shell: 'cmd', cmd: 'reg query HKCU\\Software\\CohReg /s' },
      { shell: 'ps',  cmd: 'Get-ChildItem HKCU:\\Software\\CohReg -Recurse' },

      // ── 11. delete from cmd, observe from ps ─────────────────────
      { section: 'reg delete (cmd) → read (ps)',
        shell: 'cmd', cmd: 'reg delete HKCU\\Software\\CohReg /v Build /f' },
      { shell: 'ps',  cmd: '(Get-ItemProperty HKCU:\\Software\\CohReg).Build' },
      { shell: 'cmd', cmd: 'reg delete HKCU\\Software\\CohReg\\Sub /f' },
      { shell: 'ps',  cmd: 'Test-Path HKCU:\\Software\\CohReg\\Sub' },

      // ── 12. Remove from ps, observe from cmd ─────────────────────
      { section: 'Remove-ItemProperty (ps) → read (cmd)',
        shell: 'ps',  cmd: 'Remove-ItemProperty -Path HKCU:\\Software\\CohReg -Name "Enabled" -ErrorAction SilentlyContinue' },
      { shell: 'cmd', cmd: 'reg query HKCU\\Software\\CohReg /v Enabled' },
      { shell: 'ps',  cmd: 'Clear-ItemProperty -Path HKCU:\\Software\\CohReg -Name "InstallPath" -ErrorAction SilentlyContinue' },
      { shell: 'cmd', cmd: 'reg query HKCU\\Software\\CohReg /v InstallPath' },

      // ── 13. HKLM coherence ───────────────────────────────────────
      { section: 'HKLM coherence',
        shell: 'cmd', cmd: 'reg add HKLM\\Software\\CohReg /v Site /t REG_SZ /d "main" /f' },
      { shell: 'ps',  cmd: '(Get-ItemProperty HKLM:\\Software\\CohReg).Site' },
      { shell: 'ps',  cmd: 'Set-ItemProperty -Path HKLM:\\Software\\CohReg -Name "Tier" -Value "prod"' },
      { shell: 'cmd', cmd: 'reg query HKLM\\Software\\CohReg' },
      { shell: 'cmd', cmd: 'reg delete HKLM\\Software\\CohReg /f' },
      { shell: 'ps',  cmd: 'Test-Path HKLM:\\Software\\CohReg' },

      // ── 14. utility / discovery cmdlets ──────────────────────────
      { section: 'discovery',
        shell: 'ps',  cmd: 'Get-Command -Noun ItemProperty -ErrorAction SilentlyContinue | Select-Object -First 5 Name' },
      { shell: 'ps',  cmd: 'gcm Get-ItemProperty' },
      { shell: 'ps',  cmd: 'gcm Set-Item' },
      { shell: 'ps',  cmd: 'Get-Alias %' },
      { shell: 'ps',  cmd: 'Get-Variable PSVersionTable' },
      { shell: 'ps',  cmd: '$PSVersionTable' },
      { shell: 'ps',  cmd: 'Get-Help Set-ItemProperty -ErrorAction SilentlyContinue' },
      { shell: 'ps',  cmd: 'Get-PSProvider' },
      { shell: 'cmd', cmd: 'ver' },
      { shell: 'cmd', cmd: 'help reg' },
      { shell: 'cmd', cmd: 'help set' },

      // ── 15. cleanup ──────────────────────────────────────────────
      { section: 'cleanup',
        shell: 'ps',  cmd: 'Remove-Item HKCU:\\Software\\CohReg -Recurse -ErrorAction SilentlyContinue' },
      { shell: 'cmd', cmd: 'reg query HKCU\\Software\\CohReg' },
      { shell: 'cmd', cmd: 'set DBG_PERSIST_CMD=' },
    ];

    expect(commands.length).toBeGreaterThanOrEqual(100);

    const psPc = createPSRunner(pc);
    const cmdPc = createCmdRunner(pc);
    await runCoherenceDump('coherence-env-registry-pc', commands, psPc, cmdPc,
      'host=WIN-ENV-DBG (windows-pc)');

    const psSrv = createPSRunner(srv);
    const cmdSrv = createCmdRunner(srv);
    await runCoherenceDump('coherence-env-registry-server', commands, psSrv, cmdSrv,
      'host=SRV-ENV-DBG (windows-server)');
  }, 240_000);
});
