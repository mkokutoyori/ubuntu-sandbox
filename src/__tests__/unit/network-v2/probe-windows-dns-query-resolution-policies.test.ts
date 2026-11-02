/*
 * Probe — Add-/Get-/Set-/Remove-DnsServerQueryResolutionPolicy and Enable-/Disable-DnsServerPolicy exist, and the policies really
 * govern the queries a Windows DNS server receives: DENY answers REFUSED, IGNORE answers nothing (over a datagram and over a
 * stream), by the name asked, the type asked, the client subnet record the requestor belongs to, the transport, the server
 * interface that received the query and the time of day on the clock of the server in its time zone; the criteria combine under
 * AND (the default) or OR; the first enabled policy in processing order that holds decides, the processing order is kept per
 * type, a disabled policy decides nothing; a zone-level policy governs the names of its zone after the server-level ones and an
 * ALLOW ends the search; a recursion policy decides for the names the server would resolve through its forwarder and not for
 * the ones its cache holds. The statistics agree with what the clients saw: a refusal is a Refused response, an ignored query is
 * received and never answered. The refusals carry the text of the Win32 errors of [MS-DNSP].
 *
 * Measured first (a Windows DNS server holding corp.test, three UDP clients): none of the six cmdlets existed ("is not
 * recognized"), and every query was answered whatever the intent of a policy.
 *
 * Authority: the Learn pages of the six cmdlets (parameter sets and their positions, the EQ/NE grammar with ";" between the
 * groups, the examples 4 to 6 of Add and 1 of Set and the objects they print, the optional name of Enable and Disable) and of
 * the class DnsServerPolicy (the nine members), [MS-DNSP] 3.1.4.1 and 3.1.8.2 to 3.1.8.3 (CreatePolicy, UpdatePolicy,
 * DeletePolicy, the criteria and the table that says which level, type and action go together, the processing order kept
 * contiguous per level and type) and the Win32 error table (9959, 9971, 9972, 9974, 9981, 9990 to 9996 and their texts). Not
 * sourced, said here: that DENY answers REFUSED (the page contradicts itself, SERV_FAIL in the parameter text and REFUSED in
 * the description of the policy types, three times; REFUSED is what a client sees and what the page narrates), that IGNORE
 * over a stream sends nothing and leaves the connection open, that a time of day holds at both ends to the minute, that a
 * start after the end is invalid (9996), that ";" and "," both separate the values of a criterion, that a recursion policy is
 * not applied to an answer found in the cache, that a policy is seen only by the cmdlets of its own type while its name is
 * taken across types, that a missing -Action is a policy with invalid settings, that the processing order of a piped policy is
 * not copied (the page of example 3 says the order of the pipeline keeps the order of processing), that a name given on the
 * command line wins over the policy that is piped, and that Remove asks its confirmation before it looks for the policy.
 *
 * Discrimination (the probe run on the tree before the change): 75 of 78 cases fall. The three that pass either way are the
 * WITNESSES "answers every query while no policy exists", "answers the clients over a stream while no policy exists" and
 * "resolve through the forwarder while no policy exists": the lab answers and resolves, so every refusal and every silence
 * below comes from a policy.
 */
import { describe, it, expect } from 'vitest';
import { RRType } from '@/network/dns/wire/RRType';
import type { LinuxPC } from '@/network/devices/LinuxPC';
import { lab, run, verdictOf, virtualClock, type Verdict } from './dnsRateLimitingLab';

virtualClock();

const ADD = 'Add-DnsServerQueryResolutionPolicy';
const GET = 'Get-DnsServerQueryResolutionPolicy';
const SET = 'Set-DnsServerQueryResolutionPolicy';
const REMOVE = 'Remove-DnsServerQueryResolutionPolicy';
const ENABLE = 'Enable-DnsServerPolicy';
const DISABLE = 'Disable-DnsServerPolicy';

const EXISTS = 'A policy with the same name already exists on this level (server level or zone level) on the DNS server.';
const MISSING = 'No policy with this name exists on this level (server level or zone level) on the DNS server.';
const INVALID_SETTINGS = 'At least one of the settings of this policy is invalid.';
const SCOPE_MISSING = 'The scope does not exist.';
const INVALID_WEIGHT = 'The weight of the scope in the policy is invalid.';
const INVALID_SUBNET = 'The criterion client subnet provided in the policy is invalid.';
const INVALID_TRANSPORT = 'The criterion transport protocol provided in the policy is invalid.';
const INVALID_NETWORK = 'The criterion network protocol provided in the policy is invalid.';
const INVALID_INTERFACE = 'The criterion interface provided in the policy is invalid.';
const INVALID_FQDN = 'The criterion FQDN provided in the policy is invalid.';
const INVALID_QTYPE = 'The criterion query type provided in the policy is invalid.';
const INVALID_TIME = 'The criterion time of day provided in the policy is invalid.';
const ZONE_MISSING = 'Zone "nowhere.test" does not exist on this server.';
const NON_INTERACTIVE = 'Windows PowerShell is in NonInteractive mode.';

async function governed() {
  const context = await lab();
  const { server, ask } = context;
  const cmd = (line: string) => run(server, line);
  const verdict = async (from: LinuxPC, qname: string, qtype: number = RRType.A): Promise<Verdict> => verdictOf(await ask(from, qname, qtype));
  const verdictOverTcp = async (qname: string): Promise<Verdict> => verdictOf(await context.askOverTcp(qname));
  await cmd('Add-DnsServerClientSubnet -Name Lan -IPv4Subnet 10.0.1.0/24');
  await cmd('Add-DnsServerClientSubnet -Name Remote -IPv4Subnet 10.0.2.0/24');
  return { ...context, cmd, verdict, verdictOverTcp };
}

