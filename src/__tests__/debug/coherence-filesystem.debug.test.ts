/**
 * Debug run — cmd ↔ PowerShell filesystem coherence.
 *
 * Interleaves cmd.exe and PowerShell commands against the SAME Windows
 * device.  Both shells share the same underlying VFS, so any mutation
 * (mkdir, copy, move, del, ren) made on one side MUST be visible from
 * the other.  The transcript pairs each "do" with a "read-back" from
 * the opposite shell so reviewers can eyeball coherence.
 *
 * Each script spins up a `windows-pc` AND a `windows-server`; the same
 * command list is replayed on both.
 *
 * Transcripts →
 *   debug-output/coherence-filesystem-pc_results_debug.txt
 *   debug-output/coherence-filesystem-server_results_debug.txt
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

describe('debug — cmd ↔ PowerShell filesystem coherence', () => {
  it('exercises filesystem ops from both shells on PC + Server', async () => {
    const pc = new WindowsPC('windows-pc', 'WIN-FSC-DBG');
    const srv = new WindowsPC('windows-server', 'SRV-FSC-DBG');
    pc.setCurrentUser('Administrator');
    srv.setCurrentUser('Administrator');

    const commands: CoherenceCommand[] = [
      // ── 1. baseline directory listing in both engines ────────────
      { section: 'baseline listing', shell: 'cmd', cmd: 'cd C:\\' },
      { shell: 'cmd', cmd: 'dir C:\\' },
      { shell: 'ps',  cmd: 'Set-Location C:\\' },
      { shell: 'ps',  cmd: 'Get-ChildItem C:\\' },
      { shell: 'ps',  cmd: 'ls C:\\' },
      { shell: 'ps',  cmd: 'dir C:\\' },
      { shell: 'cmd', cmd: 'cd' },
      { shell: 'ps',  cmd: 'Get-Location' },
      { shell: 'ps',  cmd: 'pwd' },
      { shell: 'cmd', cmd: 'echo %CD%' },

      // ── 2. mkdir from cmd, observed from PS ──────────────────────
      { section: 'mkdir (cmd) → read (ps)', shell: 'cmd', cmd: 'mkdir C:\\CohFs' },
      { shell: 'cmd', cmd: 'dir C:\\ | findstr CohFs' },
      { shell: 'ps',  cmd: 'Test-Path C:\\CohFs' },
      { shell: 'ps',  cmd: 'Get-Item C:\\CohFs | Format-List Name, FullName, Mode' },
      { shell: 'ps',  cmd: '(Get-Item C:\\CohFs).PSIsContainer' },
      { shell: 'cmd', cmd: 'mkdir C:\\CohFs\\sub1' },
      { shell: 'cmd', cmd: 'mkdir C:\\CohFs\\sub2' },
      { shell: 'cmd', cmd: 'mkdir C:\\CohFs\\sub1\\nested' },
      { shell: 'ps',  cmd: 'Get-ChildItem C:\\CohFs' },
      { shell: 'ps',  cmd: '(Get-ChildItem C:\\CohFs -Recurse -Directory).Count' },

      // ── 3. mkdir / New-Item from PS, observed from cmd ──────────
      { section: 'New-Item (ps) → read (cmd)',
        shell: 'ps',  cmd: 'New-Item -Path C:\\CohFs\\fromPS -ItemType Directory' },
      { shell: 'ps',  cmd: 'New-Item -Path C:\\CohFs\\fromPS\\inner -ItemType Directory' },
      { shell: 'cmd', cmd: 'dir C:\\CohFs' },
      { shell: 'cmd', cmd: 'dir C:\\CohFs\\fromPS' },
      { shell: 'cmd', cmd: 'cd C:\\CohFs\\fromPS && cd' },

      // ── 4. file creation via redirection / Set-Content ───────────
      { section: 'create file (cmd) → read (ps)',
        shell: 'cmd', cmd: 'echo hello from cmd > C:\\CohFs\\fromCmd.txt' },
      { shell: 'cmd', cmd: 'type C:\\CohFs\\fromCmd.txt' },
      { shell: 'ps',  cmd: 'Test-Path C:\\CohFs\\fromCmd.txt' },
      { shell: 'ps',  cmd: 'Get-Content C:\\CohFs\\fromCmd.txt' },
      { shell: 'ps',  cmd: 'cat C:\\CohFs\\fromCmd.txt' },
      { shell: 'ps',  cmd: '(Get-Item C:\\CohFs\\fromCmd.txt).Length' },

      { section: 'create file (ps) → read (cmd)',
        shell: 'ps',  cmd: 'Set-Content -Path C:\\CohFs\\fromPs.txt -Value "hello from ps"' },
      { shell: 'cmd', cmd: 'type C:\\CohFs\\fromPs.txt' },
      { shell: 'cmd', cmd: 'dir C:\\CohFs\\fromPs.txt' },
      { shell: 'cmd', cmd: 'more C:\\CohFs\\fromPs.txt' },

      // ── 5. append from each side, observed from the other ────────
      { section: 'append (cmd) → read (ps)',
        shell: 'cmd', cmd: 'echo line-2-from-cmd >> C:\\CohFs\\log.txt' },
      { shell: 'cmd', cmd: 'echo line-3-from-cmd >> C:\\CohFs\\log.txt' },
      { shell: 'ps',  cmd: 'Get-Content C:\\CohFs\\log.txt' },
      { shell: 'ps',  cmd: '(Get-Content C:\\CohFs\\log.txt).Count' },
      { section: 'append (ps) → read (cmd)',
        shell: 'ps',  cmd: 'Add-Content -Path C:\\CohFs\\log.txt -Value "line-4-from-ps"' },
      { shell: 'ps',  cmd: 'Add-Content -Path C:\\CohFs\\log.txt -Value "line-5-from-ps"' },
      { shell: 'cmd', cmd: 'type C:\\CohFs\\log.txt' },
      { shell: 'cmd', cmd: 'find /c "line-" C:\\CohFs\\log.txt' },

      // ── 6. copy cross-shell ───────────────────────────────────────
      { section: 'copy (cmd) → list (ps)',
        shell: 'cmd', cmd: 'copy C:\\CohFs\\fromCmd.txt C:\\CohFs\\copyByCmd.txt' },
      { shell: 'ps',  cmd: 'Test-Path C:\\CohFs\\copyByCmd.txt' },
      { shell: 'ps',  cmd: 'Get-Content C:\\CohFs\\copyByCmd.txt' },
      { section: 'Copy-Item (ps) → list (cmd)',
        shell: 'ps',  cmd: 'Copy-Item C:\\CohFs\\fromPs.txt C:\\CohFs\\copyByPs.txt' },
      { shell: 'cmd', cmd: 'dir C:\\CohFs\\copyByPs.txt' },
      { shell: 'cmd', cmd: 'type C:\\CohFs\\copyByPs.txt' },

      // ── 7. move / rename cross-shell ─────────────────────────────
      { section: 'move (cmd) → check (ps)',
        shell: 'cmd', cmd: 'move C:\\CohFs\\copyByCmd.txt C:\\CohFs\\movedByCmd.txt' },
      { shell: 'ps',  cmd: 'Test-Path C:\\CohFs\\copyByCmd.txt' },
      { shell: 'ps',  cmd: 'Test-Path C:\\CohFs\\movedByCmd.txt' },
      { shell: 'cmd', cmd: 'ren C:\\CohFs\\movedByCmd.txt renamedByCmd.txt' },
      { shell: 'ps',  cmd: 'Test-Path C:\\CohFs\\renamedByCmd.txt' },
      { section: 'Move-Item (ps) → check (cmd)',
        shell: 'ps',  cmd: 'Move-Item C:\\CohFs\\copyByPs.txt C:\\CohFs\\movedByPs.txt' },
      { shell: 'cmd', cmd: 'dir C:\\CohFs\\movedByPs.txt' },
      { shell: 'ps',  cmd: 'Rename-Item C:\\CohFs\\movedByPs.txt renamedByPs.txt' },
      { shell: 'cmd', cmd: 'dir C:\\CohFs\\renamedByPs.txt' },

      // ── 8. delete cross-shell ─────────────────────────────────────
      { section: 'delete (cmd) → check (ps)',
        shell: 'cmd', cmd: 'del C:\\CohFs\\renamedByCmd.txt' },
      { shell: 'ps',  cmd: 'Test-Path C:\\CohFs\\renamedByCmd.txt' },
      { section: 'Remove-Item (ps) → check (cmd)',
        shell: 'ps',  cmd: 'Remove-Item C:\\CohFs\\renamedByPs.txt' },
      { shell: 'cmd', cmd: 'dir C:\\CohFs\\renamedByPs.txt' },

      // ── 9. directory listing equivalences ────────────────────────
      { section: 'listing equivalences', shell: 'cmd', cmd: 'dir C:\\CohFs' },
      { shell: 'cmd', cmd: 'dir C:\\CohFs /b' },
      { shell: 'cmd', cmd: 'dir C:\\CohFs /s' },
      { shell: 'cmd', cmd: 'dir C:\\CohFs /a' },
      { shell: 'cmd', cmd: 'dir C:\\CohFs /od' },
      { shell: 'cmd', cmd: 'dir C:\\CohFs *.txt' },
      { shell: 'ps',  cmd: 'Get-ChildItem C:\\CohFs' },
      { shell: 'ps',  cmd: 'Get-ChildItem C:\\CohFs -Name' },
      { shell: 'ps',  cmd: 'Get-ChildItem C:\\CohFs -Recurse' },
      { shell: 'ps',  cmd: 'Get-ChildItem C:\\CohFs -File' },
      { shell: 'ps',  cmd: 'Get-ChildItem C:\\CohFs -Directory' },
      { shell: 'ps',  cmd: 'Get-ChildItem C:\\CohFs -Filter *.txt' },
      { shell: 'ps',  cmd: '(Get-ChildItem C:\\CohFs).Count' },

      // ── 10. file content equivalences ───────────────────────────
      { section: 'content equivalences',
        shell: 'cmd', cmd: 'echo first > C:\\CohFs\\multi.txt' },
      { shell: 'cmd', cmd: 'echo second >> C:\\CohFs\\multi.txt' },
      { shell: 'cmd', cmd: 'echo third  >> C:\\CohFs\\multi.txt' },
      { shell: 'cmd', cmd: 'type C:\\CohFs\\multi.txt' },
      { shell: 'cmd', cmd: 'more C:\\CohFs\\multi.txt' },
      { shell: 'ps',  cmd: 'Get-Content C:\\CohFs\\multi.txt' },
      { shell: 'ps',  cmd: 'Get-Content C:\\CohFs\\multi.txt -TotalCount 2' },
      { shell: 'ps',  cmd: 'Get-Content C:\\CohFs\\multi.txt -Tail 1' },
      { shell: 'ps',  cmd: 'type C:\\CohFs\\multi.txt' },

      // ── 11. cwd coherence (cd / Set-Location) ───────────────────
      { section: 'cwd coherence', shell: 'cmd', cmd: 'cd C:\\CohFs' },
      { shell: 'cmd', cmd: 'cd' },
      { shell: 'ps',  cmd: 'Get-Location' },
      { shell: 'ps',  cmd: 'Set-Location C:\\CohFs\\sub1' },
      { shell: 'ps',  cmd: 'pwd' },
      { shell: 'cmd', cmd: 'cd' },
      { shell: 'cmd', cmd: 'cd ..' },
      { shell: 'ps',  cmd: 'Get-Location' },
      { shell: 'cmd', cmd: 'cd \\' },
      { shell: 'ps',  cmd: '(Get-Location).Path' },

      // ── 12. attrib / file metadata ───────────────────────────────
      { section: 'attributes',
        shell: 'cmd', cmd: 'echo data > C:\\CohFs\\attr.txt' },
      { shell: 'cmd', cmd: 'attrib C:\\CohFs\\attr.txt' },
      { shell: 'cmd', cmd: 'attrib +R C:\\CohFs\\attr.txt' },
      { shell: 'ps',  cmd: '(Get-Item C:\\CohFs\\attr.txt).Attributes' },
      { shell: 'ps',  cmd: '(Get-Item C:\\CohFs\\attr.txt).IsReadOnly' },
      { shell: 'cmd', cmd: 'attrib -R C:\\CohFs\\attr.txt' },
      { shell: 'ps',  cmd: '(Get-Item C:\\CohFs\\attr.txt).IsReadOnly' },

      // ── 13. drives & volume info ─────────────────────────────────
      { section: 'drives & volumes',
        shell: 'cmd', cmd: 'vol C:' },
      { shell: 'cmd', cmd: 'wmic logicaldisk get name' },
      { shell: 'ps',  cmd: 'Get-PSDrive' },
      { shell: 'ps',  cmd: 'Get-PSDrive C' },
      { shell: 'ps',  cmd: 'Get-Volume -ErrorAction SilentlyContinue' },
      { shell: 'ps',  cmd: 'Get-Disk -ErrorAction SilentlyContinue' },

      // ── 14. utility / discovery cmdlets ──────────────────────────
      { section: 'discovery',
        shell: 'ps',  cmd: 'Get-Command -Noun Item -ErrorAction SilentlyContinue | Select-Object -First 5 Name' },
      { shell: 'ps',  cmd: 'gcm Get-ChildItem' },
      { shell: 'ps',  cmd: 'Get-Alias ls' },
      { shell: 'ps',  cmd: 'Get-Alias dir' },
      { shell: 'ps',  cmd: 'Get-Alias type' },
      { shell: 'ps',  cmd: 'Get-Alias cd' },
      { shell: 'ps',  cmd: 'Get-Help Get-ChildItem -ErrorAction SilentlyContinue' },
      { shell: 'ps',  cmd: 'Get-Member -InputObject (Get-Item C:\\CohFs) -ErrorAction SilentlyContinue | Select-Object -First 5 Name, MemberType' },
      { shell: 'cmd', cmd: 'help dir' },
      { shell: 'cmd', cmd: 'help copy' },
      { shell: 'cmd', cmd: 'where cmd' },

      // ── 15. final state, then cleanup ────────────────────────────
      { section: 'final state', shell: 'cmd', cmd: 'dir C:\\CohFs /s' },
      { shell: 'ps',  cmd: 'Get-ChildItem C:\\CohFs -Recurse | Format-Table Mode, Length, Name -AutoSize' },
      { shell: 'ps',  cmd: 'Get-ChildItem C:\\CohFs -Recurse -File | Measure-Object -Property Length -Sum' },

      { section: 'cleanup', shell: 'cmd', cmd: 'rmdir /s /q C:\\CohFs' },
      { shell: 'ps',  cmd: 'Test-Path C:\\CohFs' },
      { shell: 'cmd', cmd: 'dir C:\\CohFs' },
    ];

    expect(commands.length).toBeGreaterThanOrEqual(100);

    const psPc = createPSRunner(pc);
    const cmdPc = createCmdRunner(pc);
    await runCoherenceDump('coherence-filesystem-pc', commands, psPc, cmdPc,
      'host=WIN-FSC-DBG (windows-pc)');

    const psSrv = createPSRunner(srv);
    const cmdSrv = createCmdRunner(srv);
    await runCoherenceDump('coherence-filesystem-server', commands, psSrv, cmdSrv,
      'host=SRV-FSC-DBG (windows-server)');
  }, 240_000);
});
