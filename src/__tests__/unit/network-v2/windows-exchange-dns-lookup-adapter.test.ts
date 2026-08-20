import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, IPAddress, SubnetMask } from '@/network/core/types';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { createDnsLookupAdapter } from '@/network/devices/windows/server/exchange/DnsLookupAdapter';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

const ps = (d: WindowsServer | WindowsPC) => PowerShellSubShell.create(d).subShell;
const run = async (sh: ReturnType<typeof ps>, l: string) => (await sh.processLine(l)).output.join('\n');

async function buildDnsLab() {
  const dns = new WindowsServer('DNS1');
  const client = new WindowsPC('windows-pc', 'CLIENT1');
  const sw = new GenericSwitch('switch-generic', 'SW1');
  new Cable('c1').connect(dns.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(client.getPorts()[0], sw.getPorts()[1]);
  const mask = new SubnetMask('255.255.255.0');
  dns.getPorts()[0].configureIP(new IPAddress('192.168.70.10'), mask);
  client.getPorts()[0].configureIP(new IPAddress('192.168.70.20'), mask);
  dns.setCurrentUser('Administrator');
  client.setCurrentUser('Administrator');
  await run(ps(dns), 'Install-WindowsFeature DNS');
  await run(ps(dns), 'Add-DnsServerPrimaryZone -Name partner.example');
  await run(ps(dns), 'Add-DnsServerResourceRecordA -ZoneName partner.example -Name mail -IPv4Address 192.168.70.30');
  await run(ps(dns), 'Add-DnsServerResourceRecordMX -ZoneName partner.example -Name "@" -MailExchange mail.partner.example -Preference 10');
  return { dns, client };
}

describe('createDnsLookupAdapter (docs/PRD-Exchange.md §2.1 P7) — wraps queryDnsServer for real MX/A lookups', () => {
  it('resolveMx() returns the real MX record from a live DNS server', async () => {
    const { client } = await buildDnsLab();
    const lookup = createDnsLookupAdapter(client, new IPAddress('192.168.70.10'));
    const targets = await lookup.resolveMx('partner.example');
    expect(targets).toEqual([{ preference: 10, exchange: 'mail.partner.example' }]);
  });

  it('resolveAddress() returns the real A record from a live DNS server', async () => {
    const { client } = await buildDnsLab();
    const lookup = createDnsLookupAdapter(client, new IPAddress('192.168.70.10'));
    const address = await lookup.resolveAddress('mail.partner.example');
    expect(address).toBe('192.168.70.30');
  });

  it('resolveMx() returns an empty list for a domain with no MX record', async () => {
    const { client } = await buildDnsLab();
    const lookup = createDnsLookupAdapter(client, new IPAddress('192.168.70.10'));
    const targets = await lookup.resolveMx('nowhere.example');
    expect(targets).toEqual([]);
  });

  it('resolveAddress() returns null for a hostname with no A record', async () => {
    const { client } = await buildDnsLab();
    const lookup = createDnsLookupAdapter(client, new IPAddress('192.168.70.10'));
    const address = await lookup.resolveAddress('nowhere.example');
    expect(address).toBeNull();
  });
});