function members(values: Record<string, string | number>): string {
  const all: Record<string, string | number> = {
    Action: '', AppliesOn: 'QueryProcessing', Condition: 'And', Content: '', Criteria: '', IsEnabled: 'True', Level: 'Server', Name: '',
    ProcessingOrder: 0, ZoneName: '', ...values,
  };
  return ['', ...Object.entries(all).map(([key, value]) => `${key.padEnd(15)} : ${value}`), ''].join('\n');
}

const tidy = (text: string): string => text.split('\n').map(line => line.trimEnd()).join('\n');

describe('the cmdlets of the examples', () => {
  it('add the policy of example 4 of Add, write nothing without -PassThru, and show it under the nine members of the class', async () => {
    const { cmd } = await governed();
    expect(await cmd(`${ADD} -Name "BlackholePolicy" -Action IGNORE -FQDN "EQ,*.corp.test"`)).toBe('');
    expect(await cmd(`${GET} -Name BlackholePolicy | Format-List *`)).toBe(members({
      Action: 'Ignore', Criteria: '{DnsServerPolicyCriteria}', Name: 'BlackholePolicy', ProcessingOrder: 1,
    }));
  });

  it('return the policy -PassThru as the page prints it', async () => {
    const { cmd } = await governed();
    expect(await cmd(`${ADD} -Name "BlackholePolicy" -Action IGNORE -FQDN "EQ,*.corp.test" -PassThru | Format-List *`)).toBe(members({
      Action: 'Ignore', Criteria: '{DnsServerPolicyCriteria}', Name: 'BlackholePolicy', ProcessingOrder: 1,
    }));
  });

  it('number the policies of examples 4 to 6 one after the other and list them in the table of example 4 of Get', async () => {
    const { cmd } = await governed();
    await cmd(`${ADD} -Name "BlackholePolicy" -Action IGNORE -FQDN "EQ,*.corp.test"`);
    await cmd(`${ADD} -Name "BlackholePolicyMalicious06" -Action IGNORE -ClientSubnet "EQ,Remote"`);
    await cmd(`${ADD} -Name "BlackholePolicyQType" -Action IGNORE -QType "EQ,ANY"`);
    expect(tidy(await cmd(GET))).toBe([
      '',
      'Name                       ProcessingOrder IsEnabled Action',
      '----                       --------------- --------- ------',
      'BlackholePolicy                          1 True      Ignore',
      'BlackholePolicyMalicious06               2 True      Ignore',
      'BlackholePolicyQType                     3 True      Ignore',
      '',
    ].join('\n'));
    expect(tidy(await cmd(`${GET} -Name "BlackholePolicy"`))).toBe([
      '',
      'Name            ProcessingOrder IsEnabled Action',
      '----            --------------- --------- ------',
      'BlackholePolicy               1 True      Ignore',
      '',
    ].join('\n'));
  });

  it('keep the processing order per type: a recursion policy starts again at 1', async () => {
    const { cmd } = await governed();
    await cmd(`${ADD} -Name Q1 -Action DENY -QType "EQ,ANY"`);
    await cmd(`${ADD} -Name Q2 -Action DENY -QType "EQ,TXT"`);
    await cmd(`${ADD} -Name SplitBrainPolicy -Action ALLOW -ApplyOnRecursion -RecursionScope "." -ServerInterfaceIP "EQ,10.0.1.10"`);
    expect(await cmd(`(${GET}).Name -join ","`)).toBe('Q1,Q2,SplitBrainPolicy');
    expect(await cmd(`(${GET}).ProcessingOrder -join ","`)).toBe('1,2,1');
    expect(await cmd(`(${GET} -Name SplitBrainPolicy).AppliesOn`)).toBe('Recursion');
    expect(await cmd(`(${GET} -Name Q1).AppliesOn`)).toBe('QueryProcessing');
  });

  it('add a criterion with Set as the example of Set does, keep the others, and show the criteria as a table', async () => {
    const { cmd } = await governed();
    await cmd(`${ADD} -Name "PolicyMalicious" -Action IGNORE -QType "EQ,ANY"`);
    expect(await cmd(`${SET} -Name "PolicyMalicious" -InternetProtocol "eq,IPv4" -PassThru | Format-List *`)).toBe(members({
      Action: 'Ignore', Criteria: '{DnsServerPolicyCriteria, DnsServerPolicyCriteria}', Name: 'PolicyMalicious', ProcessingOrder: 1,
    }));
    expect(tidy(await cmd(`(${GET} -Name PolicyMalicious).Criteria`))).toBe([
      '',
      'CriteriaType    Criteria',
      '------------    --------',
      'NetworkProtocol EQ,IPv4',
      'Qtype           EQ,ANY',
      '',
    ].join('\n'));
  });

  it('write each criterion under the type the class gives it, normalised', async () => {
    const { cmd } = await governed();
    await cmd(`${ADD} -Name P -Action DENY -ClientSubnet "eq, Lan" -TransportProtocol "ne,udp" -InternetProtocol "EQ,ipv6" -ServerInterfaceIP "EQ,10.0.1.10" -Fqdn "EQ,*.corp.test" -QType "eq,txt,srv;ne,mx" -TimeOfDay "EQ,10:00-12:00,22:00-23:00"`);
    expect(await cmd(`(${GET} -Name P).Criteria | ForEach-Object { $_.CriteriaType + " " + $_.Criteria }`)).toBe([
      'ClientSubnet EQ,Lan',
      'TransportProtocol NE,udp',
      'NetworkProtocol EQ,ipv6',
      'Interface EQ,10.0.1.10',
      'Fqdn EQ,*.corp.test',
      'Qtype EQ,txt,srv,NE,mx',
      'Time EQ,10:00-12:00,22:00-23:00',
    ].join('\n'));
  });

  it('replace a criterion given again, change the condition and move the policy', async () => {
    const { cmd } = await governed();
    await cmd(`${ADD} -Name A -Action DENY -QType "EQ,ANY"`);
    await cmd(`${ADD} -Name B -Action DENY -QType "EQ,TXT"`);
    expect(await cmd(`${SET} -Name B -QType "EQ,MX" -Condition OR -ProcessingOrder 1`)).toBe('');
    expect(await cmd(`(${GET}).Name -join ","`)).toBe('B,A');
    expect(await cmd(`(${GET} -Name B).Condition`)).toBe('Or');
    expect(await cmd(`(${GET} -Name B).Criteria.Criteria`)).toBe('EQ,MX');
    expect(await cmd(`(${GET} -Name A).ProcessingOrder`)).toBe('2');
  });

  it('insert a policy at the processing order it is given and shift the others', async () => {
    const { cmd } = await governed();
    await cmd(`${ADD} -Name A -Action DENY -QType "EQ,ANY"`);
    await cmd(`${ADD} -Name B -Action DENY -QType "EQ,TXT"`);
    await cmd(`${ADD} -Name C -Action DENY -QType "EQ,MX" -ProcessingOrder 1`);
    expect(await cmd(`(${GET}).Name -join ","`)).toBe('C,A,B');
    expect(await cmd(`(${GET}).ProcessingOrder -join ","`)).toBe('1,2,3');
  });

  it('remove a policy with -Force, hand it back with -PassThru, and close the gap in the processing order', async () => {
    const { cmd } = await governed();
    await cmd(`${ADD} -Name A -Action DENY -QType "EQ,ANY"`);
    await cmd(`${ADD} -Name B -Action DENY -QType "EQ,TXT"`);
    expect(tidy(await cmd(`${REMOVE} -Name A -Force -PassThru`))).toBe([
      '',
      'Name ProcessingOrder IsEnabled Action',
      '---- --------------- --------- ------',
      'A                  1 True      Deny',
      '',
    ].join('\n'));
    expect(await cmd(`(${GET}).Name -join ","`)).toBe('B');
    expect(await cmd(`(${GET} -Name B).ProcessingOrder`)).toBe('1');
  });

  it('ask before they remove, whether or not the policy exists, and go on with -Force', async () => {
    const { cmd } = await governed();
    await cmd(`${ADD} -Name A -Action DENY -QType "EQ,ANY"`);
    expect(await cmd(`${REMOVE} -Name A`)).toContain(`${REMOVE} : ${NON_INTERACTIVE}`);
    expect(await cmd(`${REMOVE} -Name Nope`)).toContain(`${REMOVE} : ${NON_INTERACTIVE}`);
    expect(await cmd(`${REMOVE} -Name Nope -Force`)).toContain(`${REMOVE} : ${MISSING}`);
    expect(await cmd(`(${GET} -Name A).Name`)).toBe('A');
    expect(await cmd(`${REMOVE} -Name A -Force`)).toBe('');
  });

  it('name their target under -WhatIf and change nothing', async () => {
    const { cmd } = await governed();
    expect(await cmd(`${ADD} -Name A -Action DENY -QType "EQ,ANY" -WhatIf`)).toContain(`What if: Performing the operation "${ADD}" on target "A".`);
    expect(await cmd(GET)).toBe('');
    await cmd(`${ADD} -Name A -Action DENY -QType "EQ,ANY"`);
    expect(await cmd(`${SET} -Name A -QType "EQ,TXT" -WhatIf`)).toContain(`What if: Performing the operation "${SET}" on target "A".`);
    expect(await cmd(`${REMOVE} -Name A -WhatIf`)).toContain(`What if: Performing the operation "${REMOVE}" on target "A".`);
    expect(await cmd(`(${GET} -Name A).Criteria.Criteria`)).toBe('EQ,ANY');
  });

  it('bind the positions of the page: name, action, condition', async () => {
    const { cmd } = await governed();
    expect(await cmd(`${ADD} Positional DENY OR -QType "EQ,ANY" -Fqdn "EQ,a.test"`)).toBe('');
    expect(await cmd(`(${GET} Positional).Action`)).toBe('Deny');
    expect(await cmd(`(${GET} Positional).Condition`)).toBe('Or');
  });

  it('copy the policies through the pipeline in the order they come, as example 3 of Add does', async () => {
    const { cmd } = await governed();
    await cmd(`${ADD} -Name A -Action IGNORE -QType "EQ,ANY" -Fqdn "EQ,*.corp.test" -Condition OR`);
    await cmd(`${ADD} -Name B -Action DENY -ClientSubnet "NE,Lan"`);
    await cmd(`${ADD} -Name C -Action DENY -TimeOfDay "EQ,10:00-12:00"`);
    await cmd(`$policies = ${GET}; ${REMOVE} -Name C -Force; ${REMOVE} -Name B -Force; ${REMOVE} -Name A -Force; $policies | ${ADD}`);
    expect(await cmd(`(${GET}).Name -join ","`)).toBe('A,B,C');
    expect(await cmd(`(${GET}).ProcessingOrder -join ","`)).toBe('1,2,3');
    expect(await cmd(`(${GET} -Name A).Action`)).toBe('Ignore');
    expect(await cmd(`(${GET} -Name A).Condition`)).toBe('Or');
    expect(await cmd(`(${GET} -Name A).Criteria.CriteriaType -join ","`)).toBe('Fqdn,Qtype');
    expect(await cmd(`(${GET} -Name B).Criteria.Criteria`)).toBe('NE,Lan');
  });

  it('let a name given on the command line win over the policy that is piped, and keep the piped one', async () => {
    const { cmd } = await governed();
    await cmd(`${ADD} -Name Original -Action IGNORE -QType "EQ,ANY" -Condition OR`);
    await cmd(`$policy = ${GET} -Name Original; $policy | ${ADD} -Name Twin -Fqdn "EQ,a.corp.test"`);
    expect(await cmd(`(${GET}).Name -join ","`)).toBe('Original,Twin');
    expect(await cmd(`(${GET} -Name Twin).Action`)).toBe('Ignore');
    expect(await cmd(`(${GET} -Name Twin).Condition`)).toBe('Or');
    expect(await cmd(`(${GET} -Name Twin).Criteria.Criteria -join "|"`)).toBe('EQ,a.corp.test|EQ,ANY');
    expect(await cmd(`(${GET} -Name Original).Criteria.Criteria`)).toBe('EQ,ANY');
  });

  it('update the policy that is piped, taking what is named over what the object holds', async () => {
    const { cmd } = await governed();
    await cmd(`${ADD} -Name P -Action DENY -QType "EQ,ANY" -Fqdn "EQ,a.corp.test"`);
    expect(await cmd(`${GET} -Name P | ${SET} -QType "EQ,TXT"`)).toBe('');
    expect(await cmd(`(${GET} -Name P).Criteria.Criteria -join "|"`)).toBe('EQ,a.corp.test|EQ,TXT');
  });

  it('create a policy disabled with -Disable', async () => {
    const { cmd } = await governed();
    await cmd(`${ADD} -Name Off -Action DENY -QType "EQ,ANY" -Disable`);
    expect(await cmd(`(${GET} -Name Off).IsEnabled`)).toBe('False');
  });
});

