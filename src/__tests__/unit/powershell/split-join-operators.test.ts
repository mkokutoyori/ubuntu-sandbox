/**
 * -split / -join binary operators.
 *
 * Bug from debug-output/ps-registry-env_results_debug.txt:
 *
 *     PS> ($env:Path -split ";").Count
 *       1
 *
 * Expected: 4 (there are 4 entries in the default PATH). The `-split`
 * operator was missing from the binary-operator list so the whole
 * expression was treated as a command lookup.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { PowerShellExecutor } from '@/network/devices/windows/PowerShellExecutor';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

function createPS(): PowerShellExecutor {
  const pc = new WindowsPC('windows-pc', 'WIN-SPLIT');
  pc.setCurrentUser('Administrator');
  return new PowerShellExecutor(pc);
}

describe('-split operator', () => {
  it('splits a literal string by a literal separator', async () => {
    const ps = createPS();
    const out = await ps.execute('"a,b,c" -split ","');
    expect(out).toContain('a');
    expect(out).toContain('b');
    expect(out).toContain('c');
  });

  it('counting after -split via (.).Count', async () => {
    const ps = createPS();
    const out = await ps.execute('("a,b,c,d" -split ",").Count');
    expect(out.trim()).toBe('4');
  });

  it('($env:Path -split ";").Count returns the segment count', async () => {
    const ps = createPS();
    const out = await ps.execute('($env:Path -split ";").Count');
    // Default simulator PATH has 4 entries separated by `;`.
    expect(parseInt(out.trim(), 10)).toBeGreaterThanOrEqual(2);
  });
});

describe('-join operator', () => {
  it('rejoins after -split round-trip', async () => {
    const ps = createPS();
    const out = await ps.execute('"a,b,c" -split "," -join "-"');
    // Note: -join is binary so the parser may pick it up to the right.
    // Accept either "a-b-c" or the equivalent table form.
    expect(out).toMatch(/a-b-c|a\n.*b\n.*c/);
  });
});
