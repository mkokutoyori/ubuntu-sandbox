/**
 * ForEach-Object scriptblocks containing arithmetic on `$_`.
 *
 * Bug from debug-output/ps-pipelines_results_debug.txt:
 *
 *     PS> 1..20 | ForEach-Object { $_ * $_ }
 *       1 : The term '1' is not recognized as the name of a cmdlet ...
 *
 * Real PowerShell evaluates `$_ * $_` as arithmetic for each item.
 * Our pipeline was substituting `$_` then routing the result to
 * `executeSingle`, which only does command lookup. Result: every
 * digit was treated as an unknown cmdlet. Now the scriptblock body
 * is routed through the full statement evaluator.
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
  return new PowerShellExecutor(new WindowsPC('windows-pc', 'WIN-FE'));
}

describe('ForEach-Object scriptblock — arithmetic on $_', () => {
  it('1..5 | % { $_ * $_ } produces 1 4 9 16 25', async () => {
    const ps = createPS();
    const out = await ps.execute('1..5 | ForEach-Object { $_ * $_ }');
    expect(out).toContain('1');
    expect(out).toContain('4');
    expect(out).toContain('9');
    expect(out).toContain('16');
    expect(out).toContain('25');
    expect(out).not.toContain('is not recognized');
  });

  it('1..3 | % { $_ + 10 } produces 11 12 13', async () => {
    const ps = createPS();
    const out = await ps.execute('1..3 | ForEach-Object { $_ + 10 }');
    const lines = out.split('\n').map(l => l.trim()).filter(Boolean);
    expect(lines).toContain('11');
    expect(lines).toContain('12');
    expect(lines).toContain('13');
  });

  it('parenthesized pipeline (1..3 | % { $_ * 2 })', async () => {
    const ps = createPS();
    const out = await ps.execute('(1..3 | ForEach-Object { $_ * 2 })');
    const lines = out.split('\n').map(l => l.trim()).filter(Boolean);
    expect(lines).toContain('2');
    expect(lines).toContain('4');
    expect(lines).toContain('6');
    expect(out).not.toContain('is not recognized');
  });

  it('"a","b","c" | % { $_.ToUpper() } returns uppercased values', async () => {
    const ps = createPS();
    const out = await ps.execute('"a","b","c" | ForEach-Object { $_.ToUpper() }');
    const lines = out.split('\n').map(l => l.trim()).filter(Boolean);
    expect(lines).toContain('A');
    expect(lines).toContain('B');
    expect(lines).toContain('C');
    expect(out).not.toContain('is not recognized');
  });

  it('1..4 | % { $_ * 2 + 1 } honours precedence', async () => {
    const ps = createPS();
    const out = await ps.execute('1..4 | ForEach-Object { $_ * 2 + 1 }');
    const lines = out.split('\n').map(l => l.trim()).filter(Boolean);
    expect(lines).toContain('3');
    expect(lines).toContain('5');
    expect(lines).toContain('7');
    expect(lines).toContain('9');
  });
});