describe('the refusals', () => {
  it.each([
    ['a name that is taken, whatever its case', `${ADD} -Name TAKEN -Action DENY -QType "EQ,TXT"`, ADD, EXISTS],
    ['a name that is taken by a policy of another type', `${ADD} -Name taken -Action ALLOW -ApplyOnRecursion -RecursionScope "." -Fqdn "EQ,a.test"`, ADD, EXISTS],
    ['a policy with no criterion', `${ADD} -Name Empty -Action DENY`, ADD, INVALID_SETTINGS],
    ['a policy with no action', `${ADD} -Name NoAction -QType "EQ,TXT"`, ADD, INVALID_SETTINGS],
    ['an ALLOW with no scope', `${ADD} -Name Allow -Action ALLOW -QType "EQ,TXT"`, ADD, INVALID_SETTINGS],
    ['a DENY with a scope', `${ADD} -Name Deny -Action DENY -QType "EQ,TXT" -RecursionScope "."`, ADD, INVALID_SETTINGS],
    ['an ALLOW on queries at the server level', `${ADD} -Name Allow -Action ALLOW -RecursionScope "." -QType "EQ,TXT"`, ADD, INVALID_SETTINGS],
    ['an ECS criterion, which no policy can evaluate', `${ADD} -Name Ecs -Action DENY -ECS "EQ,10.0.0.0/8" -QType "EQ,TXT"`, ADD, INVALID_SETTINGS],
    ['a processing order beyond the next one', `${ADD} -Name Far -Action DENY -QType "EQ,TXT" -ProcessingOrder 7`, ADD, INVALID_SETTINGS],
    ['a client subnet record that does not exist', `${ADD} -Name Bad -Action DENY -ClientSubnet "EQ,Atlantis"`, ADD, INVALID_SUBNET],
    ['a criterion without comparator', `${ADD} -Name Bad -Action DENY -ClientSubnet "Lan"`, ADD, INVALID_SUBNET],
    ['a transport that is neither TCP nor UDP', `${ADD} -Name Bad -Action DENY -TransportProtocol "EQ,ICMP"`, ADD, INVALID_TRANSPORT],
    ['an internet protocol that is neither IPv4 nor IPv6', `${ADD} -Name Bad -Action DENY -InternetProtocol "EQ,IPv5"`, ADD, INVALID_NETWORK],
    ['an interface that is no address', `${ADD} -Name Bad -Action DENY -ServerInterfaceIP "EQ,eth0"`, ADD, INVALID_INTERFACE],
    ['an FQDN that is no name', `${ADD} -Name Bad -Action DENY -Fqdn "EQ,a..b"`, ADD, INVALID_FQDN],
    ['a query type that is no mnemonic', `${ADD} -Name Bad -Action DENY -QType "EQ,NOPE"`, ADD, INVALID_QTYPE],
    ['a time of day beyond the day', `${ADD} -Name Bad -Action DENY -TimeOfDay "EQ,25:00-26:00"`, ADD, INVALID_TIME],
    ['a time of day that ends before it starts', `${ADD} -Name Bad -Action DENY -TimeOfDay "EQ,12:00-10:00"`, ADD, INVALID_TIME],
    ['a time of day that is no range', `${ADD} -Name Bad -Action DENY -TimeOfDay "EQ,noon"`, ADD, INVALID_TIME],
    ['a zone that the server does not host', `${ADD} -Name Bad -ZoneName nowhere.test -Action DENY -QType "EQ,TXT"`, ADD, ZONE_MISSING],
    ['a zone scope that does not exist', `${ADD} -Name Bad -ZoneName corp.test -Action ALLOW -ZoneScope "europe,1" -QType "EQ,TXT"`, ADD, SCOPE_MISSING],
    ['a zone scope of weight 0', `${ADD} -Name Bad -ZoneName corp.test -Action ALLOW -ZoneScope "corp.test,0" -QType "EQ,TXT"`, ADD, INVALID_WEIGHT],
    ['a recursion scope that does not exist', `${ADD} -Name Bad -Action ALLOW -ApplyOnRecursion -RecursionScope "InternalClients" -QType "EQ,TXT"`, ADD, SCOPE_MISSING],
    ['a policy that is not held', `${GET} -Name Nope`, GET, MISSING],
    ['a policy that is not held, to set', `${SET} -Name Nope -QType "EQ,TXT"`, SET, MISSING],
    ['a policy that is not held, to remove', `${REMOVE} -Name Nope -Force`, REMOVE, MISSING],
    ['a policy that is not held, to disable', `${DISABLE} -Level Server -Name Nope -Force`, DISABLE, MISSING],
    ['a criterion that is not valid, to set', `${SET} -Name Taken -QType "EQ,NOPE"`, SET, INVALID_QTYPE],
    ['a processing order beyond the last one, to set', `${SET} -Name Taken -ProcessingOrder 7`, SET, INVALID_SETTINGS],
    ['the policies of a zone that the server does not host', `${GET} -ZoneName nowhere.test`, GET, ZONE_MISSING],
  ])('refuse %s with the text of the Win32 error and change nothing', async (_label, command, cmdlet, message) => {
    const { cmd } = await governed();
    await cmd(`${ADD} -Name Taken -Action DENY -QType "EQ,ANY"`);
    expect(await cmd(command)).toContain(`${cmdlet} : ${message}`);
    expect(await cmd(`(${GET}).Name -join ","`)).toBe('Taken');
    expect(await cmd(`(${GET} -Name Taken).Criteria.Criteria`)).toBe('EQ,ANY');
  });
});

