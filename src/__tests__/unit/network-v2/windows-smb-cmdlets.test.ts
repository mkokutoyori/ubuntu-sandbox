/**
 * PRD-Windows-Server.md §5 P3 — New/Get/Remove-SmbShare, Get-SmbSession.
 * Gated on the FS-FileServer role (§8 acceptance criterion 2): before
 * install, New-SmbShare must fail with the "not recognized" module-absent
 * message; on a windows-pc it must never exist at all.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

const ps = (d: WindowsPC) => PowerShellSubShell.create(d).subShell;
const run = async (sh: ReturnType<typeof ps>, l: string) =>
  (await sh.processLine(l)).output.join('\n');

describe('New-SmbShare requires the FS-FileServer role', () => {
  it('fails with "not recognized" before the role is installed', async () => {
    const srv = new WindowsServer('SRV1');
    srv.setCurrentUser('Administrator');
    const out = await run(ps(srv), 'New-SmbShare -Name Data -Path C:\\Shares\\Data');
    expect(out).toMatch(/is not recognized as the name of a cmdlet/i);
  });

  it('does not exist at all on a windows-pc', async () => {
    const pc = new WindowsPC('windows-pc', 'DESKTOP-01');
    pc.setCurrentUser('Administrator');
    const out = await run(ps(pc), 'Get-SmbShare');
    expect(out).toMatch(/is not recognized as the name of a cmdlet/i);
  });

  it('works once FS-FileServer is installed', async () => {
    const srv = new WindowsServer('SRV1');
    srv.setCurrentUser('Administrator');
    const sh = ps(srv);
    await run(sh, 'Install-WindowsFeature FS-FileServer');

    const created = await run(sh, 'New-SmbShare -Name Data -Path C:\\Shares\\Data');
    expect(created).toContain('Data');
    expect(created).toContain('C:\\Shares\\Data');

    const list = await run(sh, 'Get-SmbShare');
    expect(list).toContain('Data');
    expect(list).toContain('ADMIN$');
    expect(list).toContain('IPC$');

    const removed = await run(sh, 'Remove-SmbShare -Name Data -Force');
    expect(removed).toBe('');
    expect(await run(sh, 'Get-SmbShare -Name Data')).toMatch(/No SMB share exists/i);
  });
});

describe('net share / New-SmbShare share ONE table', () => {
  it('a share added via cmd net share is visible from Get-SmbShare and vice versa', async () => {
    const srv = new WindowsServer('SRV2');
    srv.setCurrentUser('Administrator');
    await srv.executeCmdCommand('net share Legacy=C:\\Legacy');
    await run(ps(srv), 'Install-WindowsFeature FS-FileServer');
    expect(await run(ps(srv), 'Get-SmbShare -Name Legacy')).toContain('C:\\Legacy');

    await run(ps(srv), 'New-SmbShare -Name Modern -Path C:\\Modern');
    expect(await srv.executeCmdCommand('net share')).toContain('Modern');
  });
});

describe('Get-SmbSession starts empty', () => {
  it('returns nothing until a client connects', async () => {
    const srv = new WindowsServer('SRV3');
    srv.setCurrentUser('Administrator');
    await run(ps(srv), 'Install-WindowsFeature FS-FileServer');
    const out = await run(ps(srv), 'Get-SmbSession');
    expect(out).toBe('');
  });
});
