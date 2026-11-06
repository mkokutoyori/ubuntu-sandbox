/*
 * Probe — Add-/Get-/Set-/Remove-DnsServerZoneTransferPolicy exist and the policies really decide the zone transfers: a transfer query
 * (AXFR or IXFR) that meets the criteria of a server level policy, or of a policy of its zone, is refused (DENY) or dropped (IGNORE),
 * a query that meets none is decided by the zone's own transfer setting as before. The examples of the Learn pages are the
 * transcripts, a Windows server holding corp.test and clients on two client subnets (and a second Windows server that pulls the zone
 * as a secondary) are the lab.
 *
 * Measured first: none of the four cmdlets existed ("is not recognized"), and a transfer query was decided by the zone's setting
 * alone, whatever the client subnet, the interface it came in on, the transport or the time of day.
 *
 * Authority: the Learn pages of the four cmdlets (parameters and positions, the criteria ClientSubnet, InternetProtocol,
 * ServerInterfaceIP, TimeOfDay and TransportProtocol, the actions DENY and IGNORE, "server level policies apply on every zone transfer
 * query that occurs on the DNS server", "zone level policies apply only on the queries on a zone hosted on the DNS server", "if you
 * remove a zone, that removal deletes the associated zone level policies", the object printed with AppliesOn ZoneTransfer), [MS-DNSP]
 * 3.1.8.3 (a zone transfer policy takes DENY or IGNORE, never ALLOW), CreatePolicy (a name is unique at its level, 9971, whatever the
 * type of the policies that hold it) and the policy evaluation of the policy page (a DENY answers
 * REFUSED, an IGNORE drops the query, the first policy in the order of precedence that matches decides). Not sourced, said here: that
 * the policies are evaluated before the zone's own transfer setting (they only restrict, so the outcome is the same, only the answer to
 * a transfer that both would stop differs), that a policy that denies counts as a refusal for security reasons in the master
 * statistics, and that the criteria a query policy takes and a zone transfer policy does not (-Fqdn, -QType) are refused by the
 * parameter binder, as the real cmdlet does.
 *
 * Discrimination (the probe run on the tree before the change): 32 of 35 cases fall, the ones that need the cmdlets and the ones that
 * need a policy to decide. The three that pass on both sides are the WITNESSes: the lab transfers to any client when the zone allows
 * it, refuses a client the zone does not name, and a secondary pulls the zone from it, as it always did.
 */