describe('Enable-DnsServerPolicy and Disable-DnsServerPolicy', () => {
  it('disable one policy by name and enable it again', async () => {
    const { cmd } = await governed();
    await cmd(`${ADD} -Name A -Action DENY -QType "EQ,ANY"`);
    await cmd(`${ADD} -Name B -Action DENY -QType "EQ,TXT"`);
    expect(await cmd(`${DISABLE} -Level Server -Name B -Force`)).toBe('');
    expect(await cmd(`(${GET}).IsEnabled -join ","`)).toBe('True,False');
    expect(await cmd(`${ENABLE} -Level Server -Name B -Force`)).toBe('');
    expect(await cmd(`(${GET}).IsEnabled -join ","`)).toBe('True,True');
  });

  it('take every policy of the level when no name is given, recursion policies included', async () => {
    const { cmd } = await governed();
    await cmd(`${ADD} -Name A -Action DENY -QType "EQ,ANY"`);
    await cmd(`${ADD} -Name R -Action ALLOW -ApplyOnRecursion -RecursionScope "." -QType "EQ,A"`);
    await cmd(`${DISABLE} -Level Server -Force`);
    expect(await cmd(`(${GET}).IsEnabled -join ","`)).toBe('False,False');
    await cmd(`${ENABLE} -Level Server -Force`);
    expect(await cmd(`(${GET}).IsEnabled -join ","`)).toBe('True,True');
  });

  it('read a zone-level policy by the zone, and keep the server level apart', async () => {
    const { cmd } = await governed();
    await cmd(`${ADD} -Name Z -ZoneName corp.test -Action DENY -QType "EQ,ANY"`);
    await cmd(`${ADD} -Name S -Action DENY -QType "EQ,ANY"`);
    await cmd(`${DISABLE} -Level Zone -ZoneName corp.test -Force`);
    expect(await cmd(`(${GET} -ZoneName corp.test).IsEnabled`)).toBe('False');
    expect(await cmd(`(${GET}).IsEnabled`)).toBe('True');
    await cmd(`${ENABLE} -Level Zone -Name Z -ZoneName corp.test -Force`);
    expect(await cmd(`(${GET} -ZoneName corp.test).IsEnabled`)).toBe('True');
  });

  it('ask before they act, and name the zone of a zone-level call', async () => {
    const { cmd } = await governed();
    await cmd(`${ADD} -Name A -Action DENY -QType "EQ,ANY"`);
    expect(await cmd(`${DISABLE} -Level Server -Name A`)).toContain(`${DISABLE} : ${NON_INTERACTIVE}`);
    expect(await cmd(`(${GET} -Name A).IsEnabled`)).toBe('True');
    expect(await cmd(`${ENABLE} -Level Zone -Name A -Force`)).toContain('missing mandatory parameters: ZoneName');
    expect(await cmd(`${ENABLE} -Name A -Force`)).toContain('missing mandatory parameters: Level');
  });
});

