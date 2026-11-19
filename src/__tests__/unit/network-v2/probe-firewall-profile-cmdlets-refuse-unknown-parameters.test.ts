/*
 * Probe: `Set-NetFirewallProfile -Profile Domain -Enabled False` was accepted, did not read -Profile and switched
 * all three profiles off; `-Bogus 1` was swallowed by Get- and Set-NetFirewallProfile. PowerShell binds only declared
 * parameters (NetSecurity/Set-NetFirewallProfile.md lists -Name, not -Profile) and answers
 * "A parameter cannot be found that matches parameter name 'X'." (ParameterBindingException). The two cmdlets now declare a closed parameter set, the mechanism the runtime already offers.
 *
 * Discriminated with git stash on src: 3 of 4 fall before the fix; one passes either way and is named: the witness
 * (-Name Domain changes exactly the Domain profile).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

beforeEach(() => { resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset(); });

function shell() {
  const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
  pc.powerOn();
  const sh = PowerShellSubShell.create(pc).subShell;
  return async (line: string) => (await sh.processLine(line)).output.join('\n').trim();
}

const enabled = (run: (line: string) => Promise<string>) => run('(Get-NetFirewallProfile | ForEach-Object { $_.Enabled }) -join ","');

describe('Get/Set-NetFirewallProfile bind only the parameters they declare', () => {
  it('witness: -Name Domain changes only the Domain profile', async () => {
    const run = shell();
    await run('Set-NetFirewallProfile -Name Domain -Enabled False');
    expect(await enabled(run)).toBe('False,True,True');
  });

  it('-Profile is not a parameter of Set-NetFirewallProfile, and nothing changes', async () => {
    const run = shell();
    expect(await run('Set-NetFirewallProfile -Profile Domain -Enabled False'))
      .toContain("A parameter cannot be found that matches parameter name 'Profile'.");
    expect(await enabled(run)).toBe('True,True,True');
  });

  it('an unknown parameter of Set-NetFirewallProfile is refused', async () => {
    const run = shell();
    expect(await run('Set-NetFirewallProfile -Bogus 1')).toContain("A parameter cannot be found that matches parameter name 'Bogus'.");
  });

  it('an unknown parameter of Get-NetFirewallProfile is refused', async () => {
    const run = shell();
    expect(await run('Get-NetFirewallProfile -Name Domain -Bogus 1')).toContain("A parameter cannot be found that matches parameter name 'Bogus'.");
  });
});
