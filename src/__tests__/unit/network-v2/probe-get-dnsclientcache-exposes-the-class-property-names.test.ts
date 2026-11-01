/*
 * Probe — Get-DnsClientCache returns the MSFT_DNSClientCache properties its own parameters filter on:
 * Entry, Name, Type, Status, Section, TimeToLive, DataLength, Data.
 *
 * Measured first (a Windows client that resolved example.com): `Get-DnsClientCache | Where-Object Name -like
 * 'example*'` returned nothing although `Get-DnsClientCache -Name example.com` found the entry, because the
 * objects carried RecordName and RecordType where the cmdlet's own filters are called Name and Type. The two
 * views of one cache contradicted each other, and the lab's cache exercise had to avoid the idiom everybody types.
 *
 * Authority: Microsoft Learn, DnsClient module, Get-DnsClientCache — parameters -Entry (position 0), -Name
 * ("Specifies the record name"), -Type (A, NS, CNAME, SOA, PTR, MX, AAAA, SRV), -Status, -Section, -TimeToLive,
 * -DataLength, -Data; the output is the MSFT_DNSClientCache CIM instance.
 *
 * Discrimination (the probe run on the tree before the change): 4 of the 7 cases fall. The three that pass either
 * way are the WITNESS (the entry is cached and found by -Entry), the NON-REGRESSION (-Name already filtered) and
 * the NEGATIVE CONTROL (a pattern that matches nothing selects nothing — it proves the Where-Object case is not
 * passing because the pipeline returns everything).
 */
import { describe, it, expect } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';

async function dnsLab() {
  const pc = new WindowsPC('windows-pc', 'WIN', 0, 0);
  const srv = new LinuxServer('linux-server', 'SRV', 0, 0);
  pc.powerOn(); srv.powerOn();
  new Cable('c1').connect(pc.getPort('eth0')!, srv.getPort('eth0')!);
  pc.getPort('eth0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  srv.getPort('eth0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  srv.dnsService.start();
  srv.dnsService.addRecord({ name: 'example.com', type: 'A', value: '93.184.216.34', ttl: 3600 });
  srv.dnsService.addRecord({ name: 'srv.lab', type: 'A', value: '10.0.0.2', ttl: 3600 });
  (pc as unknown as { dnsConfig: Map<string, { servers: string[]; mode: string }> })
    .dnsConfig = new Map([['eth0', { servers: ['10.0.0.2'], mode: 'static' }]]);
  const interp = pc.getPowerShellInterpreter();
  const ps = (line: string): Promise<string> => Promise.resolve(interp.execute(line)) as Promise<string>;
  await ps('Resolve-DnsName example.com');
  await ps('Resolve-DnsName srv.lab');
  return { ps };
}

describe('Get-DnsClientCache objects carry the documented property names', () => {
  it('WITNESS: the resolved entry is cached and found by -Entry', async () => {
    const { ps } = await dnsLab();
    expect((await ps('(Get-DnsClientCache -Entry example.com).Entry')).trim()).toBe('example.com');
  });

  it('exposes Entry, Name, Type, Status, Section, TimeToLive, DataLength, Data, in that order', async () => {
    const { ps } = await dnsLab();
    const listing = await ps('Get-DnsClientCache -Entry example.com | Format-List');
    const names = [...listing.matchAll(/^(\w+)\s*:/gm)].map((match) => match[1]);
    expect(names).toEqual(['Entry', 'Name', 'Type', 'Status', 'Section', 'TimeToLive', 'DataLength', 'Data']);
  });

  it('Where-Object Name -like selects the entry', async () => {
    const { ps } = await dnsLab();
    const out = await ps("(Get-DnsClientCache | Where-Object Name -like 'example*').Entry");
    expect(out.trim()).toBe('example.com');
  });

  it('NEGATIVE CONTROL: Where-Object Name -like on a pattern nothing matches selects nothing', async () => {
    const { ps } = await dnsLab();
    const out = await ps("(Get-DnsClientCache | Where-Object Name -like 'zzz*').Entry");
    expect(out.trim()).toBe('');
  });

  it('.Name and .Type of a record read what the entry holds', async () => {
    const { ps } = await dnsLab();
    expect((await ps('(Get-DnsClientCache -Entry example.com).Name')).trim()).toBe('example.com');
    expect((await ps('(Get-DnsClientCache -Entry example.com).Type')).trim()).toBe('A');
  });

  it('NON-REGRESSION: -Name already filtered on the record name', async () => {
    const { ps } = await dnsLab();
    const out = await ps('(Get-DnsClientCache -Name srv.lab).Entry');
    expect(out.trim()).toBe('srv.lab');
  });

  it('-Type A returns objects whose Type is A', async () => {
    const { ps } = await dnsLab();
    const out = await ps('(Get-DnsClientCache -Type A | ForEach-Object { $_.Type } | Sort-Object -Unique) -join ","');
    expect(out.trim()).toBe('A');
  });
});
