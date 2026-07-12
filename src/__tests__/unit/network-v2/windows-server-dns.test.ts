/**
 * PRD-Windows-Server.md §5 P7 — DNS Server role: `Install-WindowsFeature
 * DNS` hosts the real DNS engine over genuine UDP/TCP port 53. Covers the
 * `DnsServer` cmdlets, `dnscmd`, the domain zone (+ DC locator SRV
 * records) auto-provisioned at `Install-ADDSForest`, forwarders, and
 * real client resolution (`nslookup`) over the wire.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, IPAddress, SubnetMask } from '@/network/core/types';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
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
  const dns = new WindowsServer('DNS1');
  const client = new WindowsPC('windows-pc', 'CLIENT1');
  const sw = new GenericSwitch('switch-generic', 'SW1');
  new Cable('c1').connect(dns.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(client.getPorts()[0], sw.getPorts()[1]);
  const mask = new SubnetMask('255.255.255.0');
  dns.getPorts()[0].configureIP(new IPAddress('192.168.60.10'), mask);
  client.getPorts()[0].configureIP(new IPAddress('192.168.60.20'), mask);
  dns.setCurrentUser('Administrator');
  client.setCurrentUser('Administrator');
  return { dns, client };
}

describe('Install-WindowsFeature DNS', () => {
  it('DnsServer cmdlets are "not recognized" before the role is installed', async () => {
    const { dns } = await buildLan();
    const out = await run(ps(dns), 'Add-DnsServerPrimaryZone -Name lab.local');
    expect(out).toMatch(/not recognized/i);
  });

  it('dnscmd is "not recognized" before the role is installed', async () => {
    const { dns } = await buildLan();
    const out = await dns.executeCmdCommand('dnscmd /enumzones');
    expect(out).toMatch(/not recognized/i);
  });
});

describe('Add-DnsServerPrimaryZone / Get-DnsServerZone', () => {
  it('creates a zone and lists it back', async () => {
    const { dns } = await buildLan();
    await run(ps(dns), 'Install-WindowsFeature DNS');
    await run(ps(dns), 'Add-DnsServerPrimaryZone -Name lab.local');
    const out = await run(ps(dns), 'Get-DnsServerZone');
    expect(out).toContain('lab.local');
  });

  it('Get-DnsServerZone -Name filters to one zone', async () => {
    const { dns } = await buildLan();
    await run(ps(dns), 'Install-WindowsFeature DNS');
    await run(ps(dns), 'Add-DnsServerPrimaryZone -Name lab.local');
    await run(ps(dns), 'Add-DnsServerPrimaryZone -Name other.local');
    const out = await run(ps(dns), 'Get-DnsServerZone -Name lab.local');
    expect(out).toContain('lab.local');
    expect(out).not.toContain('other.local');
  });

  it('refuses a duplicate zone', async () => {
    const { dns } = await buildLan();
    await run(ps(dns), 'Install-WindowsFeature DNS');
    await run(ps(dns), 'Add-DnsServerPrimaryZone -Name lab.local');
    const out = await run(ps(dns), 'Add-DnsServerPrimaryZone -Name lab.local');
    expect(out).toMatch(/already configured/i);
  });
});

describe('Add-DnsServerResourceRecord* / Get-DnsServerResourceRecord', () => {
  async function zoned() {
    const lan = await buildLan();
    await run(ps(lan.dns), 'Install-WindowsFeature DNS');
    await run(ps(lan.dns), 'Add-DnsServerPrimaryZone -Name lab.local');
    return lan;
  }

  it('adds an A record and reads it back', async () => {
    const { dns } = await zoned();
    await run(ps(dns), 'Add-DnsServerResourceRecordA -ZoneName lab.local -Name ws01 -IPv4Address 192.168.60.30');
    const out = await run(ps(dns), 'Get-DnsServerResourceRecord -ZoneName lab.local -Name ws01');
    expect(out).toContain('ws01.lab.local');
    expect(out).toContain('192.168.60.30');
  });

  it('adds a CNAME, MX, and SRV record', async () => {
    const { dns } = await zoned();
    await run(ps(dns), 'Add-DnsServerResourceRecordA -ZoneName lab.local -Name ws01 -IPv4Address 192.168.60.30');
    await run(ps(dns), 'Add-DnsServerResourceRecordCName -ZoneName lab.local -Name www -HostNameAlias ws01.lab.local');
    await run(ps(dns), 'Add-DnsServerResourceRecordMX -ZoneName lab.local -Name lab.local -MailExchange mail.lab.local -Preference 10');
    await run(ps(dns), 'Add-DnsServerResourceRecord -ZoneName lab.local -Name _ldap._tcp.dc._msdcs -Srv -DomainNameTarget dc1.lab.local -Priority 0 -Weight 100 -Port 389');
    const out = await run(ps(dns), 'Get-DnsServerResourceRecord -ZoneName lab.local');
    expect(out).toContain('CNAME');
    expect(out).toContain('MX');
    expect(out).toContain('389');
  });

  it('Remove-DnsServerResourceRecord deletes a record', async () => {
    const { dns } = await zoned();
    await run(ps(dns), 'Add-DnsServerResourceRecordA -ZoneName lab.local -Name ws01 -IPv4Address 192.168.60.30');
    await run(ps(dns), 'Remove-DnsServerResourceRecord -ZoneName lab.local -Name ws01 -RRType A');
    const out = await run(ps(dns), 'Get-DnsServerResourceRecord -ZoneName lab.local -Name ws01');
    expect(out.trim()).toBe('');
  });

  it('errors for a nonexistent zone', async () => {
    const { dns } = await zoned();
    const out = await run(ps(dns), 'Add-DnsServerResourceRecordA -ZoneName ghost.local -Name ws01 -IPv4Address 192.168.60.30');
    expect(out).toMatch(/does not exist/i);
  });
});

describe('dnscmd — cmd-level equivalents', () => {
  it('creates a zone, adds records, and prints them', async () => {
    const { dns } = await buildLan();
    await run(ps(dns), 'Install-WindowsFeature DNS');
    await run(ps(dns), 'Add-DnsServerPrimaryZone -Name lab.local');

    const zoneAdd = await dns.executeCmdCommand('dnscmd /zoneadd lab.local /Primary');
    expect(zoneAdd).toMatch(/failed/i); // already created above via cmdlet — duplicate

    const recordAdd = await dns.executeCmdCommand('dnscmd /recordadd lab.local ws01 A 192.168.60.30');
    expect(recordAdd).toMatch(/completed successfully/i);

    const print = await dns.executeCmdCommand('dnscmd /zoneprint lab.local');
    expect(print).toContain('ws01.lab.local');
    expect(print).toContain('192.168.60.30');
  });

  it('/enumzones lists all zones', async () => {
    const { dns } = await buildLan();
    await run(ps(dns), 'Install-WindowsFeature DNS');
    await dns.executeCmdCommand('dnscmd /zoneadd lab.local /Primary');
    const out = await dns.executeCmdCommand('dnscmd /enumzones');
    expect(out).toContain('lab.local');
  });

  it('/resetforwarders configures forwarders', async () => {
    const { dns } = await buildLan();
    await run(ps(dns), 'Install-WindowsFeature DNS');
    const out = await dns.executeCmdCommand('dnscmd /resetforwarders 8.8.8.8');
    expect(out).toMatch(/completed successfully/i);
    const get = await run(ps(dns), 'Get-DnsServerForwarder');
    expect(get).toContain('8.8.8.8');
  });
});

describe('Set-DnsServerForwarder / Get-DnsServerForwarder', () => {
  it('sets and reads back forwarders', async () => {
    const { dns } = await buildLan();
    await run(ps(dns), 'Install-WindowsFeature DNS');
    await run(ps(dns), 'Set-DnsServerForwarder -IPAddress 8.8.8.8');
    const out = await run(ps(dns), 'Get-DnsServerForwarder');
    expect(out).toContain('8.8.8.8');
  });
});

describe('Real client resolution over the wire (nslookup)', () => {
  it('resolves an A record hosted by the DNS role', async () => {
    const { dns, client } = await buildLan();
    await run(ps(dns), 'Install-WindowsFeature DNS');
    await run(ps(dns), 'Add-DnsServerPrimaryZone -Name lab.local');
    await run(ps(dns), 'Add-DnsServerResourceRecordA -ZoneName lab.local -Name ws01 -IPv4Address 192.168.60.30');

    const out = await client.executeCmdCommand('nslookup ws01.lab.local 192.168.60.10');
    expect(out).toContain('192.168.60.30');
  });

  it('reports NXDOMAIN for an unknown name inside the hosted zone', async () => {
    const { dns, client } = await buildLan();
    await run(ps(dns), 'Install-WindowsFeature DNS');
    await run(ps(dns), 'Add-DnsServerPrimaryZone -Name lab.local');

    const out = await client.executeCmdCommand('nslookup ghost.lab.local 192.168.60.10');
    expect(out.toLowerCase()).toMatch(/can't find|non-existent|nxdomain/);
  });
});

describe('AD-integrated DNS zone auto-provisioned at DC promotion', () => {
  it('creates the domain zone with the DC locator SRV records and the DC A record when DNS is installed before promotion', async () => {
    const { dns: dc } = await buildLan();
    await run(ps(dc), 'Install-WindowsFeature DNS');
    await run(ps(dc), 'Install-WindowsFeature AD-Domain-Services');
    await run(ps(dc), 'Install-ADDSForest -DomainName lab.local -SafeModeAdministratorPassword (ConvertTo-SecureString "P@ssw0rd" -AsPlainText -Force)');

    const zone = await run(ps(dc), 'Get-DnsServerZone -Name lab.local');
    expect(zone).toContain('lab.local');

    const records = await run(ps(dc), 'Get-DnsServerResourceRecord -ZoneName lab.local');
    expect(records).toContain('192.168.60.10'); // DC's own A record
    expect(records).toContain('SRV');
    expect(records).toContain('389');
  });

  it('does not create a zone when the DNS role is not installed at promotion time', async () => {
    const { dns: dc } = await buildLan();
    await run(ps(dc), 'Install-WindowsFeature AD-Domain-Services');
    await run(ps(dc), 'Install-ADDSForest -DomainName lab.local -SafeModeAdministratorPassword (ConvertTo-SecureString "P@ssw0rd" -AsPlainText -Force)');
    expect(dc.getDirectoryStore()).not.toBeNull();
    expect(dc.getDnsServerRole()).toBeNull();
  });

  it('a client can resolve the DC locator SRV record after promotion', async () => {
    const { dns: dc, client } = await buildLan();
    await run(ps(dc), 'Install-WindowsFeature DNS');
    await run(ps(dc), 'Install-WindowsFeature AD-Domain-Services');
    await run(ps(dc), 'Install-ADDSForest -DomainName lab.local -SafeModeAdministratorPassword (ConvertTo-SecureString "P@ssw0rd" -AsPlainText -Force)');

    const out = await client.executeCmdCommand('nslookup -type=SRV _ldap._tcp.dc._msdcs.lab.local 192.168.60.10');
    expect(out).toContain('389');
    expect(out.toLowerCase()).toContain('dns1.lab.local');
  });

  it('registers a dynamic DNS A record for a computer that joins the domain over the real LDAP AddRequest', async () => {
    const { dns: dc, client } = await buildLan();
    await run(ps(dc), 'Install-WindowsFeature DNS');
    await run(ps(dc), 'Install-WindowsFeature AD-Domain-Services');
    await run(ps(dc), 'Install-ADDSForest -DomainName lab.local -SafeModeAdministratorPassword (ConvertTo-SecureString "P@ssw0rd" -AsPlainText -Force)');

    client.joinDomainNow('lab.local', '192.168.60.10', 'Administrator', 'P@ssw0rd');

    const records = dc.getDnsServerRole()!.getRecords('lab.local', 'CLIENT1');
    expect(records).not.toBeNull();
    expect(records!.some(r => r.type === 'A' && r.text === '192.168.60.20')).toBe(true);
  });

  it('auto-creates the reverse (in-addr.arpa) zone for the DC\'s own /24 and registers its PTR record', async () => {
    const { dns: dc } = await buildLan();
    await run(ps(dc), 'Install-WindowsFeature DNS');
    await run(ps(dc), 'Install-WindowsFeature AD-Domain-Services');
    await run(ps(dc), 'Install-ADDSForest -DomainName lab.local -SafeModeAdministratorPassword (ConvertTo-SecureString "P@ssw0rd" -AsPlainText -Force)');

    const zone = dc.getDnsServerRole()!.getZone('60.168.192.in-addr.arpa');
    expect(zone).not.toBeNull();
    const records = dc.getDnsServerRole()!.getRecords('60.168.192.in-addr.arpa', '10');
    expect(records).not.toBeNull();
    expect(records!.some(r => r.type === 'PTR' && r.text === 'DNS1.lab.local')).toBe(true);
  });
});
