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
    expect(gci).toMatch(/WindowsInstallationType\s+: Server/);

    // $PSVersionTable.BuildVersion — same registry-backed build as the
    // three checks above. Windows PowerShell 5.1 has no `OS` key (that is
    // PowerShell Core's), so the build is read where 5.1 publishes it.
    const psVersion = await run(ps(srv), '$PSVersionTable.BuildVersion');
    expect(psVersion).toContain('10.0.20348');
    expect(await run(ps(srv), '(Get-ComputerInfo).OsVersion')).toContain('10.0.20348');
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
    expect(gci).toMatch(/WindowsInstallationType\s+: Client/);

    const psVersion = await run(ps(pc), '$PSVersionTable.BuildVersion');
    expect(psVersion).toContain('10.0.22631');
  });
});
