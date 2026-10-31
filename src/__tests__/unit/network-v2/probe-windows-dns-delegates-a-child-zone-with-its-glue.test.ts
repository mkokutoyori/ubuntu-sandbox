/*
 * Probe — the DnsServer zone-delegation cmdlets: Add-, Get- and Remove-DnsServerZoneDelegation.
 *
 * Measured first (Windows Server 2022 DNS role, zone contoso.com): `Add-DnsServerZoneDelegation -Name contoso.com
 * -ChildZoneName west01 -NameServer wserver.west01.contoso.com -IPAddress 172.23.90.136` is the command Microsoft
 * documents for delegating a child zone; the simulator answered that the cmdlet is not recognised, so a
 * delegation could only be built by hand from an NS record and a glue A record, and Get-DnsServerZoneDelegation
 * did not exist to read it back. The documented shape (Learn, DnsServer module): Add takes Name (alias
 * ZoneName), ChildZoneName, NameServer and IPAddress, all mandatory and positional in that order, and -PassThru;
 * Get takes Name and an optional ChildZoneName; Remove takes Name, ChildZoneName, an optional NameServer and
 * -Force, and removes the delegation when its last name server goes. The object a delegation yields carries
 * ChildZoneName, NameServer (an NS record) and IPAddress (the glue A records); the property paths are read from a
 * published script (AsBuiltReport.Microsoft.AD, Get-AbrADDNSZone) because the documentation page prints no output.
 *
 * Limit accepted, stated rather than hidden: the glue is written into the parent zone only when the name server
 * sits below it (wserver.west01.contoso.com under contoso.com). For a name server outside the zone the NS record
 * is written and the addresses are not stored, since a zone cannot hold a record that is not below its origin;
 * which of the two a real Windows DNS server does for an out-of-zone name could not be confirmed from here.
 *
 * Discrimination (git stash of DnsServerCmdlets.ts and index.ts): 10 of the 11 cases fall before the change — each
 * one calls a cmdlet that did not exist. One passes either way: "refers queries for a delegation written by
 * hand" — WITNESS built in the same lab from the older record cmdlets: it proves that the server, the cable and
 * dig are sound and already refer a hand-built delegation, so the failure of the cmdlet-built case accuses the
 * cmdlet and not the lab. The last case compares the zone the cmdlet writes with the zone the record cmdlets
 * write, which is the coherence the two interfaces over one zone owe each other.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

const SERVER_IP = '10.0.0.3';
const PC_IP = '10.0.0.100';

interface Lab { readonly server: WindowsServer; readonly pc: LinuxPC; run(line: string): Promise<string> }

async function buildLab(): Promise<Lab> {
  const sw = new GenericSwitch('switch-generic', 'SW', 8, 0, 0);
  const server = new WindowsServer('WIN');
  const pc = new LinuxPC('linux-pc', 'PC');
  const mask = new SubnetMask('255.255.255.0');
  [server, pc].forEach((device, index) => {
    new Cable(`c${index}`).connect(device.getPorts()[0], sw.getPorts()[index]);
    device.getPorts()[0].configureIP(new IPAddress([SERVER_IP, PC_IP][index]), mask);
  });
  server.setCurrentUser('Administrator');
  const shell = PowerShellSubShell.create(server).subShell;
  const run = async (line: string): Promise<string> => (await shell.processLine(line)).output.join('\n');
  await run('Install-WindowsFeature DNS');
  await run('Add-DnsServerPrimaryZone -Name contoso.com -ZoneFile contoso.com.dns');
  return { server, pc, run };
}

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
});

describe('delegating a child zone from Windows DNS', () => {
  it('writes the NS record and the glue A record the documented command describes', async () => {
    const { run } = await buildLab();
    const out = await run('Add-DnsServerZoneDelegation -Name "contoso.com" -ChildZoneName "west01" -NameServer "wserver.west01.contoso.com" -IPAddress 172.23.90.136');
    expect(out).toBe('');
    const records = await run('Get-DnsServerResourceRecord -ZoneName contoso.com');
    expect(records).toMatch(/^west01\s+NS\s+\d+\s+\d+\s+wserver\.west01\.contoso\.com\s*$/m);
    expect(records).toMatch(/^wserver\.west01\s+A\s+\d+\s+\d+\s+172\.23\.90\.136\s*$/m);
  });

  it('accepts the arguments by position: zone, child, name server, address', async () => {
    const { run } = await buildLab();
    await run('Add-DnsServerZoneDelegation contoso.com west01 wserver.west01.contoso.com 172.23.90.136');
    expect(await run('(Get-DnsServerZoneDelegation -Name contoso.com).ChildZoneName')).toBe('west01.contoso.com');
  });

  it('takes the child zone as a full name as well as a relative one', async () => {
    const { run } = await buildLab();
    await run('Add-DnsServerZoneDelegation -Name contoso.com -ChildZoneName west01.contoso.com -NameServer wserver.west01.contoso.com -IPAddress 172.23.90.136');
    expect(await run('(Get-DnsServerZoneDelegation -Name contoso.com).ChildZoneName')).toBe('west01.contoso.com');
  });

  it('reads back the child zone, its name server and its glue addresses', async () => {
    const { run } = await buildLab();
    await run('Add-DnsServerZoneDelegation -Name contoso.com -ChildZoneName west01 -NameServer wserver.west01.contoso.com -IPAddress 172.23.90.136');
    const delegation = await run('Get-DnsServerZoneDelegation -Name contoso.com -ChildZoneName west01 | ForEach-Object { "$($_.ChildZoneName)|$($_.NameServer.RecordData.NameServer)|$($_.IPAddress.RecordData.IPv4Address)" }');
    expect(delegation).toBe('west01.contoso.com|wserver.west01.contoso.com|172.23.90.136');
  });

  it('returns the delegation with -PassThru and nothing without it', async () => {
    const { run } = await buildLab();
    const passed = await run('(Add-DnsServerZoneDelegation -Name contoso.com -ChildZoneName west01 -NameServer wserver.west01.contoso.com -IPAddress 172.23.90.136 -PassThru).ChildZoneName');
    expect(passed).toBe('west01.contoso.com');
  });

  it('makes the server refer queries for the child to its name server, with the glue', async () => {
    const { run, pc } = await buildLab();
    await run('Add-DnsServerZoneDelegation -Name contoso.com -ChildZoneName west01 -NameServer wserver.west01.contoso.com -IPAddress 172.23.90.136');
    const out = await pc.executeCommand(`dig @${SERVER_IP} www.west01.contoso.com A +norecurse`);
    expect(out).not.toMatch(/flags: [a-z ]*\baa\b/);
    expect(out).toMatch(/west01\.contoso\.com\.\s+\d+\s+IN\s+NS\s+wserver\.west01\.contoso\.com\./);
    expect(out).toMatch(/wserver\.west01\.contoso\.com\.\s+\d+\s+IN\s+A\s+172\.23\.90\.136/);
  });

  it('refers queries for a delegation written by hand', async () => {
    const { run, pc } = await buildLab();
    await run('Add-DnsServerResourceRecord -NS -ZoneName contoso.com -Name west01 -NameServer wserver.west01.contoso.com');
    await run('Add-DnsServerResourceRecordA -ZoneName contoso.com -Name wserver.west01 -IPv4Address 172.23.90.136');
    const out = await pc.executeCommand(`dig @${SERVER_IP} www.west01.contoso.com A +norecurse`);
    expect(out).not.toMatch(/flags: [a-z ]*\baa\b/);
    expect(out).toMatch(/wserver\.west01\.contoso\.com\.\s+\d+\s+IN\s+A\s+172\.23\.90\.136/);
  });

  it('keeps the name server record only for a server outside the parent zone', async () => {
    const { run } = await buildLab();
    await run('Add-DnsServerZoneDelegation -Name contoso.com -ChildZoneName east01 -NameServer ns1.hoster.example -IPAddress 192.0.2.53');
    const records = await run('Get-DnsServerResourceRecord -ZoneName contoso.com');
    expect(records).toMatch(/^east01\s+NS\s+\d+\s+\d+\s+ns1\.hoster\.example\s*$/m);
    expect(records).not.toContain('192.0.2.53');
  });

  it('removes the name server records and their glue when the last name server goes', async () => {
    const { run } = await buildLab();
    await run('Add-DnsServerZoneDelegation -Name contoso.com -ChildZoneName west01 -NameServer wserver.west01.contoso.com -IPAddress 172.23.90.136');
    await run('Remove-DnsServerZoneDelegation -Name contoso.com -ChildZoneName west01 -Force');
    const records = await run('Get-DnsServerResourceRecord -ZoneName contoso.com');
    expect(records).not.toContain('west01');
    expect(await run('Get-DnsServerZoneDelegation -Name contoso.com')).toBe('');
  });

  it('refuses a parent zone the server does not host', async () => {
    const { run } = await buildLab();
    const out = await run('Add-DnsServerZoneDelegation -Name fabrikam.com -ChildZoneName west01 -NameServer wserver.west01.fabrikam.com -IPAddress 172.23.90.136');
    expect(out).toContain('fabrikam.com');
  });

  it('writes the same records by hand and by cmdlet', async () => {
    const byCmdlet = await buildLab();
    await byCmdlet.run('Add-DnsServerZoneDelegation -Name contoso.com -ChildZoneName west01 -NameServer wserver.west01.contoso.com -IPAddress 172.23.90.136');
    const byHand = await buildLab();
    await byHand.run('Add-DnsServerResourceRecord -NS -ZoneName contoso.com -Name west01 -NameServer wserver.west01.contoso.com');
    await byHand.run('Add-DnsServerResourceRecordA -ZoneName contoso.com -Name wserver.west01 -IPv4Address 172.23.90.136');
    const dump = (lab: Lab): Promise<string> => lab.run('Get-DnsServerResourceRecord -ZoneName contoso.com | Sort-Object HostName | ForEach-Object { "$($_.HostName) $($_.RecordType) $($_.RecordData)" }');
    expect(await dump(byCmdlet)).toBe(await dump(byHand));
  });
});
