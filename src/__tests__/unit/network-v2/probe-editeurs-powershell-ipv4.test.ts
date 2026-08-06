import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

function shell(pc: WindowsPC) {
  const { subShell } = PowerShellSubShell.create(pc);
  return async (line: string): Promise<string> => {
    const r = await subShell.processLine(line);
    if (typeof r === 'string') return r;
    const out = (r as { output?: string | string[] }).output;
    return Array.isArray(out) ? out.join('\n') : (out ?? '');
  };
}

describe('a directory that does not exist is not a place one can go', () => {
  it('Set-Location refuses it, in PowerShell own words', async () => {
    const run = shell(new WindowsPC('windows-pc', 'W1', 0, 0));
    const before = await run('Get-Location');
    const err = await run('cd C:\\nexistepas');
    expect(err).toContain("Cannot find path 'C:\\nexistepas' because it does not exist.");
    expect(await run('Get-Location')).toBe(before);
  });

  it('Push-Location refuses it too', async () => {
    const run = shell(new WindowsPC('windows-pc', 'W1', 0, 0));
    const before = await run('Get-Location');
    expect(await run('pushd C:\\pas-la')).toContain('Cannot find path');
    expect(await run('Get-Location')).toBe(before);
  });

  it('a directory that DOES exist is still reachable', async () => {
    const run = shell(new WindowsPC('windows-pc', 'W1', 0, 0));
    await run('New-Item -ItemType Directory -Path C:\\travail');
    expect(await run('cd C:\\travail')).not.toContain('Cannot find path');
    expect(await run('Get-Location')).toContain('C:\\travail');
  });

  it('Test-Path and Set-Location agree about the same path', async () => {
    const run = shell(new WindowsPC('windows-pc', 'W1', 0, 0));
    for (const p of ['C:\\absent', 'C:\\Users']) {
      const exists = (await run(`Test-Path ${p}`)).includes('True');
      const moved = !(await run(`cd ${p}`)).includes('Cannot find path');
      expect(moved, p).toBe(exists);
    }
  });
});

describe('an IPv4 address with an octet over 255 is not an address', () => {
  it('New-NetIPAddress refuses it', async () => {
    const pc = new WindowsPC('windows-pc', 'W1', 0, 0);
    const run = shell(pc);
    const err = await run(
      'New-NetIPAddress -InterfaceAlias Ethernet0 -IPAddress 999.1.1.1 -PrefixLength 24');
    expect(err).toContain('not a valid IPv4 address');
    expect(await run('Get-NetIPAddress')).not.toContain('999.1.1.1');
  });

  it.each(['256.1.1.1', '1.2.3.999', '300.300.300.300', '192.168.1'])(
    '%s is refused', async (bad) => {
      const run = shell(new WindowsPC('windows-pc', 'W1', 0, 0));
      expect(await run(
        `New-NetIPAddress -InterfaceAlias Ethernet0 -IPAddress ${bad} -PrefixLength 24`))
        .toContain('not a valid IPv4 address');
    });

  it('a real address is still accepted, and shows up', async () => {
    const pc = new WindowsPC('windows-pc', 'W1', 0, 0);
    const run = shell(pc);
    expect(await run(
      'New-NetIPAddress -InterfaceAlias Ethernet0 -IPAddress 192.168.5.10 -PrefixLength 24'))
      .not.toContain('not a valid');
    expect(await run('Get-NetIPAddress')).toContain('192.168.5.10');
  });

  it('an IPv6 address is not judged by the IPv4 rule', async () => {
    const run = shell(new WindowsPC('windows-pc', 'W1', 0, 0));
    expect(await run(
      'New-NetIPAddress -InterfaceAlias Ethernet0 -IPAddress "2001:db8::1" -PrefixLength 64'))
      .not.toContain('not a valid IPv4 address');
  });

  it('netsh and PowerShell now agree on the same bad address', async () => {
    const pc = new WindowsPC('windows-pc', 'W1', 0, 0);
    const run = shell(pc);
    const viaNetsh = await pc.executeCommand(
      'netsh interface ip set address name="Ethernet0" static 300.1.1.1 255.255.255.0');
    const viaPs = await run(
      'New-NetIPAddress -InterfaceAlias Ethernet0 -IPAddress 300.1.1.1 -PrefixLength 24');
    expect(viaNetsh).toMatch(/Invalid|not a valid/i);
    expect(viaPs).toMatch(/Invalid|not a valid/i);
  });
});
