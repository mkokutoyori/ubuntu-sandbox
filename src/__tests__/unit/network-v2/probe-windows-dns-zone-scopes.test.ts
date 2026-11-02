/*
 * Probe — Add-/Get-/Remove-DnsServerZoneScope exist, a zone scope keeps its own records (every record and delegation cmdlet takes
 * -ZoneScope), the scope's records are persisted in <zone name>\<scope name>.dns and come back with -LoadExisting, and a zone level
 * policy that ALLOWs really answers from the scope it picks, in the ratio of the weights it gives. The examples of the Learn pages are
 * the transcripts, the geo-location split of the policy page (a client subnet picks a zone scope) is the lab.
 *
 * Measured first (a Windows DNS server holding corp.test, three clients on two client subnets): none of the three cmdlets existed
 * ("is not recognized"), -ZoneScope on a record cmdlet was swallowed and the record landed in the zone, and a zone level ALLOW
 * could name no scope but the zone itself.
 *
 * Authority: the Learn pages of the three cmdlets (parameter positions, -Name aliased ZoneScope, the object printed as ZoneScope and
 * FileName, the default scope listed first under the zone's own name and file, "%Systemroot%\system32\dns\<zone name>\<scope name>.dns",
 * -LoadExisting, "You cannot delete the default scope"), the page of Add-DnsServerQueryResolutionPolicy ("zone level policies can decide
 * which zone scopes to use to answer queries and in what ratio"), [MS-DNSP] CreateZoneScope (the zone must exist and not be a reverse
 * lookup zone, the scope must not exist), DeleteZoneScope (9959 when the scope is absent, 9989 when a policy names it), DeleteZone
 * ("the database file of the scopes MUST not be deleted") and DNS_RPC_POLICY_CONTENT (the weights), and the Windows message table
 * (9951 "The scope already exists for the zone.", 9952 "The scope does not exist for the zone.", 9953 "The scope is the same as the
 * default zone scope.", 9954 "The scope name contains invalid characters.", 9989). Not sourced, said here: which code each refusal of a
 * reverse lookup zone carries (the text is ours), that a record cmdlet on an absent scope answers 9952, that a scope holds neither the
 * SOA nor the apex NS of the zone (negative answers carry the zone's SOA, read at the time of the answer), that a removed scope keeps
 * its file, that aging applies to the records of a scope like to the ones of the zone, and that a zone transfer carries the default
 * scope alone.
 *
 * Discrimination (the probe run on the tree before the change): 46 of 50 cases fall. The four that pass on
 * both sides are named: the WITNESS proves the lab itself (both client subnets are answered from the zone) and the CONTROLs pin what the
 * change must not touch (a server level DENY wins over a zone level ALLOW, a zone level DENY refuses as before, an unscoped query on a
 * zone that is not loaded keeps saying that the zone cannot be found).
 */
import { describe, it, expect } from 'vitest';
import { RRType } from '@/network/dns/wire/RRType';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import type { ARecordData, SoaRecordData } from '@/network/dns/wire/ResourceRecord';
import { policyLab as governed, run } from './dnsRateLimitingLab';

const ADD = 'Add-DnsServerZoneScope';
const GET = 'Get-DnsServerZoneScope';
const REMOVE = 'Remove-DnsServerZoneScope';
const POLICY = 'Add-DnsServerQueryResolutionPolicy';

const EXISTS = 'The scope already exists for the zone.';
const ABSENT = 'The scope does not exist for the zone.';
const IS_DEFAULT = 'The scope is the same as the default zone scope.';
const INVALID_NAME = 'The scope name contains invalid characters.';
const MISSING = 'The scope does not exist.';
const REFERENCED = 'The zone scope cannot be deleted because it is referenced by a DNS Policy.';
const NON_INTERACTIVE = 'Windows PowerShell is in NonInteractive mode.';
const SCOPE_FOLDER = 'C:\\Windows\\System32\\dns\\corp.test';

const tidy = (text: string): string => text.split('\n').map(line => line.trimEnd()).join('\n');

const addressesOf = (reply: DnsMessage | null): string[] =>
  (reply?.answers ?? []).filter(record => record.data.type === RRType.A).map(record => (record.data as ARecordData).address.toString());

async function scoped() {
  const context = await governed();
  const { cmd } = context;
  await cmd(`${ADD} -ZoneName corp.test -Name ScopeA`);
  await cmd(`${ADD} -ZoneName corp.test -Name ScopeB`);
  await cmd('Add-DnsServerResourceRecordA -ZoneName corp.test -Name www -IPv4Address 10.9.9.9');
  await cmd('Add-DnsServerResourceRecordA -ZoneName corp.test -Name www -IPv4Address 10.1.1.1 -ZoneScope ScopeA');
  await cmd('Add-DnsServerResourceRecordA -ZoneName corp.test -Name www -IPv4Address 10.2.2.2 -ZoneScope ScopeB');
  return context;
}

const names = (listing: string): string => `(${listing}).ZoneScope -join ","`;

