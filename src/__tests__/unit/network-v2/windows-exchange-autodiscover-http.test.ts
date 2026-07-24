import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, IPAddress, SubnetMask } from '@/network/core/types';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { resetExchangeOrganizations } from '@/network/devices/windows/server/exchange/ExchangeOrganization';
import { Http1ClientSession } from '@/network/http/http1/Http1ClientSession';
import { createRequest } from '@/network/http/semantics/types';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
  resetExchangeOrganizations();
});

const ps = (d: WindowsServer) => PowerShellSubShell.create(d).subShell;
const run = async (sh: ReturnType<typeof ps>, l: string) => (await sh.processLine(l)).output.join('\n');

function autodiscoverRequestXml(email: string): string {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/outlook/requestschema/2006">',
    '  <Request>',
    `    <EMailAddress>${email}</EMailAddress>`,
    '    <AcceptableResponseSchema>http://schemas.microsoft.com/exchange/autodiscover/outlook/responseschema/2006a</AcceptableResponseSchema>',
    '  </Request>',
    '</Autodiscover>',
  ].join('\n');
}

async function buildLab() {
  const dc = new WindowsServer('DC01');
  const client = new LinuxPC('linux-pc', 'CLIENT1');
  const sw = new GenericSwitch('switch-generic', 'SW1');
  const mask = new SubnetMask('255.255.255.0');
  new Cable('c1').connect(dc.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(client.getPorts()[0], sw.getPorts()[1]);
  dc.getPorts()[0].configureIP(new IPAddress('192.168.90.10'), mask);
  client.getPorts()[0].configureIP(new IPAddress('192.168.90.2'), mask);
  dc.setCurrentUser('Administrator');

  await run(ps(dc), 'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools');
  await run(ps(dc), 'Install-ADDSForest -DomainName "mandeng.lan" -DomainNetBiosName "MANDENG" -SafeModeAdministratorPassword (ConvertTo-SecureString "DSRM@Mandeng2025!" -AsPlainText -Force) -Force:$true');
  await run(ps(dc), 'Install-ExchangeServer -Roles Mailbox -OrganizationName "Mandeng"');
  await run(ps(dc), 'New-Mailbox -Name bob -Password (ConvertTo-SecureString "P@ssw0rd1!" -AsPlainText -Force)');

  return { dc, client };
}

describe('Autodiscover HTTP/XML endpoint (docs/PRD-Exchange.md §2.1 P8, MS-OXDSCLI)', () => {
  it('a real POST to /autodiscover/autodiscover.xml resolves a known mailbox to this Exchange server', async () => {
    const { client } = await buildLab();
    const http = new Http1ClientSession(client.getTcpStack(), '192.168.90.10', 80);
    const req = createRequest('POST', '/autodiscover/autodiscover.xml');
    req.body = new TextEncoder().encode(autodiscoverRequestXml('bob@mandeng.lan'));

    const result = http.send(req);

    expect(result.ok).toBe(true);
    expect(result.response?.statusCode).toBe(200);
    const xml = new TextDecoder().decode(result.response!.body!);
    expect(xml).toContain('<Server>DC01</Server>');
    expect(xml).toContain('<LoginName>bob@mandeng.lan</LoginName>');
    expect(xml).toContain('http://schemas.microsoft.com/exchange/autodiscover/outlook/responseschema/2006a');
  });

  it('an unknown mailbox gets a real MS-OXDSCLI <Error> response, not a silent 404', async () => {
    const { client } = await buildLab();
    const http = new Http1ClientSession(client.getTcpStack(), '192.168.90.10', 80);
    const req = createRequest('POST', '/autodiscover/autodiscover.xml');
    req.body = new TextEncoder().encode(autodiscoverRequestXml('nobody@mandeng.lan'));

    const result = http.send(req);

    expect(result.ok).toBe(true);
    expect(result.response?.statusCode).toBe(200);
    const xml = new TextDecoder().decode(result.response!.body!);
    expect(xml).toContain('<Error');
    expect(xml).not.toContain('<Server>');
  });

  it('getAutodiscoverResponse() is null and no HTTP listener answers before Install-ExchangeServer', async () => {
    const dc = new WindowsServer('DC01');
    const client = new LinuxPC('linux-pc', 'CLIENT1');
    const sw = new GenericSwitch('switch-generic', 'SW1');
    const mask = new SubnetMask('255.255.255.0');
    new Cable('c1').connect(dc.getPorts()[0], sw.getPorts()[0]);
    new Cable('c2').connect(client.getPorts()[0], sw.getPorts()[1]);
    dc.getPorts()[0].configureIP(new IPAddress('192.168.91.10'), mask);
    client.getPorts()[0].configureIP(new IPAddress('192.168.91.2'), mask);
    dc.setCurrentUser('Administrator');

    expect(dc.getAutodiscoverResponse('bob@mandeng.lan')).toBeNull();

    const http = new Http1ClientSession(client.getTcpStack(), '192.168.91.10', 80);
    const result = http.send(createRequest('POST', '/autodiscover/autodiscover.xml'));
    expect(result.ok).toBe(false);
  });
});
