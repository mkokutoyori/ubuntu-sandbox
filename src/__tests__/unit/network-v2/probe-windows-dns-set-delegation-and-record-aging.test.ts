/*
 * Probe — Set-DnsServerResourceRecordAging and Set-DnsServerZoneDelegation exist and do what their pages say. Set-DnsServerResourceRecordAging
 * "sets a time stamp to the current time for records in a specified zone ... if you have enabled aging for the zone": the records of the node
 * (and of the nodes under it with -Recurse) become records that the scavenging may remove once their no-refresh and refresh intervals have
 * passed, static ones included. Set-DnsServerZoneDelegation changes "the IP addresses for name servers for the delegated zone": the addresses
 * of the name server's glue in the zone become the ones given. The examples of the Learn pages are the transcripts, the Windows server of the
 * lab holds corp.test.
 *
 * Measured first: neither cmdlet existed ("is not recognized"), a static record could never be aged except by creating it with -AgeRecord,
 * and the glue of a delegation could be changed only by removing the delegation and adding it again.
 *
 * Authority: the Learn pages of the two cmdlets (the parameters and positions, -NodeName and -Recurse, "you must enable aging at the zone
 * level by using the Set-DnsServerZoneAging cmdlet", the two examples, the delegation set by name and by object, the address list). Not
 * sourced, said here: that nothing is stamped, and nothing is said, when aging is not enabled for the zone; that the SOA record is never
 * stamped; that a NodeName under the zone may be given by its full name; that the glue replaced is the one of the name server whatever the
 * delegation that names it; that a name server outside the zone, which has no address in it, is refused; and the wording of the refusals.
 *
 * Discrimination (the probe run on the tree before the change): 19 of 20 cases fall, the ones that need the cmdlets; the one that passes on
 * both sides is the WITNESS (a static record has no time stamp, whatever the aging of the zone).
 */
import { describe, it, expect } from 'vitest';
import { policyLab as governed } from './dnsRateLimitingLab';

const AGING = 'Set-DnsServerResourceRecordAging';
const SET_DELEGATION = 'Set-DnsServerZoneDelegation';
const ADD_DELEGATION = 'Add-DnsServerZoneDelegation';
const GET_DELEGATION = 'Get-DnsServerZoneDelegation';
const NON_INTERACTIVE = 'Windows PowerShell is in NonInteractive mode.';
const NO_ZONE = (name: string): string => `Zone "${name}" does not exist on this server.`;
const DAY = 24 * 60 * 60 * 1000;

const stampOf = (cmd: (line: string) => Promise<string>, zone: string, name: string, type = 'A'): Promise<string> =>
  cmd(`(Get-DnsServerResourceRecord -ZoneName ${zone} -Name ${name} -RRType ${type}).Timestamp`);

async function agingLab() {
  const context = await governed();
  const { cmd } = context;
  await cmd('Set-DnsServerZoneAging -Name corp.test -Aging $true -NoRefreshInterval "1.00:00:00" -RefreshInterval "1.00:00:00"');
  await cmd('Add-DnsServerResourceRecordA -ZoneName corp.test -Name two -IPv4Address 10.0.5.1');
  await cmd('Add-DnsServerResourceRecordA -ZoneName corp.test -Name three.two -IPv4Address 10.0.5.2');
  await cmd('Add-DnsServerResourceRecordA -ZoneName corp.test -Name a.three.two -IPv4Address 10.0.5.3');
  await cmd('Add-DnsServerResourceRecordA -ZoneName corp.test -Name b.three.two -IPv4Address 10.0.5.4');
  return context;
}

