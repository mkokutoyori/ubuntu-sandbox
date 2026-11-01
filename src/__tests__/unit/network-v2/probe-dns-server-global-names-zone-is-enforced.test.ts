/*
 * Probe — Get-/Set-DnsServerGlobalNameZone exist, keep their settings in the DNS Parameters registry key, and a Windows
 * DNS server that hosts a GlobalNames zone answers single-label names from it, in the order GlobalOverLocal says, and
 * blocks dynamic updates that would collide with one of its labels.
 *
 * Measured first (a Windows DNS server holding corp.test, a GlobalNames zone with CNAME records, a single-label zone
 * called intranet, a second server holding other.test, a UDP client): the cmdlets did not exist; a query for the
 * single label sarah was REFUSED whatever the server held; a dynamic update creating sarah.corp.test was accepted.
 *
 * Authority: Microsoft Learn, Set-DnsServerGlobalNameZone and Get-DnsServerGlobalNameZone (Enable, GlobalOverLocal,
 * PreferAAAA, AlwaysQueryServer, EnableEDnsProbes, BlockUpdates, SendTimeout(s) 1 to 15 with 0 standing for the default 3,
 * ServerQueryInterval 60 seconds to 30 days with 0 standing for six hours); [MS-DNSP] 3.1.1.1.1 EnableGlobalNamesSupport
 * (default 0; the server uses GNZ data while answering queries and updates), GlobalNamesQueryOrder (TRUE: authoritative zone
 * data is preferred, FALSE, the default: GNZ data), GlobalNamesBlockUpdates (default 1: an update in an authoritative zone is
 * blocked when the relative portion of the name matches a name of the locally hosted GNZ, tested case-insensitively),
 * GlobalNamesPreferAAAA, GlobalNamesAlwaysQuerySrv, GlobalNamesEnableEDnsProbes, GlobalNamesSendTimeout and
 * GlobalNamesServerQueryInterval; the PS_DnsServerGlobalNameZone WMI pages. Not sourced: the rcode of a blocked update
 * (REFUSED), that a single-label query is looked up in the zone named GlobalNames as label.GlobalNames, and the chase of a
 * CNAME target through the server's own zones and recursion. The five settings about REMOTE GlobalNames zones
 * (PreferAAAA, AlwaysQueryServer, EnableEDnsProbes, SendTimeout, ServerQueryInterval) are stored, shown and written to the
 * registry only: finding the remote servers takes the SRV records _globalnames._msdcs.<forest root> and the text of the
 * query the server then sends is not in a page this probe can cite.
 *
 * Discrimination (the probe run on the tree before the change): 11 of the 18 cases fall. The seven that pass either way
 * are CONTROLS: support off answers nothing from the zone; a name of two labels is not looked up in it; support on
 * without the zone answers nothing; a label the zone does not hold falls through to the local zone; an update is
 * accepted with support off, for another name, and inside the GlobalNames zone itself.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { RRType, DnsClass } from '@/network/dns/wire/RRType';
import { DnsOpcode, DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import { makeARecord } from '@/network/dns/wire/ResourceRecord';
import { buildUpdateMessage } from '@/network/dns/update/DnsUpdate';
import { queryDnsOverUdp } from '@/network/dns/transport/DnsUdpTransport';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import type { ARecordData, CnameRecordData } from '@/network/dns/wire/ResourceRecord';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

const PARAMETERS = 'HKLM\\SYSTEM\\CurrentControlSet\\Services\\DNS\\Parameters';

beforeEach(() => { resetCounters(); resetDeviceCounters(); Logger.clear(); });

const run = async (server: WindowsServer, line: string): Promise<string> =>
  (await PowerShellSubShell.create(server).subShell.processLine(line)).output.join('\n');

function question(qname: string, qtype: number, recursionDesired: boolean): DnsMessage {
  return {
    id: Math.floor(Math.random() * 60000),
    flags: { qr: false, opcode: DnsOpcode.QUERY, aa: false, tc: false, rd: recursionDesired, ra: false, ad: false, cd: false, rcode: DnsRcode.NOERROR },
    questions: [{ qname, qtype, qclass: DnsClass.IN }],
    answers: [], authorities: [], additionals: [],
  };
}

const addressesOf = (reply: DnsMessage | null): string[] =>
  (reply?.answers ?? []).filter((rr) => rr.data.type === RRType.A).map((rr) => String((rr.data as ARecordData).address));
const targetsOf = (reply: DnsMessage | null): string[] =>
  (reply?.answers ?? []).filter((rr) => rr.data.type === RRType.CNAME).map((rr) => (rr.data as CnameRecordData).cname);

async function lab(options: { globalNames?: boolean } = {}) {
  const sw = new GenericSwitch('switch-generic', 'sw1', 8, 0, 0);
  const server = new WindowsServer('WNS1');
  const other = new WindowsServer('WNS2');
  const client = new LinuxPC('linux-pc', 'PC1');
  const mask = new SubnetMask('255.255.255.0');
  [server, other, client].forEach((device, index) => {
    new Cable(`c${index}`).connect(device.getPorts()[0], sw.getPorts()[index]);
    device.getPorts()[0].configureIP(new IPAddress(['10.0.1.10', '10.0.1.30', '10.0.1.2'][index]), mask);
  });
  for (const machine of [server, other]) {
    machine.setCurrentUser('Administrator');
    await run(machine, 'Install-WindowsFeature DNS');
  }
  await run(other, 'Add-DnsServerPrimaryZone -Name other.test');
  await run(other, 'Add-DnsServerResourceRecordA -ZoneName other.test -Name external -IPv4Address 10.0.9.77');
  await run(server, 'foreach ($h in Get-DnsServerRootHint) { Remove-DnsServerRootHint -NameServer $h.NameServer -Force }');
  await run(server, 'Add-DnsServerRootHint -NameServer a.root.test -IPAddress 10.0.1.30');
  await run(server, 'Add-DnsServerPrimaryZone -Name corp.test -DynamicUpdate NonsecureAndSecure');
  await run(server, 'Add-DnsServerResourceRecordA -ZoneName corp.test -Name desktop01 -IPv4Address 10.0.9.5');
  await run(server, 'Add-DnsServerResourceRecordCName -ZoneName corp.test -Name alias -HostNameAlias desktop01.corp.test');
  await run(server, 'Add-DnsServerPrimaryZone -Name intranet');
  await run(server, 'Add-DnsServerResourceRecordA -ZoneName intranet -Name @ -IPv4Address 10.0.9.50');
  if (options.globalNames !== false) {
    await run(server, 'Add-DnsServerPrimaryZone -Name GlobalNames -DynamicUpdate NonsecureAndSecure');
    await run(server, 'Add-DnsServerResourceRecordCName -ZoneName GlobalNames -Name sarah -HostNameAlias desktop01.corp.test');
    await run(server, 'Add-DnsServerResourceRecordCName -ZoneName GlobalNames -Name portal -HostNameAlias external.other.test');
    await run(server, 'Add-DnsServerResourceRecordCName -ZoneName GlobalNames -Name intranet -HostNameAlias desktop01.corp.test');
    await run(server, 'Add-DnsServerResourceRecordCName -ZoneName GlobalNames -Name chained -HostNameAlias alias.corp.test');
    await run(server, 'Add-DnsServerResourceRecordCName -ZoneName GlobalNames -Name deep.sarah -HostNameAlias desktop01.corp.test');
  }
  const ask = (qname: string, qtype: number = RRType.A, recursionDesired = false) =>
    queryDnsOverUdp(client, new IPAddress('10.0.1.10'), question(qname, qtype, recursionDesired), 53, 9000);
  const update = (name: string, address: string, zone = 'corp.test') => queryDnsOverUdp(
    client, new IPAddress('10.0.1.10'),
    buildUpdateMessage({ zone, zoneClass: DnsClass.IN, prerequisites: [], updates: [{ kind: 'add', record: makeARecord(name, 300, address) }] }, 4242),
    53, 9000,
  );
  return { server, ask, update };
}

describe('the settings surface', () => {
  it('Get-DnsServerGlobalNameZone reports the documented defaults as a list', async () => {
    const { server } = await lab();
    const out = await run(server, 'Get-DnsServerGlobalNameZone');
    expect(out).toMatch(/Enable\s+:\s+False/);
    expect(out).toMatch(/GlobalOverLocal\s+:\s+False/);
    expect(out).toMatch(/PreferAAAA\s+:\s+False/);
    expect(out).toMatch(/AlwaysQueryServer\s+:\s+False/);
    expect(out).toMatch(/EnableEDnsProbes\s+:\s+True/);
    expect(out).toMatch(/BlockUpdates\s+:\s+True/);
    expect(out).toMatch(/SendTimeout\(s\)\s+:\s+3/);
    expect(out).toMatch(/ServerQueryInterval\s+:\s+06:00:00/);
  });

  it('Set-DnsServerGlobalNameZone writes the DNS Parameters registry values, -PassThru shows them', async () => {
    const { server } = await lab();
    const out = await run(server, 'Set-DnsServerGlobalNameZone -Enable $true -GlobalOverLocal $true -PreferAaaa $true -AlwaysQueryServer $true -EnableEDnsProbes $false -BlockUpdates $false -SendTimeout 5 -ServerQueryInterval 01:00:00 -PassThru');
    expect(out).toMatch(/Enable\s+:\s+True/);
    expect(out).toMatch(/SendTimeout\(s\)\s+:\s+5/);
    expect(out).toMatch(/ServerQueryInterval\s+:\s+01:00:00/);
    const registry = await server.executeCommand(`reg query ${PARAMETERS}`);
    expect(registry).toMatch(/EnableGlobalNamesSupport\s+REG_DWORD\s+0x1/);
    expect(registry).toMatch(/GlobalNamesQueryOrder\s+REG_DWORD\s+0x1/);
    expect(registry).toMatch(/GlobalNamesPreferAAAA\s+REG_DWORD\s+0x1/);
    expect(registry).toMatch(/GlobalNamesAlwaysQuerySrv\s+REG_DWORD\s+0x1/);
    expect(registry).toMatch(/GlobalNamesEnableEDnsProbes\s+REG_DWORD\s+0x0/);
    expect(registry).toMatch(/GlobalNamesBlockUpdates\s+REG_DWORD\s+0x0/);
    expect(registry).toMatch(/GlobalNamesSendTimeout\s+REG_DWORD\s+0x5/);
    expect(registry).toMatch(/GlobalNamesServerQueryInterval\s+REG_DWORD\s+0xe10/);
  });

  it('a value written with reg.exe is the setting the cmdlet reports, and zero stands for the default', async () => {
    const { server } = await lab();
    await server.executeCommand(`reg add ${PARAMETERS} /v EnableGlobalNamesSupport /t REG_DWORD /d 1 /f`);
    await server.executeCommand(`reg add ${PARAMETERS} /v GlobalNamesSendTimeout /t REG_DWORD /d 0 /f`);
    await server.executeCommand(`reg add ${PARAMETERS} /v GlobalNamesServerQueryInterval /t REG_DWORD /d 0 /f`);
    const out = await run(server, 'Get-DnsServerGlobalNameZone');
    expect(out).toMatch(/Enable\s+:\s+True/);
    expect(out).toMatch(/SendTimeout\(s\)\s+:\s+3/);
    expect(out).toMatch(/ServerQueryInterval\s+:\s+06:00:00/);
  });

  it('values outside the documented ranges are refused and change nothing', async () => {
    const { server } = await lab();
    expect(await run(server, 'Set-DnsServerGlobalNameZone -SendTimeout 16')).toContain("Cannot validate argument on parameter 'SendTimeout'");
    expect(await run(server, 'Set-DnsServerGlobalNameZone -ServerQueryInterval 00:00:30')).toContain('less than the minimum allowed range of 00:01:00');
    expect(await run(server, 'Get-DnsServerGlobalNameZone')).toMatch(/SendTimeout\(s\)\s+:\s+3/);
  });
});

describe('answering a single-label name', () => {
  it('CONTROL: with support off (the default) the server does not answer from the GlobalNames zone', async () => {
    const { ask } = await lab();
    expect((await ask('sarah'))?.flags.rcode).toBe(DnsRcode.REFUSED);
  });

  it('with support on, a single label is answered from the GlobalNames zone with its CNAME and the target address', async () => {
    const { server, ask } = await lab();
    await run(server, 'Set-DnsServerGlobalNameZone -Enable $true');
    const reply = await ask('sarah');
    expect(reply?.flags.rcode).toBe(DnsRcode.NOERROR);
    expect(reply?.flags.aa).toBe(true);
    expect(reply?.answers[0].name).toBe('sarah');
    expect(targetsOf(reply)).toEqual(['desktop01.corp.test']);
    expect(addressesOf(reply)).toEqual(['10.0.9.5']);
  });

  it('a CNAME query returns the CNAME alone', async () => {
    const { server, ask } = await lab();
    await run(server, 'Set-DnsServerGlobalNameZone -Enable $true');
    const reply = await ask('sarah', RRType.CNAME);
    expect(targetsOf(reply)).toEqual(['desktop01.corp.test']);
    expect(addressesOf(reply)).toEqual([]);
  });

  it('CONTROL: a name with two labels is not looked up in the GlobalNames zone, even if the zone holds that name', async () => {
    const { server, ask } = await lab();
    await run(server, 'Set-DnsServerGlobalNameZone -Enable $true');
    expect((await ask('sarah.corp.test'))?.flags.rcode).toBe(DnsRcode.NXDOMAIN);
    expect((await ask('deep.sarah'))?.flags.rcode).toBe(DnsRcode.REFUSED);
  });

  it('the answer follows the whole chain of aliases, and a CNAME query stops at the first', async () => {
    const { server, ask } = await lab();
    await run(server, 'Set-DnsServerGlobalNameZone -Enable $true');
    expect(targetsOf(await ask('chained'))).toEqual(['alias.corp.test', 'desktop01.corp.test']);
    expect(addressesOf(await ask('chained'))).toEqual(['10.0.9.5']);
    expect(targetsOf(await ask('chained', RRType.CNAME))).toEqual(['alias.corp.test']);
  });

  it('CONTROL: support on without a GlobalNames zone answers nothing', async () => {
    const { server, ask } = await lab({ globalNames: false });
    await run(server, 'Set-DnsServerGlobalNameZone -Enable $true');
    expect((await ask('sarah'))?.flags.rcode).toBe(DnsRcode.REFUSED);
  });

  it('a target outside the server\'s zones is chased by recursion when the client asks for it', async () => {
    const { server, ask } = await lab();
    await run(server, 'Set-DnsServerGlobalNameZone -Enable $true');
    const reply = await ask('portal', RRType.A, true);
    expect(targetsOf(reply)).toEqual(['external.other.test']);
    expect(addressesOf(reply)).toEqual(['10.0.9.77']);
  });

  it('the GlobalNames zone is read first by default, and after the local zones with -GlobalOverLocal $true', async () => {
    const { server, ask } = await lab();
    await run(server, 'Set-DnsServerGlobalNameZone -Enable $true');
    expect(addressesOf(await ask('intranet'))).toEqual(['10.0.9.5']);
    await run(server, 'Set-DnsServerGlobalNameZone -GlobalOverLocal $true');
    expect(addressesOf(await ask('intranet'))).toEqual(['10.0.9.50']);
  });

  it('CONTROL: a label the GlobalNames zone does not hold falls through to the local zone', async () => {
    const { server, ask } = await lab();
    await run(server, 'Set-DnsServerGlobalNameZone -Enable $true');
    await run(server, 'Add-DnsServerPrimaryZone -Name local1');
    await run(server, 'Add-DnsServerResourceRecordA -ZoneName local1 -Name @ -IPv4Address 10.0.9.60');
    expect(addressesOf(await ask('local1'))).toEqual(['10.0.9.60']);
  });
});

describe('BlockUpdates', () => {
  it('CONTROL: with support off a dynamic update for a name of the GlobalNames zone is accepted', async () => {
    const { update } = await lab();
    expect((await update('sarah.corp.test', '10.0.9.99'))?.flags.rcode).toBe(DnsRcode.NOERROR);
  });

  it('with support on, an update whose relative name is a label of the GlobalNames zone is refused', async () => {
    const { server, ask, update } = await lab();
    await run(server, 'Set-DnsServerGlobalNameZone -Enable $true');
    expect((await update('Sarah.corp.test', '10.0.9.99'))?.flags.rcode).toBe(DnsRcode.REFUSED);
    expect((await ask('sarah.corp.test'))?.flags.rcode).toBe(DnsRcode.NXDOMAIN);
  });

  it('CONTROL: an update for another name is accepted', async () => {
    const { server, update } = await lab();
    await run(server, 'Set-DnsServerGlobalNameZone -Enable $true');
    expect((await update('desktop02.corp.test', '10.0.9.98'))?.flags.rcode).toBe(DnsRcode.NOERROR);
  });

  it('-BlockUpdates $false lets the colliding update through', async () => {
    const { server, ask, update } = await lab();
    await run(server, 'Set-DnsServerGlobalNameZone -Enable $true');
    expect((await update('sarah.corp.test', '10.0.9.99'))?.flags.rcode).toBe(DnsRcode.REFUSED);
    await run(server, 'Set-DnsServerGlobalNameZone -BlockUpdates $false');
    expect((await update('sarah.corp.test', '10.0.9.99'))?.flags.rcode).toBe(DnsRcode.NOERROR);
    expect(addressesOf(await ask('sarah.corp.test'))).toEqual(['10.0.9.99']);
  });

  it('CONTROL: updates inside the GlobalNames zone itself are never a collision, even for a name it already holds', async () => {
    const { server, update } = await lab();
    await run(server, 'Set-DnsServerGlobalNameZone -Enable $true');
    expect((await update('newlabel.globalnames', '10.0.9.97', 'GlobalNames'))?.flags.rcode).toBe(DnsRcode.NOERROR);
    expect((await update('newlabel.globalnames', '10.0.9.96', 'GlobalNames'))?.flags.rcode).toBe(DnsRcode.NOERROR);
  });
});