describe('the policies govern the queries the server receives', () => {
  it('answers every query while no policy exists', async () => {
    const { verdict, clientA, clientC } = await governed();
    expect([await verdict(clientA, 'web.corp.test'), await verdict(clientC, 'web.corp.test'), await verdict(clientA, 'web.corp.test', RRType.ANY)])
      .toEqual(['answered', 'answered', 'answered']);
  });

  it('answers the clients over a stream while no policy exists', async () => {
    const { verdictOverTcp } = await governed();
    expect(await verdictOverTcp('web.corp.test')).toBe('answered');
  });

  it('answers REFUSED to the name a DENY policy covers and leaves the others alone', async () => {
    const { cmd, verdict, clientA } = await governed();
    await cmd(`${ADD} -Name Deny -Action DENY -Fqdn "EQ,web.corp.test"`);
    expect([await verdict(clientA, 'web.corp.test'), await verdict(clientA, 'mail.corp.test')]).toEqual(['refused', 'answered']);
  });

  it('answers nothing to the name an IGNORE policy covers, as example 4 blocks a domain', async () => {
    const { cmd, verdict, clientA } = await governed();
    await cmd(`${ADD} -Name "BlackholePolicy" -Action IGNORE -FQDN "EQ,*.corp.test"`);
    expect([await verdict(clientA, 'web.corp.test'), await verdict(clientA, 'a.b.corp.test'), await verdict(clientA, 'corp.test')])
      .toEqual(['dropped', 'dropped', 'dropped']);
  });

  it('blocks the queries of a client subnet, as example 5 does, and no other client', async () => {
    const { cmd, verdict, clientA, clientB, clientC } = await governed();
    await cmd(`${ADD} -Name "BlackholePolicyMalicious06" -Action IGNORE -ClientSubnet "EQ,Remote"`);
    expect([await verdict(clientC, 'web.corp.test'), await verdict(clientA, 'web.corp.test'), await verdict(clientB, 'web.corp.test')])
      .toEqual(['dropped', 'answered', 'answered']);
  });

  it('blocks a type of query, as example 6 does, and only that type', async () => {
    const { cmd, verdict, clientA } = await governed();
    await cmd(`${ADD} -Name "BlackholePolicyQType" -Action IGNORE -QType "EQ,ANY"`);
    expect([await verdict(clientA, 'web.corp.test', RRType.ANY), await verdict(clientA, 'web.corp.test', RRType.A), await verdict(clientA, 'web.corp.test', RRType.MX)])
      .toEqual(['dropped', 'answered', 'answered']);
  });

  it('keeps the clients outside a subnet when the criterion is NE', async () => {
    const { cmd, verdict, clientA, clientC } = await governed();
    await cmd(`${ADD} -Name Outside -Action DENY -ClientSubnet "NE,Lan"`);
    expect([await verdict(clientA, 'web.corp.test'), await verdict(clientC, 'web.corp.test')]).toEqual(['answered', 'refused']);
  });

  it('decides on the transport of the query', async () => {
    const { cmd, verdict, verdictOverTcp, clientA } = await governed();
    await cmd(`${ADD} -Name NoStream -Action DENY -TransportProtocol "EQ,TCP"`);
    expect([await verdict(clientA, 'web.corp.test'), await verdictOverTcp('web.corp.test')]).toEqual(['answered', 'refused']);
  });

  it('answers nothing over a stream to a query an IGNORE policy covers, and serves the next connection', async () => {
    const { cmd, verdictOverTcp } = await governed();
    await cmd(`${ADD} -Name Quiet -Action IGNORE -Fqdn "EQ,web.corp.test"`);
    expect(await verdictOverTcp('web.corp.test')).toBe('dropped');
    expect(await verdictOverTcp('mail.corp.test')).toBe('answered');
  });

  it('decides on the address of the interface that received the query', async () => {
    const { cmd, verdict, clientA } = await governed();
    await cmd(`${ADD} -Name Elsewhere -Action DENY -ServerInterfaceIP "EQ,10.0.1.99"`);
    expect(await verdict(clientA, 'web.corp.test')).toBe('answered');
    await cmd(`${SET} -Name Elsewhere -ServerInterfaceIP "EQ,10.0.1.10"`);
    expect(await verdict(clientA, 'web.corp.test')).toBe('refused');
  });

  it('decides on the family of the requestor', async () => {
    const { cmd, verdict, clientA } = await governed();
    await cmd(`${ADD} -Name SixOnly -Action DENY -InternetProtocol "EQ,IPv6"`);
    expect(await verdict(clientA, 'web.corp.test')).toBe('answered');
    await cmd(`${SET} -Name SixOnly -InternetProtocol "EQ,IPv4"`);
    expect(await verdict(clientA, 'web.corp.test')).toBe('refused');
  });

  it('decides on the time of day of the clock of the server, in its time zone', async () => {
    const { cmd, verdict, clientA, server } = await governed();
    server.setSystemTime(Date.UTC(2024, 5, 3, 22, 30, 0));
    await cmd('Set-TimeZone -Id "UTC"');
    await cmd(`${ADD} -Name Night -Action DENY -TimeOfDay "EQ,22:00-23:00"`);
    expect(await verdict(clientA, 'web.corp.test')).toBe('refused');
    await cmd('Set-TimeZone -Id "Tokyo Standard Time"');
    expect(await verdict(clientA, 'web.corp.test')).toBe('answered');
    await cmd(`${SET} -Name Night -TimeOfDay "EQ,07:00-08:00"`);
    expect(await verdict(clientA, 'web.corp.test')).toBe('refused');
    server.setSystemTime(Date.UTC(2024, 5, 3, 23, 30, 0));
    expect(await verdict(clientA, 'web.corp.test')).toBe('answered');
  });

  it('combines the criteria with AND by default and with OR on request', async () => {
    const { cmd, verdict, clientA } = await governed();
    await cmd(`${ADD} -Name Both -Action DENY -Fqdn "EQ,web.corp.test" -QType "EQ,MX"`);
    expect([
      await verdict(clientA, 'web.corp.test', RRType.MX), await verdict(clientA, 'web.corp.test', RRType.A), await verdict(clientA, 'mail.corp.test', RRType.MX),
    ]).toEqual(['refused', 'answered', 'answered']);
    await cmd(`${SET} -Name Both -Condition OR`);
    expect([
      await verdict(clientA, 'web.corp.test', RRType.MX), await verdict(clientA, 'web.corp.test', RRType.A), await verdict(clientA, 'mail.corp.test', RRType.MX),
      await verdict(clientA, 'mail.corp.test', RRType.A),
    ]).toEqual(['refused', 'refused', 'refused', 'answered']);
  });

  it('lets the first policy in processing order that holds decide, and moves with the order', async () => {
    const { cmd, verdict, clientA } = await governed();
    await cmd(`${ADD} -Name Quiet -Action IGNORE -Fqdn "EQ,web.corp.test"`);
    await cmd(`${ADD} -Name Loud -Action DENY -Fqdn "EQ,*.corp.test"`);
    expect([await verdict(clientA, 'web.corp.test'), await verdict(clientA, 'mail.corp.test')]).toEqual(['dropped', 'refused']);
    await cmd(`${SET} -Name Loud -ProcessingOrder 1`);
    expect([await verdict(clientA, 'web.corp.test'), await verdict(clientA, 'mail.corp.test')]).toEqual(['refused', 'refused']);
  });

  it('stops governing once the policy is disabled and starts again once it is enabled', async () => {
    const { cmd, verdict, clientA } = await governed();
    await cmd(`${ADD} -Name Deny -Action DENY -Fqdn "EQ,web.corp.test"`);
    expect(await verdict(clientA, 'web.corp.test')).toBe('refused');
    await cmd(`${DISABLE} -Level Server -Name Deny -Force`);
    expect(await verdict(clientA, 'web.corp.test')).toBe('answered');
    await cmd(`${ENABLE} -Level Server -Name Deny -Force`);
    expect(await verdict(clientA, 'web.corp.test')).toBe('refused');
  });

  it('stops governing once the policy is removed, and does not govern a policy created disabled', async () => {
    const { cmd, verdict, clientA } = await governed();
    await cmd(`${ADD} -Name Off -Action DENY -Fqdn "EQ,web.corp.test" -Disable`);
    expect(await verdict(clientA, 'web.corp.test')).toBe('answered');
    await cmd(`${ENABLE} -Level Server -Name Off -Force`);
    expect(await verdict(clientA, 'web.corp.test')).toBe('refused');
    await cmd(`${REMOVE} -Name Off -Force`);
    expect(await verdict(clientA, 'web.corp.test')).toBe('answered');
  });

  it('counts a refusal as a Refused response and an ignored query as received and never answered', async () => {
    const { cmd, verdict, clientA } = await governed();
    await cmd('Clear-DnsServerStatistics -Force');
    await cmd(`${ADD} -Name Deny -Action DENY -Fqdn "EQ,web.corp.test"`);
    await cmd(`${ADD} -Name Quiet -Action IGNORE -Fqdn "EQ,mail.corp.test"`);
    await verdict(clientA, 'web.corp.test');
    await verdict(clientA, 'mail.corp.test');
    expect(await cmd('(Get-DnsServerStatistics).QueryStatistics.UdpQueries')).toBe('2');
    expect(await cmd('(Get-DnsServerStatistics).QueryStatistics.UdpResponses')).toBe('1');
    expect(await cmd('(Get-DnsServerStatistics).ErrorStatistics.Refused')).toBe('1');
  });
});