describe('Set-DnsServerResourceRecordAging', () => {
  it('(WITNESS) finds no time stamp on a static record, whatever the aging of the zone', async () => {
    const { cmd } = await agingLab();
    expect(await stampOf(cmd, 'corp.test', 'web')).toBe('');
    expect(await stampOf(cmd, 'corp.test', 'three.two')).toBe('');
  });

  it('ages every record of the zone under -Recurse (example 1), the records that had no time stamp getting one', async () => {
    const { cmd } = await agingLab();
    expect(await cmd(`${AGING} -ZoneName "corp.test" -Force -Recurse`)).toBe('');
    for (const name of ['web', 'mail', 'two', 'three.two', 'a.three.two']) expect(await stampOf(cmd, 'corp.test', name)).not.toBe('');
  });

  it('ages the records of a node alone, and its descendants under -Recurse (example 2)', async () => {
    const { cmd } = await agingLab();
    expect(await cmd(`${AGING} -NodeName "three.two" -ZoneName "corp.test" -Force`)).toBe('');
    expect(await stampOf(cmd, 'corp.test', 'three.two')).not.toBe('');
    expect(await stampOf(cmd, 'corp.test', 'a.three.two')).toBe('');
    expect(await stampOf(cmd, 'corp.test', 'two')).toBe('');
    await cmd(`${AGING} -NodeName "three.two" -ZoneName "corp.test" -Force -Recurse`);
    expect(await stampOf(cmd, 'corp.test', 'a.three.two')).not.toBe('');
    expect(await stampOf(cmd, 'corp.test', 'b.three.two')).not.toBe('');
    expect(await stampOf(cmd, 'corp.test', 'two')).toBe('');
  });

  it('takes the zone and the node by position, and the node by its full name', async () => {
    const { cmd } = await agingLab();
    await cmd(`${AGING} corp.test two -Force`);
    expect(await stampOf(cmd, 'corp.test', 'two')).not.toBe('');
    await cmd(`${AGING} -ZoneName corp.test -NodeName a.three.two.corp.test -Force`);
    expect(await stampOf(cmd, 'corp.test', 'a.three.two')).not.toBe('');
    expect(await stampOf(cmd, 'corp.test', 'b.three.two')).toBe('');
  });

  it('finds the records of a node whatever the case of the names they were written with', async () => {
    const { cmd } = await agingLab();
    await cmd('Add-DnsServerResourceRecordA -ZoneName corp.test -Name Mixed.Case -IPv4Address 10.0.6.1');
    await cmd(`${AGING} -ZoneName corp.test -NodeName MIXED.case -Force`);
    expect(await stampOf(cmd, 'corp.test', 'Mixed.Case')).not.toBe('');
  });

  it('ages the apex alone when no node is given, and never the SOA', async () => {
    const { cmd } = await agingLab();
    await cmd('Add-DnsServerResourceRecordA -ZoneName corp.test -Name @ -IPv4Address 10.0.9.9');
    await cmd(`${AGING} -ZoneName corp.test -Force`);
    expect(await stampOf(cmd, 'corp.test', '@')).not.toBe('');
    expect(await stampOf(cmd, 'corp.test', 'web')).toBe('');
    await cmd(`${AGING} -ZoneName corp.test -Force -Recurse`);
    expect(await stampOf(cmd, 'corp.test', '@', 'SOA')).toBe('');
  });

  it('does nothing, and says nothing, when aging is not enabled for the zone', async () => {
    const { cmd } = await governed();
    expect(await cmd(`${AGING} -ZoneName corp.test -Force -Recurse`)).toBe('');
    expect(await stampOf(cmd, 'corp.test', 'web')).toBe('');
  });

  it('makes the static records it ages eligible for the scavenging, once their intervals have passed', async () => {
    const { cmd, server } = await agingLab();
    await cmd(`${AGING} -ZoneName corp.test -Force -Recurse`);
    server.advanceTime(1.5 * DAY);
    await cmd('Start-DnsServerScavenging');
    expect(await cmd('(Get-DnsServerResourceRecord -ZoneName corp.test -Name web).Count')).toBe('1');
    server.advanceTime(1 * DAY);
    await cmd('Start-DnsServerScavenging');
    expect(await cmd('(Get-DnsServerResourceRecord -ZoneName corp.test -Name web).Count')).toBe('0');
    expect(await cmd('(Get-DnsServerResourceRecord -ZoneName corp.test -Name two).Count')).toBe('0');
  });

  it('asks before it ages unless -Force is given, and names its target under -WhatIf', async () => {
    const { cmd } = await agingLab();
    expect(await cmd(`${AGING} -ZoneName corp.test`)).toContain(`${AGING} : ${NON_INTERACTIVE}`);
    expect(await cmd(`${AGING} -ZoneName corp.test -WhatIf`)).toContain(`What if: Performing the operation "${AGING}" on target "corp.test".`);
    expect(await stampOf(cmd, 'corp.test', 'two')).toBe('');
  });

  it('refuses a zone that is not on the server and asks for the zone that is missing', async () => {
    const { cmd } = await agingLab();
    expect(await cmd(`${AGING} -ZoneName nope.test -Force`)).toContain(`${AGING} : ${NO_ZONE('nope.test')}`);
    expect(await cmd(`${AGING} -Force`)).toContain(`${AGING} : Cannot process command because of one or more missing mandatory parameters: ZoneName.`);
  });
});