import { describe, it, expect } from 'vitest';
import { IPAddress } from '@/network/core/types';
import { RRType } from '@/network/dns/wire/RRType';
import { DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import { queryDnsOverTcp } from '@/network/dns/transport/DnsTcpTransport';
import type { LinuxPC } from '@/network/devices/LinuxPC';
import { policyLab as governed, question, run, SERVER } from './dnsRateLimitingLab';

const ADD = 'Add-DnsServerZoneTransferPolicy';
const GET = 'Get-DnsServerZoneTransferPolicy';
const SET = 'Set-DnsServerZoneTransferPolicy';
const REMOVE = 'Remove-DnsServerZoneTransferPolicy';

const MISSING = 'No policy with this name exists on this level (server level or zone level) on the DNS server.';
const EXISTS = 'A policy with the same name already exists on this level (server level or zone level) on the DNS server.';
const NOT_ALLOWED = 'At least one of the settings of this policy is invalid.';
const NO_CRITERIA = 'The policy is missing criteria.';
const NON_INTERACTIVE = 'PowerShell is in NonInteractive mode.';

const tidy = (text: string): string => text.split('\n').map(line => line.trimEnd()).join('\n');

type Outcome = 'transferred' | 'refused' | 'dropped';

const outcomeOf = (reply: DnsMessage | null): Outcome =>
  reply === null ? 'dropped' : reply.flags.rcode === DnsRcode.REFUSED ? 'refused' : 'transferred';

const transfer = async (from: LinuxPC, zone = 'corp.test', type: number = RRType.AXFR): Promise<Outcome> =>
  outcomeOf(await queryDnsOverTcp(from, new IPAddress(SERVER), question(zone, type), 53, 1500));

async function transferring() {
  const context = await governed();
  await context.cmd('Set-DnsServerPrimaryZone -Name corp.test -SecureSecondaries TransferAnyServer');
  return context;
}

describe('the cmdlets of the examples', () => {
  it('create the server level policy of example 1 and print it (-ClientSubnet "ne,AllowedSubnet")', async () => {
    const { cmd } = await governed();
    await cmd('Add-DnsServerClientSubnet -Name "AllowedSubnet" -IPv4Subnet 172.21.33.0/24');
    expect(await cmd(`${ADD} -Name "NorthAmericaPolicy" -Action IGNORE -ClientSubnet "ne,AllowedSubnet" -PassThru | ForEach-Object { "$($_.Action)|$($_.AppliesOn)|$($_.Condition)|$($_.IsEnabled)|$($_.Level)|$($_.Name)|$($_.ProcessingOrder)|[$($_.ZoneName)]|$($_.Criteria.Count)|$($_.Criteria.CriteriaType)|$($_.Criteria.Criteria)" }`))
      .toBe('Ignore|ZoneTransfer|And|True|Server|NorthAmericaPolicy|1|[]|1|ClientSubnet|NE,AllowedSubnet');
  });

  it('create the policy of example 2 and print it as the table of the page (-ServerInterfaceIP "ne,10.0.0.33")', async () => {
    const { cmd } = await governed();
    expect(tidy(await cmd(`${ADD} -Name "InternalTransfers" -Action IGNORE -ServerInterfaceIP "ne,10.0.0.33" -PassThru`))).toBe([
      '',
      'Name              ProcessingOrder IsEnabled Action',
      '----              --------------- --------- ------',
      'InternalTransfers               1 True      Ignore',
      '',
    ].join('\n'));
  });

  it('create the zone level policy of example 3 (-ZoneName)', async () => {
    const { cmd } = await governed();
    expect(await cmd(`${ADD} -Name "InternalTransfers" -Action IGNORE -ServerInterfaceIP "ne,10.0.0.33" -PassThru -ZoneName "corp.test" | ForEach-Object { "$($_.Action)|$($_.AppliesOn)|$($_.Level)|$($_.Name)|$($_.ProcessingOrder)|$($_.ZoneName)" }`))
      .toBe('Ignore|ZoneTransfer|Zone|InternalTransfers|1|corp.test');
  });

  it('refuse a zone that is not on the server', async () => {
    const { cmd } = await governed();
    expect(await cmd(`${ADD} -Name P -Action DENY -ClientSubnet "EQ,Lan" -ZoneName nope.test`)).toContain(`${ADD}: Zone "nope.test" does not exist on this server.`);
  });

  it('get the policies of the server, those of a zone and one policy by name, whatever its case', async () => {
    const { cmd } = await governed();
    await cmd(`${ADD} -Name Server1 -Action DENY -ClientSubnet "EQ,Lan"`);
    await cmd(`${ADD} -Name Server2 -Action IGNORE -ClientSubnet "EQ,Remote"`);
    await cmd(`${ADD} -Name Zone1 -Action DENY -ClientSubnet "EQ,Lan" -ZoneName corp.test`);
    expect(await cmd(`(${GET}).Name -join ","`)).toBe('Server1,Server2');
    expect(await cmd(`(${GET} -ZoneName corp.test).Name -join ","`)).toBe('Zone1');
    expect(await cmd(`(${GET} server2).Action`)).toBe('Ignore');
    expect(await cmd(`(${GET} Zone1 corp.test).Level`)).toBe('Zone');
    expect(await cmd(`${GET} -Name Nope`)).toContain(`${GET}: ${MISSING}`);
    expect(await cmd(`${GET} -ZoneName nope.test`)).toContain(`${GET}: Zone "nope.test" does not exist on this server.`);
  });

  it('share the names of their level with the query resolution policies: a name that is taken is refused whatever the family (9971)', async () => {
    const { cmd } = await governed();
    await cmd('Add-DnsServerQueryResolutionPolicy -Name Same -Action DENY -ClientSubnet "EQ,Lan"');
    expect(await cmd(`${ADD} -Name same -Action DENY -ClientSubnet "EQ,Lan"`)).toContain(`${ADD}: ${EXISTS}`);
    expect(await cmd(`${ADD} -Name Same -Action DENY -ClientSubnet "EQ,Lan" -ZoneName corp.test`)).toBe('');
    expect(await cmd('(Get-DnsServerQueryResolutionPolicy).Name -join ","')).toBe('Same');
    expect(await cmd(`(${GET}).Count`)).toBe('0');
  });

  it('read the zone of a policy by position, and take an empty zone name for the server level', async () => {
    const { cmd } = await governed();
    await cmd(`${ADD} -Name Server1 -Action DENY -ClientSubnet "EQ,Lan"`);
    await cmd(`${ADD} -Name Z -Action DENY -ClientSubnet "EQ,Lan" -ZoneName corp.test`);
    expect(await cmd(`(${GET} -ZoneName "").Name -join ","`)).toBe('Server1');
    expect(await cmd(`${ADD} -Name Empty -Action DENY -ClientSubnet "EQ,Lan" -ZoneName ""`)).toBe('');
    expect(await cmd(`(${GET}).Name -join ","`)).toBe('Server1,Empty');
    expect(await cmd(`${REMOVE} -Name Empty -ZoneName "" -Force`)).toBe('');
    expect(await cmd(`${REMOVE} Z corp.test -Force`)).toBe('');
    expect(await cmd(`(${GET} -ZoneName corp.test).Count`)).toBe('0');
    expect(await cmd(`(${GET}).Name -join ","`)).toBe('Server1');
  });

  it('keep their own list: a query resolution policy is not a zone transfer policy', async () => {
    const { cmd } = await governed();
    await cmd(`${ADD} -Name T -Action DENY -ClientSubnet "EQ,Lan"`);
    await cmd('Add-DnsServerQueryResolutionPolicy -Name Q -Action DENY -ClientSubnet "EQ,Remote"');
    expect(await cmd(`(${GET}).Name -join ","`)).toBe('T');
    expect(await cmd('(Get-DnsServerQueryResolutionPolicy).Name -join ","')).toBe('Q');
  });

  it('order the policies of a level, a new one last, an order that exists shifting the others', async () => {
    const { cmd } = await governed();
    await cmd(`${ADD} -Name A -Action DENY -ClientSubnet "EQ,Lan"`);
    await cmd(`${ADD} -Name B -Action DENY -ClientSubnet "EQ,Lan"`);
    await cmd(`${ADD} -Name C -Action DENY -ClientSubnet "EQ,Lan" -ProcessingOrder 1`);
    expect(await cmd(`(${GET} | Sort-Object ProcessingOrder).Name -join ","`)).toBe('C,A,B');
  });

  it('create a policy that is disabled with -Disable, and read the condition', async () => {
    const { cmd } = await governed();
    await cmd(`${ADD} -Name P -Action DENY -Condition OR -ClientSubnet "EQ,Lan" -TransportProtocol "EQ,TCP" -Disable`);
    expect(await cmd(`(${GET} P).IsEnabled`)).toBe('False');
    expect(await cmd(`(${GET} P).Condition`)).toBe('Or');
    expect(await cmd(`(${GET} P).Criteria.CriteriaType -join ","`)).toBe('ClientSubnet,TransportProtocol');
  });

  it('bind the positions of the page: name, action, condition, then the zone after the name when four are given', async () => {
    const { cmd } = await governed();
    expect(await cmd(`${ADD} Positional IGNORE OR -ClientSubnet "EQ,Lan"`)).toBe('');
    expect(await cmd(`(${GET} Positional).Action`)).toBe('Ignore');
    expect(await cmd(`(${GET} Positional).Condition`)).toBe('Or');
    expect(await cmd(`${ADD} InZone corp.test DENY AND -ClientSubnet "EQ,Lan"`)).toBe('');
    expect(await cmd(`(${GET} -ZoneName corp.test InZone).Action`)).toBe('Deny');
  });

  it('refuse what a zone transfer policy cannot be: an ALLOW, a policy with no criterion, a name that is taken, the criteria of a query policy', async () => {
    const { cmd } = await governed();
    expect(await cmd(`${ADD} -Name P -Action ALLOW -ClientSubnet "EQ,Lan"`)).toContain(`${ADD}: ${NOT_ALLOWED}`);
    expect(await cmd(`${ADD} -Name P -Action DENY`)).toContain(`${ADD}: ${NO_CRITERIA}`);
    await cmd(`${ADD} -Name P -Action DENY -ClientSubnet "EQ,Lan"`);
    expect(await cmd(`${ADD} -Name p -Action DENY -ClientSubnet "EQ,Lan"`)).toContain(`${ADD}: ${EXISTS}`);
    expect(await cmd(`${ADD} -Name Q -Action DENY -Fqdn "EQ,*.corp.test"`)).toContain("A parameter cannot be found that matches parameter name 'Fqdn'.");
    expect(await cmd(`${ADD} -Name Q -Action DENY -QType "EQ,AXFR"`)).toContain("A parameter cannot be found that matches parameter name 'QType'.");
    expect(await cmd(`(${GET}).Name -join ","`)).toBe('P');
  });

  it('ask for the name that is missing and refuse the parameters of a query policy on every cmdlet', async () => {
    const { cmd } = await governed();
    expect(await cmd(`${ADD} -Action DENY -ClientSubnet "EQ,Lan"`)).toContain(`${ADD}: Cannot process command because of one or more missing mandatory parameters: Name.`);
    expect(await cmd(`${SET} -ClientSubnet "EQ,Lan"`)).toContain(`${SET}: Cannot process command because of one or more missing mandatory parameters: Name.`);
    expect(await cmd(`${REMOVE} -Force`)).toContain(`${REMOVE}: Cannot process command because of one or more missing mandatory parameters: Name.`);
    expect(await cmd(`${GET} -Fqdn "EQ,x"`)).toContain("A parameter cannot be found that matches parameter name 'Fqdn'.");
    expect(await cmd(`${REMOVE} -Name P -QType "EQ,A" -Force`)).toContain("A parameter cannot be found that matches parameter name 'QType'.");
    expect(await cmd(`${ADD} -Name P -Action DENY -ClientSubnet "EQ,Lan" -ApplyOnRecursion`)).toContain("A parameter cannot be found that matches parameter name 'ApplyOnRecursion'.");
  });

  it('set the condition, the order and the criteria of a policy, whatever the level', async () => {
    const { cmd } = await governed();
    await cmd(`${ADD} -Name A -Action DENY -ClientSubnet "EQ,Lan"`);
    await cmd(`${ADD} -Name B -Action DENY -ClientSubnet "EQ,Lan"`);
    expect(await cmd(`${SET} -Name B -ProcessingOrder 1 -Condition OR -ClientSubnet "EQ,Remote" -PassThru | ForEach-Object { "$($_.Name)|$($_.ProcessingOrder)|$($_.Condition)|$($_.Criteria.Criteria)" }`)).toBe('B|1|Or|EQ,Remote');
    expect(await cmd(`(${GET} | Sort-Object ProcessingOrder).Name -join ","`)).toBe('B,A');
    await cmd(`${ADD} -Name Z -Action DENY -ClientSubnet "EQ,Lan" -ZoneName corp.test`);
    expect(await cmd(`${SET} Z corp.test -TransportProtocol "EQ,TCP" -PassThru | ForEach-Object { $_.Criteria.CriteriaType -join "," }`)).toBe('ClientSubnet,TransportProtocol');
    expect(await cmd(`${SET} -Name Nope -ClientSubnet "EQ,Lan"`)).toContain(`${SET}: ${MISSING}`);
    expect(await cmd(`${SET} -Name A -Fqdn "EQ,x"`)).toContain("A parameter cannot be found that matches parameter name 'Fqdn'.");
  });

  it('remove a policy, asking before unless -Force, and print it under -PassThru', async () => {
    const { cmd } = await governed();
    await cmd(`${ADD} -Name P -Action DENY -ClientSubnet "EQ,Lan"`);
    expect(await cmd(`${REMOVE} -Name P`)).toContain(`${REMOVE}: ${NON_INTERACTIVE}`);
    expect(await cmd(`${REMOVE} -Name P -WhatIf`)).toContain(`What if: Performing the operation "${REMOVE}" on target "P".`);
    expect(await cmd(`(${GET}).Name -join ","`)).toBe('P');
    expect(await cmd(`${REMOVE} -Name p -Force -PassThru | ForEach-Object { $_.Name }`)).toBe('P');
    expect(await cmd(`${GET}`)).toBe('');
    expect(await cmd(`${REMOVE} -Name P -Force`)).toContain(`${REMOVE}: ${MISSING}`);
  });

  it('go with the zone: a zone that comes back has none of the policies of the zone that went', async () => {
    const { cmd } = await governed();
    await cmd(`${ADD} -Name Z -Action DENY -ClientSubnet "EQ,Lan" -ZoneName corp.test`);
    await cmd('Remove-DnsServerZone -Name corp.test -Force');
    await cmd('Add-DnsServerPrimaryZone -Name corp.test');
    expect(await cmd(`(${GET} -ZoneName corp.test).Count`)).toBe('0');
  });

  it('are enabled and disabled by Enable-DnsServerPolicy and Disable-DnsServerPolicy like the other policies', async () => {
    const { cmd } = await governed();
    await cmd(`${ADD} -Name P -Action DENY -ClientSubnet "EQ,Lan"`);
    await cmd('Disable-DnsServerPolicy -Level Server -Name P -Force');
    expect(await cmd(`(${GET} P).IsEnabled`)).toBe('False');
    await cmd('Enable-DnsServerPolicy -Level Server -Name P -Force');
    expect(await cmd(`(${GET} P).IsEnabled`)).toBe('True');
  });
});

describe('a zone transfer', () => {
  it('(WITNESS) is made to any client when the zone allows it and no policy says otherwise', async () => {
    const { clientA, clientC } = await transferring();
    expect(await transfer(clientA)).toBe('transferred');
    expect(await transfer(clientC)).toBe('transferred');
  });

  it('(WITNESS) is refused by default to a client the zone does not name', async () => {
    const { clientA } = await governed();
    expect(await transfer(clientA)).toBe('refused');
  });

  it('is refused (REFUSED) to the clients a DENY policy names, and to those alone', async () => {
    const { cmd, clientA, clientC } = await transferring();
    await cmd(`${ADD} -Name Block -Action DENY -ClientSubnet "EQ,Lan"`);
    expect(await transfer(clientA)).toBe('refused');
    expect(await transfer(clientC)).toBe('transferred');
  });

  it('is dropped, with no answer, for the clients an IGNORE policy names', async () => {
    const { cmd, clientA, clientC } = await transferring();
    await cmd(`${ADD} -Name Quiet -Action IGNORE -ClientSubnet "EQ,Lan"`);
    expect(await transfer(clientA)).toBe('dropped');
    expect(await transfer(clientC)).toBe('transferred');
  });

  it('is governed through the exception of example 1: refused to every client that is not in the subnet', async () => {
    const { cmd, clientA, clientC } = await transferring();
    await cmd(`${ADD} -Name OnlyLan -Action DENY -ClientSubnet "NE,Lan"`);
    expect(await transfer(clientA)).toBe('transferred');
    expect(await transfer(clientC)).toBe('refused');
  });

  it('is decided by a policy of the zone for that zone alone', async () => {
    const { cmd, clientA } = await transferring();
    await cmd('Add-DnsServerPrimaryZone -Name other.test');
    await cmd('Set-DnsServerPrimaryZone -Name other.test -SecureSecondaries TransferAnyServer');
    await cmd(`${ADD} -Name Block -Action DENY -ClientSubnet "EQ,Lan" -ZoneName corp.test`);
    expect(await transfer(clientA, 'corp.test')).toBe('refused');
    expect(await transfer(clientA, 'other.test')).toBe('transferred');
  });

  it('is decided by an IXFR query as by an AXFR query', async () => {
    const { cmd, clientA, clientC } = await transferring();
    await cmd(`${ADD} -Name Block -Action DENY -ClientSubnet "EQ,Lan"`);
    expect(await transfer(clientA, 'corp.test', RRType.IXFR)).toBe('refused');
    expect(await transfer(clientC, 'corp.test', RRType.IXFR)).toBe('transferred');
  });

  it('meets the server interface criterion on the address the query came in on', async () => {
    const { cmd, clientA } = await transferring();
    await cmd(`${ADD} -Name OtherInterface -Action DENY -ServerInterfaceIP "EQ,10.0.9.9"`);
    expect(await transfer(clientA)).toBe('transferred');
    await cmd(`${ADD} -Name ThisInterface -Action DENY -ServerInterfaceIP "EQ,${SERVER}"`);
    expect(await transfer(clientA)).toBe('refused');
  });

  it('meets the time of day criterion on the minute of the query', async () => {
    const { cmd, clientA } = await transferring();
    await cmd(`${ADD} -Name Never -Action DENY -TimeOfDay "NE,00:00-23:59"`);
    expect(await transfer(clientA)).toBe('transferred');
    await cmd(`${ADD} -Name Always -Action DENY -TimeOfDay "EQ,00:00-23:59"`);
    expect(await transfer(clientA)).toBe('refused');
  });

  it('is decided for a UDP query as for a TCP one: an IGNORE policy drops what would have been refused', async () => {
    const { cmd, ask, clientA } = await transferring();
    expect(outcomeOf(await ask(clientA, 'corp.test', RRType.AXFR))).toBe('refused');
    await cmd(`${ADD} -Name QuietDatagrams -Action IGNORE -TransportProtocol "EQ,UDP"`);
    expect(outcomeOf(await ask(clientA, 'corp.test', RRType.AXFR))).toBe('dropped');
    expect(await transfer(clientA)).toBe('transferred');
  });

  it('meets the transport criterion on the transport of the query', async () => {
    const { cmd, clientA } = await transferring();
    await cmd(`${ADD} -Name Datagrams -Action DENY -TransportProtocol "EQ,UDP"`);
    expect(await transfer(clientA)).toBe('transferred');
    await cmd(`${ADD} -Name Streams -Action DENY -TransportProtocol "EQ,TCP"`);
    expect(await transfer(clientA)).toBe('refused');
  });

  it('meets the Internet protocol criterion on the family of the client', async () => {
    const { cmd, clientA } = await transferring();
    await cmd(`${ADD} -Name SixOnly -Action DENY -InternetProtocol "EQ,IPv6"`);
    expect(await transfer(clientA)).toBe('transferred');
    await cmd(`${ADD} -Name FourToo -Action DENY -InternetProtocol "EQ,IPv4"`);
    expect(await transfer(clientA)).toBe('refused');
  });

  it('follows the order of precedence: the first policy that matches decides, and moving it changes the answer', async () => {
    const { cmd, clientA } = await transferring();
    await cmd(`${ADD} -Name Quiet -Action IGNORE -ClientSubnet "EQ,Lan"`);
    await cmd(`${ADD} -Name Block -Action DENY -ClientSubnet "EQ,Lan"`);
    expect(await transfer(clientA)).toBe('dropped');
    await cmd(`${SET} -Name Block -ProcessingOrder 1`);
    expect(await transfer(clientA)).toBe('refused');
  });

  it('is not governed by a policy that is disabled, and is again once it is enabled', async () => {
    const { cmd, clientA } = await transferring();
    await cmd(`${ADD} -Name Block -Action DENY -ClientSubnet "EQ,Lan" -Disable`);
    expect(await transfer(clientA)).toBe('transferred');
    await cmd('Enable-DnsServerPolicy -Level Server -Name Block -Force');
    expect(await transfer(clientA)).toBe('refused');
    await cmd(`${REMOVE} -Name Block -Force`);
    expect(await transfer(clientA)).toBe('transferred');
  });

  it('is not governed by the policy of a query: the policies of the two families stay apart', async () => {
    const { cmd, verdict, clientA } = await transferring();
    await cmd('Add-DnsServerQueryResolutionPolicy -Name QueryBlock -Action DENY -ClientSubnet "EQ,Lan"');
    expect(await transfer(clientA)).toBe('transferred');
    expect(await verdict(clientA, 'web.corp.test')).toBe('refused');
    await cmd('Remove-DnsServerQueryResolutionPolicy -Name QueryBlock -Force');
    await cmd(`${ADD} -Name TransferBlock -Action DENY -ClientSubnet "EQ,Lan"`);
    expect(await verdict(clientA, 'web.corp.test')).toBe('answered');
    expect(await transfer(clientA)).toBe('refused');
  });

  it('is counted as a request and as a refusal in the master statistics when a policy denies it, and as a request alone when one ignores it', async () => {
    const { cmd, clientA } = await transferring();
    const count = (member: string) => cmd(`(Get-DnsServerStatistics).MasterStatistics.${member}`);
    await cmd(`${ADD} -Name Quiet -Action IGNORE -ClientSubnet "EQ,Lan"`);
    await transfer(clientA);
    expect([await count('AxfrRequest'), await count('Refused'), await count('RefuseSecurity')]).toEqual(['1', '0', '0']);
    await cmd(`${REMOVE} -Name Quiet -Force`);
    await cmd(`${ADD} -Name Block -Action DENY -ClientSubnet "EQ,Lan"`);
    await transfer(clientA);
    expect([await count('AxfrRequest'), await count('Refused'), await count('RefuseSecurity')]).toEqual(['2', '1', '1']);
  });
});

describe('a secondary that pulls the zone', () => {
  const pull = async (cmd: (line: string) => Promise<string>, master: Parameters<typeof run>[0]): Promise<string> => {
    await run(master, 'Add-DnsServerSecondaryZone -Name corp.test -ZoneFile corp.test.dns -MasterServers 10.0.1.10');
    await run(master, 'Start-DnsServerZoneTransfer -Name corp.test');
    const listing = 'Get-DnsServerResourceRecord -ZoneName corp.test -Name web';
    const carriedNow = async (): Promise<string> => {
      const text = await run(master, `(${listing}).Count`);
      return /^\d+$/.test(text) ? text : '0';
    };
    let carried = await carriedNow();
    for (let attempt = 0; attempt < 30 && carried === '0'; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 50));
      carried = await carriedNow();
    }
    return carried;
  };

  it('(WITNESS) gets the zone when the master allows it and no policy says otherwise', async () => {
    const { cmd, master } = await transferring();
    expect(await pull(cmd, master)).toBe('1');
  }, 30000);

  it('does not get the zone from a master whose policy denies its subnet', async () => {
    const { cmd, master } = await transferring();
    await cmd(`${ADD} -Name Block -Action DENY -ClientSubnet "EQ,Lan"`);
    expect(await pull(cmd, master)).toBe('0');
  }, 30000);
});