describe('the policies of a zone', () => {
  it('govern the names of the zone only, after the server-level ones', async () => {
    const { cmd, verdict, clientA } = await governed();
    expect(await cmd(`${ADD} -Name ZoneDeny -ZoneName corp.test -Action DENY -QType "EQ,MX"`)).toBe('');
    expect([await verdict(clientA, 'web.corp.test', RRType.MX), await verdict(clientA, 'web.corp.test', RRType.A)]).toEqual(['refused', 'answered']);
    await cmd(`${ADD} -Name ServerQuiet -Action IGNORE -QType "EQ,MX"`);
    expect(await verdict(clientA, 'web.corp.test', RRType.MX)).toBe('dropped');
  });

  it('show their zone, apart from the policies of the server of the same name', async () => {
    const { cmd } = await governed();
    await cmd(`${ADD} -Name Same -ZoneName corp.test -Action DENY -QType "EQ,MX"`);
    await cmd(`${ADD} -Name Same -Action DENY -QType "EQ,MX"`);
    expect(await cmd(`(${GET} -ZoneName corp.test).ZoneName`)).toBe('corp.test');
    expect(await cmd(`(${GET} -ZoneName corp.test).Level`)).toBe('Zone');
    expect(await cmd(`(${GET}).Level`)).toBe('Server');
    expect(await cmd(`${REMOVE} -Name Same -ZoneName corp.test -Force`)).toBe('');
    expect(await cmd(`(${GET}).Name`)).toBe('Same');
    expect(await cmd(`${GET} -ZoneName corp.test`)).toBe('');
  });

  it('bind the zone by position as the pages do: Remove takes name then zone, Set takes the zone first', async () => {
    const { cmd } = await governed();
    await cmd(`${ADD} -Name Same -ZoneName corp.test -Action DENY -QType "EQ,MX"`);
    await cmd(`${ADD} -Name Same -Action DENY -QType "EQ,MX"`);
    expect(await cmd(`${SET} corp.test -Name Same -QType "EQ,TXT"`)).toBe('');
    expect(await cmd(`(${GET} -ZoneName corp.test -Name Same).Criteria.Criteria`)).toBe('EQ,TXT');
    expect(await cmd(`(${GET} -Name Same).Criteria.Criteria`)).toBe('EQ,MX');
    expect(await cmd(`${REMOVE} Same corp.test -Force`)).toBe('');
    expect(await cmd(`${GET} -ZoneName corp.test`)).toBe('');
    expect(await cmd(`(${GET}).Name`)).toBe('Same');
    expect(await cmd(`(${GET} Same corp.test)`)).toContain(`${GET} : ${MISSING}`);
  });

  it('end the search with an ALLOW that holds, so that a later DENY does not apply', async () => {
    const { cmd, verdict, clientA, clientC } = await governed();
    expect(await cmd(`${ADD} -Name AllowLan -ZoneName corp.test -Action ALLOW -ZoneScope "corp.test,3" -ClientSubnet "EQ,Lan"`)).toBe('');
    expect(await cmd(`(${GET} -ZoneName corp.test -Name AllowLan).Content | ForEach-Object { $_.ScopeName + " " + $_.Weight }`)).toBe('corp.test 3');
    await cmd(`${ADD} -Name Everyone -ZoneName corp.test -Action DENY -QType "EQ,A"`);
    expect([await verdict(clientA, 'web.corp.test'), await verdict(clientC, 'web.corp.test')]).toEqual(['answered', 'refused']);
  });

  it('disappear with their zone', async () => {
    const { cmd } = await governed();
    await cmd(`${ADD} -Name Z -ZoneName corp.test -Action DENY -QType "EQ,MX"`);
    await cmd('Remove-DnsServerZone -Name corp.test -Force');
    await cmd('Add-DnsServerPrimaryZone -Name corp.test -ZoneFile corp.test.dns');
    expect(await cmd(`${GET} -ZoneName corp.test`)).toBe('');
  });
});