describe('Add-DnsServerZoneScope', () => {
  it('prints the scope of example 1 under -PassThru, its file named after the scope', async () => {
    const { cmd } = await governed();
    expect(tidy(await cmd(`${ADD} -ZoneName corp.test -Name corp_NorthAmerica -PassThru`))).toBe([
      '',
      'ZoneScope         FileName',
      '---------         --------',
      'corp_NorthAmerica corp_NorthAmerica.dns',
      '',
    ].join('\n'));
  });

  it('is quiet without -PassThru and takes the zone and the name by position', async () => {
    const { cmd } = await governed();
    expect(await cmd(`${ADD} corp.test Europe`)).toBe('');
    expect(await cmd(names(`${GET} -ZoneName corp.test`))).toBe('corp.test,Europe');
  });

  it('takes -ZoneScope as the alias of -Name', async () => {
    const { cmd } = await governed();
    expect(await cmd(`${ADD} -ZoneName corp.test -ZoneScope Asia`)).toBe('');
    expect(await cmd(names(`${GET} -ZoneName corp.test`))).toBe('corp.test,Asia');
  });

  it('refuses the zone name itself, whatever its case: the default scope exists', async () => {
    const { cmd } = await governed();
    expect(await cmd(`${ADD} -ZoneName corp.test -Name corp.test`)).toContain(`${ADD} : ${IS_DEFAULT}`);
    expect(await cmd(`${ADD} -ZoneName corp.test -Name CORP.TEST`)).toContain(`${ADD} : ${IS_DEFAULT}`);
  });

  it('refuses a scope that exists, whatever its case', async () => {
    const { cmd } = await governed();
    await cmd(`${ADD} -ZoneName corp.test -Name Europe`);
    expect(await cmd(`${ADD} -ZoneName corp.test -Name EUROPE`)).toContain(`${ADD} : ${EXISTS}`);
    expect(await cmd(names(`${GET} -ZoneName corp.test`))).toBe('corp.test,Europe');
  });

  it('refuses a name a zone name cannot carry', async () => {
    const { cmd } = await governed();
    expect(await cmd(`${ADD} -ZoneName corp.test -Name "bad name!"`)).toContain(`${ADD} : ${INVALID_NAME}`);
    expect(await cmd(names(`${GET} -ZoneName corp.test`))).toBe('corp.test');
  });

  it('refuses a zone that is not on the server', async () => {
    const { cmd } = await governed();
    expect(await cmd(`${ADD} -ZoneName nope.test -Name X`)).toContain(`${ADD} : Zone "nope.test" does not exist on this server.`);
  });

  it('refuses a reverse lookup zone', async () => {
    const { cmd } = await governed();
    await cmd('Add-DnsServerPrimaryZone -Name 1.0.10.in-addr.arpa');
    expect(await cmd(`${ADD} -ZoneName 1.0.10.in-addr.arpa -Name X`)).toContain('is a reverse lookup zone and cannot have zone scopes.');
    expect(await cmd(names(`${GET} -ZoneName 1.0.10.in-addr.arpa`))).toBe('1.0.10.in-addr.arpa');
  });

  it('asks for what is missing and names its target under -WhatIf', async () => {
    const { cmd } = await governed();
    expect(await cmd(`${ADD} -ZoneName corp.test`)).toContain(`${ADD} : Cannot process command because of one or more missing mandatory parameters: Name.`);
    expect(await cmd(`${ADD} -Name X`)).toContain(`${ADD} : Cannot process command because of one or more missing mandatory parameters: ZoneName.`);
    expect(await cmd(`${ADD} -ZoneName corp.test -Name X -WhatIf`)).toContain(`What if: Performing the operation "${ADD}" on target "X".`);
    expect(await cmd(names(`${GET} -ZoneName corp.test`))).toBe('corp.test');
  });
});

describe('Get-DnsServerZoneScope', () => {
  it('lists the default scope first, under the zone name and its file, then the scopes in the order they were added (example 1)', async () => {
    const { cmd } = await governed();
    await cmd(`${ADD} -ZoneName corp.test -Name corp_NorthAmerica`);
    await cmd(`${ADD} -ZoneName corp.test -Name corp_Europe`);
    expect(tidy(await cmd(`${GET} -ZoneName corp.test`))).toBe([
      '',
      'ZoneScope         FileName',
      '---------         --------',
      'corp.test         corp.test.dns',
      'corp_NorthAmerica corp_NorthAmerica.dns',
      'corp_Europe       corp_Europe.dns',
      '',
    ].join('\n'));
  });

  it('gets one scope by name, whatever its case, by position or by its alias (example 2)', async () => {
    const { cmd } = await governed();
    await cmd(`${ADD} -ZoneName corp.test -Name corp_Europe`);
    expect(tidy(await cmd(`${GET} -ZoneName corp.test -Name corp_europe`))).toBe([
      '',
      'ZoneScope   FileName',
      '---------   --------',
      'corp_Europe corp_Europe.dns',
      '',
    ].join('\n'));
    expect(await cmd(`(${GET} corp.test CORP_EUROPE).ZoneScope`)).toBe('corp_Europe');
    expect(await cmd(`(${GET} -ZoneName corp.test -ZoneScope corp_Europe).FileName`)).toBe('corp_Europe.dns');
    expect(await cmd(`(${GET} -ZoneName corp.test -Name CORP.TEST).FileName`)).toBe('corp.test.dns');
  });

  it('says when the scope is not in the zone and when the zone is not on the server', async () => {
    const { cmd } = await governed();
    expect(await cmd(`${GET} -ZoneName corp.test -Name nope`)).toContain(`${GET} : ${ABSENT}`);
    expect(await cmd(`${GET} -ZoneName nope.test`)).toContain(`${GET} : Zone "nope.test" does not exist on this server.`);
    expect(await cmd(GET)).toContain(`${GET} : Cannot process command because of one or more missing mandatory parameters: ZoneName.`);
  });

  it('keeps the scopes of a zone apart from the scopes of another zone', async () => {
    const { cmd } = await governed();
    await cmd('Add-DnsServerPrimaryZone -Name other.test');
    await cmd(`${ADD} -ZoneName corp.test -Name Shared`);
    await cmd(`${ADD} -ZoneName other.test -Name Shared`);
    await cmd(`${ADD} -ZoneName other.test -Name OnlyOther`);
    expect(await cmd(names(`${GET} -ZoneName corp.test`))).toBe('corp.test,Shared');
    expect(await cmd(names(`${GET} -ZoneName other.test`))).toBe('other.test,Shared,OnlyOther');
  });
});

