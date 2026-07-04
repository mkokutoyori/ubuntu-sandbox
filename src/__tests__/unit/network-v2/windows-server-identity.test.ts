/**
 * PRD-Windows-Server.md §5 P1 acceptance criterion #1: systeminfo, wmic
 * os get caption, reg query CurrentVersion /v ProductName and
 * Get-ComputerInfo must agree on the OS identity — "Windows Server 2022
 * Standard" for a `windows-server` device, and the existing client
 * identity ("Windows 10 Pro") for a `windows-pc`, on the SAME machine.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { createDevice, resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { PowerShellExecutor } from '@/network/devices/windows/PowerShellExecutor';
import { resetCounters } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

const ps = (d: WindowsPC) => PowerShellSubShell.create(d).subShell;
const run = async (sh: ReturnType<typeof ps>, l: string) =>
  (await sh.processLine(l)).output.join('\n');

describe('WindowsServer class', () => {
  it('is a WindowsPC subclass carrying the windows-server device type', () => {
    const srv = new WindowsServer('SRV1');
    expect(srv).toBeInstanceOf(WindowsPC);
    expect(srv).toBeInstanceOf(WindowsServer);
    expect(srv.getType()).toBe('windows-server');
  });

  it('DeviceFactory instantiates a WindowsServer for the windows-server type', () => {
    const dev = createDevice('windows-server');
    expect(dev).toBeInstanceOf(WindowsServer);
  });
});

describe('4-source identity coherence — windows-server', () => {
  it('systeminfo, wmic, reg query and Get-ComputerInfo all agree', async () => {
    const srv = new WindowsServer('WIN-SRV01');
    srv.setCurrentUser('Administrator');

    const systeminfo = await srv.executeCmdCommand('systeminfo');
    expect(systeminfo).toContain('Windows Server 2022 Standard');
    expect(systeminfo).toContain('Member Server');

    const wmic = await srv.executeCmdCommand('wmic os get caption');
    expect(wmic).toContain('Microsoft Windows Server 2022 Standard');

    const reg = await srv.executeCmdCommand(
      'reg query "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion" /v ProductName');
    expect(reg).toContain('Windows Server 2022 Standard');

    const gci = await run(ps(srv), 'Get-ComputerInfo');
    expect(gci).toContain('Windows Server 2022 Standard');
    expect(gci).toContain('WindowsInstallationType  : Server');

    // $PSVersionTable.OS — same registry-backed build string sourced by
    // the other 3 checks above (executor-level; the tree-walking
    // interpreter's static $PSVersionTable has no .OS property at all,
    // a pre-existing gap unrelated to Windows Server identity).
    const psVersion = await new PowerShellExecutor(srv as any).execute('$PSVersionTable.OS');
    expect(psVersion).toContain('10.0.20348');
  });
});

describe('4-source identity coherence — windows-pc (unaffected by server changes)', () => {
  it('systeminfo, wmic, reg query and Get-ComputerInfo all agree on the client identity', async () => {
    const pc = new WindowsPC('windows-pc', 'DESKTOP-01');
    pc.setCurrentUser('Administrator');

    const systeminfo = await pc.executeCmdCommand('systeminfo');
    expect(systeminfo).toContain('Windows 10 Pro');
    expect(systeminfo).toContain('Member Workstation');
    expect(systeminfo).not.toContain('Server');

    const wmic = await pc.executeCmdCommand('wmic os get caption');
    expect(wmic).toContain('Windows 10 Pro');
    expect(wmic).not.toContain('Server');

    const reg = await pc.executeCmdCommand(
      'reg query "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion" /v ProductName');
    expect(reg).toContain('Windows 10 Pro');

    const gci = await run(ps(pc), 'Get-ComputerInfo');
    expect(gci).toContain('Windows 10 Pro');
    expect(gci).toContain('WindowsInstallationType  : Client');

    const psVersion = await new PowerShellExecutor(pc as any).execute('$PSVersionTable.OS');
    expect(psVersion).toContain('10.0.22631');
  });
});