describe('the policies of recursion', () => {
  async function forwarding() {
    const context = await governed();
    await context.cmd('Set-DnsServerForwarder -IPAddress 10.0.1.30 -UseRootHint $false');
    for (const [name, host] of [['a', 11], ['b', 12], ['c', 13]] as const) {
      await run(context.master, `Add-DnsServerResourceRecordA -ZoneName ext.test -Name ${name} -IPv4Address 10.0.7.${host}`);
    }
    return context;
  }

  it('resolve through the forwarder while no policy exists', async () => {
    const { verdict, clientA } = await forwarding();
    expect(await verdict(clientA, 'host.ext.test')).toBe('answered');
  });

  it('deny the resolution with REFUSED and keep answering the names of the server', async () => {
    const { cmd, verdict, clientA } = await forwarding();
    await cmd(`${ADD} -Name NoRecursion -Action DENY -ApplyOnRecursion -Fqdn "EQ,*.ext.test"`);
    expect([await verdict(clientA, 'host.ext.test'), await verdict(clientA, 'web.corp.test')]).toEqual(['refused', 'answered']);
  });

  it('ignore the resolution they are told to ignore', async () => {
    const { cmd, verdict, clientA } = await forwarding();
    await cmd(`${ADD} -Name Quiet -Action IGNORE -ApplyOnRecursion -ClientSubnet "EQ,Lan"`);
    expect(await verdict(clientA, 'host.ext.test')).toBe('dropped');
  });

  it('allow the resolution of the default recursion scope, as the split-brain policy of example 7 does', async () => {
    const { cmd, verdict, clientA, clientC } = await forwarding();
    await cmd(`${ADD} -Name NoOthers -Action DENY -ApplyOnRecursion -ClientSubnet "NE,Lan"`);
    expect([await verdict(clientA, 'a.ext.test'), await verdict(clientC, 'b.ext.test')]).toEqual(['answered', 'refused']);
    await cmd(`${ADD} -Name SplitBrainPolicy -Action ALLOW -ApplyOnRecursion -RecursionScope "." -ServerInterfaceIP "EQ,10.0.1.10" -ProcessingOrder 1`);
    expect(await verdict(clientC, 'c.ext.test')).toBe('answered');
  });

  it('do not govern a name the cache already holds', async () => {
    const { cmd, verdict, clientA } = await forwarding();
    expect(await verdict(clientA, 'host.ext.test')).toBe('answered');
    await cmd(`${ADD} -Name NoRecursion -Action DENY -ApplyOnRecursion -Fqdn "EQ,*.ext.test"`);
    expect(await verdict(clientA, 'host.ext.test')).toBe('answered');
    expect(await verdict(clientA, 'nothing.ext.test')).toBe('refused');
  });

  it('come after the query processing policies', async () => {
    const { cmd, verdict, clientA } = await forwarding();
    await cmd(`${ADD} -Name Deny -Action DENY -ApplyOnRecursion -Fqdn "EQ,*.ext.test"`);
    await cmd(`${ADD} -Name Quiet -Action IGNORE -Fqdn "EQ,*.ext.test"`);
    expect(await verdict(clientA, 'host.ext.test')).toBe('dropped');
  });
});
