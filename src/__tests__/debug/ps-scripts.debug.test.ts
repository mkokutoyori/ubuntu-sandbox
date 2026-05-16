/**
 * Debug run — `.ps1` scripts authored via PowerShell on the simulated
 * machine, then executed via dot-sourcing / call-operator.
 *
 * Each scenario:
 *   1. Writes a script to `C:\Scripts\*.ps1` using Set-Content / here-string.
 *   2. Verifies its content with `Get-Content`.
 *   3. Executes it (`& C:\Scripts\foo.ps1` or `. C:\Scripts\foo.ps1`).
 *   4. Captures the output / resulting machine state.
 *
 * Transcript → `debug-output/ps-scripts_results_debug.txt`.
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

describe('debug — PowerShell .ps1 scripts', () => {
  it('writes & runs .ps1 scripts and writes the transcript', async () => {
    const pc = new WindowsPC('windows-pc', 'WIN-SCR-DBG');
    const srv = new WindowsPC('windows-server', 'SRV-SCR-DBG');
    pc.setCurrentUser('Administrator');
    srv.setCurrentUser('Administrator');
    const psPc = createPSRunner(pc);
    const psSrv = createPSRunner(srv);

    // Two scripts authored as raw strings (PowerShell-friendly).  We use
    // `\`` line-joining sparingly; multi-line scripts go through a single
    // Set-Content call whose -Value is a string with embedded newlines.
    const helloScript =
      '$name = if ($args.Count -gt 0) { $args[0] } else { "world" }\n' +
      'Write-Output "Hello, $name!"\n';

    const sumScript =
      'param([int[]]$Numbers = (1..10))\n' +
      '$total = 0\n' +
      'foreach ($n in $Numbers) { $total += $n }\n' +
      '"Total = $total"\n';

    const usersScript =
      'param([string]$Prefix = "auto")\n' +
      '1..3 | ForEach-Object {\n' +
      '  $u = "$Prefix-user$_"\n' +
      '  New-LocalUser -Name $u -NoPassword -ErrorAction SilentlyContinue | Out-Null\n' +
      '  Write-Output "created $u"\n' +
      '}\n';

    const filesScript =
      'param([string]$Dir = "C:\\BulkOut", [int]$Count = 5)\n' +
      'New-Item -Path $Dir -ItemType Directory -Force | Out-Null\n' +
      '1..$Count | ForEach-Object {\n' +
      '  Set-Content -Path (Join-Path $Dir "item$_.txt") -Value "row $_"\n' +
      '}\n' +
      'Get-ChildItem $Dir | Measure-Object | Select-Object -ExpandProperty Count\n';

    const fnScript =
      'function Get-Greeting {\n' +
      '  param([string]$Who = "world", [string]$Lang = "en")\n' +
      '  switch ($Lang) {\n' +
      '    "fr" { "Bonjour, $Who!" }\n' +
      '    "es" { "Hola, $Who!" }\n' +
      '    default { "Hello, $Who!" }\n' +
      '  }\n' +
      '}\n' +
      'Get-Greeting -Who Alice -Lang fr\n' +
      'Get-Greeting -Who Bob -Lang es\n' +
      'Get-Greeting -Who Carol\n';

    const pipelineScript =
      'param([string]$Path = "C:\\BulkOut")\n' +
      'Get-ChildItem $Path -ErrorAction SilentlyContinue |\n' +
      '  Where-Object { -not $_.PSIsContainer } |\n' +
      '  Sort-Object Length -Descending |\n' +
      '  Select-Object -First 3 -Property Name, Length\n';

    const tryCatchScript =
      'try {\n' +
      '  Get-Item C:\\ghost-file -ErrorAction Stop\n' +
      '} catch {\n' +
      '  "caught: $($_.Exception.Message)"\n' +
      '} finally {\n' +
      '  "done"\n' +
      '}\n';

    // ── Build the (long) command list ─────────────────────────────
    const commands: DebugCommandInput[] = [
      { section: 'prepare scripts dir', cmd: 'New-Item -Path C:\\Scripts -ItemType Directory -Force' },
      'Test-Path C:\\Scripts',
      'Get-ChildItem C:\\Scripts',

      // hello.ps1
      { section: 'hello.ps1',
        cmd: 'Set-Content -Path C:\\Scripts\\hello.ps1 -Value ' + jsonStringify(helloScript) },
      'Test-Path C:\\Scripts\\hello.ps1',
      'Get-Content C:\\Scripts\\hello.ps1',
      '. C:\\Scripts\\hello.ps1',
      '& C:\\Scripts\\hello.ps1 PowerShell',
      'powershell -File C:\\Scripts\\hello.ps1 -ErrorAction SilentlyContinue',

      // sum.ps1
      { section: 'sum.ps1',
        cmd: 'Set-Content -Path C:\\Scripts\\sum.ps1 -Value ' + jsonStringify(sumScript) },
      'Get-Content C:\\Scripts\\sum.ps1',
      '& C:\\Scripts\\sum.ps1',
      '& C:\\Scripts\\sum.ps1 -Numbers 5,10,15,20',
      '& C:\\Scripts\\sum.ps1 -Numbers (1..100)',

      // users.ps1
      { section: 'users.ps1',
        cmd: 'Set-Content -Path C:\\Scripts\\users.ps1 -Value ' + jsonStringify(usersScript) },
      'Get-Content C:\\Scripts\\users.ps1',
      '& C:\\Scripts\\users.ps1 -Prefix dbg',
      'Get-LocalUser | Where-Object { $_.Name -like "dbg-*" }',
      '& C:\\Scripts\\users.ps1 -Prefix qa',
      'Get-LocalUser | Where-Object { $_.Name -like "qa-*" }',
      '"dbg-user1","dbg-user2","dbg-user3","qa-user1","qa-user2","qa-user3" | ForEach-Object { Remove-LocalUser -Name $_ -ErrorAction SilentlyContinue }',

      // files.ps1
      { section: 'files.ps1',
        cmd: 'Set-Content -Path C:\\Scripts\\files.ps1 -Value ' + jsonStringify(filesScript) },
      'Get-Content C:\\Scripts\\files.ps1',
      '& C:\\Scripts\\files.ps1',
      'Get-ChildItem C:\\BulkOut',
      'Get-ChildItem C:\\BulkOut | Measure-Object Length -Sum',
      '& C:\\Scripts\\files.ps1 -Dir C:\\BulkOut2 -Count 10',
      'Get-ChildItem C:\\BulkOut2 | Sort-Object Name',
      '(Get-ChildItem C:\\BulkOut2).Count',

      // fn.ps1
      { section: 'fn.ps1 (functions)',
        cmd: 'Set-Content -Path C:\\Scripts\\fn.ps1 -Value ' + jsonStringify(fnScript) },
      'Get-Content C:\\Scripts\\fn.ps1',
      '. C:\\Scripts\\fn.ps1',
      'Get-Greeting -Who "Eve"',
      'Get-Greeting -Who "Frank" -Lang fr',
      'Get-Greeting -Who "Grace" -Lang es',

      // pipeline.ps1
      { section: 'pipeline.ps1',
        cmd: 'Set-Content -Path C:\\Scripts\\pipeline.ps1 -Value ' + jsonStringify(pipelineScript) },
      'Get-Content C:\\Scripts\\pipeline.ps1',
      '& C:\\Scripts\\pipeline.ps1 -Path C:\\BulkOut2',
      '& C:\\Scripts\\pipeline.ps1 -Path C:\\BulkOut',

      // try.ps1
      { section: 'try.ps1',
        cmd: 'Set-Content -Path C:\\Scripts\\try.ps1 -Value ' + jsonStringify(tryCatchScript) },
      'Get-Content C:\\Scripts\\try.ps1',
      '& C:\\Scripts\\try.ps1',

      // ── ad-hoc scriptblocks (no .ps1 file) ────────────────────────
      { section: 'inline scriptblocks',
        cmd: '& { Write-Output "inline-1"; Write-Output "inline-2" }' },
      '& { param($n) 1..$n } 5',
      '$sb = { param($x) $x * $x }; & $sb 7',
      '$sb2 = { param($a,$b) $a + $b }; & $sb2 10 20',
      '& { Get-Process | Select-Object -First 2 Name }',
      '& { Get-Service | Where-Object { $_.Status -eq "Running" } | Select-Object -First 2 Name, Status }',

      // ── compose multiple scripts ──────────────────────────────────
      { section: 'multi-script composition',
        cmd: '. C:\\Scripts\\fn.ps1; "Alpha","Beta","Gamma" | ForEach-Object { Get-Greeting -Who $_ -Lang fr }' },
      '. C:\\Scripts\\fn.ps1; 1..3 | ForEach-Object { Get-Greeting -Who "Bot$_" }',
      '& C:\\Scripts\\sum.ps1 -Numbers (1..1000)',
      '& C:\\Scripts\\sum.ps1 -Numbers ((1..10) | Where-Object { $_ % 2 -eq 0 })',

      // ── machine-state probes after running scripts ────────────────
      { section: 'state probes', cmd: 'Get-ChildItem C:\\Scripts | Format-Table Name, Length -AutoSize' },
      '(Get-ChildItem C:\\Scripts).Count',
      'Get-ChildItem C:\\Scripts | Sort-Object Name | Select-Object -ExpandProperty Name',
      'Get-ChildItem C:\\Scripts | ForEach-Object { "$($_.Name) -> $($_.Length) bytes" }',
      'Get-ChildItem C:\\BulkOut2 | Measure-Object Length -Sum -Average -Max -Min',
      'Get-ChildItem C:\\BulkOut2 | ForEach-Object { Get-Content $_.FullName } | Measure-Object',

      // ── error / nonexistent script ────────────────────────────────
      { section: 'error paths', cmd: '& C:\\Scripts\\does-not-exist.ps1 -ErrorAction SilentlyContinue' },
      '. C:\\Scripts\\does-not-exist.ps1 -ErrorAction SilentlyContinue',
      'try { & C:\\Scripts\\missing.ps1 } catch { "missing-caught: $($_.Exception.Message)" }',

      // ── extra ad-hoc invocations ──────────────────────────────────
      { section: 'extra invocations',
        cmd: '& C:\\Scripts\\hello.ps1' },
      '& C:\\Scripts\\hello.ps1 alice',
      '& C:\\Scripts\\hello.ps1 bob',
      '& C:\\Scripts\\sum.ps1 -Numbers 10,20',
      '& C:\\Scripts\\sum.ps1 -Numbers 1,2,3',
      '& C:\\Scripts\\sum.ps1 -Numbers ((1..50) | Where-Object { $_ % 3 -eq 0 })',
      '. C:\\Scripts\\fn.ps1; Get-Greeting -Who "World"',
      '. C:\\Scripts\\fn.ps1; Get-Greeting -Who "Monde" -Lang fr',
      '. C:\\Scripts\\fn.ps1; Get-Greeting -Who "Mundo" -Lang es',
      '. C:\\Scripts\\fn.ps1; "a","b","c" | ForEach-Object { Get-Greeting -Who $_ }',
      '& { 100, 200, 300 } | Measure-Object -Sum',
      '& { "x","y","z" } | Measure-Object',

      // ── cleanup ───────────────────────────────────────────────────
      { section: 'cleanup', cmd: 'Remove-Item C:\\BulkOut -Recurse -Force -ErrorAction SilentlyContinue' },
      'Remove-Item C:\\BulkOut2 -Recurse -Force -ErrorAction SilentlyContinue',
      'Remove-Item C:\\Scripts -Recurse -Force',
      'Test-Path C:\\Scripts',
    ];

    await runAndDump('ps-scripts-pc', commands, psPc,
      'host=WIN-SCR-DBG (windows-pc)');
    // Re-run the SAME long list on the server.  The transcript will
    // diverge wherever the engine treats `windows-server` differently
    // (default services, accounts, build number, etc.).
    await runAndDump('ps-scripts-server', commands, psSrv,
      'host=SRV-SCR-DBG (windows-server)');

    // ── extra server-only pass: scripts authored on C:\\ServerScripts ──
    const srvCommands: DebugCommandInput[] = [
      { section: 'server (windows-server)', cmd: 'New-Item -Path C:\\ServerScripts -ItemType Directory -Force' },
      'Test-Path C:\\ServerScripts',

      'Set-Content -Path C:\\ServerScripts\\role.ps1 -Value ' +
        jsonStringify('"Hostname = $env:COMPUTERNAME"\n"User = $env:USERNAME"\n"Date = $(Get-Date)"\n'),
      'Get-Content C:\\ServerScripts\\role.ps1',
      '& C:\\ServerScripts\\role.ps1',
      '. C:\\ServerScripts\\role.ps1',

      'Set-Content -Path C:\\ServerScripts\\svcaudit.ps1 -Value ' +
        jsonStringify(
          'Get-Service | Group-Object Status | ForEach-Object { "$($_.Name): $($_.Count)" }\n' +
          'Get-Service | Where-Object { $_.Status -eq "Running" } | Select-Object -First 5 Name, Status\n',
        ),
      'Get-Content C:\\ServerScripts\\svcaudit.ps1',
      '& C:\\ServerScripts\\svcaudit.ps1',

      'Set-Content -Path C:\\ServerScripts\\users.ps1 -Value ' +
        jsonStringify(
          'param([string]$Prefix = "srv")\n' +
          '1..2 | ForEach-Object {\n' +
          '  $u = "$Prefix-acct$_"\n' +
          '  New-LocalUser -Name $u -NoPassword -ErrorAction SilentlyContinue | Out-Null\n' +
          '  Write-Output "created $u"\n' +
          '}\n',
        ),
      'Get-Content C:\\ServerScripts\\users.ps1',
      '& C:\\ServerScripts\\users.ps1 -Prefix srv',
      'Get-LocalUser | Where-Object { $_.Name -like "srv-*" }',
      '"srv-acct1","srv-acct2" | ForEach-Object { Remove-LocalUser -Name $_ -ErrorAction SilentlyContinue }',

      'Set-Content -Path C:\\ServerScripts\\report.ps1 -Value ' +
        jsonStringify(
          '"== System report =="\n' +
          '"Hostname: $env:COMPUTERNAME"\n' +
          '"User: $env:USERNAME"\n' +
          '"Services running: $((Get-Service | Where-Object { $_.Status -eq \'Running\' }).Count)"\n' +
          '"Processes: $((Get-Process).Count)"\n',
        ),
      'Get-Content C:\\ServerScripts\\report.ps1',
      '& C:\\ServerScripts\\report.ps1',

      'Set-Content -Path C:\\ServerScripts\\inline.ps1 -Value ' +
        jsonStringify('& { 1..5 | ForEach-Object { "[$_]" } }\n'),
      '& C:\\ServerScripts\\inline.ps1',

      'Get-ChildItem C:\\ServerScripts | Format-Table Name, Length -AutoSize',
      '(Get-ChildItem C:\\ServerScripts).Count',
      'Remove-Item C:\\ServerScripts -Recurse -Force',
      'Test-Path C:\\ServerScripts',
    ];
    await runAndDump('ps-scripts-server-extras', srvCommands, psSrv,
      'host=SRV-SCR-DBG (windows-server)');

    expect(commands.length + srvCommands.length).toBeGreaterThanOrEqual(100);
  }, 300_000);
});

/**
 * Encode a multi-line PowerShell script as a double-quoted PowerShell
 * literal — newlines become "`n" so Set-Content can be called with a
 * single -Value argument.
 */
function jsonStringify(s: string): string {
  const escaped = s
    .replace(/`/g, '``')
    .replace(/"/g, '`"')
    .replace(/\$/g, '`$')
    .replace(/\r?\n/g, '`n');
  return '"' + escaped + '"';
}
