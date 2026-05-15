/**
 * Debug run — cmd ↔ PowerShell users & groups coherence.
 *
 * `net user`, `net localgroup` (cmd) and `Get-LocalUser`,
 * `New-LocalUser`, `Add-LocalGroupMember`, etc. (PowerShell) all
 * mutate the SAME account database on the device.  This script
 * interleaves operations and read-backs from both shells to expose
 * any divergence in user / group / membership state.
 *
 * Transcripts →
 *   debug-output/coherence-users-groups-pc_results_debug.txt
 *   debug-output/coherence-users-groups-server_results_debug.txt
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

describe('debug — cmd ↔ PowerShell users & groups coherence', () => {
  it('exercises users/groups from both shells', async () => {
    const pc = new WindowsPC('windows-pc', 'WIN-USR-COH');
    const srv = new WindowsPC('windows-server', 'SRV-USR-COH');
    pc.setCurrentUser('Administrator');
    srv.setCurrentUser('Administrator');

    const commands: CoherenceCommand[] = [
      // ── 1. baseline enumeration ──────────────────────────────────
      { section: 'baseline', shell: 'cmd', cmd: 'net user' },
      { shell: 'cmd', cmd: 'net localgroup' },
      { shell: 'ps',  cmd: 'Get-LocalUser' },
      { shell: 'ps',  cmd: 'Get-LocalGroup' },
      { shell: 'ps',  cmd: '(Get-LocalUser).Count' },
      { shell: 'ps',  cmd: '(Get-LocalGroup).Count' },
      { shell: 'cmd', cmd: 'whoami' },
      { shell: 'ps',  cmd: 'whoami' },
      { shell: 'ps',  cmd: '$env:USERNAME' },
      { shell: 'cmd', cmd: 'echo %USERNAME%' },

      // ── 2. inspect a built-in account ────────────────────────────
      { section: 'built-in account',
        shell: 'cmd', cmd: 'net user Administrator' },
      { shell: 'ps',  cmd: 'Get-LocalUser -Name Administrator' },
      { shell: 'ps',  cmd: '(Get-LocalUser -Name Administrator).Enabled' },
      { shell: 'ps',  cmd: '(Get-LocalUser -Name Administrator).FullName' },
      { shell: 'cmd', cmd: 'net localgroup Administrators' },
      { shell: 'ps',  cmd: 'Get-LocalGroupMember -Group Administrators' },

      // ── 3. create user via cmd, observe via ps ───────────────────
      { section: 'net user /add (cmd) → Get-LocalUser (ps)',
        shell: 'cmd', cmd: 'net user alice "" /add' },
      { shell: 'cmd', cmd: 'net user alice' },
      { shell: 'ps',  cmd: 'Get-LocalUser -Name alice' },
      { shell: 'ps',  cmd: '(Get-LocalUser -Name alice).Enabled' },
      { shell: 'cmd', cmd: 'net user bob "" /add /fullname:"Bob Builder"' },
      { shell: 'ps',  cmd: '(Get-LocalUser -Name bob).FullName' },
      { shell: 'cmd', cmd: 'net user carol "" /add /comment:"QA tester"' },
      { shell: 'ps',  cmd: '(Get-LocalUser -Name carol).Description' },

      // ── 4. create user via ps, observe via cmd ───────────────────
      { section: 'New-LocalUser (ps) → net user (cmd)',
        shell: 'ps',  cmd: 'New-LocalUser -Name dave -NoPassword -FullName "Dave PS"' },
      { shell: 'cmd', cmd: 'net user dave' },
      { shell: 'cmd', cmd: 'net user | findstr dave' },
      { shell: 'ps',  cmd: 'New-LocalUser -Name erin -NoPassword -Description "From PS"' },
      { shell: 'cmd', cmd: 'net user erin' },
      { shell: 'ps',  cmd: 'New-LocalUser -Name frank -NoPassword' },
      { shell: 'cmd', cmd: 'net user frank' },

      // ── 5. mutate user (cmd) → check (ps) ────────────────────────
      { section: 'mutate (cmd) → check (ps)',
        shell: 'cmd', cmd: 'net user alice /fullname:"Alice CMD"' },
      { shell: 'ps',  cmd: '(Get-LocalUser -Name alice).FullName' },
      { shell: 'cmd', cmd: 'net user alice /comment:"lead dev"' },
      { shell: 'ps',  cmd: '(Get-LocalUser -Name alice).Description' },
      { shell: 'cmd', cmd: 'net user alice /active:no' },
      { shell: 'ps',  cmd: '(Get-LocalUser -Name alice).Enabled' },
      { shell: 'cmd', cmd: 'net user alice /active:yes' },
      { shell: 'ps',  cmd: '(Get-LocalUser -Name alice).Enabled' },

      // ── 6. mutate user (ps) → check (cmd) ────────────────────────
      { section: 'mutate (ps) → check (cmd)',
        shell: 'ps',  cmd: 'Set-LocalUser -Name bob -FullName "Robert PS-Set"' },
      { shell: 'cmd', cmd: 'net user bob | findstr /i "Full Name"' },
      { shell: 'ps',  cmd: 'Set-LocalUser -Name bob -Description "Set from PS"' },
      { shell: 'cmd', cmd: 'net user bob | findstr /i Comment' },
      { shell: 'ps',  cmd: 'Disable-LocalUser -Name carol -ErrorAction SilentlyContinue' },
      { shell: 'cmd', cmd: 'net user carol | findstr /i "Account active"' },
      { shell: 'ps',  cmd: 'Enable-LocalUser -Name carol -ErrorAction SilentlyContinue' },
      { shell: 'cmd', cmd: 'net user carol | findstr /i "Account active"' },

      // ── 7. groups: create cross-shell ────────────────────────────
      { section: 'create groups',
        shell: 'cmd', cmd: 'net localgroup Developers /add /comment:"Dev team"' },
      { shell: 'ps',  cmd: 'Get-LocalGroup -Name Developers' },
      { shell: 'ps',  cmd: '(Get-LocalGroup -Name Developers).Description' },
      { shell: 'cmd', cmd: 'net localgroup QA /add' },
      { shell: 'ps',  cmd: 'Get-LocalGroup -Name QA' },
      { shell: 'ps',  cmd: 'New-LocalGroup -Name Ops -Description "Operations"' },
      { shell: 'cmd', cmd: 'net localgroup Ops' },
      { shell: 'ps',  cmd: 'New-LocalGroup -Name Security' },
      { shell: 'cmd', cmd: 'net localgroup | findstr Security' },

      // ── 8. membership cross-shell ────────────────────────────────
      { section: 'add member (cmd) → list (ps)',
        shell: 'cmd', cmd: 'net localgroup Developers alice /add' },
      { shell: 'cmd', cmd: 'net localgroup Developers bob /add' },
      { shell: 'cmd', cmd: 'net localgroup Developers' },
      { shell: 'ps',  cmd: 'Get-LocalGroupMember -Group Developers' },
      { shell: 'ps',  cmd: 'Get-LocalGroupMember -Group Developers | Select-Object -ExpandProperty Name' },
      { shell: 'ps',  cmd: '(Get-LocalGroupMember -Group Developers).Count' },

      { section: 'Add-LocalGroupMember (ps) → list (cmd)',
        shell: 'ps',  cmd: 'Add-LocalGroupMember -Group QA -Member carol' },
      { shell: 'ps',  cmd: 'Add-LocalGroupMember -Group QA -Member dave' },
      { shell: 'cmd', cmd: 'net localgroup QA' },
      { shell: 'ps',  cmd: 'Add-LocalGroupMember -Group Ops -Member erin' },
      { shell: 'cmd', cmd: 'net localgroup Ops' },

      // ── 9. removal cross-shell ──────────────────────────────────
      { section: 'remove (cmd) → list (ps)',
        shell: 'cmd', cmd: 'net localgroup Developers bob /delete' },
      { shell: 'ps',  cmd: 'Get-LocalGroupMember -Group Developers' },
      { shell: 'cmd', cmd: 'net localgroup QA dave /delete' },
      { shell: 'ps',  cmd: 'Get-LocalGroupMember -Group QA' },
      { section: 'Remove-LocalGroupMember (ps) → list (cmd)',
        shell: 'ps',  cmd: 'Remove-LocalGroupMember -Group Ops -Member erin' },
      { shell: 'cmd', cmd: 'net localgroup Ops' },
      { shell: 'ps',  cmd: 'Remove-LocalGroupMember -Group Developers -Member alice' },
      { shell: 'cmd', cmd: 'net localgroup Developers' },

      // ── 10. delete user / group cross-shell ──────────────────────
      { section: 'delete (cmd) → check (ps)',
        shell: 'cmd', cmd: 'net user frank /delete' },
      { shell: 'ps',  cmd: 'Get-LocalUser -Name frank -ErrorAction SilentlyContinue' },
      { shell: 'cmd', cmd: 'net localgroup Security /delete' },
      { shell: 'ps',  cmd: 'Get-LocalGroup -Name Security -ErrorAction SilentlyContinue' },
      { section: 'delete (ps) → check (cmd)',
        shell: 'ps',  cmd: 'Remove-LocalUser -Name dave' },
      { shell: 'cmd', cmd: 'net user dave' },
      { shell: 'ps',  cmd: 'Remove-LocalGroup -Name Ops' },
      { shell: 'cmd', cmd: 'net localgroup Ops' },

      // ── 11. cross-check membership counts ────────────────────────
      { section: 'final state checks',
        shell: 'cmd', cmd: 'net user' },
      { shell: 'ps',  cmd: 'Get-LocalUser | Sort-Object Name' },
      { shell: 'cmd', cmd: 'net localgroup' },
      { shell: 'ps',  cmd: 'Get-LocalGroup | Sort-Object Name' },
      { shell: 'ps',  cmd: '(Get-LocalUser).Count' },
      { shell: 'ps',  cmd: '(Get-LocalGroup).Count' },

      // ── 12. discover / help / aliases ────────────────────────────
      { section: 'discovery',
        shell: 'ps',  cmd: 'Get-Command -Noun LocalUser -ErrorAction SilentlyContinue | Select-Object Name' },
      { shell: 'ps',  cmd: 'Get-Command -Noun LocalGroup -ErrorAction SilentlyContinue | Select-Object Name' },
      { shell: 'ps',  cmd: 'gcm New-LocalUser' },
      { shell: 'ps',  cmd: 'gcm Add-LocalGroupMember' },
      { shell: 'ps',  cmd: 'Get-Alias whoami' },
      { shell: 'ps',  cmd: 'Get-Help Get-LocalUser -ErrorAction SilentlyContinue' },
      { shell: 'cmd', cmd: 'help net' },
      { shell: 'cmd', cmd: 'net help user' },

      // ── 13. cleanup ──────────────────────────────────────────────
      { section: 'cleanup',
        shell: 'cmd', cmd: 'net user alice /delete' },
      { shell: 'cmd', cmd: 'net user bob /delete' },
      { shell: 'cmd', cmd: 'net user carol /delete' },
      { shell: 'cmd', cmd: 'net user erin /delete' },
      { shell: 'cmd', cmd: 'net localgroup Developers /delete' },
      { shell: 'cmd', cmd: 'net localgroup QA /delete' },
      { shell: 'ps',  cmd: 'Get-LocalUser | Where-Object { $_.Name -in @("alice","bob","carol","erin") }' },
      { shell: 'ps',  cmd: 'Get-LocalGroup | Where-Object { $_.Name -in @("Developers","QA") }' },
    ];

    expect(commands.length).toBeGreaterThanOrEqual(100);

    const psPc = createPSRunner(pc);
    const cmdPc = createCmdRunner(pc);
    await runCoherenceDump('coherence-users-groups-pc', commands, psPc, cmdPc,
      'host=WIN-USR-COH (windows-pc)');

    const psSrv = createPSRunner(srv);
    const cmdSrv = createCmdRunner(srv);
    await runCoherenceDump('coherence-users-groups-server', commands, psSrv, cmdSrv,
      'host=SRV-USR-COH (windows-server)');
  }, 240_000);
});
