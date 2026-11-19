/*
 * Probe: `netsh advfirewall reset` emptied the user rules and restored the profile settings and wrote nothing. Source (rule 8):
 * Microsoft Learn "4949(S): Windows Firewall settings were restored to the default values." (Windows 10 auditing reference, read in
 * this session): subcategory Audit MPSSVC Rule-Level Policy Change, Task 13571, version 0, Keywords 0x8020000000000000, no EventData;
 * "This event generates when Windows Firewall settings were locally restored to the default configuration." The windows-commands
 * reference (official_docs, windows-commands-part002) gives `netsh advfirewall reset [export <path\filename>]`. Whether a reset also
 * writes 4946-4948 for each rule it removes is documented nowhere read, and is left in TODO.md.
 *
 * Discriminated with git stash on src/network: 2 of 4 fall before the fix; two pass either way and are named: the witness (the reset
 * answers Ok. and the rules are gone) and "writes nothing while the subcategory is not audited" (nothing was written for anything).
 */
import { describe, it, expect } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

function lab() {
  const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
  pc.setCurrentUser('Administrator');
  const shell = PowerShellSubShell.create(pc).subShell;
  return {
    ps: async (line: string) => (await shell.processLine(line)).output.join('\n'),
    cmd: (line: string) => pc.executeCommand(line),
  };
}

const EVENTS_4949 = '(Get-WinEvent -FilterHashtable @{LogName="Security"; Id=4949} -ErrorAction SilentlyContinue)';

describe('netsh advfirewall reset', () => {
  it('witness: the reset answers Ok. and the rule added before it is gone', async () => {
    const machine = lab();
    await machine.ps('New-NetFirewallRule -DisplayName Probe1 -Direction Inbound -Protocol TCP -LocalPort 4444 -Action Allow');
    expect(await machine.cmd('netsh advfirewall reset')).toContain('Ok.');
    expect(await machine.ps('(Get-NetFirewallRule -DisplayName Probe1 -ErrorAction SilentlyContinue | Measure-Object).Count')).toContain('0');
  });

  it('writes 4949 with its message, task and keywords when the subcategory audits success', async () => {
    const machine = lab();
    await machine.cmd('auditpol /set /subcategory:"MPSSVC Rule-Level Policy Change" /success:enable');
    await machine.cmd('netsh advfirewall reset');
    const xml = await machine.ps(`${EVENTS_4949}[0].ToXml()`);
    expect(xml).toContain('<EventID>4949</EventID>');
    expect(xml).toContain('<Task>13571</Task>');
    expect(xml).toContain('<Keywords>0x8020000000000000</Keywords>');
    expect(await machine.ps(`${EVENTS_4949}[0].Message`)).toContain('Windows Firewall settings were restored to the default values.');
  });

  it('writes one 4949 per reset', async () => {
    const machine = lab();
    await machine.cmd('auditpol /set /subcategory:"MPSSVC Rule-Level Policy Change" /success:enable');
    await machine.cmd('netsh advfirewall reset');
    await machine.cmd('netsh advfirewall reset');
    expect((await machine.ps(`(${EVENTS_4949} | Measure-Object).Count`)).trim()).toBe('2');
  });

  it('writes nothing while the subcategory is not audited', async () => {
    const machine = lab();
    await machine.cmd('netsh advfirewall reset');
    expect((await machine.ps(`(${EVENTS_4949} | Measure-Object).Count`)).trim()).toBe('0');
  });
});
