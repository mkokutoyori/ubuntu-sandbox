/**
 * IIS app pools and global modules — PRD-Windows-Server-Advanced.md §5
 * P15, §2.1.14. Purely process/isolation metadata (identity, recycling,
 * worker count) — this simulator never executes real .NET application
 * code in any app pool, matching the already-established convention for
 * simulated Oracle PL/SQL. `Get-WebGlobalModule` exposes the static
 * module registry already relevant to this role's own request pipeline.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters } from '@/network/core/types';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

const ps = (d: WindowsServer) => PowerShellSubShell.create(d).subShell;
const run = async (sh: ReturnType<typeof ps>, l: string) => (await sh.processLine(l)).output.join('\n');

async function installed(): Promise<WindowsServer> {
  const srv = new WindowsServer('SRV1');
  srv.setCurrentUser('Administrator');
  await run(ps(srv), 'Install-WindowsFeature Web-Server');
  await run(ps(srv), 'Get-Website'); // triggers the lazy role/listener creation
  return srv;
}

describe('New-WebAppPool / Get-IISAppPool (§5 P15)', () => {
  it('DefaultAppPool exists as soon as the role is installed', async () => {
    const srv = await installed();
    const out = await run(ps(srv), 'Get-IISAppPool');
    expect(out).toContain('DefaultAppPool');
    expect(out).toContain('Started');
  });

  it('New-WebAppPool creates a new pool with sane process/isolation defaults', async () => {
    const srv = await installed();
    await run(ps(srv), 'New-WebAppPool -Name ContosoPool');
    const out = await run(ps(srv), 'Get-IISAppPool -Name ContosoPool');
    expect(out).toContain('ContosoPool');
    expect(out).toContain('ApplicationPoolIdentity');
    expect(out).toContain('v4.0');
  });

  it('rejects creating a pool with a name that already exists', async () => {
    const srv = await installed();
    await run(ps(srv), 'New-WebAppPool -Name ContosoPool');
    const out = await run(ps(srv), 'New-WebAppPool -Name ContosoPool');
    expect(out).toMatch(/already exists/);
  });

  it('New-Website assigns the Default Web Site to DefaultAppPool, and a custom pool when specified', async () => {
    const srv = await installed();
    const defaultSite = await run(ps(srv), 'Get-Website -Name "Default Web Site" | Select-Object -ExpandProperty ApplicationPool');
    expect(defaultSite.trim()).toBe('DefaultAppPool');

    await run(ps(srv), 'New-WebAppPool -Name ContosoPool');
    await run(ps(srv), 'New-Website -Name Contoso -PhysicalPath C:\\inetpub\\contoso -Port 8080 -ApplicationPool ContosoPool');
    const contosoPool = await run(ps(srv), 'Get-Website -Name Contoso | Select-Object -ExpandProperty ApplicationPool');
    expect(contosoPool.trim()).toBe('ContosoPool');
  });

  it('Stop-WebAppPool / Start-WebAppPool toggle pool state', async () => {
    const srv = await installed();
    await run(ps(srv), 'New-WebAppPool -Name ContosoPool');
    await run(ps(srv), 'Stop-WebAppPool -Name ContosoPool');
    let out = await run(ps(srv), 'Get-IISAppPool -Name ContosoPool');
    expect(out).toContain('Stopped');
    await run(ps(srv), 'Start-WebAppPool -Name ContosoPool');
    out = await run(ps(srv), 'Get-IISAppPool -Name ContosoPool');
    expect(out).toContain('Started');
  });

  it('Restart-WebAppPool bumps the recycle count without touching state', async () => {
    const srv = await installed();
    await run(ps(srv), 'New-WebAppPool -Name ContosoPool');
    await run(ps(srv), 'Restart-WebAppPool -Name ContosoPool');
    await run(ps(srv), 'Restart-WebAppPool -Name ContosoPool');
    const out = await run(ps(srv), 'Get-IISAppPool -Name ContosoPool | Select-Object -ExpandProperty RecycleCount');
    expect(out.trim()).toBe('2');
  });

  it('the default application pool cannot be removed', async () => {
    const srv = await installed();
    const out = await run(ps(srv), 'Remove-WebAppPool -Name DefaultAppPool');
    expect(out).toMatch(/cannot be removed/);
  });

  it('Remove-WebAppPool removes a custom pool', async () => {
    const srv = await installed();
    await run(ps(srv), 'New-WebAppPool -Name ContosoPool');
    await run(ps(srv), 'Remove-WebAppPool -Name ContosoPool');
    const out = await run(ps(srv), 'Get-IISAppPool -Name ContosoPool');
    expect(out).toMatch(/does not exist/);
  });

  it('app pool cmdlets are "not recognized" before the Web-Server role is installed', async () => {
    const srv = new WindowsServer('SRV1');
    srv.setCurrentUser('Administrator');
    const out = await run(ps(srv), 'Get-IISAppPool');
    expect(out).toMatch(/not recognized/i);
  });
});

describe('Get-WebGlobalModule (§5 P15)', () => {
  it('lists the static module registry already relevant to this role\'s own pipeline', async () => {
    const srv = await installed();
    const out = await run(ps(srv), 'Get-WebGlobalModule');
    expect(out).toContain('StaticFileModule');
    expect(out).toContain('DefaultDocumentModule');
    expect(out).toContain('HttpErrorsModule');
  });

  it('Get-WebGlobalModule -Name filters to a single module', async () => {
    const srv = await installed();
    const out = await run(ps(srv), 'Get-WebGlobalModule -Name StaticFileModule');
    expect(out).toContain('StaticFileModule');
    expect(out).not.toContain('HttpErrorsModule');
  });
});
