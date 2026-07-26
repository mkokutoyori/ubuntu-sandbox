/**
 * Get-CimInstance/Get-WmiObject coverage (rapport 06, item #47). Only
 * Win32_Process/Win32_Service/Win32_PerfFormattedData_PerfProc_Process/
 * SoftwareLicensingProduct were wired to real per-device state; every other
 * class name threw "not recognized". Adds Win32_NetworkAdapter,
 * Win32_NetworkAdapterConfiguration, Win32_UserAccount, and Win32_Group as
 * thin projections over the already-real network/user providers (the same
 * ones backing Get-NetAdapter/Get-NetIPAddress/New-LocalUser) — no new
 * device-model state, matching the shape of the four classes already done.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { IPAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

const ps = (d: WindowsPC) => PowerShellSubShell.create(d).subShell;
const run = async (sh: ReturnType<typeof ps>, l: string) =>
  (await sh.processLine(l)).output.join('\n');

describe('Win32_NetworkAdapter', () => {
  it('reflects the real adapter name and MAC address', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1');
    const shell = ps(pc);
    const name = (await run(shell, 'Get-CimInstance -ClassName Win32_NetworkAdapter | Select-Object -ExpandProperty Name')).trim();
    expect(name).toContain('Ethernet');

    const mac = (await run(shell, 'Get-CimInstance -ClassName Win32_NetworkAdapter | Select-Object -ExpandProperty MACAddress')).trim();
    const fromGetNetAdapter = (await run(shell, 'Get-NetAdapter | Select-Object -ExpandProperty MacAddress')).trim();
    expect(mac).toBe(fromGetNetAdapter);
  });

  it('gwmi alias resolves the same class', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1');
    const out = await run(ps(pc), 'gwmi Win32_NetworkAdapter | Select-Object -ExpandProperty Name');
    expect(out.trim().length).toBeGreaterThan(0);
  });
});

describe('Win32_NetworkAdapterConfiguration', () => {
  it('joins adapter + a newly-assigned IP + gateway into one object', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1');
    pc.setDefaultGateway(new IPAddress('10.0.0.1'));
    const shell = ps(pc);
    await run(shell, 'New-NetIPAddress -IPAddress 10.0.0.9 -InterfaceAlias "Ethernet 0" -PrefixLength 24');

    const ip = (await run(shell,
      'Get-CimInstance -ClassName Win32_NetworkAdapterConfiguration | Where-Object { $_.IPAddress -contains "10.0.0.9" } | Select-Object -ExpandProperty IPAddress')).trim();
    expect(ip).toContain('10.0.0.9');

    const subnet = (await run(shell,
      'Get-CimInstance -ClassName Win32_NetworkAdapterConfiguration | Where-Object { $_.IPAddress -contains "10.0.0.9" } | Select-Object -ExpandProperty IPSubnet')).trim();
    expect(subnet).toContain('255.255.255.0');

    const gw = (await run(shell,
      'Get-CimInstance -ClassName Win32_NetworkAdapterConfiguration | Where-Object { $_.IPAddress -contains "10.0.0.9" } | Select-Object -ExpandProperty DefaultIPGateway')).trim();
    expect(gw).toContain('10.0.0.1');
  });
});

describe('Win32_UserAccount', () => {
  it('reflects a user created via New-LocalUser, including Disabled state', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1');
    pc.setCurrentUser('Administrator');
    const shell = ps(pc);
    await run(shell, 'New-LocalUser -Name "jdoe" -FullName "Jane Doe"');

    const full = (await run(shell,
      'Get-CimInstance -ClassName Win32_UserAccount | Where-Object { $_.Name -eq "jdoe" } | Select-Object -ExpandProperty FullName')).trim();
    expect(full).toBe('Jane Doe');

    const disabled = (await run(shell,
      'Get-CimInstance -ClassName Win32_UserAccount | Where-Object { $_.Name -eq "jdoe" } | Select-Object -ExpandProperty Disabled')).trim();
    expect(disabled).toBe('False');
  });
});

describe('Win32_Group', () => {
  it('reflects a group created via New-LocalGroup', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1');
    pc.setCurrentUser('Administrator');
    const shell = ps(pc);
    await run(shell, 'New-LocalGroup -Name "Auditors" -Description "Audit team"');

    const desc = (await run(shell,
      'Get-CimInstance -ClassName Win32_Group | Where-Object { $_.Name -eq "Auditors" } | Select-Object -ExpandProperty Description')).trim();
    expect(desc).toBe('Audit team');
  });
});

describe('an unrecognized class still falls through to the legacy executor', () => {
  it('Win32_Bogus is neither a modern nor legacy class and reports an error', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1');
    const shell = ps(pc);
    const out = await run(shell, 'Get-CimInstance -ClassName Win32_Bogus');
    expect(out.toLowerCase()).toMatch(/not recognized|invalid class/);
  });
});
