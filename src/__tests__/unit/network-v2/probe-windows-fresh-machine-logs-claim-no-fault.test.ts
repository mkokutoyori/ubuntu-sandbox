/**
 * Probe: a machine that has just been created does not carry the record of faults that never happened.
 *
 * Reference (rule 3, one event log per machine, and the rule against fabricated records): a log entry is a statement about the machine. The
 * seed of the System and Application logs stated that a disk had a bad block, that the time service had not synchronised for a day, that
 * the machine had come back from a low power state, that explorer.exe had faulted, that svchost.exe had stopped responding, that a fault bucket
 * APPCRASH existed and that a .NET application had crashed. None of it was true of a machine created a moment earlier, and a learner reading
 * Get-WinEvent -LogName System -Level 2 was sent hunting a disk fault that the simulator had invented.
 *
 * Measured before the change: a fresh WindowsPC listed the Disk 7 error, the Time-Service 36 warning, the Power-Troubleshooter 1 warning in System
 * and the WER 1001, Application Error 1000, Application Hang 1002 and .NET Runtime 1026 entries in Application. Two tests that took the Disk
 * provider as a convenient fixture were repointed to Service Control Manager, a provider every machine really has.
 *
 * Discrimination (git stash push -- src/network src/powershell): 5 of 6 cases fall on the base. The WITNESS passes either way: the genuine
 * start-up entries (Event log service started, operating system started) are still there, so the logs are not simply emptied.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

let ps: (line: string) => Promise<string>;

const providers = (log: string): Promise<string> =>
  ps(`Get-WinEvent -LogName ${log} | ForEach-Object { $_.ProviderName } | Sort-Object -Unique`);

beforeEach(() => {
  EquipmentRegistry.getInstance().clear();
  const pc = new WindowsPC('windows-pc', 'PC-A', 0, 0);
  pc.setCurrentUser('Administrator');
  const shell = PowerShellSubShell.create(pc).subShell;
  ps = async (line) => (await shell.processLine(line)).output.join('\n').trim();
});

describe('a fresh machine', () => {
  it('WITNESS: keeps its genuine start-up entries', async () => {
    const out = await ps('Get-WinEvent -LogName System | ForEach-Object { "$($_.ProviderName):$($_.Id)" }');
    expect(out).toContain('EventLog:6005');
    expect(out).toContain('Microsoft-Windows-Kernel-General:12');
  });

  it('has no disk error in System', async () => {
    expect(await providers('System')).not.toContain('Disk');
  });

  it('has no time-service warning in System', async () => {
    const out = await ps('Get-WinEvent -LogName System | ForEach-Object { "$($_.ProviderName):$($_.Id)" }');
    expect(out).not.toContain('Microsoft-Windows-Time-Service:36');
  });

  it('has no power-state warning in System', async () => {
    expect(await providers('System')).not.toContain('Microsoft-Windows-Power-Troubleshooter');
  });

  it('has no application fault in Application', async () => {
    const out = await providers('Application');
    expect(out).not.toContain('Application Error');
    expect(out).not.toContain('Application Hang');
  });

  it('has no crash report in Application', async () => {
    const out = await providers('Application');
    expect(out).not.toContain('Windows Error Reporting');
    expect(out).not.toContain('.NET Runtime');
  });
});
