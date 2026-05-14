/**
 * Debug run — registry providers, environment variables, variables &
 * formatting cmdlets on a Windows PC.
 *
 * Transcript → `debug-output/ps-registry-env_results_debug.txt`.
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

describe('debug — PowerShell registry & env', () => {
  it('runs registry/env/variable cmdlets and writes the transcript', async () => {
    const pc = new WindowsPC('windows-pc', 'WIN-REG-DBG');
    pc.setCurrentUser('Administrator');
    const ps = new PowerShellExecutor(pc);

    const commands: DebugCommandInput[] = [
      // ── 1. registry navigation ────────────────────────────────────
      { section: 'registry navigation', cmd: 'Get-PSDrive | Where-Object { $_.Provider -like "*Registry*" }' },
      'Test-Path HKCU:\\',
      'Test-Path HKLM:\\',
      'Test-Path HKCU:\\Software',
      'Get-ChildItem HKCU:\\Software -ErrorAction SilentlyContinue | Select-Object -First 5',
      'Get-ChildItem HKLM:\\Software -ErrorAction SilentlyContinue | Select-Object -First 5',
      'Get-ChildItem HKCU:\\Software\\Microsoft -ErrorAction SilentlyContinue | Select-Object -First 5',
      'Get-Item HKCU:\\Software -ErrorAction SilentlyContinue',
      '(Get-Item HKCU:\\Software).Name',

      // ── 2. create / read keys ─────────────────────────────────────
      { section: 'create & read keys', cmd: 'New-Item -Path HKCU:\\Software\\DebugSim -Force' },
      'Test-Path HKCU:\\Software\\DebugSim',
      'New-Item -Path HKCU:\\Software\\DebugSim\\Settings -Force',
      'New-Item -Path HKCU:\\Software\\DebugSim\\Settings\\UI -Force',
      'New-Item -Path HKCU:\\Software\\DebugSim\\Settings\\Logs -Force',
      'Get-ChildItem HKCU:\\Software\\DebugSim',
      'Get-ChildItem HKCU:\\Software\\DebugSim -Recurse',
      '(Get-ChildItem HKCU:\\Software\\DebugSim).Count',
      '(Get-ChildItem HKCU:\\Software\\DebugSim -Recurse).Count',

      // ── 3. property values ────────────────────────────────────────
      { section: 'property values',
        cmd: 'Set-ItemProperty -Path HKCU:\\Software\\DebugSim -Name "Version" -Value "1.0.0"' },
      'Set-ItemProperty -Path HKCU:\\Software\\DebugSim -Name "Build" -Value 42 -Type DWord',
      'Set-ItemProperty -Path HKCU:\\Software\\DebugSim -Name "InstallPath" -Value "C:\\DebugSim"',
      'Set-ItemProperty -Path HKCU:\\Software\\DebugSim -Name "Enabled" -Value 1 -Type DWord',
      'Set-ItemProperty -Path HKCU:\\Software\\DebugSim\\Settings -Name "Theme" -Value "dark"',
      'Set-ItemProperty -Path HKCU:\\Software\\DebugSim\\Settings -Name "Lang" -Value "fr-FR"',
      'Set-ItemProperty -Path HKCU:\\Software\\DebugSim\\Settings\\UI -Name "Width" -Value 1920 -Type DWord',
      'Set-ItemProperty -Path HKCU:\\Software\\DebugSim\\Settings\\UI -Name "Height" -Value 1080 -Type DWord',
      'Get-ItemProperty -Path HKCU:\\Software\\DebugSim',
      'Get-ItemProperty -Path HKCU:\\Software\\DebugSim -Name "Version"',
      '(Get-ItemProperty -Path HKCU:\\Software\\DebugSim).Version',
      '(Get-ItemProperty -Path HKCU:\\Software\\DebugSim).Build',
      'Get-ItemProperty -Path HKCU:\\Software\\DebugSim\\Settings',
      'Get-ItemProperty -Path HKCU:\\Software\\DebugSim\\Settings\\UI | Format-List',

      // ── 4. rename / delete values ─────────────────────────────────
      { section: 'rename & delete values',
        cmd: 'Rename-ItemProperty -Path HKCU:\\Software\\DebugSim -Name "Build" -NewName "BuildNumber" -ErrorAction SilentlyContinue' },
      'Get-ItemProperty -Path HKCU:\\Software\\DebugSim -Name "BuildNumber" -ErrorAction SilentlyContinue',
      'Remove-ItemProperty -Path HKCU:\\Software\\DebugSim -Name "Enabled" -ErrorAction SilentlyContinue',
      'Get-ItemProperty -Path HKCU:\\Software\\DebugSim',
      'Clear-ItemProperty -Path HKCU:\\Software\\DebugSim -Name "InstallPath" -ErrorAction SilentlyContinue',
      '(Get-ItemProperty -Path HKCU:\\Software\\DebugSim).InstallPath',

      // ── 5. environment variables ─────────────────────────────────
      { section: 'environment variables', cmd: 'Get-ChildItem Env:' },
      'Get-ChildItem Env: | Sort-Object Name | Select-Object -First 5',
      'Get-ChildItem Env: | Sort-Object Name | Select-Object -Last 5',
      '(Get-ChildItem Env:).Count',
      '$env:Path',
      '$env:SystemRoot',
      '$env:USERNAME',
      '$env:COMPUTERNAME',
      '$env:TEMP',
      '$env:Path -split ";" | Select-Object -First 3',
      '($env:Path -split ";").Count',
      'Set-Item -Path Env:DEBUG_SIM -Value "1"',
      '$env:DEBUG_SIM',
      'Set-Item -Path Env:DEBUG_LABEL -Value "first"',
      '$env:DEBUG_LABEL',
      'Set-Item -Path Env:DEBUG_LABEL -Value "second"',
      '$env:DEBUG_LABEL',
      'Remove-Item Env:DEBUG_LABEL',
      '$env:DEBUG_LABEL',
      '[System.Environment]::SetEnvironmentVariable("DBG_PROC", "process-scope", "Process")',
      '[System.Environment]::GetEnvironmentVariable("DBG_PROC", "Process")',
      '[System.Environment]::SetEnvironmentVariable("DBG_USR", "user-scope", "User")',
      '[System.Environment]::GetEnvironmentVariable("DBG_USR", "User")',
      '[System.Environment]::SetEnvironmentVariable("DBG_MCH", "machine-scope", "Machine")',
      '[System.Environment]::GetEnvironmentVariable("DBG_MCH", "Machine")',
      '[System.Environment]::SetEnvironmentVariable("DBG_PROC", $null, "Process")',
      '[System.Environment]::SetEnvironmentVariable("DBG_USR", $null, "User")',
      '[System.Environment]::SetEnvironmentVariable("DBG_MCH", $null, "Machine")',

      // ── 6. Variable: provider ─────────────────────────────────────
      { section: 'variables', cmd: '$x = 42; $x' },
      '$y = "hello world"; $y',
      '$nums = 1..10; $nums',
      '$nums.Length',
      '$nums | Measure-Object -Sum -Average -Min -Max',
      '$hash = @{ a = 1; b = 2; c = 3 }; $hash',
      '$hash.a',
      '$hash.Keys',
      '$hash.Values',
      '$arr = @("alpha","beta","gamma"); $arr',
      '$arr[0]',
      '$arr[-1]',
      '$arr.Length',
      'Get-Variable -Name x -ErrorAction SilentlyContinue',
      'Get-Variable | Where-Object { $_.Name -like "x*" }',
      '(Get-Variable).Count',
      'Set-Variable -Name z -Value 99',
      '$z',
      'Remove-Variable -Name z -ErrorAction SilentlyContinue',
      '$z',
      '$obj = [pscustomobject]@{ Name="alice"; Age=30 }; $obj',
      '$obj.Name',
      '$obj.Age',

      // ── 7. type accelerators & casting ────────────────────────────
      { section: 'casting',
        cmd: '[int]"42"' },
      '[double]"3.14"',
      '[bool]"true"',
      '[string]42',
      '[datetime]"2024-01-15"',
      '"abc".ToUpper()',
      '"abc".Length',
      '"alpha,beta,gamma".Split(",")',
      '"alpha-beta".Replace("-","_")',
      '[Math]::Pow(2,10)',
      '[Math]::PI',
      '[Math]::Sqrt(16)',
      '[Guid]::NewGuid()',
      '[DateTime]::Now',

      // ── 8. formatting cmdlets ─────────────────────────────────────
      { section: 'formatting',
        cmd: 'Get-Process | Select-Object -First 3 | Format-Table' },
      'Get-Process | Select-Object -First 3 | Format-List',
      'Get-Process | Select-Object -First 3 | Format-List Name, Id, CPU',
      'Get-Process | Select-Object -First 3 | Format-Table Name, Id, CPU -AutoSize',
      'Get-Process | Select-Object -First 3 | Out-String',
      'Get-Process | Select-Object -First 3 | ConvertTo-Json',
      'Get-Process | Select-Object -First 3 | ConvertTo-Csv',
      'Get-Process | Select-Object -First 3 -Property Name, Id | ConvertTo-Json',
      '"hello", "world" | Out-String',
      '@{ a=1; b=2 } | ConvertTo-Json',

      // ── 9. cleanup ────────────────────────────────────────────────
      { section: 'cleanup', cmd: 'Remove-Item HKCU:\\Software\\DebugSim -Recurse -ErrorAction SilentlyContinue' },
      'Test-Path HKCU:\\Software\\DebugSim',
      'Remove-Item Env:DEBUG_SIM -ErrorAction SilentlyContinue',
      '$env:DEBUG_SIM',
    ];

    await runAndDump('ps-registry-env', commands, ps,
      'host=WIN-REG-DBG (windows-pc)');
    expect(commands.length).toBeGreaterThanOrEqual(100);
  }, 120_000);
});
