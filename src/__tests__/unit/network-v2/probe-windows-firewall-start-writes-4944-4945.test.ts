/**
 * Probe — starting the Windows Firewall service writes 4944 and 4945.
 *
 * Measured: `Restart-Service mpssvc` with "MPSSVC Rule-Level Policy Change"
 * auditing on wrote nothing about the policy in effect, while a real machine
 * writes one 4944 per profile and one 4945 per rule listed for the Public
 * profile (Microsoft "event-4944" / "event-4945" pages: fields, task 13571,
 * Audit Success keyword; message text from the Microsoft-Windows-Security-Auditing
 * manifest dump of Windows 11 24H2). Gated by the same subcategory as 4946-4950.
 * Not covered: 4957, which needs an address set that resolves empty (DNS,
 * DHCP, DefaultGateway keywords) that the rule store cannot express yet.
 *
 * Discrimination on the base: 5 of 6 fall; the witness (nothing written while
 * the subcategory is off) passes either way. Operational mode "On"/"Off"
 * and "Enabled"/"Disabled" for the flags: the page shows "Off" and "Disabled"
 * examples only; the other values are their complement.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => { EquipmentRegistry.resetInstance(); });

async function lab(audited: boolean): Promise<WindowsPC> {
  const pc = new WindowsPC('windows-pc', 'win1', 0, 0);
  pc.powerOn();
  pc.setCurrentUser('Administrator');
  if (audited) await pc.executeCommand('auditpol /set /subcategory:"MPSSVC Rule-Level Policy Change" /success:enable');
  await pc.executeCommand('powershell -Command "Restart-Service mpssvc"');
  return pc;
}

const query = (pc: WindowsPC, id: number, extra = ''): Promise<string> =>
  pc.executeCommand(`powershell -Command "Get-WinEvent -FilterHashtable @{LogName='Security';Id=${id}} -ErrorAction SilentlyContinue ${extra}"`);

describe('Windows Firewall start', () => {
  it('writes one 4944 per profile', async () => {
    const out = await query(await lab(true), 4944, '| Measure-Object | ForEach-Object { $_.Count }');
    expect(out.trim()).toBe('3');
  });

  it('4944 carries the profile settings and the documented text', async () => {
    const out = await query(await lab(true), 4944, '| Select-Object -First 1 | ForEach-Object { $_.Message }');
    expect(out).toContain('The following policy was active when the Windows Firewall started.');
    expect(out).toContain('Group Policy Applied:\tNo');
    expect(out).toMatch(/Profile Used:\t(Domain|Private|Public)/);
    expect(out).toContain('Operational mode:\tOn');
    expect(out).toContain('Allow Remote Administration:\tDisabled');
  });

  it('writes 4945 for the rules listed for the Public profile', async () => {
    const out = await query(await lab(true), 4945, '| Measure-Object | ForEach-Object { $_.Count }');
    expect(Number(out.trim())).toBeGreaterThan(0);
  });

  it('4945 names the profile, the rule id and the rule name', async () => {
    const out = await query(await lab(true), 4945, '| Select-Object -First 1 | ForEach-Object { $_.Message }');
    expect(out).toContain('A rule was listed when the Windows Firewall started.');
    expect(out).toContain('Profile used:\tPublic');
    expect(out).toMatch(/Rule ID:\t\S+/);
  });

  it('is tagged task 13571 and the Audit Success keyword', async () => {
    const out = await query(await lab(true), 4944, '| Select-Object -First 1 | ForEach-Object { "$($_.Task) $($_.Keywords)" }');
    expect(out.trim()).toBe(`13571 ${0x8020000000000000n}`);
  });

  it('witness: with the subcategory off, nothing is written', async () => {
    const pc = await lab(false);
    expect((await query(pc, 4944)).trim()).toBe('');
    expect((await query(pc, 4945)).trim()).toBe('');
  });
});