describe('Remove-DnsServerZoneScope', () => {
  it('removes the scope of example 1 and prints it under -PassThru', async () => {
    const { cmd } = await governed();
    await cmd(`${ADD} -ZoneName corp.test -Name corp_NorthAmerica`);
    expect(tidy(await cmd(`${REMOVE} -ZoneName corp.test -Name corp_NorthAmerica -PassThru -Force`))).toBe([
      '',
      'ZoneScope         FileName',
      '---------         --------',
      'corp_NorthAmerica corp_NorthAmerica.dns',
      '',
    ].join('\n'));
    expect(await cmd(names(`${GET} -ZoneName corp.test`))).toBe('corp.test');
  });

  it('finds the scope it prints whatever the case it is named with', async () => {
    const { cmd } = await governed();
    await cmd(`${ADD} -ZoneName corp.test -Name corp_NorthAmerica`);
    expect(await cmd(`${REMOVE} -ZoneName corp.test -Name CORP_NORTHAMERICA -PassThru -Force | ForEach-Object { $_.ZoneScope }`)).toBe('corp_NorthAmerica');
  });

  it('removes every scope that Get lists, the default one refusing to go (example 2)', async () => {
    const { cmd } = await governed();
    await cmd(`${ADD} -ZoneName corp.test -Name corp_NorthAmerica`);
    await cmd(`${ADD} -ZoneName corp.test -Name corp_Europe`);
    const output = await cmd(`${GET} -ZoneName corp.test | ${REMOVE} -Force -PassThru`);
    expect(output).toContain(`${REMOVE} : ${IS_DEFAULT}`);
    expect(output).toContain('corp_NorthAmerica.dns');
    expect(output).toContain('corp_Europe.dns');
    expect(await cmd(names(`${GET} -ZoneName corp.test`))).toBe('corp.test');
  });

  it('refuses the default scope, an absent scope and an absent zone', async () => {
    const { cmd } = await governed();
    expect(await cmd(`${REMOVE} -ZoneName corp.test -Name corp.test -Force`)).toContain(`${REMOVE} : ${IS_DEFAULT}`);
    expect(await cmd(`${REMOVE} -ZoneName corp.test -Name nope -Force`)).toContain(`${REMOVE} : ${MISSING}`);
    expect(await cmd(`${REMOVE} -ZoneName nope.test -Name X -Force`)).toContain(`${REMOVE} : Zone "nope.test" does not exist on this server.`);
  });

  it('asks before it removes and names its target under -WhatIf', async () => {
    const { cmd } = await governed();
    await cmd(`${ADD} -ZoneName corp.test -Name S`);
    expect(await cmd(`${REMOVE} -ZoneName corp.test -Name S`)).toContain(`${REMOVE} : ${NON_INTERACTIVE}`);
    expect(await cmd(`${REMOVE} -ZoneName corp.test -Name S -WhatIf`)).toContain(`What if: Performing the operation "${REMOVE}" on target "S".`);
    expect(await cmd(names(`${GET} -ZoneName corp.test`))).toBe('corp.test,S');
  });

  it('refuses a scope that a zone level policy names, until the policy goes (9989)', async () => {
    const { cmd } = await scoped();
    await cmd(`${POLICY} -Name P -Action ALLOW -ClientSubnet "EQ,Lan" -ZoneScope "ScopeA,1" -ZoneName corp.test`);
    expect(await cmd(`${REMOVE} -ZoneName corp.test -Name ScopeA -Force`)).toContain(`${REMOVE} : ${REFERENCED}`);
    expect(await cmd(`${REMOVE} -ZoneName corp.test -Name SCOPEA -Force`)).toContain(`${REMOVE} : ${REFERENCED}`);
    expect(await cmd(`${REMOVE} -ZoneName corp.test -Name ScopeB -Force`)).toBe('');
    await cmd('Remove-DnsServerQueryResolutionPolicy -Name P -ZoneName corp.test -Force');
    expect(await cmd(`${REMOVE} -ZoneName corp.test -Name ScopeA -Force`)).toBe('');
    expect(await cmd(names(`${GET} -ZoneName corp.test`))).toBe('corp.test');
  });

  it('goes with the zone: a zone added again has no scope', async () => {
    const { cmd } = await scoped();
    await cmd('Remove-DnsServerZone -Name corp.test -Force');
    await cmd('Add-DnsServerPrimaryZone -Name corp.test');
    expect(await cmd(names(`${GET} -ZoneName corp.test`))).toBe('corp.test');
    expect(await cmd('Get-DnsServerResourceRecord -ZoneName corp.test -ZoneScope ScopeA')).toContain(ABSENT);
  });
});

