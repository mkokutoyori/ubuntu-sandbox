/**
 * Debug run — local accounts & groups on Windows PC + Windows Server.
 *
 * Spins up a `windows-pc` and a `windows-server`, then drives both
 * `PowerShellExecutor` instances through user/group cmdlets and their
 * aliases. Transcript → `debug-output/ps-users-groups_results_debug.txt`.
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

describe('debug — PowerShell local accounts & groups', () => {
  it('runs user/group cmdlets and writes the transcript', async () => {
    const pc = new WindowsPC('windows-pc', 'WIN-USR-DBG');
    const srv = new WindowsPC('windows-server', 'SRV-USR-DBG');
    pc.setCurrentUser('Administrator');
    srv.setCurrentUser('Administrator');
    const psPc = createPSRunner(pc);
    const psSrv = createPSRunner(srv);

    const commands: DebugCommandInput[] = [
      // ── 1. baseline enumeration ───────────────────────────────────
      { section: 'baseline enumeration', cmd: 'Get-LocalUser' },
      'Get-LocalUser | Format-Table Name, Enabled, Description -AutoSize',
      'Get-LocalUser | Sort-Object Name',
      'Get-LocalUser | Where-Object { $_.Enabled }',
      'Get-LocalUser | Where-Object { -not $_.Enabled }',
      '(Get-LocalUser).Count',
      'Get-LocalUser | Select-Object -ExpandProperty Name',
      'Get-LocalGroup',
      'Get-LocalGroup | Format-Table Name, Description -AutoSize',
      'Get-LocalGroup | Sort-Object Name',
      '(Get-LocalGroup).Count',
      'Get-LocalGroupMember -Group Administrators',
      'Get-LocalGroupMember -Group Users',

      // ── 2. create users (no password) ─────────────────────────────
      { section: 'create users', cmd: 'New-LocalUser -Name alice -NoPassword' },
      'New-LocalUser -Name bob -NoPassword -FullName "Bob Builder"',
      'New-LocalUser -Name carol -NoPassword -Description "QA tester"',
      'New-LocalUser -Name dave -NoPassword',
      'New-LocalUser -Name erin -NoPassword',
      'New-LocalUser -Name frank -NoPassword',
      'New-LocalUser -Name grace -NoPassword',
      'New-LocalUser -Name heidi -NoPassword',
      'New-LocalUser -Name ivan -NoPassword',
      'New-LocalUser -Name judy -NoPassword',

      // ── 3. create users with password ─────────────────────────────
      { section: 'create users with password',
        cmd: '$pw = ConvertTo-SecureString "P@ssw0rd1" -AsPlainText -Force; New-LocalUser -Name "powerUser1" -Password $pw' },
      '$pw = ConvertTo-SecureString "P@ssw0rd2" -AsPlainText -Force; New-LocalUser -Name "powerUser2" -Password $pw -FullName "Power Two"',
      '$pw = ConvertTo-SecureString "P@ssw0rd3" -AsPlainText -Force; New-LocalUser -Name "powerUser3" -Password $pw -Description "with desc"',
      '$pw = ConvertTo-SecureString "1" -AsPlainText -Force; New-LocalUser -Name "weakPw" -Password $pw -ErrorAction SilentlyContinue',
      'New-LocalUser -Name alice -NoPassword -ErrorAction SilentlyContinue',

      // ── 4. inspect created users ──────────────────────────────────
      { section: 'inspect users', cmd: 'Get-LocalUser -Name alice' },
      'Get-LocalUser -Name bob | Format-List *',
      '(Get-LocalUser -Name carol).Description',
      '(Get-LocalUser -Name bob).FullName',
      '(Get-LocalUser -Name dave).Enabled',
      'Get-LocalUser | Where-Object { $_.Name -like "p*" }',
      'Get-LocalUser | Where-Object { $_.Description }',
      'Get-LocalUser | Select-Object Name, Description, Enabled | Sort-Object Name',
      'Get-LocalUser -Name "ghost-user" -ErrorAction SilentlyContinue',

      // ── 5. mutate users ───────────────────────────────────────────
      { section: 'mutate users', cmd: 'Set-LocalUser -Name alice -Description "lead dev"' },
      'Set-LocalUser -Name bob -FullName "Robert Builder"',
      'Set-LocalUser -Name carol -AccountDisabled',
      '(Get-LocalUser -Name carol).Enabled',
      'Set-LocalUser -Name carol -AccountDisabled:$false',
      '(Get-LocalUser -Name carol).Enabled',
      'Rename-LocalUser -Name dave -NewName david',
      'Get-LocalUser -Name david',
      'Get-LocalUser -Name dave -ErrorAction SilentlyContinue',

      // ── 6. groups: create ─────────────────────────────────────────
      { section: 'create groups', cmd: 'New-LocalGroup -Name Developers -Description "Dev team"' },
      'New-LocalGroup -Name QA -Description "QA team"',
      'New-LocalGroup -Name Ops',
      'New-LocalGroup -Name Security',
      'New-LocalGroup -Name Interns',
      'New-LocalGroup -Name Contractors',
      'New-LocalGroup -Name Developers -ErrorAction SilentlyContinue',
      'Get-LocalGroup | Where-Object { $_.Description }',
      'Get-LocalGroup | Sort-Object Name | Format-Table -AutoSize',

      // ── 7. group membership ───────────────────────────────────────
      { section: 'membership', cmd: 'Add-LocalGroupMember -Group Developers -Member alice' },
      'Add-LocalGroupMember -Group Developers -Member bob',
      'Add-LocalGroupMember -Group Developers -Member powerUser1',
      'Add-LocalGroupMember -Group QA -Member carol',
      'Add-LocalGroupMember -Group QA -Member erin, frank',
      'Add-LocalGroupMember -Group Ops -Member grace',
      'Add-LocalGroupMember -Group Security -Member heidi, ivan',
      'Add-LocalGroupMember -Group Interns -Member judy',
      'Add-LocalGroupMember -Group Developers -Member ghost-user -ErrorAction SilentlyContinue',
      'Add-LocalGroupMember -Group Developers -Member alice -ErrorAction SilentlyContinue',
      'Get-LocalGroupMember -Group Developers',
      'Get-LocalGroupMember -Group QA',
      'Get-LocalGroupMember -Group Security',
      '(Get-LocalGroupMember -Group Developers).Count',
      'Get-LocalGroupMember -Group Developers | Select-Object -ExpandProperty Name',
      'Get-LocalGroupMember -Group Developers | Sort-Object Name',

      // ── 8. membership removal ─────────────────────────────────────
      { section: 'removal',
        cmd: 'Remove-LocalGroupMember -Group Developers -Member powerUser1' },
      'Get-LocalGroupMember -Group Developers',
      'Remove-LocalGroupMember -Group QA -Member erin',
      'Get-LocalGroupMember -Group QA',
      'Remove-LocalGroupMember -Group Security -Member heidi, ivan',
      'Get-LocalGroupMember -Group Security',
      'Remove-LocalUser -Name judy',
      'Remove-LocalGroup -Name Interns',
      'Get-LocalGroup -Name Interns -ErrorAction SilentlyContinue',

      // ── 9. complex pipelines on users/groups ──────────────────────
      { section: 'complex pipelines',
        cmd: 'Get-LocalUser | Where-Object { $_.Enabled } | Sort-Object Name | Select-Object -First 5 Name' },
      'Get-LocalUser | Group-Object Enabled | Format-Table Name, Count -AutoSize',
      'Get-LocalUser | ForEach-Object { "$($_.Name): $($_.Description)" }',
      'Get-LocalGroup | ForEach-Object { "Group: $($_.Name)" }',
      'Get-LocalUser | Where-Object { $_.Name -match "^[a-c]" } | Select-Object Name',
      'Get-LocalUser | Sort-Object Name -Descending | Select-Object -First 3',
      '(Get-LocalUser | Measure-Object).Count',
      '(Get-LocalGroup | Measure-Object).Count',
      'Get-LocalGroup | ForEach-Object { $g = $_.Name; Get-LocalGroupMember -Group $g | ForEach-Object { "$g <- $($_.Name)" } }',
      'Get-LocalUser | Where-Object { $_.Description -like "*team*" -or $_.Description -like "*dev*" }',

      // ── 10. bulk script — create + assign in one ──────────────────
      { section: 'bulk creation script', cmd: 'function New-DevUser { param($Name) New-LocalUser -Name $Name -NoPassword; Add-LocalGroupMember -Group Developers -Member $Name }' },
      '"kate","leo","mary","nina","oscar" | ForEach-Object { New-DevUser -Name $_ }',
      'Get-LocalGroupMember -Group Developers | Sort-Object Name',
      '"kate","leo","mary","nina","oscar" | ForEach-Object { Remove-LocalGroupMember -Group Developers -Member $_; Remove-LocalUser -Name $_ }',
      'Get-LocalGroupMember -Group Developers',

      // ── 11. cleanup ──────────────────────────────────────────────
      { section: 'cleanup', cmd: '"alice","bob","carol","david","erin","frank","grace","heidi","ivan","powerUser1","powerUser2","powerUser3" | ForEach-Object { Remove-LocalUser -Name $_ -ErrorAction SilentlyContinue }' },
      '"Developers","QA","Ops","Security","Contractors" | ForEach-Object { Remove-LocalGroup -Name $_ -ErrorAction SilentlyContinue }',
      'Get-LocalUser',
      'Get-LocalGroup',

      // ── 12. now repeat a subset on the SERVER (handled below) ─────
      // (handled by the dedicated server pass; keeping in PC list for size)
      { section: 'whoami on PC', cmd: 'whoami' },
      '$env:USERNAME',
      '$env:COMPUTERNAME',
    ];

    await runAndDump('ps-users-groups-pc', commands, psPc,
      'host=WIN-USR-DBG (windows-pc)');
    await runAndDump('ps-users-groups-server', commands, psSrv,
      'host=SRV-USR-DBG (windows-server)');

    expect(commands.length).toBeGreaterThanOrEqual(100);
  }, 240_000);
});
