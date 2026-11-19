/**
 * Probe: the System log's service, time and boot events follow the providers' manifests.
 *
 * Reference (rule 8): the event manifests dumped from Windows 11 (nasbench/EVTX-ETW-Resources, ETWProvidersCSVs/Internal): Service Control Manager 7034
 * "The {svc} service terminated unexpectedly.  It has done this {n} time(s)." (no corrective action configured) and 7031 "... The following corrective
 * action will be taken in {ms} milliseconds: {action}." (an action is configured); Microsoft-Windows-Time-Service 129 "NtpClient was unable to set a
 * domain peer ..." and 134 "... a manual peer ... DNS resolution error on '{peer}' ..."; Microsoft-Windows-Kernel-General 1 "The system time has changed to
 * {new} from {old}." with Change Reason and Process; Microsoft-Windows-Kernel-Boot 20 "The last shutdown's success status was {x}. The last boot's success
 * status was {y}."; Microsoft-Windows-Winlogon 7001 without a final period. The action words (Restart the service, Run the configured recovery program,
 * Reboot the computer) and the Change Reason wording come from real logs, not from the dump: recorded in TODO.md.
 *
 * Measured before the change: a crash with a recovery configured wrote 7034 and, for a reboot action, a 7031 whose text said the action was "suppressed
 * by the simulator"; Time-Service wrote 134 for the domain-peer error and 129 for the manual-peer one (the two ids swapped); Kernel-Boot 20 and Winlogon 7001
 * had the wrong wording; a fresh machine carried a Kernel-General 1 reading "The system uptime is 86400 seconds." (event 1 is the time change); and
 * changing the date wrote Security 4616 but no Kernel-General 1.
 *
 * Discrimination (git stash push -- src/network src/powershell): 8 of 9 cases fall on the base. Only the WITNESS that a crash is journalled passes either way
 * (the 7034 case fails on the double space of the manifest).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

let pc: WindowsPC;
let ps: (line: string) => Promise<string>;

const system = (id: number): Promise<string> =>
  ps(`Get-WinEvent -FilterHashtable @{LogName="System"; Id=${id}} -ErrorAction SilentlyContinue | ForEach-Object { $_.Message }`);
const pidOf = async (service: string): Promise<number> => Number(/PID\s*:\s*(\d+)/.exec(await pc.executeCommand(`sc queryex ${service}`))?.[1] ?? -1);

beforeEach(async () => {
  pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
  pc.setCurrentUser('Administrator');
  const shell = PowerShellSubShell.create(pc).subShell;
  ps = async (line) => (await shell.processLine(line)).output.join('\n').trim();
  await ps('New-Service -Name Svc1 -BinaryPathName "C:\\Services\\Svc1.exe" -DisplayName "Service One" -StartupType Automatic | Out-Null');
  await ps('Start-Service -Name Svc1');
});

describe('a service crash', () => {
  it('WITNESS: a crash is journalled', async () => {
    await pc.executeCommand(`taskkill /F /PID ${await pidOf('Svc1')}`);
    expect((await system(7034)).length + (await system(7031)).length).toBeGreaterThan(0);
  });

  it('with no recovery action writes 7034, double-spaced as the manifest has it', async () => {
    await pc.executeCommand(`taskkill /F /PID ${await pidOf('Svc1')}`);
    expect(await system(7034)).toBe('The Service One service terminated unexpectedly.  It has done this 1 time(s).');
    expect(await system(7031)).toBe('');
  });

  it('with a restart configured writes 7031 with the delay and the action', async () => {
    await pc.executeCommand('sc failure Svc1 reset= 60 actions= restart/5000');
    await pc.executeCommand(`taskkill /F /PID ${await pidOf('Svc1')}`);
    expect(await system(7031)).toBe('The Service One service terminated unexpectedly.  It has done this 1 time(s).  The following corrective action will be taken in 5000 milliseconds: Restart the service.');
    expect(await system(7034)).toBe('');
  });

  it('a reboot action is announced in the manifest wording, not as "suppressed by the simulator"', async () => {
    await pc.executeCommand('sc failure Svc1 reset= 60 actions= reboot/30000');
    await pc.executeCommand(`taskkill /F /PID ${await pidOf('Svc1')}`);
    pc.advanceTime(31_000);
    const out = await system(7031);
    expect(out).toContain('corrective action will be taken in 30000 milliseconds: Reboot the computer.');
    expect(out).not.toContain('suppressed');
  });
});

describe('the time service', () => {
  it('a manual peer that does not resolve writes 134, not 129', async () => {
    await pc.executeCommand('w32tm /config /manualpeerlist:nohost.invalid /syncfromflags:manual /update');
    await pc.executeCommand('w32tm /query /peers');
    expect(await system(134)).toContain("a manual peer to use as a time source because of DNS resolution error on 'nohost.invalid'");
    expect(await system(129)).toBe('');
  });
});

describe('a fresh machine and a clock change', () => {
  it('Kernel-Boot 20 states both the last shutdown and the last boot', async () => {
    expect(await system(20)).toBe("The last shutdown's success status was true. The last boot's success status was true.");
  });

  it('Winlogon 7001 has no final period', async () => {
    expect(await system(7001)).toBe('User Logon Notification for Customer Experience Improvement Program');
  });

  it('carries no Kernel-General 1 about uptime before the clock changes', async () => {
    expect(await system(1)).toBe('');
  });

  it('changing the date writes Kernel-General 1 with the change reason and the process', async () => {
    await pc.executeCommand('date 08-03-07');
    const out = await system(1);
    expect(out).toMatch(/^The system time has changed to 2007-08-03T\S+Z from \S+Z\.\n\nChange Reason: An application or system component changed the time\.\nProcess: 'C:\\Windows\\System32\\cmd\.exe' \(PID \d+\)\.$/);
  });
});