describe('the records of a scope', () => {
  it('stay in the scope: the zone shows its own, the scope shows its own and neither the SOA nor the NS of the zone', async () => {
    const { cmd } = await scoped();
    expect(await cmd('(Get-DnsServerResourceRecord -ZoneName corp.test -Name www).RecordData.IPv4Address -join ","')).toBe('10.9.9.9');
    expect(await cmd('(Get-DnsServerResourceRecord -ZoneName corp.test -ZoneScope ScopeA).RecordData.IPv4Address -join ","')).toBe('10.1.1.1');
    expect(await cmd('(Get-DnsServerResourceRecord -ZoneName corp.test -ZoneScope ScopeA).HostName -join ","')).toBe('www');
    expect(await cmd('(Get-DnsServerResourceRecord -ZoneName corp.test -ZoneScope ScopeB -RRType SOA).Count')).toBe('0');
    expect(await cmd('(Get-DnsServerResourceRecord -ZoneName corp.test -RRType SOA).Count')).toBe('1');
  });

  it('take the name of the zone as the default scope', async () => {
    const { cmd } = await scoped();
    await cmd('Add-DnsServerResourceRecordA -ZoneName corp.test -Name inzone -IPv4Address 10.7.7.7 -ZoneScope CORP.TEST');
    expect(await cmd('(Get-DnsServerResourceRecord -ZoneName corp.test -Name inzone).HostName')).toBe('inzone');
    expect(await cmd('(Get-DnsServerResourceRecord -ZoneName corp.test -ZoneScope corp.test -Name inzone).HostName')).toBe('inzone');
    expect(await cmd('(Get-DnsServerResourceRecord -ZoneName corp.test -ZoneScope ScopeA -Name inzone).Count')).toBe('0');
  });

  it('are refused, written, read, replaced and removed, under an absent scope, with the text of 9952', async () => {
    const { cmd } = await scoped();
    expect(await cmd('Add-DnsServerResourceRecordA -ZoneName corp.test -Name x -IPv4Address 10.1.1.1 -ZoneScope Nope')).toContain(`Add-DnsServerResourceRecordA : ${ABSENT}`);
    expect(await cmd('Add-DnsServerResourceRecord -ZoneName corp.test -Name x -A -IPv4Address 10.1.1.1 -ZoneScope Nope')).toContain(`Add-DnsServerResourceRecord : ${ABSENT}`);
    expect(await cmd('Get-DnsServerResourceRecord -ZoneName corp.test -ZoneScope Nope')).toContain(`Get-DnsServerResourceRecord : ${ABSENT}`);
    expect(await cmd('Remove-DnsServerResourceRecord -ZoneName corp.test -Name www -RRType A -ZoneScope Nope -Force')).toContain(`Remove-DnsServerResourceRecord : ${ABSENT}`);
    expect(await cmd('Get-DnsServerZoneDelegation -Name corp.test -ZoneScope Nope')).toContain(`Get-DnsServerZoneDelegation : ${ABSENT}`);
    expect(await cmd('(Get-DnsServerResourceRecord -ZoneName corp.test -Name x).Count')).toBe('0');
  });

  it('(CONTROL) say that the zone cannot be found, not that a scope is missing, when none was asked for on a secondary zone that has not transferred yet', async () => {
    const { master } = await governed();
    await run(master, 'Add-DnsServerSecondaryZone -Name corp.test -MasterServers 10.0.1.10');
    expect(await run(master, 'Get-DnsServerResourceRecord -ZoneName corp.test')).toContain('Get-DnsServerResourceRecord : Cannot find zone "corp.test" on this server.');
    expect(await run(master, 'Get-DnsServerZoneDelegation -Name corp.test')).toContain('Get-DnsServerZoneDelegation : Zone "corp.test" does not exist on this server.');
  });

  it('are written through every Add cmdlet of the family', async () => {
    const { cmd } = await governed();
    await cmd(`${ADD} -ZoneName corp.test -Name ScopeA`);
    await cmd('Add-DnsServerResourceRecordAAAA -ZoneName corp.test -Name six -IPv6Address 2001:db8::7 -ZoneScope ScopeA');
    await cmd('Add-DnsServerResourceRecordCName -ZoneName corp.test -Name alias -HostNameAlias www.corp.test -ZoneScope ScopeA');
    await cmd('Add-DnsServerResourceRecordMX -ZoneName corp.test -Name corp.test -MailExchange mail.corp.test -Preference 10 -ZoneScope ScopeA');
    await cmd('Add-DnsServerResourceRecordPtr -ZoneName corp.test -Name ptr -PtrDomainName www.corp.test -ZoneScope ScopeA');
    await cmd('Add-DnsServerResourceRecord -ZoneName corp.test -Name text -Txt -DescriptiveText hello -ZoneScope ScopeA');
    expect(await cmd('(Get-DnsServerResourceRecord -ZoneName corp.test -ZoneScope ScopeA).RecordType -join ","')).toBe('AAAA,CNAME,MX,PTR,TXT');
    expect(await cmd('(Get-DnsServerResourceRecord -ZoneName corp.test | Where-Object { $_.HostName -in "six","alias","ptr","text" }).Count')).toBe('0');
  });

  it('are replaced in the scope alone by Set-DnsServerResourceRecord', async () => {
    const { cmd } = await scoped();
    await cmd([
      '$old = Get-DnsServerResourceRecord -ZoneName corp.test -ZoneScope ScopeA -Name www -RRType A',
      '$new = Get-DnsServerResourceRecord -ZoneName corp.test -ZoneScope ScopeA -Name www -RRType A',
      '$new.RecordData.IPv4Address = "10.1.1.9"',
      'Set-DnsServerResourceRecord -ZoneName corp.test -OldInputObject $old -NewInputObject $new -ZoneScope ScopeA',
    ].join('; '));
    expect(await cmd('(Get-DnsServerResourceRecord -ZoneName corp.test -ZoneScope ScopeA -Name www).RecordData.IPv4Address')).toBe('10.1.1.9');
    expect(await cmd('(Get-DnsServerResourceRecord -ZoneName corp.test -Name www).RecordData.IPv4Address')).toBe('10.9.9.9');
  });

  it('are removed from the scope by the record that Get printed, piped to Remove with the scope', async () => {
    const { cmd } = await scoped();
    expect(await cmd('Get-DnsServerResourceRecord -ZoneName corp.test -ZoneScope ScopeA -Name www | Remove-DnsServerResourceRecord -ZoneName corp.test -ZoneScope ScopeA -Force')).toBe('');
    expect(await cmd('(Get-DnsServerResourceRecord -ZoneName corp.test -ZoneScope ScopeA -Name www).Count')).toBe('0');
    expect(await cmd('(Get-DnsServerResourceRecord -ZoneName corp.test -Name www).RecordData.IPv4Address')).toBe('10.9.9.9');
  });

  it('are removed from the scope alone, even when the zone holds the very same record', async () => {
    const { cmd } = await scoped();
    await cmd('Add-DnsServerResourceRecordA -ZoneName corp.test -Name same -IPv4Address 10.5.5.5');
    await cmd('Add-DnsServerResourceRecordA -ZoneName corp.test -Name same -IPv4Address 10.5.5.5 -ZoneScope ScopeA');
    expect(await cmd('Remove-DnsServerResourceRecord -ZoneName corp.test -Name same -RRType A -ZoneScope ScopeA -Force')).toBe('');
    expect(await cmd('(Get-DnsServerResourceRecord -ZoneName corp.test -ZoneScope ScopeA -Name same).Count')).toBe('0');
    expect(await cmd('(Get-DnsServerResourceRecord -ZoneName corp.test -Name same).RecordData.IPv4Address')).toBe('10.5.5.5');
  });

  it('are aged apart from the same record of the zone', async () => {
    const { cmd } = await scoped();
    await cmd('Add-DnsServerResourceRecordA -ZoneName corp.test -Name aged -IPv4Address 10.6.6.6 -AgeRecord');
    await cmd('Add-DnsServerResourceRecordA -ZoneName corp.test -Name aged -IPv4Address 10.6.6.6 -ZoneScope ScopeA');
    expect(await cmd('(Get-DnsServerResourceRecord -ZoneName corp.test -ZoneScope ScopeA -Name aged).Timestamp')).toBe('');
    expect(await cmd('(Get-DnsServerResourceRecord -ZoneName corp.test -Name aged).Timestamp')).not.toBe('');
    await cmd('Add-DnsServerResourceRecordA -ZoneName corp.test -Name aged -IPv4Address 10.6.6.6 -ZoneScope ScopeA -AgeRecord');
    expect(await cmd('(Get-DnsServerResourceRecord -ZoneName corp.test -ZoneScope ScopeA -Name aged).Timestamp')).not.toBe('');
    await cmd('Remove-DnsServerResourceRecord -ZoneName corp.test -Name aged -RRType A -ZoneScope ScopeA -Force');
    expect(await cmd('(Get-DnsServerResourceRecord -ZoneName corp.test -Name aged).Timestamp')).not.toBe('');
  });

  it('are scavenged with the zone, once the no-refresh and the refresh intervals are over, and the file of the scope follows', async () => {
    const { cmd, server } = await scoped();
    const day = 24 * 60 * 60 * 1000;
    await cmd('Set-DnsServerZoneAging -Name corp.test -Aging $true -NoRefreshInterval "1.00:00:00" -RefreshInterval "1.00:00:00"');
    await cmd('Add-DnsServerResourceRecordA -ZoneName corp.test -Name aged -IPv4Address 10.6.6.6 -ZoneScope ScopeA -AgeRecord');
    await cmd('Add-DnsServerResourceRecordA -ZoneName corp.test -Name kept -IPv4Address 10.6.6.7 -ZoneScope ScopeA');
    server.advanceTime(1.5 * day);
    await cmd('Start-DnsServerScavenging');
    expect(await cmd('(Get-DnsServerResourceRecord -ZoneName corp.test -ZoneScope ScopeA -Name aged).Count')).toBe('1');
    server.advanceTime(1 * day);
    await cmd('Start-DnsServerScavenging');
    expect(await cmd('(Get-DnsServerResourceRecord -ZoneName corp.test -ZoneScope ScopeA -Name aged).Count')).toBe('0');
    expect(await cmd('(Get-DnsServerResourceRecord -ZoneName corp.test -ZoneScope ScopeA -Name kept).Count')).toBe('1');
    expect(await cmd(`Get-Content ${SCOPE_FOLDER}\\ScopeA.dns`)).not.toContain('10.6.6.6');
    expect(await cmd('(Get-DnsServerResourceRecord -ZoneName corp.test -Name www).Count')).toBe('1');
  });

  it('hold a delegation with its glue, apart from the zone', async () => {
    const { cmd } = await scoped();
    expect(await cmd('Add-DnsServerZoneDelegation -Name corp.test -ChildZoneName sub -NameServer ns.sub.corp.test -IPAddress 10.5.5.5 -ZoneScope ScopeA')).toBe('');
    const shown = 'ForEach-Object { "$($_.ChildZoneName)|$($_.NameServer.RecordData.NameServer)|$($_.IPAddress.RecordData.IPv4Address)" }';
    expect(await cmd(`Get-DnsServerZoneDelegation -Name corp.test -ZoneScope ScopeA | ${shown}`)).toBe('sub.corp.test|ns.sub.corp.test|10.5.5.5');
    expect(await cmd('(Get-DnsServerZoneDelegation -Name corp.test).Count')).toBe('0');
    expect(await cmd('Remove-DnsServerZoneDelegation -Name corp.test -ChildZoneName sub -ZoneScope ScopeA -Force')).toBe('');
    expect(await cmd('(Get-DnsServerZoneDelegation -Name corp.test -ZoneScope ScopeA).Count')).toBe('0');
    expect(await cmd('(Get-DnsServerResourceRecord -ZoneName corp.test -ZoneScope ScopeA -Name ns.sub).Count')).toBe('0');
  });
});

