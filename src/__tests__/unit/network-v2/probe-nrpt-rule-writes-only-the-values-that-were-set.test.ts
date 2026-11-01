/*
 * Probe — a name resolution policy rule stores in the registry only the values that carry something: Version, Name,
 * ConfigOptions and, when set, GenericDNSServers and the optional fields. A field left at its default is absent, and
 * clearing a field removes its value.
 *
 * Measured first (Add-DnsClientNrptRule -Namespace ".corp.test" -NameServers 10.0.0.20): `reg query ...\DnsPolicyConfig
 * /s` listed eighteen values — twelve of them empty strings or zeroes (DirectAccessDNSServers, DirectAccessProxyType,
 * IPSECCARestriction, DNSSECQueryIPSECEncryption, DisplayName, Comment, NameEncoding, ...) that nobody asked for, so a
 * rule carried settings it never had, and `Set-DnsClientNrptRule -Comment ''` left an empty Comment behind instead of
 * removing it.
 *
 * Authority: Microsoft Learn, DnsClient module, Add-DnsClientNrptRule and Set-DnsClientNrptRule (the parameters that a
 * rule can carry, each optional; -NameServers sets the generic DNS servers); the registry layout of a rule
 * (Version, Name, ConfigOptions, GenericDNSServers under Dnscache\Parameters\DnsPolicyConfig\<id>) as written by the
 * cmdlet on a real machine.
 *
 * Discrimination (the probe run on the tree before the change): 3 of the 6 cases fall. The three that pass either way
 * are the WITNESS (the four values are there) and two NON-REGRESSIONS (a field that was set is stored and read back; a
 * rule read back reports the defaults of the fields it does not store).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

const RULES = 'HKLM\\SYSTEM\\CurrentControlSet\\Services\\Dnscache\\Parameters\\DnsPolicyConfig';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

function pc() {
  const win = new WindowsPC('windows-pc', 'WIN', 0, 0);
  win.powerOn();
  win.setCurrentUser('Administrator');
  const shell = PowerShellSubShell.create(win as never).subShell;
  const ps = async (line: string): Promise<string> => (await shell.processLine(line)).output.join('\n');
  const dump = (): Promise<string> => win.executeCommand(`reg query ${RULES} /s`);
  return { win, ps, dump };
}

describe('a rule stores only what was set', () => {
  it('WITNESS: the four values a minimal rule needs are there', async () => {
    const { ps, dump } = pc();
    await ps('Add-DnsClientNrptRule -Namespace ".corp.test" -NameServers 10.0.0.20');
    const out = await dump();
    expect(out).toMatch(/Version\s+REG_DWORD\s+0x2/);
    expect(out).toMatch(/Name\s+REG_MULTI_SZ\s+\.corp\.test/);
    expect(out).toMatch(/ConfigOptions\s+REG_DWORD\s+0x8/);
    expect(out).toMatch(/GenericDNSServers\s+REG_SZ\s+10\.0\.0\.20/);
  });

  it('a minimal rule carries nothing else', async () => {
    const { ps, dump } = pc();
    await ps('Add-DnsClientNrptRule -Namespace ".corp.test" -NameServers 10.0.0.20');
    const values = (await dump()).split(/\r?\n/).filter((line) => /^\s+\S+\s+REG_/.test(line)).map((line) => line.trim().split(/\s+/)[0]);
    expect(values.sort()).toEqual(['ConfigOptions', 'GenericDNSServers', 'Name', 'Version']);
  });

  it('NON-REGRESSION: a field that was set is stored and read back', async () => {
    const { ps, dump } = pc();
    await ps('Add-DnsClientNrptRule -Namespace ".corp.test" -NameServers 10.0.0.20 -DisplayName "Corp" -Comment "split dns"');
    expect(await dump()).toMatch(/DisplayName\s+REG_SZ\s+Corp/);
    expect(await ps('(Get-DnsClientNrptRule).Comment')).toBe('split dns');
  });

  it('clearing a field removes its value', async () => {
    const { ps, dump } = pc();
    await ps('Add-DnsClientNrptRule -Namespace ".corp.test" -NameServers 10.0.0.20 -Comment "split dns"');
    const name = (await ps('(Get-DnsClientNrptRule).Name')).trim();
    await ps(`Set-DnsClientNrptRule -Name "${name}" -Comment ""`);
    expect(await dump()).not.toContain('Comment');
  });

  it('a rule read back reports the defaults of the fields it does not store', async () => {
    const { ps } = pc();
    await ps('Add-DnsClientNrptRule -Namespace ".corp.test" -NameServers 10.0.0.20');
    expect(await ps('(Get-DnsClientNrptRule).NameEncoding')).toBe('Utf8WithMapping');
    expect(await ps('(Get-DnsClientNrptRule).DnsSecEnabled')).toBe('False');
    expect(await ps('(Get-DnsClientNrptRule).NameServers')).toBe('10.0.0.20');
  });

  it('a rule moved to another namespace keeps the same four-value shape', async () => {
    const { ps, dump } = pc();
    await ps('Add-DnsClientNrptRule -Namespace ".corp.test" -NameServers 10.0.0.20');
    const name = (await ps('(Get-DnsClientNrptRule).Name')).trim();
    await ps(`Set-DnsClientNrptRule -Name "${name}" -Namespace ".lab.test"`);
    const out = await dump();
    expect(out).toMatch(/Name\s+REG_MULTI_SZ\s+\.lab\.test/);
    expect(out).not.toContain('DirectAccessProxyType');
  });
});
