/*
 * Probe — Get-/Set-DnsServerSetting exist, show the settings of the Windows DNS server under the names and in the order
 * of the Microsoft page, keep them in the DNS Parameters registry key, and the server obeys the ones whose effect the
 * simulation can show: RoundRobin, AddressAnswerLimit, AllowUpdate, WriteAuthorityNS and
 * MaxResourceRecordsInNonSecureUpdate.
 *
 * Measured first (a Windows DNS server holding corp.test with three records for web, eight for many, an NS record and a
 * dynamic update zone, a UDP client): neither cmdlet existed; the server rotated the records of a name on every query
 * whatever was configured, answered all eight addresses, accepted any dynamic update the zone allowed, left the NS
 * records out of positive answers, and took an update of any size.
 *
 * Authority: Microsoft Learn, Get-DnsServerSetting (the -All sample: property names, order and the values of a real
 * server, the brief set is the default) and Set-DnsServerSetting (-InputObject takes the object Get-DnsServerSetting
 * returned, so a setting is changed by editing the object; Example 1 copies the settings of one server to another);
 * [MS-DNSP] 3.1.1.1.1 for the registry names and defaults: RoundRobin (default 1), AddressAnswerLimit (0, or 5 to 28),
 * AllowUpdate (default 1: any update at all), WriteAuthorityNs (default 0), MaxResourceRecordsInNonSecureUpdate (default
 * 30, zero stands for the default), MaximumUdpPacketSize and TcpReceivePacketSize (a value outside the range MUST
 * be an error); dnscmd /config /roundrobin (0: the first record to every query), /addressanswerlimit and /writeauthorityns.
 * Not sourced: which of the properties make up the brief set (the pages give the -All set only), the text of the
 * refusal of an out-of-range value ("The parameter is incorrect.", the Win32 text for ERROR_INVALID_PARAMETER), BootMethod
 * of a standalone server (2: registry boot) and the build numbers of this simulator's Windows Server (10.0.20348). The
 * properties nothing in the simulation reads (LocalNetPriority and its mask, NameCheckFlag, UpdateOptions, the RODC and
 * socket pool settings, ...) are accepted, stored in the registry and shown, not evaluated.
 *
 * Discrimination (the probe run on the tree before the change): 13 of the 19 cases fall. The six that pass either way are
 * the WITNESS (the records of a name rotate by default) and five CONTROLS (by default every address record is answered,
 * the records of other types are never cut, an update the zone allows is accepted, a signed update is not subject to the
 * limit, a positive answer carries no NS record).
  */
