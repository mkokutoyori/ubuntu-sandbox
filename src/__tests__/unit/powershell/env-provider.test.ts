/**
 * Regression tests for the Env: drive / environment provider.
 *
 * Bug captured from debug-output/coherence-env-registry-*_results_debug.txt:
 *
 *     PS> Get-ChildItem Env: | Sort-Object Name | Select-Object -First 10
 *       ERROR: Cannot find path 'Env:' because it does not exist.
 *
 *     PS> Get-Item Env:DBG_FROM_CMD
 *       ERROR: Cannot find path 'Env:DBG_FROM_CMD' because it does not exist.
 *
 * Get-ChildItem/Get-Item didn't recognize the Env: drive. Fixed by adding
 * an IEnvironmentProvider to PSProviders backed by the device's env map,
 * and routing Env: paths through ctx.runtime.listEnvVars() and
 * ctx.providers.environment.get(). $env:VAR reads/writes also go
 * through the provider so cmd `setx` and PS `$env:VAR = ...` are
 * coherent (both subshells see the same map).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

async function setup() {
  const pc = new WindowsPC('windows-pc', 'WIN-ENV');
  pc.setCurrentUser('Administrator');
  const { subShell } = PowerShellSubShell.create(pc);
  return { pc, subShell };
}

async function ps(subShell: PowerShellSubShell, line: string): Promise<string> {
  const r = await subShell.processLine(line);
  return r.output.join('\n');
}

describe('Env: drive — Get-ChildItem / Get-Item', () => {
  it('Get-ChildItem Env: lists at least the well-known vars', async () => {
    const { subShell } = await setup();
    const out = await ps(subShell, 'Get-ChildItem Env: | Sort-Object Name');
    expect(out).toContain('USERNAME');
    expect(out).toContain('COMPUTERNAME');
    expect(out).toContain('PATH');
    expect(out).not.toMatch(/Cannot find path/i);
  });

  it('Get-Item Env:USERNAME returns a {Name, Value} object', async () => {
    const { subShell } = await setup();
    const out = await ps(subShell, 'Get-Item Env:USERNAME');
    expect(out).toContain('USERNAME');
    expect(out).toContain('Administrator');
  });

  it('Get-Item Env:<missing> emits a clean error', async () => {
    const { subShell } = await setup();
    const out = await ps(subShell, 'Get-Item Env:NOPE_DOES_NOT_EXIST');
    expect(out).toMatch(/Cannot find path 'Env:NOPE_DOES_NOT_EXIST'/i);
  });
});

describe('cmd → PS env coherence', () => {
  it('setx VAR VALUE in cmd is visible as $env:VAR in PS', async () => {
    const { pc, subShell } = await setup();
    await pc.executeCmdCommand('setx DBG_FROM_CMD "from-cmd"');
    const out = await ps(subShell, '$env:DBG_FROM_CMD');
    expect(out).toContain('from-cmd');
  });

  it('setx VAR VALUE in cmd is visible via Get-ChildItem Env:', async () => {
    const { pc, subShell } = await setup();
    await pc.executeCmdCommand('setx DBG_FROM_CMD2 "via-listing"');
    const out = await ps(subShell, 'Get-ChildItem Env: | Where-Object { $_.Name -eq "DBG_FROM_CMD2" }');
    expect(out).toContain('DBG_FROM_CMD2');
    expect(out).toContain('via-listing');
  });
});

describe('PS → cmd env coherence', () => {
  it('$env:VAR = "..." assignment in PS is visible to cmd `set VAR`', async () => {
    const { pc, subShell } = await setup();
    await ps(subShell, '$env:DBG_FROM_PS = "from-ps"');
    const out = await pc.executeCmdCommand('set DBG_FROM_PS');
    expect(out).toContain('from-ps');
  });
});