describe('the file of a scope', () => {
  it('is <zone name>\\<scope name>.dns, written at once and at every change, and the zone file is not touched', async () => {
    const { cmd } = await scoped();
    const written = await cmd(`Get-Content ${SCOPE_FOLDER}\\ScopeA.dns`);
    expect(written).toContain('10.1.1.1');
    expect(written).not.toContain('10.2.2.2');
    expect(await cmd('Get-Content C:\\Windows\\System32\\dns\\corp.test.dns')).not.toContain('10.1.1.1');
    await cmd('Add-DnsServerResourceRecordA -ZoneName corp.test -Name later -IPv4Address 10.1.1.2 -ZoneScope ScopeA');
    expect(await cmd(`Get-Content ${SCOPE_FOLDER}\\ScopeA.dns`)).toContain('10.1.1.2');
    await cmd('Remove-DnsServerResourceRecord -ZoneName corp.test -Name later -RRType A -ZoneScope ScopeA -Force');
    expect(await cmd(`Get-Content ${SCOPE_FOLDER}\\ScopeA.dns`)).not.toContain('10.1.1.2');
  });

  it('survives the removal of the scope and comes back with -LoadExisting', async () => {
    const { cmd } = await scoped();
    await cmd(`${REMOVE} -ZoneName corp.test -Name ScopeA -Force`);
    expect(await cmd(`Test-Path ${SCOPE_FOLDER}\\ScopeA.dns`)).toBe('True');
    expect(tidy(await cmd(`${ADD} -ZoneName corp.test -Name ScopeA -LoadExisting -PassThru`))).toBe([
      '',
      'ZoneScope FileName',
      '--------- --------',
      'ScopeA    ScopeA.dns',
      '',
    ].join('\n'));
    expect(await cmd('(Get-DnsServerResourceRecord -ZoneName corp.test -ZoneScope ScopeA -Name www).RecordData.IPv4Address')).toBe('10.1.1.1');
  });

  it('starts empty when -LoadExisting is not given, and the file is overwritten at the first change', async () => {
    const { cmd } = await scoped();
    await cmd(`${REMOVE} -ZoneName corp.test -Name ScopeA -Force`);
    await cmd(`${ADD} -ZoneName corp.test -Name ScopeA`);
    expect(await cmd('(Get-DnsServerResourceRecord -ZoneName corp.test -ZoneScope ScopeA).Count')).toBe('0');
    expect(await cmd(`Get-Content ${SCOPE_FOLDER}\\ScopeA.dns`)).not.toContain('10.1.1.1');
  });

  it('is refused by -LoadExisting when there is none, and when it is not a zone file of the zone', async () => {
    const { cmd } = await governed();
    expect(await cmd(`${ADD} -ZoneName corp.test -Name Ghost -LoadExisting`)).toContain(`${ADD} : The zone file "corp.test\\Ghost.dns" does not exist in C:\\Windows\\System32\\dns.`);
    await cmd(`New-Item -ItemType Directory -Force -Path ${SCOPE_FOLDER} | Out-Null`);
    await cmd(`Set-Content -Path ${SCOPE_FOLDER}\\Alien.dns -Value "$ORIGIN other.test."`);
    expect(await cmd(`${ADD} -ZoneName corp.test -Name Alien -LoadExisting`)).toContain(`${ADD} : The zone file "corp.test\\Alien.dns"`);
    expect(await cmd(names(`${GET} -ZoneName corp.test`))).toBe('corp.test');
  });
});