import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { RRType, DnsClass } from '@/network/dns/wire/RRType';
import { DnsOpcode, DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import { makeARecord } from '@/network/dns/wire/ResourceRecord';
import { buildUpdateMessage } from '@/network/dns/update/DnsUpdate';
import { queryDnsOverUdp } from '@/network/dns/transport/DnsUdpTransport';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import type { ARecordData } from '@/network/dns/wire/ResourceRecord';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

const PARAMETERS = 'HKLM\\SYSTEM\\CurrentControlSet\\Services\\DNS\\Parameters';

beforeEach(() => { resetCounters(); resetDeviceCounters(); Logger.clear(); });

const run = async (server: WindowsServer, line: string): Promise<string> =>
  (await PowerShellSubShell.create(server).subShell.processLine(line)).output.join('\n');

function question(qname: string, qtype: number): DnsMessage {
  return {
    id: Math.floor(Math.random() * 60000),
    flags: { qr: false, opcode: DnsOpcode.QUERY, aa: false, tc: false, rd: false, ra: false, ad: false, cd: false, rcode: DnsRcode.NOERROR },
    questions: [{ qname, qtype, qclass: DnsClass.IN }],
    answers: [], authorities: [], additionals: [],
  };
}

const addressesOf = (reply: DnsMessage | null): string[] =>
  (reply?.answers ?? []).filter((rr) => rr.data.type === RRType.A).map((rr) => String((rr.data as ARecordData).address));

async function lab() {
  const server = new WindowsServer('WNS1');
  const client = new LinuxPC('linux-pc', 'PC1');
  new Cable('c0').connect(server.getPorts()[0], client.getPorts()[0]);
  server.getPorts()[0].configureIP(new IPAddress('10.0.1.10'), new SubnetMask('255.255.255.0'));
  client.getPorts()[0].configureIP(new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
  server.setCurrentUser('Administrator');
  await run(server, 'Install-WindowsFeature DNS');
  await run(server, 'Add-DnsServerPrimaryZone -Name corp.test -DynamicUpdate NonsecureAndSecure');
  for (const address of ['10.0.9.1', '10.0.9.2', '10.0.9.3']) {
    await run(server, `Add-DnsServerResourceRecordA -ZoneName corp.test -Name web -IPv4Address ${address}`);
  }
  for (let n = 1; n <= 8; n++) await run(server, `Add-DnsServerResourceRecordA -ZoneName corp.test -Name many -IPv4Address 10.0.8.${n}`);
  for (let n = 1; n <= 8; n++) await run(server, `Add-DnsServerResourceRecordMX -ZoneName corp.test -Name mx -MailExchange relay${n}.corp.test -Preference ${n * 10}`);
  await run(server, 'Add-DnsServerTsigKey -Name alice -Secret YWxpY2Utc2VjcmV0');
  await run(server, 'Add-DnsServerResourceRecord -NS -ZoneName corp.test -Name "@" -NameServer ns1.corp.test');
  await run(server, 'Add-DnsServerResourceRecordA -ZoneName corp.test -Name ns1 -IPv4Address 10.0.1.10');
  const ask = (qname: string, qtype: number = RRType.A) => queryDnsOverUdp(client, new IPAddress('10.0.1.10'), question(qname, qtype), 53, 9000);
  const update = (names: readonly string[]) => queryDnsOverUdp(
    client, new IPAddress('10.0.1.10'),
    buildUpdateMessage({
      zone: 'corp.test', zoneClass: DnsClass.IN, prerequisites: [],
      updates: names.map((name, index) => ({ kind: 'add' as const, record: makeARecord(name, 300, `10.0.7.${index + 1}`) })),
    }, 4242),
    53, 9000,
  );
  const signedUpdate = (names: readonly string[]) => client.executeCommand(
    `printf 'server 10.0.1.10\\nzone corp.test\\n${names.map((name, index) => `update add ${name} 300 A 10.0.6.${index + 1}\\n`).join('')}send\\n' | nsupdate -y hmac-sha256:alice:YWxpY2Utc2VjcmV0`,
  );
  const change = (assignments: string) => run(server, `$s = Get-DnsServerSetting -All; ${assignments}; Set-DnsServerSetting $s`);
  return { server, ask, update, signedUpdate, change };
}

describe('the settings surface', () => {
  it('the default view is the brief set, with the machine behind it', async () => {
    const { server } = await lab();
    const out = await run(server, 'Get-DnsServerSetting');
    expect(out).toMatch(/ComputerName\s+:\s+WNS1/);
    expect(out).toMatch(/MajorVersion\s+:\s+10/);
    expect(out).toMatch(/BuildNumber\s+:\s+20348/);
    expect(out).toMatch(/AllIPAddress\s+:\s+\{10\.0\.1\.10\}/);
    expect(out).toMatch(/XfrConnectTimeout\(s\)\s+:\s+30/);
    expect(out).not.toContain('RoundRobin');
  });

  it('-All shows the full set in the order of the Microsoft sample, with its defaults', async () => {
    const { server } = await lab();
    const out = await run(server, 'Get-DnsServerSetting -All');
    const names = out.split(/\r?\n/).map((line) => line.split(':')[0].trim()).filter((name) => name !== '');
    expect(names.slice(0, 8)).toEqual(['ComputerName', 'MajorVersion', 'MinorVersion', 'BuildNumber', 'IsReadOnlyDC', 'EnableDnsSec', 'EnableIPv6', 'EnableOnlineSigning']);
    expect(names.slice(-4)).toEqual(['MaximumSignatureScanPeriod', 'MaximumTrustAnchorActiveRefreshInterval', 'ListeningIPAddress', 'AllIPAddress']);
    expect(names.length).toBe(70);
    expect(out).toMatch(/RoundRobin\s+:\s+True/);
    expect(out).toMatch(/UpdateOptions\s+:\s+783/);
    expect(out).toMatch(/SendPort\s+:\s+Random/);
    expect(out).toMatch(/LameDelegationTTL\s+:\s+00:00:00/);
    expect(out).toMatch(/MaximumTrustAnchorActiveRefreshInterval\s+:\s+15\.00:00:00/);
  });

  it('a standalone server boots from the registry, a domain controller from the directory', async () => {
    const { server } = await lab();
    expect(await run(server, '(Get-DnsServerSetting -All).BootMethod')).toBe('2');
    expect(await run(server, '(Get-DnsServerSetting -All).DsAvailable')).toBe('False');
  });

  it('a setting is changed by editing the object and handing it back, and only what changed reaches the registry', async () => {
    const { server, change } = await lab();
    const before = await server.executeCommand(`reg query ${PARAMETERS}`);
    await run(server, '$s = Get-DnsServerSetting -All; Set-DnsServerSetting $s');
    expect(await server.executeCommand(`reg query ${PARAMETERS}`)).toBe(before);
    await change('$s.RoundRobin = $false; $s."XfrConnectTimeout(s)" = 45; $s.SendPort = 5353; $s.LameDelegationTTL = [TimeSpan]::FromMinutes(5)');
    const registry = await server.executeCommand(`reg query ${PARAMETERS}`);
    expect(registry).toMatch(/RoundRobin\s+REG_DWORD\s+0x0/);
    expect(registry).toMatch(/XfrConnectTimeout\s+REG_DWORD\s+0x2d/);
    expect(registry).toMatch(/SendPort\s+REG_DWORD\s+0x14e9/);
    expect(registry).toMatch(/LameDelegationTtl\s+REG_DWORD\s+0x12c/);
    const out = await run(server, 'Get-DnsServerSetting -All');
    expect(out).toMatch(/RoundRobin\s+:\s+False/);
    expect(out).toMatch(/SendPort\s+:\s+5353/);
    expect(out).toMatch(/LameDelegationTTL\s+:\s+00:05:00/);
  });

  it('the object can come through the pipeline, and the computed properties of another server are ignored', async () => {
    const { server } = await lab();
    await run(server, '$s = Get-DnsServerSetting -All; $s.ComputerName = "OTHER"; $s.BuildNumber = 1; $s.RoundRobin = $false; $s | Set-DnsServerSetting');
    const out = await run(server, 'Get-DnsServerSetting -All');
    expect(out).toMatch(/ComputerName\s+:\s+WNS1/);
    expect(out).toMatch(/BuildNumber\s+:\s+20348/);
    expect(out).toMatch(/RoundRobin\s+:\s+False/);
  });

  it('a value written with reg.exe is the setting Get-DnsServerSetting reports, and deleting it restores the default', async () => {
    const { server } = await lab();
    await server.executeCommand(`reg add ${PARAMETERS} /v RoundRobin /t REG_DWORD /d 0 /f`);
    expect(await run(server, '(Get-DnsServerSetting -All).RoundRobin')).toBe('False');
    await server.executeCommand(`reg delete ${PARAMETERS} /v RoundRobin /f`);
    expect(await run(server, '(Get-DnsServerSetting -All).RoundRobin')).toBe('True');
  });

  it('a value the protocol document bounds is refused as a whole, nothing is written', async () => {
    const { server, change } = await lab();
    const out = await change('$s.RoundRobin = $false; $s.TcpReceivePacketSize = 100');
    expect(out).toContain('Set-DnsServerSetting : The parameter is incorrect.');
    expect(await run(server, '(Get-DnsServerSetting -All).RoundRobin')).toBe('True');
  });
});

describe('RoundRobin', () => {
  it('WITNESS: the records of a name rotate from query to query by default', async () => {
    const { ask } = await lab();
    const firsts = [(await ask('web.corp.test')), (await ask('web.corp.test')), (await ask('web.corp.test'))].map((reply) => addressesOf(reply)[0]);
    expect(new Set(firsts).size).toBe(3);
  });

  it('returns the records in the same order to every query once it is off', async () => {
    const { change, ask } = await lab();
    await change('$s.RoundRobin = $false');
    const orders = [(await ask('web.corp.test')), (await ask('web.corp.test')), (await ask('web.corp.test'))].map((reply) => addressesOf(reply).join(','));
    expect(new Set(orders).size).toBe(1);
  });
});

describe('AddressAnswerLimit', () => {
  it('CONTROL: by default every address record is answered', async () => {
    const { ask } = await lab();
    expect(addressesOf(await ask('many.corp.test'))).toHaveLength(8);
  });

  it('keeps no more address records than the limit in a response', async () => {
    const { change, ask } = await lab();
    await change('$s.AddressAnswerLimit = 5');
    expect(addressesOf(await ask('many.corp.test'))).toHaveLength(5);
    expect(addressesOf(await ask('web.corp.test'))).toHaveLength(3);
  });

  it('counts address records only: the records of any other type are all answered', async () => {
    const { change, ask } = await lab();
    await change('$s.AddressAnswerLimit = 5');
    expect((await ask('mx.corp.test', RRType.MX))?.answers).toHaveLength(8);
  });
});

describe('dynamic updates', () => {
  it('CONTROL: an update the zone allows is accepted', async () => {
    const { update } = await lab();
    expect((await update(['host1.corp.test']))?.flags.rcode).toBe(DnsRcode.NOERROR);
  });

  it('AllowUpdate off refuses every update, whatever the zone says', async () => {
    const { change, update } = await lab();
    await change('$s.AllowUpdate = $false');
    expect((await update(['host1.corp.test']))?.flags.rcode).toBe(DnsRcode.REFUSED);
    await change('$s.AllowUpdate = $true');
    expect((await update(['host1.corp.test']))?.flags.rcode).toBe(DnsRcode.NOERROR);
  });

  it('an unsigned update with more records than MaxResourceRecordsInNonSecureUpdate is refused', async () => {
    const { change, update } = await lab();
    await change('$s.MaxResourceRecordsInNonSecureUpdate = 2');
    expect((await update(['a.corp.test', 'b.corp.test', 'c.corp.test']))?.flags.rcode).toBe(DnsRcode.REFUSED);
    expect((await update(['a.corp.test', 'b.corp.test']))?.flags.rcode).toBe(DnsRcode.NOERROR);
  });

  it('CONTROL: a signed update is not subject to that limit', async () => {
    const { change, ask, signedUpdate } = await lab();
    await change('$s.MaxResourceRecordsInNonSecureUpdate = 2');
    await signedUpdate(['s1.corp.test', 's2.corp.test', 's3.corp.test']);
    expect(addressesOf(await ask('s3.corp.test'))).toEqual(['10.0.6.3']);
  });

  it('a limit of zero stands for the default of 30', async () => {
    const { change, update } = await lab();
    await change('$s.MaxResourceRecordsInNonSecureUpdate = 0');
    const names = Array.from({ length: 31 }, (_, index) => `h${index}.corp.test`);
    expect((await update(names.slice(0, 30)))?.flags.rcode).toBe(DnsRcode.NOERROR);
    expect((await update(names))?.flags.rcode).toBe(DnsRcode.REFUSED);
  });
});

describe('WriteAuthorityNS', () => {
  it('CONTROL: a positive answer carries no NS record by default', async () => {
    const { ask } = await lab();
    expect((await ask('web.corp.test'))?.authorities).toHaveLength(0);
  });

  it('writes the NS records of the zone in the authority section of a positive answer', async () => {
    const { change, ask } = await lab();
    await change('$s.WriteAuthorityNS = $true');
    const reply = await ask('web.corp.test');
    expect(reply?.authorities.map((rr) => rr.data.type)).toEqual([RRType.NS]);
    expect(reply?.answers).toHaveLength(3);
  });
});
