/**
 * PRD-Windows-Server.md §5 P2 — Get/Install/Uninstall-WindowsFeature through
 * the real PowerShell interpreter stack (PSInterpreter → WindowsPSProviders
 * → RoleManager → WindowsServiceManager). Also pins PRD §2.1.2's client
 * refusal: these cmdlets don't exist at all on a `windows-pc`.
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

describe('Get-WindowsFeature on a Windows Server', () => {
  it('lists every catalog feature as Available on a fresh server', async () => {
    const srv = new WindowsServer('SRV1');
    srv.setCurrentUser('Administrator');
    const out = await run(ps(srv), 'Get-WindowsFeature');
    expect(out).toContain('Display Name');
    expect(out).toContain('Install State');
    expect(out).toMatch(/\[ \] File Server\s+FS-FileServer\s+Available/);
    expect(out).toMatch(/\[ \] DNS Server\s+DNS\s+Available/);
  });

  it('-Name filters to a single feature', async () => {
    const srv = new WindowsServer('SRV1');
    const out = await run(ps(srv), 'Get-WindowsFeature -Name FS-FileServer');
    expect(out).toMatch(/\[ \] File Server\s+FS-FileServer\s+Available/);
    expect(out).not.toContain('DNS Server');
  });
});

describe('Install-WindowsFeature / Uninstall-WindowsFeature on a Windows Server', () => {
  it('installs FS-FileServer, starts LanmanServer, and Get-WindowsFeature reflects it', async () => {
    const srv = new WindowsServer('SRV1');
    srv.setCurrentUser('Administrator');
    const sh = ps(srv);

    const installOut = await run(sh, 'Install-WindowsFeature FS-FileServer');
    expect(installOut).toContain('Success');
    expect(installOut).toContain('File Server');

    const feature = await run(sh, 'Get-WindowsFeature -Name FS-FileServer');
    expect(feature).toMatch(/\[X\] File Server\s+FS-FileServer\s+Installed/);

    const svcOut = await run(sh, 'Get-Service LanmanServer');
    expect(svcOut).toContain('Running');
  });

  it('installs a role-only service (DNS) that did not exist before', async () => {
    const srv = new WindowsServer('SRV1');
    srv.setCurrentUser('Administrator');
    const sh = ps(srv);

    const before = await run(sh, 'Get-Service DNS');
    expect(before).toMatch(/Cannot find any service/i);

    await run(sh, 'Install-WindowsFeature DNS');
    const after = await run(sh, 'Get-Service DNS');
    expect(after).toContain('Running');
  });

  it('-IncludeManagementTools also installs RSAT-AD-PowerShell', async () => {
    const srv = new WindowsServer('SRV1');
    srv.setCurrentUser('Administrator');
    const sh = ps(srv);

    await run(sh, 'Install-WindowsFeature AD-Domain-Services -IncludeManagementTools');
    const rsat = await run(sh, 'Get-WindowsFeature -Name RSAT-AD-PowerShell');
    expect(rsat).toMatch(/\[X\]/);
  });

  it('Uninstall-WindowsFeature removes a role-only service entirely', async () => {
    const srv = new WindowsServer('SRV1');
    srv.setCurrentUser('Administrator');
    const sh = ps(srv);

    await run(sh, 'Install-WindowsFeature DNS');
    const uninstallOut = await run(sh, 'Uninstall-WindowsFeature DNS');
    expect(uninstallOut).toContain('Success');

    const feature = await run(sh, 'Get-WindowsFeature -Name DNS');
    expect(feature).toMatch(/\[ \] DNS Server\s+DNS\s+Available/);
    const svcOut = await run(sh, 'Get-Service DNS');
    expect(svcOut).toMatch(/Cannot find any service/i);
  });

  it('an unrecognized feature name fails without crashing the shell', async () => {
    const srv = new WindowsServer('SRV1');
    srv.setCurrentUser('Administrator');
    const out = await run(ps(srv), 'Install-WindowsFeature Not-A-Real-Feature');
    expect(out).toMatch(/not a recognized Windows feature name/i);
  });

  it('a non-elevated user is denied and no service is created', async () => {
    const srv = new WindowsServer('SRV1'); // default current user is 'User' (non-admin)
    const sh = ps(srv);
    const out = await run(sh, 'Install-WindowsFeature DNS');
    expect(out).toMatch(/access is denied/i);
    expect(await run(sh, 'Get-WindowsFeature -Name DNS')).toMatch(/Available/);
    expect(await run(sh, 'Get-Service DNS')).toMatch(/Cannot find any service/i);
  });
});

describe('Server Manager cmdlets do not exist on a Windows client (PRD §2.1.2)', () => {
  it('Get-WindowsFeature is "not recognized" on a windows-pc', async () => {
    const pc = new WindowsPC('windows-pc', 'DESKTOP-01');
    pc.setCurrentUser('Administrator');
    const out = await run(ps(pc), 'Get-WindowsFeature');
    expect(out).toMatch(/is not recognized as the name of a cmdlet/i);
  });

  it('Install-WindowsFeature is "not recognized" on a windows-pc', async () => {
    const pc = new WindowsPC('windows-pc', 'DESKTOP-01');
    pc.setCurrentUser('Administrator');
    const out = await run(ps(pc), 'Install-WindowsFeature FS-FileServer');
    expect(out).toMatch(/is not recognized as the name of a cmdlet/i);
  });
});
