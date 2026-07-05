/**
 * PRD-Windows-Server.md §5 P11 — Web Server (IIS) role: `Install-
 * WindowsFeature Web-Server` hosts a minimal W3SVC + "Default Web Site"
 * over genuine TCP/80. Covers `New/Get/Start/Stop-Website`, `iisreset`,
 * and the PRD's explicit cross-OS acceptance criterion: `curl
 * http://srv1.lab.local/` from a Linux client and `Invoke-WebRequest`
 * from a Windows client both reach the real IIS default page.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, IPAddress, SubnetMask } from '@/network/core/types';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

const ps = (d: WindowsServer | WindowsPC) => PowerShellSubShell.create(d).subShell;
const run = async (sh: ReturnType<typeof ps>, l: string) => (await sh.processLine(l)).output.join('\n');

async function buildLan() {
  const srv1 = new WindowsServer('SRV1');
  const winClient = new WindowsPC('windows-pc', 'WINCLIENT1');
  const linuxClient = new LinuxPC('linux-pc', 'LINUXCLIENT1');
  const sw = new GenericSwitch('switch-generic', 'SW1');
  new Cable('c1').connect(srv1.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(winClient.getPorts()[0], sw.getPorts()[1]);
  new Cable('c3').connect(linuxClient.getPorts()[0], sw.getPorts()[2]);
  const mask = new SubnetMask('255.255.255.0');
  srv1.getPorts()[0].configureIP(new IPAddress('192.168.85.10'), mask);
  winClient.getPorts()[0].configureIP(new IPAddress('192.168.85.20'), mask);
  linuxClient.getPorts()[0].configureIP(new IPAddress('192.168.85.30'), mask);
  srv1.setCurrentUser('Administrator');
  return { srv1, winClient, linuxClient };
}

describe('Install-WindowsFeature Web-Server', () => {
  it('Website cmdlets are "not recognized" before the role is installed', async () => {
    const { srv1 } = await buildLan();
    const out = await run(ps(srv1), 'Get-Website');
    expect(out).toMatch(/not recognized/i);
  });
});

describe('New-Website / Get-Website / Start-Website / Stop-Website', () => {
  async function installed() {
    const lab = await buildLan();
    await run(ps(lab.srv1), 'Install-WindowsFeature Web-Server');
    return lab;
  }

  it('Get-Website lists the auto-created Default Web Site', async () => {
    const { srv1 } = await installed();
    const out = await run(ps(srv1), 'Get-Website');
    expect(out).toContain('Default Web Site');
    expect(out).toContain('80');
  });

  it('New-Website creates and starts a second site on its own port', async () => {
    const { srv1 } = await installed();
    await run(ps(srv1), 'New-Website -Name Contoso -PhysicalPath C:\\inetpub\\contoso -Port 8080');
    const out = await run(ps(srv1), 'Get-Website -Name Contoso');
    expect(out).toContain('Contoso');
    expect(out).toContain('Started');
  });

  it('Stop-Website / Start-Website toggle a site', async () => {
    const { srv1 } = await installed();
    await run(ps(srv1), 'Stop-Website -Name "Default Web Site"');
    let out = await run(ps(srv1), 'Get-Website -Name "Default Web Site"');
    expect(out).toContain('Stopped');
    await run(ps(srv1), 'Start-Website -Name "Default Web Site"');
    out = await run(ps(srv1), 'Get-Website -Name "Default Web Site"');
    expect(out).toContain('Started');
  });
});

describe('iisreset', () => {
  it('restarts running sites', async () => {
    const { srv1 } = await buildLan();
    await run(ps(srv1), 'Install-WindowsFeature Web-Server');
    const out = await srv1.executeCmdCommand('iisreset');
    expect(out).toMatch(/successfully/i);
  });
});

describe('PRD cross-OS acceptance criterion — curl / Invoke-WebRequest reach the real IIS default page', () => {
  it('curl from a Linux client gets the IIS default page with the Microsoft-IIS Server header', async () => {
    const { srv1, linuxClient } = await buildLan();
    await run(ps(srv1), 'Install-WindowsFeature Web-Server');
    await run(ps(srv1), 'Get-Website'); // triggers the lazy role/listener creation, mirroring real IIS bringing W3SVC up on role install

    const out = await linuxClient.executeCommand('curl http://192.168.85.10/');
    expect(out).toContain('IIS Windows Server');

    const head = await linuxClient.executeCommand('curl -I http://192.168.85.10/');
    expect(head).toContain('200');
    expect(head).toContain('Microsoft-IIS/10.0');
  });

  it('curl resolves a DNS hostname before dialing (DNS role + IIS role together)', async () => {
    const { srv1, linuxClient } = await buildLan();
    await run(ps(srv1), 'Install-WindowsFeature Web-Server');
    await run(ps(srv1), 'Get-Website');
    await run(ps(srv1), 'Install-WindowsFeature DNS');
    await run(ps(srv1), 'Add-DnsServerPrimaryZone -Name lab.local');
    await run(ps(srv1), 'Add-DnsServerResourceRecordA -ZoneName lab.local -Name srv1 -IPv4Address 192.168.85.10');
    await linuxClient.executeCommand('echo "nameserver 192.168.85.10" > /etc/resolv.conf');

    const out = await linuxClient.executeCommand('curl http://srv1.lab.local/');
    expect(out).toContain('IIS Windows Server');
  });

  it('Invoke-WebRequest from a Windows client gets the IIS default page', async () => {
    const { srv1, winClient } = await buildLan();
    await run(ps(srv1), 'Install-WindowsFeature Web-Server');
    await run(ps(srv1), 'Get-Website');

    const out = await run(ps(winClient), 'Invoke-WebRequest -Uri "http://192.168.85.10/"');
    expect(out).toContain('200');
    expect(out).toContain('IIS Windows Server');
  });

  it('a 404 for a nonexistent path is reported as an error by Invoke-WebRequest', async () => {
    const { srv1, winClient } = await buildLan();
    await run(ps(srv1), 'Install-WindowsFeature Web-Server');
    await run(ps(srv1), 'Get-Website');

    const out = await run(ps(winClient), 'Invoke-WebRequest -Uri "http://192.168.85.10/ghost.html"');
    expect(out).toMatch(/404/);
  });
});
