/**
 * Probe: a start or stop request to a service writes 7035 before the 7036 that reports its new state.
 *
 * Reference (rule 8): Microsoft's Service Control Manager events table (learn.microsoft.com, Basic Service Operations, Windows Server 2008 R2):
 * 7035, source Service Control Manager, "The %1 service was successfully sent a %2 control." — written when a client sends the service a control,
 * ahead of 7036 "The %1 service entered the %2 state." that the service itself causes. The control words are the ones Windows prints, start and stop.
 * A start or stop that the SCM itself decides (boot, crash recovery) sends no client control and writes no 7035.
 *
 * Measured before the change: sc, net, Start-Service and Stop-Service wrote 7036 only, so a System log that a learner reads against real captures
 * lost every "successfully sent a start control" line, and the request could not be told from a service that changed state by itself.
 *
 * Discrimination (git stash push -- src/network src/powershell): 5 of 8 cases fall on the base. Three pass either way: the WITNESS that 7036 is still
 * written, the refusal of a start on a disabled service (no 7035 on either version), and the absence of any 7035 on a machine nobody touched
 * (vacuous on the base, where 7035 is never written).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

let pc: WindowsPC;
let ps: (line: string) => Promise<string>;

const scm = (id: number): Promise<string> =>
  ps(`Get-WinEvent -FilterHashtable @{LogName="System"; ProviderName="Service Control Manager"; Id=${id}} -ErrorAction SilentlyContinue | ForEach-Object { $_.Message }`);
const count = (id: number): Promise<number> =>
  ps(`(Get-WinEvent -FilterHashtable @{LogName="System"; ProviderName="Service Control Manager"; Id=${id}} -ErrorAction SilentlyContinue | Measure-Object).Count`).then(Number);

beforeEach(() => {
  EquipmentRegistry.getInstance().clear();
  pc = new WindowsPC('windows-pc', 'PC-A', 0, 0);
  pc.setCurrentUser('Administrator');
  const shell = PowerShellSubShell.create(pc).subShell;
  ps = async (line) => (await shell.processLine(line)).output.join('\n').trim();
});

describe('7035 — a control sent to a service', () => {
  it('WITNESS: 7036 is still written when a service is stopped', async () => {
    await pc.executeCommand('sc stop Spooler');
    expect(await scm(7036)).toContain('The Print Spooler service entered the stopped state.');
  });

  it('sc stop writes "sent a stop control"', async () => {
    await pc.executeCommand('sc stop Spooler');
    expect(await scm(7035)).toContain('The Print Spooler service was successfully sent a stop control.');
  });

  it('sc start writes "sent a start control"', async () => {
    await pc.executeCommand('sc stop Spooler');
    await pc.executeCommand('sc start Spooler');
    expect(await scm(7035)).toContain('The Print Spooler service was successfully sent a start control.');
  });

  it('net stop and net start write the same lines', async () => {
    await pc.executeCommand('net stop Spooler');
    await pc.executeCommand('net start Spooler');
    const out = await scm(7035);
    expect(out).toContain('sent a stop control.');
    expect(out).toContain('sent a start control.');
  });

  it('Stop-Service and Start-Service write the same lines', async () => {
    await ps('Stop-Service -Name Spooler');
    await ps('Start-Service -Name Spooler');
    const out = await scm(7035);
    expect(out).toContain('The Print Spooler service was successfully sent a stop control.');
    expect(out).toContain('The Print Spooler service was successfully sent a start control.');
  });

  it('is written before the 7036 it causes', async () => {
    await pc.executeCommand('sc stop Spooler');
    const out = await ps(`Get-WinEvent -FilterHashtable @{LogName="System"; ProviderName="Service Control Manager"} | Where-Object { $_.Message -like "*Print Spooler*" } | Sort-Object RecordId | ForEach-Object { $_.Id }`);
    const ids = out.split('\n').map((l) => l.trim()).filter(Boolean);
    expect(ids.indexOf('7035')).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf('7035')).toBeLessThan(ids.lastIndexOf('7036'));
  });

  it('is not written when the request is refused (disabled service)', async () => {
    await pc.executeCommand('sc stop Spooler');
    await pc.executeCommand('sc config Spooler start= disabled');
    const before = await count(7035);
    await pc.executeCommand('sc start Spooler');
    expect(await count(7035)).toBe(before);
  });

  it('is not written for a service that is stopped by nobody (nothing happened)', async () => {
    expect(await count(7035)).toBe(0);
  });
});
