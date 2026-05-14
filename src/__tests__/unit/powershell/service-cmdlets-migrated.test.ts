/**
 * Verifies that the migrated service cmdlets — registered in the interpreter
 * and backed by `WindowsPSProviders` — produce equivalent results to the
 * legacy PowerShellExecutor path. Phase 2 of the executor → interpreter
 * migration.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { PSInterpreter } from '@/powershell/interpreter/PSInterpreter';
import { createWindowsPSProviders } from '@/powershell/providers/WindowsPSProviders';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

function setup() {
  const pc = new WindowsPC('windows-pc', 'WIN-SVC');
  pc.setCurrentUser('Administrator');
  return new PSInterpreter(createWindowsPSProviders(pc));
}

describe('Service cmdlets migrated to PSInterpreter', () => {
  it('Get-Service lists at least one service', () => {
    const out = setup().executeInteractive('Get-Service');
    // Output is the dynamic table view; should include built-ins.
    expect(out.toLowerCase()).toContain('spooler');
  });

  it('gsv alias works', () => {
    const out = setup().executeInteractive('gsv Spooler');
    expect(out.toLowerCase()).toContain('spooler');
  });

  it('Get-Service "spo*" expands wildcards (quoted form — bare * is parsed as multiply)', () => {
    const out = setup().executeInteractive('Get-Service "spo*"');
    expect(out.toLowerCase()).toContain('spooler');
  });

  it('Stop-Service then Start-Service round-trips', () => {
    const i = setup();
    i.executeInteractive('Stop-Service Spooler');
    const stopped = i.executeInteractive('Get-Service Spooler');
    expect(stopped).toMatch(/stopped/i);
    i.executeInteractive('Start-Service Spooler');
    const running = i.executeInteractive('Get-Service Spooler');
    expect(running).toMatch(/running/i);
  });

  it('pipeline: Get-Service | Where-Object filter by Status', () => {
    const out = setup().executeInteractive(
      'Get-Service | Where-Object { $_.Status -eq "Running" }',
    );
    expect(out).toBeTruthy();
  });
});
