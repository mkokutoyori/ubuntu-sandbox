/**
 * PRD-Windows-Server.md §5 P11 — Web Server (IIS) role core:
 * `WindowsIisRole` hosts a minimal HTTP server over genuine TCP/80 (and
 * additional site ports) — real 200/404 responses, `Server:
 * Microsoft-IIS/10.0`, file serving from a physical path — with
 * `dialHttp` as the real-wire client (used by `curl`/`Invoke-WebRequest`).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, IPAddress, SubnetMask } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { WindowsIisRole } from '@/network/devices/windows/server/iis/WindowsIisRole';
import { WindowsFileSystem } from '@/network/devices/windows/WindowsFileSystem';
import { WindowsCertStore } from '@/network/devices/windows/CertStore';
import { dialHttp } from '@/network/http/HttpClient';
import type { EndHost } from '@/network/devices/EndHost';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

function topology() {
  const server = new LinuxPC('linux-pc', 'IISHOST');
  const client = new LinuxPC('linux-pc', 'CLIENT1');
  const sw = new GenericSwitch('switch-generic', 'SW1');
  new Cable('c1').connect(server.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(client.getPorts()[0], sw.getPorts()[1]);
  const mask = new SubnetMask('255.255.255.0');
  server.getPorts()[0].configureIP(new IPAddress('192.168.95.10'), mask);
  client.getPorts()[0].configureIP(new IPAddress('192.168.95.20'), mask);
  return { server: server as unknown as EndHost, client };
}

describe('WindowsIisRole — site admin surface', () => {
  it('auto-creates "Default Web Site" on port 80 with C:\\inetpub\\wwwroot', () => {
    const { server } = topology();
    const fs = new WindowsFileSystem();
    const role = new WindowsIisRole(server, fs, new WindowsCertStore());
    const site = role.getWebsite('Default Web Site')!;
    expect(site.port).toBe(80);
    expect(site.physicalPath).toBe('C:\\inetpub\\wwwroot');
    expect(fs.exists('C:\\inetpub\\wwwroot\\iisstart.htm')).toBe(true);
  });

  it('New-Website creates and auto-starts an additional site on its own port', () => {
    const { server } = topology();
    const fs = new WindowsFileSystem();
    const role = new WindowsIisRole(server, fs, new WindowsCertStore());
    const res = role.newWebsite('Contoso', 'C:\\inetpub\\contoso', 8080);
    expect(res.ok).toBe(true);
    expect(role.getWebsite('Contoso')!.state).toBe('Started');
  });

  it('refuses a duplicate site name', () => {
    const { server } = topology();
    const role = new WindowsIisRole(server, new WindowsFileSystem(), new WindowsCertStore());
    const res = role.newWebsite('Default Web Site', 'C:\\x', 8081);
    expect(res.ok).toBe(false);
  });

  it('Stop-Website/Start-Website toggle a site\'s listener', () => {
    const { server } = topology();
    const role = new WindowsIisRole(server, new WindowsFileSystem(), new WindowsCertStore());
    role.start();
    expect(role.getWebsite('Default Web Site')!.state).toBe('Started');
    role.stopSite('Default Web Site');
    expect(role.getWebsite('Default Web Site')!.state).toBe('Stopped');
    role.startSite('Default Web Site');
    expect(role.getWebsite('Default Web Site')!.state).toBe('Started');
  });
});

describe('WindowsIisRole — real HTTP over TCP/80', () => {
  it('serves the default document with 200 and the IIS Server header', () => {
    const { server, client } = topology();
    const role = new WindowsIisRole(server, new WindowsFileSystem(), new WindowsCertStore());
    role.start();

    const result = dialHttp({ tcpStack: client.getTcpStack(), targetIp: '192.168.95.10', port: 80 });
    expect(result.ok).toBe(true);
    expect(result.response!.statusCode).toBe(200);
    expect(result.response!.headers.Server).toBe('Microsoft-IIS/10.0');
    expect(result.response!.body).toContain('IIS Windows Server');
  });

  it('returns 404 for a nonexistent file', () => {
    const { server, client } = topology();
    const role = new WindowsIisRole(server, new WindowsFileSystem(), new WindowsCertStore());
    role.start();

    const result = dialHttp({ tcpStack: client.getTcpStack(), targetIp: '192.168.95.10', port: 80, path: '/ghost.html' });
    expect(result.ok).toBe(true);
    expect(result.response!.statusCode).toBe(404);
  });

  it('serves a custom file with the correct Content-Type', () => {
    const { server, client } = topology();
    const fs = new WindowsFileSystem();
    fs.mkdirp('C:\\inetpub\\wwwroot');
    fs.createFile('C:\\inetpub\\wwwroot\\notes.txt', 'hello from IIS');
    const role = new WindowsIisRole(server, fs, new WindowsCertStore());
    role.start();

    const result = dialHttp({ tcpStack: client.getTcpStack(), targetIp: '192.168.95.10', port: 80, path: '/notes.txt' });
    expect(result.ok).toBe(true);
    expect(result.response!.statusCode).toBe(200);
    expect(result.response!.headers['Content-Type']).toBe('text/plain');
    expect(result.response!.body).toBe('hello from IIS');
  });

  it('a stopped site refuses the connection', () => {
    const { server, client } = topology();
    const role = new WindowsIisRole(server, new WindowsFileSystem(), new WindowsCertStore());
    role.start();
    role.stopSite('Default Web Site');

    const result = dialHttp({ tcpStack: client.getTcpStack(), targetIp: '192.168.95.10', port: 80 });
    expect(result.ok).toBe(false);
  });

  it('an additional site is reachable on its own port', () => {
    const { server, client } = topology();
    const fs = new WindowsFileSystem();
    fs.mkdirp('C:\\inetpub\\contoso');
    fs.createFile('C:\\inetpub\\contoso\\iisstart.htm', '<h1>Contoso</h1>');
    const role = new WindowsIisRole(server, fs, new WindowsCertStore());
    role.start();
    role.newWebsite('Contoso', 'C:\\inetpub\\contoso', 8080);

    const result = dialHttp({ tcpStack: client.getTcpStack(), targetIp: '192.168.95.10', port: 8080 });
    expect(result.ok).toBe(true);
    expect(result.response!.body).toContain('Contoso');
  });
});
