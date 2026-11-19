/*
 * Probe: New/Get/Set/Remove/Enable/Disable-NetFirewallRule swallowed any parameter they did not read: `-Bogus 1` was ignored, and
 * `-InterfaceAlias`, `-Owner`, `-Platform`... which Microsoft declares but this engine does not evaluate, vanished without a word
 * (a stored criterion that is not enforced). Source (rule 8): Microsoft Learn NetSecurity/{New,Get,Set,Remove,Enable,Disable}-
 * NetFirewallRule (windowsserver2025-ps, read in this session; the parameter anchors of each page give the declared set). The six
 * cmdlets now declare a closed set: an undeclared name is "A parameter cannot be found that matches parameter name 'X'." and a name
 * Microsoft declares but this engine cannot honour is refused in the simulator's own words, naming the missing brick.
 *
 * Discriminated with git stash on src: 8 of 10 fall before the fix; two pass either way and are named: the witness (a rule is
 * created and read back by DisplayName) and "-All selects every rule" (-All was already accepted and no filter selected every rule).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

beforeEach(() => { resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset(); });

async function shell() {
  const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
  pc.powerOn();
  const sh = PowerShellSubShell.create(pc).subShell;
  const run = async (line: string) => (await sh.processLine(line)).output.join('\n').trim();
  await run('New-NetFirewallRule -DisplayName probe-rule -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8080 | Out-Null');
  return run;
}

const NOT_FOUND = (name: string) => `A parameter cannot be found that matches parameter name '${name}'.`;

describe('the firewall rule cmdlets bind only what Microsoft declares', () => {
  it('witness: a rule is created and read back by DisplayName', async () => {
    const run = await shell();
    expect(await run('(Get-NetFirewallRule -DisplayName probe-rule).DisplayName')).toBe('probe-rule');
  });

  it.each([
    ['New-NetFirewallRule -DisplayName x -Direction Inbound -Action Allow -Bogus 1'],
    ['Get-NetFirewallRule -Bogus 1'],
    ['Set-NetFirewallRule -DisplayName probe-rule -Bogus 1'],
    ['Remove-NetFirewallRule -DisplayName probe-rule -Bogus 1'],
    ['Enable-NetFirewallRule -DisplayName probe-rule -Bogus 1'],
    ['Disable-NetFirewallRule -DisplayName probe-rule -Bogus 1'],
  ])('%s is refused as an unknown parameter', async (line) => {
    const run = await shell();
    expect(await run(line)).toContain(NOT_FOUND('Bogus'));
  });

  it('a declared parameter the engine cannot honour is refused, not dropped', async () => {
    const run = await shell();
    const out = await run('Set-NetFirewallRule -DisplayName probe-rule -InterfaceAlias Ethernet');
    expect(out).toContain('The -InterfaceAlias parameter is not implemented in this simulator');
  });

  it('a refused Remove leaves the rule in place', async () => {
    const run = await shell();
    await run('Remove-NetFirewallRule -DisplayName probe-rule -Owner S-1-1-0');
    expect(await run('(Get-NetFirewallRule -DisplayName probe-rule).DisplayName')).toBe('probe-rule');
  });

  it('-All selects every rule', async () => {
    const run = await shell();
    expect(await run('(Get-NetFirewallRule -All | Where-Object { $_.DisplayName -eq "probe-rule" }).DisplayName')).toBe('probe-rule');
  });
});
