/**
 * Debug run — PowerShell filesystem cmdlets on a Windows PC.
 *
 * Instantiates a `windows-pc`, drives `PowerShellExecutor` through a long
 * list of file/directory cmdlets (and their aliases), then dumps the
 * transcript to `debug-output/ps-filesystem_results_debug.txt`.
 *
 * Not a behavioural assertion suite — the only `expect` checks that the
 * dump completed. The transcript is the artefact.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { PowerShellExecutor } from '@/network/devices/windows/PowerShellExecutor';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { runAndDump, type DebugCommandInput } from './_dump';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

describe('debug — PowerShell filesystem', () => {
  it('runs filesystem cmdlets and writes the transcript', async () => {
    const pc = new WindowsPC('windows-pc', 'WIN-FS-DBG');
    pc.setCurrentUser('Administrator');
    const ps = new PowerShellExecutor(pc);

    const commands: DebugCommandInput[] = [
      // ── Section 1 — location & introspection ──────────────────────
      { section: 'location & drives', cmd: 'Get-Location' },
      'pwd',
      'gl',
      'Get-PSDrive',
      'Get-PSDrive | Where-Object { $_.Provider -like "*FileSystem*" }',
      'Get-PSDrive | Sort-Object Name',
      'Get-PSDrive C',
      '(Get-Location).Path',
      'Set-Location C:\\',
      'Get-Location',
      'Push-Location C:\\',
      'Pop-Location',
      'cd C:\\',
      'cd ..',
      'cd \\',

      // ── Section 2 — New-Item / mkdir / ni ─────────────────────────
      { section: 'New-Item & mkdir', cmd: 'New-Item -Path C:\\Debug -ItemType Directory' },
      'New-Item -Path C:\\Debug\\sub1 -ItemType Directory',
      'New-Item -Path C:\\Debug\\sub2 -ItemType Directory',
      'New-Item -Path C:\\Debug\\sub1\\nested -ItemType Directory -Force',
      'mkdir C:\\Debug\\mkdir-test',
      'md C:\\Debug\\md-test',
      'ni -Path C:\\Debug\\ni-test -ItemType Directory',
      'New-Item -Path C:\\Debug\\hello.txt -ItemType File -Value "hello world"',
      'New-Item -Path C:\\Debug\\empty.txt -ItemType File',
      'New-Item -Path C:\\Debug\\dup -ItemType Directory',
      'New-Item -Path C:\\Debug\\dup -ItemType Directory',
      'New-Item -Path C:\\Debug\\dup -ItemType Directory -Force',
      'ni C:\\Debug\\sub1\\inner.txt -ItemType File -Value "inner contents"',
      'New-Item -Path C:\\Debug\\with space\\file.txt -ItemType File -Force',

      // ── Section 3 — Test-Path / Resolve-Path / Join-Path ──────────
      { section: 'Test-Path / Resolve-Path / Join-Path', cmd: 'Test-Path C:\\Debug' },
      'Test-Path C:\\Debug\\hello.txt',
      'Test-Path C:\\Debug\\does-not-exist',
      'Test-Path -Path C:\\Debug -PathType Container',
      'Test-Path -Path C:\\Debug\\hello.txt -PathType Leaf',
      'Resolve-Path C:\\Debug\\hello.txt',
      'Resolve-Path C:\\Debug\\.\\hello.txt',
      'Resolve-Path C:\\Debug\\sub1\\..\\hello.txt',
      'Join-Path C:\\Debug sub1',
      'Join-Path -Path C:\\Debug -ChildPath nested\\deep.txt',
      'Join-Path C:\\ Users\\Administrator',
      'Split-Path C:\\Debug\\hello.txt',
      'Split-Path C:\\Debug\\hello.txt -Leaf',
      'Split-Path C:\\Debug\\hello.txt -Parent',
      'Split-Path C:\\Debug\\hello.txt -Extension',

      // ── Section 4 — content cmdlets ───────────────────────────────
      { section: 'Set/Add/Get/Clear-Content', cmd: 'Set-Content -Path C:\\Debug\\log.txt -Value "first line"' },
      'Add-Content -Path C:\\Debug\\log.txt -Value "second line"',
      'Add-Content -Path C:\\Debug\\log.txt -Value "third line"',
      'Get-Content C:\\Debug\\log.txt',
      'Get-Content C:\\Debug\\log.txt -TotalCount 2',
      'Get-Content C:\\Debug\\log.txt -Tail 1',
      'Get-Content C:\\Debug\\log.txt | Measure-Object -Line',
      'Get-Content C:\\Debug\\log.txt | Measure-Object -Word',
      'Get-Content C:\\Debug\\log.txt | Measure-Object -Character',
      '"a","b","c","d","e" | Set-Content C:\\Debug\\letters.txt',
      'Get-Content C:\\Debug\\letters.txt',
      'Get-Content C:\\Debug\\letters.txt | Sort-Object -Descending',
      'Clear-Content C:\\Debug\\letters.txt',
      'Get-Content C:\\Debug\\letters.txt',
      '1..10 | Set-Content C:\\Debug\\nums.txt',
      'Get-Content C:\\Debug\\nums.txt',
      'Get-Content C:\\Debug\\nums.txt | Where-Object { [int]$_ -gt 5 }',
      'Get-Content C:\\Debug\\nums.txt | Where-Object { [int]$_ % 2 -eq 0 }',
      '(Get-Content C:\\Debug\\nums.txt | Measure-Object -Sum).Sum',

      // ── Section 5 — Copy / Move / Rename / Remove ─────────────────
      { section: 'Copy/Move/Rename/Remove', cmd: 'Copy-Item C:\\Debug\\hello.txt C:\\Debug\\hello-copy.txt' },
      'cp C:\\Debug\\hello.txt C:\\Debug\\hello-cp.txt',
      'copy C:\\Debug\\hello.txt C:\\Debug\\hello-copy2.txt',
      'Copy-Item C:\\Debug\\sub1 C:\\Debug\\sub1-copy -Recurse',
      'Move-Item C:\\Debug\\hello-cp.txt C:\\Debug\\moved.txt',
      'mv C:\\Debug\\moved.txt C:\\Debug\\moved-again.txt',
      'Rename-Item C:\\Debug\\moved-again.txt renamed.txt',
      'ren C:\\Debug\\renamed.txt renamed2.txt',
      'Remove-Item C:\\Debug\\renamed2.txt',
      'rm C:\\Debug\\hello-copy.txt',
      'del C:\\Debug\\hello-copy2.txt',
      'Remove-Item C:\\Debug\\sub1-copy -Recurse -Force',

      // ── Section 6 — Get-ChildItem variants ────────────────────────
      { section: 'Get-ChildItem / dir / ls / gci', cmd: 'Get-ChildItem C:\\' },
      'dir C:\\',
      'ls C:\\Debug',
      'gci C:\\Debug',
      'Get-ChildItem C:\\Debug -Recurse',
      'Get-ChildItem C:\\Debug -Recurse -File',
      'Get-ChildItem C:\\Debug -Recurse -Directory',
      'Get-ChildItem C:\\Debug -Filter *.txt',
      'Get-ChildItem C:\\Debug -Include *.txt -Recurse',
      'Get-ChildItem C:\\Debug -Force',
      'Get-ChildItem C:\\Debug | Sort-Object Length',
      'Get-ChildItem C:\\Debug | Sort-Object LastWriteTime -Descending',
      'Get-ChildItem C:\\Debug | Where-Object { $_.PSIsContainer }',
      'Get-ChildItem C:\\Debug | Where-Object { -not $_.PSIsContainer }',
      'Get-ChildItem C:\\Debug | Select-Object Name, Length, Mode',
      'Get-ChildItem C:\\Debug | Format-Table Name, Length -AutoSize',
      'Get-ChildItem C:\\Debug | Format-List Name, FullName, Length',
      '(Get-ChildItem C:\\Debug).Count',
      '(Get-ChildItem C:\\Debug -File).Count',
      '(Get-ChildItem C:\\Debug -Directory).Count',
      'Get-ChildItem C:\\Debug | Measure-Object -Property Length -Sum -Average -Max -Min',

      // ── Section 7 — complex pipelines ─────────────────────────────
      { section: 'complex pipelines',
        cmd: 'Get-ChildItem C:\\Debug -Recurse -File | Where-Object { $_.Length -gt 0 } | Sort-Object Length -Descending | Select-Object -First 3 Name, Length' },
      'Get-ChildItem C:\\Debug -Recurse -File | Group-Object Extension | Sort-Object Count -Descending',
      'Get-ChildItem C:\\Debug -Recurse -File | ForEach-Object { "$($_.Name) = $($_.Length) bytes" }',
      'Get-ChildItem C:\\Debug -Recurse -File | Measure-Object Length -Sum | Select-Object Count, Sum',
      'Get-ChildItem C:\\Debug | Where-Object { $_.Name -like "*.txt" } | Sort-Object Name | Select-Object -ExpandProperty Name',
      '1..5 | ForEach-Object { New-Item -Path "C:\\Debug\\bulk-$_.txt" -ItemType File -Value "row $_" -Force }',
      'Get-ChildItem C:\\Debug -Filter "bulk-*.txt" | Sort-Object Name | ForEach-Object { (Get-Content $_.FullName) }',
      'Get-ChildItem C:\\Debug -Filter "bulk-*.txt" | Sort-Object Name | Select-Object -First 3 | Remove-Item',
      'Get-ChildItem C:\\Debug -Filter "bulk-*.txt" | ForEach-Object { $_.Name }',
      '"alpha","beta","gamma","delta" | ForEach-Object { New-Item -Path "C:\\Debug\\greek-$_.txt" -ItemType File -Value $_ -Force } | Out-Null',
      'Get-ChildItem C:\\Debug -Filter "greek-*.txt" | ForEach-Object { Get-Content $_.FullName }',
      '(Get-ChildItem C:\\Debug -Filter "greek-*.txt" | ForEach-Object { Get-Content $_.FullName }) -join ","',
      'Get-ChildItem C:\\Debug -Recurse -File | Where-Object { $_.Extension -eq ".txt" -and $_.Name -ne "log.txt" } | Sort-Object FullName',

      // ── Section 8 — ACL & security descriptors ────────────────────
      { section: 'Get-Acl / Set-Acl', cmd: 'Get-Acl C:\\Debug\\hello.txt' },
      'Get-Acl C:\\Debug',
      'Get-Acl C:\\Debug | Select-Object Owner, Group',
      'Get-Acl C:\\Debug\\hello.txt | Format-List',
      '(Get-Acl C:\\Debug\\hello.txt).Access',
      '(Get-Acl C:\\Debug\\hello.txt).Access | Format-Table IdentityReference, FileSystemRights, AccessControlType -AutoSize',
      'New-Item -Path C:\\Debug\\acl-target.txt -ItemType File -Value "guarded" -Force',
      '$acl = Get-Acl C:\\Debug\\acl-target.txt; $rule = New-Object System.Security.AccessControl.FileSystemAccessRule("Users","Write","Deny"); $acl.SetAccessRule($rule); Set-Acl -Path C:\\Debug\\acl-target.txt -AclObject $acl',
      'Get-Acl C:\\Debug\\acl-target.txt',

      // ── Section 9 — drives D: / C: cross-drive ────────────────────
      { section: 'cross-drive operations', cmd: 'New-Item -Path D:\\Backup -ItemType Directory -Force' },
      'Set-Content -Path D:\\Backup\\notes.txt -Value "D drive note"',
      'Copy-Item C:\\Debug\\hello.txt D:\\Backup\\hello-on-d.txt',
      'Get-ChildItem D:\\Backup',
      'Get-Content D:\\Backup\\hello-on-d.txt',
      'Remove-Item D:\\Backup -Recurse -Force',
      'Test-Path D:\\Backup',

      // ── Section 10 — final aggregate snapshot ─────────────────────
      { section: 'final snapshot', cmd: 'Get-ChildItem C:\\Debug -Recurse | Format-Table Mode, LastWriteTime, Length, Name -AutoSize' },
      'Get-ChildItem C:\\Debug -Recurse -File | Measure-Object -Property Length -Sum',
      'Get-ChildItem C:\\Debug -Recurse | Group-Object { $_.PSIsContainer } | Select-Object Name, Count',
      'Remove-Item C:\\Debug -Recurse -Force',
      'Test-Path C:\\Debug',
    ];

    await runAndDump('ps-filesystem', commands, ps, 'host=WIN-FS-DBG (windows-pc)');
    expect(commands.length).toBeGreaterThanOrEqual(100);
  }, 120_000);
});