describe('Set-DnsServerZoneDelegation', () => {
  const glueOf = (cmd: (line: string) => Promise<string>, host: string): Promise<string> =>
    cmd(`(Get-DnsServerResourceRecord -ZoneName corp.test -Name ${host} | Where-Object { $_.RecordType -in "A","AAAA" } | ForEach-Object { $_.RecordData.IPv4Address + $_.RecordData.IPv6Address } | Sort-Object) -join ","`);

  async function delegated() {
    const context = await governed();
    await context.cmd(`${ADD_DELEGATION} -Name "corp.test" -ChildZoneName "west01" -NameServer "wserver.west01.corp.test" -IPAddress 172.23.90.136`);
    return context;
  }

  it('changes the addresses of the name server of the delegation, the new ones being the ones given (example 1)', async () => {
    const { cmd } = await delegated();
    expect(await glueOf(cmd, 'wserver.west01')).toBe('172.23.90.136');
    expect(await cmd(`${SET_DELEGATION} -Name "corp.test" -ChildZoneName "west01" -NameServer "wserver.west01.corp.test" -IPAddress 172.23.90.136,2001:4898:7020:f100:7ce3:4bb6:7f26:27c1 -PassThru | ForEach-Object { $_.ChildZoneName + "|" + $_.NameServer.RecordData.NameServer + "|" + ($_.IPAddress.RecordData.IPv4Address -join ",") + "|" + ($_.IPAddress.RecordData.IPv6Address -join ",") }`))
      .toContain('west01.corp.test|wserver.west01.corp.test|172.23.90.136');
    expect(await glueOf(cmd, 'wserver.west01')).toBe('172.23.90.136,2001:4898:7020:f100:7ce3:4bb6:7f26:27c1');
  });

  it('replaces the addresses that are not given: the old one is gone, the new one is there', async () => {
    const { cmd } = await delegated();
    expect(await cmd(`${SET_DELEGATION} -Name corp.test -ChildZoneName west01 -NameServer wserver.west01.corp.test -IPAddress 10.9.9.9`)).toBe('');
    expect(await glueOf(cmd, 'wserver.west01')).toBe('10.9.9.9');
  });

  it('keeps the delegation itself: the name server and the child zone are as they were', async () => {
    const { cmd } = await delegated();
    await cmd(`${SET_DELEGATION} -Name corp.test -ChildZoneName west01 -NameServer wserver.west01.corp.test -IPAddress 10.9.9.9`);
    expect(await glueOf(cmd, 'wserver.west01')).toBe('10.9.9.9');
    expect(await cmd(`(${GET_DELEGATION} -Name corp.test).NameServer.RecordData.NameServer`)).toBe('wserver.west01.corp.test');
    expect(await cmd(`(${GET_DELEGATION} -Name corp.test).ChildZoneName`)).toBe('west01.corp.test');
  });

  it('takes the delegation and its new addresses from the object that Get printed and that was changed', async () => {
    const { cmd } = await delegated();
    expect(await cmd(`$d = ${GET_DELEGATION} -Name corp.test -ChildZoneName west01; $d.IPAddress[0].RecordData.IPv4Address = "10.8.8.8"; ${SET_DELEGATION} -InputObject $d`)).toBe('');
    expect(await glueOf(cmd, 'wserver.west01')).toBe('10.8.8.8');
  });

  it('reads the addresses of an IPv6 glue from the object as well', async () => {
    const { cmd } = await governed();
    await cmd(`${ADD_DELEGATION} -Name corp.test -ChildZoneName six -NameServer ns.six.corp.test -IPAddress 2001:db8::53`);
    expect(await cmd(`$d = ${GET_DELEGATION} -Name corp.test -ChildZoneName six; $d.IPAddress[0].RecordData.IPv6Address = "2001:db8::54"; ${SET_DELEGATION} -InputObject $d`)).toBe('');
    expect(await glueOf(cmd, 'ns.six')).toBe('2001:db8::54');
  });

  it('takes the arguments by position: zone, child zone, name server, addresses', async () => {
    const { cmd } = await delegated();
    expect(await cmd(`${SET_DELEGATION} corp.test west01 wserver.west01.corp.test 10.7.7.7,10.7.7.8`)).toBe('');
    expect(await glueOf(cmd, 'wserver.west01')).toBe('10.7.7.7,10.7.7.8');
  });

  it('changes the glue of a zone scope alone when -ZoneScope is given', async () => {
    const { cmd } = await delegated();
    await cmd('Add-DnsServerZoneScope -ZoneName corp.test -Name ScopeA');
    await cmd(`${ADD_DELEGATION} -Name corp.test -ChildZoneName west01 -NameServer wserver.west01.corp.test -IPAddress 172.23.90.136 -ZoneScope ScopeA`);
    await cmd(`${SET_DELEGATION} -Name corp.test -ChildZoneName west01 -NameServer wserver.west01.corp.test -IPAddress 10.6.6.6 -ZoneScope ScopeA`);
    expect(await cmd('(Get-DnsServerResourceRecord -ZoneName corp.test -ZoneScope ScopeA -Name wserver.west01).RecordData.IPv4Address')).toBe('10.6.6.6');
    expect(await glueOf(cmd, 'wserver.west01')).toBe('172.23.90.136');
  });

  it('refuses a delegation that is not there, a name server the delegation does not name and a zone that is not on the server', async () => {
    const { cmd } = await delegated();
    expect(await cmd(`${SET_DELEGATION} -Name corp.test -ChildZoneName east01 -NameServer wserver.east01.corp.test -IPAddress 10.1.1.1`))
      .toContain(`${SET_DELEGATION} : Cannot find the delegation "east01" of zone "corp.test" to the name server "wserver.east01.corp.test".`);
    expect(await cmd(`${SET_DELEGATION} -Name corp.test -ChildZoneName west01 -NameServer other.west01.corp.test -IPAddress 10.1.1.1`))
      .toContain(`${SET_DELEGATION} : Cannot find the delegation "west01" of zone "corp.test" to the name server "other.west01.corp.test".`);
    expect(await cmd(`${SET_DELEGATION} -Name nope.test -ChildZoneName west01 -NameServer wserver.west01.nope.test -IPAddress 10.1.1.1`)).toContain(`${SET_DELEGATION} : ${NO_ZONE('nope.test')}`);
    expect(await glueOf(cmd, 'wserver.west01')).toBe('172.23.90.136');
  });

  it('refuses a name server that is outside the zone, which has no address in it to change', async () => {
    const { cmd } = await governed();
    await cmd(`${ADD_DELEGATION} -Name corp.test -ChildZoneName far -NameServer ns.elsewhere.example -IPAddress 10.2.2.2`);
    expect(await cmd(`${SET_DELEGATION} -Name corp.test -ChildZoneName far -NameServer ns.elsewhere.example -IPAddress 10.3.3.3`))
      .toContain(`${SET_DELEGATION} : The name server "ns.elsewhere.example" is not in zone "corp.test": it has no address in this zone to change.`);
  });

  it('asks for what is missing', async () => {
    const { cmd } = await delegated();
    expect(await cmd(`${SET_DELEGATION} -Name corp.test -ChildZoneName west01`)).toContain(`${SET_DELEGATION} : Cannot process command because of one or more missing mandatory parameters: Name ChildZoneName NameServer IPAddress.`);
  });
});