describe('a zone level policy that ALLOWs', () => {
  it('answers a matching client from the scope it names and the others from the zone (geo-location split)', async () => {
    const { cmd, ask, clientA, clientC } = await scoped();
    await cmd(`${POLICY} -Name P -Action ALLOW -ClientSubnet "EQ,Lan" -ZoneScope "ScopeA,1" -ZoneName corp.test`);
    expect(addressesOf(await ask(clientA, 'www.corp.test'))).toEqual(['10.1.1.1']);
    expect(addressesOf(await ask(clientC, 'www.corp.test'))).toEqual(['10.9.9.9']);
  });

  it('(WITNESS) is built on a lab that answers a name of the zone to both client subnets', async () => {
    const { verdict, clientA, clientC } = await governed();
    expect(await verdict(clientA, 'web.corp.test')).toBe('answered');
    expect(await verdict(clientC, 'web.corp.test')).toBe('answered');
  });

  it('answers everyone from the zone while no policy names a scope', async () => {
    const { ask, clientA, clientC } = await scoped();
    expect(addressesOf(await ask(clientA, 'www.corp.test'))).toEqual(['10.9.9.9']);
    expect(addressesOf(await ask(clientC, 'www.corp.test'))).toEqual(['10.9.9.9']);
  });

  it('sends two subnets to two scopes at once', async () => {
    const { cmd, ask, clientA, clientC } = await scoped();
    await cmd(`${POLICY} -Name ForLan -Action ALLOW -ClientSubnet "EQ,Lan" -ZoneScope "ScopeA,1" -ZoneName corp.test`);
    await cmd(`${POLICY} -Name ForRemote -Action ALLOW -ClientSubnet "EQ,Remote" -ZoneScope "ScopeB,1" -ZoneName corp.test`);
    expect(addressesOf(await ask(clientA, 'www.corp.test'))).toEqual(['10.1.1.1']);
    expect(addressesOf(await ask(clientC, 'www.corp.test'))).toEqual(['10.2.2.2']);
  });

  it('answers NXDOMAIN when the scope does not hold the name, the zone answering the clients that it does not govern', async () => {
    const { cmd, verdict, clientA, clientC } = await scoped();
    await cmd(`${POLICY} -Name P -Action ALLOW -ClientSubnet "EQ,Lan" -ZoneScope "ScopeA,1" -ZoneName corp.test`);
    expect(await verdict(clientA, 'web.corp.test')).toBe('nxdomain');
    expect(await verdict(clientC, 'web.corp.test')).toBe('answered');
  });

  it('distributes the matches over the scopes in the ratio of the weights, then starts again', async () => {
    const { cmd, ask, clientA } = await scoped();
    await cmd(`${POLICY} -Name P -Action ALLOW -ClientSubnet "EQ,Lan" -ZoneScope "ScopeA,2;ScopeB,1" -ZoneName corp.test`);
    const served: string[] = [];
    for (let index = 0; index < 6; index++) served.push(...addressesOf(await ask(clientA, 'www.corp.test')));
    expect(served).toEqual(['10.1.1.1', '10.1.1.1', '10.2.2.2', '10.1.1.1', '10.1.1.1', '10.2.2.2']);
  });

  it('counts the zone itself in the ratio when the policy names it', async () => {
    const { cmd, ask, clientA } = await scoped();
    await cmd(`${POLICY} -Name P -Action ALLOW -ClientSubnet "EQ,Lan" -ZoneScope "corp.test,1;ScopeA,1" -ZoneName corp.test`);
    const served: string[] = [];
    for (let index = 0; index < 4; index++) served.push(...addressesOf(await ask(clientA, 'www.corp.test')));
    expect(served).toEqual(['10.9.9.9', '10.1.1.1', '10.9.9.9', '10.1.1.1']);
  });

  it('refuses a scope that is not in the zone (9959) and accepts it once it is', async () => {
    const { cmd } = await governed();
    expect(await cmd(`${POLICY} -Name P -Action ALLOW -ClientSubnet "EQ,Lan" -ZoneScope "ScopeA,1" -ZoneName corp.test`)).toContain(`${POLICY} : ${MISSING}`);
    await cmd(`${ADD} -ZoneName corp.test -Name ScopeA`);
    expect(await cmd(`${POLICY} -Name P -Action ALLOW -ClientSubnet "EQ,Lan" -ZoneScope "ScopeA,1" -ZoneName corp.test`)).toBe('');
  });

  it('stops answering from the scope when it is disabled, and starts again when it is enabled', async () => {
    const { cmd, ask, clientA } = await scoped();
    await cmd(`${POLICY} -Name P -Action ALLOW -ClientSubnet "EQ,Lan" -ZoneScope "ScopeA,1" -ZoneName corp.test`);
    await cmd('Disable-DnsServerPolicy -Level Zone -Name P -ZoneName corp.test -Force');
    expect(addressesOf(await ask(clientA, 'www.corp.test'))).toEqual(['10.9.9.9']);
    await cmd('Enable-DnsServerPolicy -Level Zone -Name P -ZoneName corp.test -Force');
    expect(addressesOf(await ask(clientA, 'www.corp.test'))).toEqual(['10.1.1.1']);
  });

  it('answers over TCP from the scope as well', async () => {
    const { cmd, askOverTcp } = await scoped();
    await cmd(`${POLICY} -Name P -Action ALLOW -ClientSubnet "EQ,Lan" -ZoneScope "ScopeA,1" -ZoneName corp.test`);
    expect(addressesOf(await askOverTcp('www.corp.test'))).toEqual(['10.1.1.1']);
  });

  it('follows the records of the scope as they change', async () => {
    const { cmd, ask, clientA } = await scoped();
    await cmd(`${POLICY} -Name P -Action ALLOW -ClientSubnet "EQ,Lan" -ZoneScope "ScopeA,1" -ZoneName corp.test`);
    await cmd('Add-DnsServerResourceRecordA -ZoneName corp.test -Name www -IPv4Address 10.1.1.2 -ZoneScope ScopeA');
    expect(addressesOf(await ask(clientA, 'www.corp.test')).sort()).toEqual(['10.1.1.1', '10.1.1.2']);
    await cmd('Remove-DnsServerResourceRecord -ZoneName corp.test -Name www -RRType A -ZoneScope ScopeA -Force');
    expect((await ask(clientA, 'www.corp.test'))?.answers).toEqual([]);
  });

  it('carries the SOA of the zone, as it is when the answer is given, in a negative answer from a scope', async () => {
    const { cmd, ask, clientA } = await scoped();
    await cmd(`${POLICY} -Name P -Action ALLOW -ClientSubnet "EQ,Lan" -ZoneScope "ScopeA,1" -ZoneName corp.test`);
    expect(addressesOf(await ask(clientA, 'www.corp.test'))).toEqual(['10.1.1.1']);
    const serialAnswered = async (): Promise<number> => {
      const reply = await ask(clientA, 'absent.corp.test');
      return (reply?.authorities.find(record => record.data.type === RRType.SOA)?.data as SoaRecordData).serial;
    };
    const before = await serialAnswered();
    await cmd('Add-DnsServerResourceRecordA -ZoneName corp.test -Name bump -IPv4Address 10.8.8.8');
    expect(await serialAnswered()).toBe(before + 1);
    expect(String(await serialAnswered())).toBe(await cmd('(Get-DnsServerResourceRecord -ZoneName corp.test -RRType SOA).RecordData.SerialNumber'));
  });

  it('(CONTROL) loses to a server level DENY, which is decided first', async () => {
    const { cmd, verdict, clientA, clientC } = await scoped();
    await cmd(`${POLICY} -Name P -Action ALLOW -ClientSubnet "EQ,Lan" -ZoneScope "ScopeA,1" -ZoneName corp.test`);
    await cmd(`${POLICY} -Name Block -Action DENY -ClientSubnet "EQ,Lan"`);
    expect(await verdict(clientA, 'www.corp.test')).toBe('refused');
    expect(await verdict(clientC, 'www.corp.test')).toBe('answered');
  });

  it('(CONTROL) leaves a zone level DENY to refuse, as before', async () => {
    const { cmd, verdict, clientA, clientC } = await scoped();
    await cmd(`${POLICY} -Name Block -Action DENY -ClientSubnet "EQ,Lan" -ZoneName corp.test`);
    expect(await verdict(clientA, 'www.corp.test')).toBe('refused');
    expect(await verdict(clientC, 'www.corp.test')).toBe('answered');
  });
});

describe('the zone transfer', () => {
  it('(CONTROL) carries the default scope alone', async () => {
    const { cmd, master } = await scoped();
    await cmd('Set-DnsServerPrimaryZone -Name corp.test -SecureSecondaries TransferAnyServer');
    await run(master, 'Add-DnsServerSecondaryZone -Name corp.test -ZoneFile corp.test.dns -MasterServers 10.0.1.10');
    await run(master, 'Start-DnsServerZoneTransfer -Name corp.test');
    const listing = 'Get-DnsServerResourceRecord -ZoneName corp.test -Name www';
    let carried = await run(master, `(${listing}).Count`);
    for (let attempt = 0; attempt < 40 && carried === '0'; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 50));
      carried = await run(master, `(${listing}).Count`);
    }
    expect(carried).toBe('1');
    expect(await run(master, `(${listing}).RecordData.IPv4Address`)).toBe('10.9.9.9');
  }, 30000);
});
