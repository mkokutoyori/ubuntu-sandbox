/*
 * Probe — Add-/Get-/Set-/Remove-DnsServerResponseRateLimitingExceptionlist exist and the lists really exempt queries from
 * response rate limiting: by the name asked (EQ and NE values, a wildcard covering the name and everything below it), by the
 * client subnet records the requestor belongs to, by the address of the server interface that received the query, the three
 * combined with the condition of the list (AND by default, or OR) and EQ with NE combined the same way inside one criterion;
 * any list that holds is enough. A list is a server-level DNS policy: its name is unique whatever the case, a criterion
 * that is malformed or names no client subnet record, no name or no address is refused under the text of the Win32 error
 * and creates nothing, a list with no criterion has no valid settings, Set replaces the criteria it is given and keeps the
 * others, and a client subnet record that a list names, under EQ or under NE, cannot be removed until the list is.
 *
 * Measured first (a Windows DNS server holding corp.test, three UDP clients, RRL enabled): none of the four cmdlets existed
 * and twelve identical queries from one client were limited whatever was configured; Remove-DnsServerClientSubnet removed
 * a record whatever used it.
 *
 * Authority: the Learn pages of the four cmdlets (parameter sets and their positions, the EQ/NE grammar, the condition and
 * its default, the examples), the provider class DnsServerResponseRateLimitingExceptionlist (the five members), [MS-DNSP]
 * 3.1.8.2 (the criteria and their grammar, the wildcard meaning "anything in contoso.com, including contoso.com"), 3.1.8.3
 * and 3.1.4.1 (CreatePolicy, UpdatePolicy, DeletePolicy, DeleteClientSubnetRecord and their errors), DNS_RPC_POLICY_TYPE
 * (DnsPolicyRRLExceptionList: queries exempted by name, source subnet or server interface) and the Win32 error table (9971,
 * 9972, 9974, 9975, 9990, 9993, 9994 and their texts). Not sourced, said here: that a list with no criterion is refused with
 * the text of 9974, that a client subnet criterion naming a record that does not exist is the invalid criterion of 9990, that
 * an interface value is valid when it is an address, that the criteria are shown with comparators in capitals, EQ before NE
 * and no blanks, that Condition shows as And or Or as the provider class says, that Name is required, that a query a list
 * exempts is neither counted by RRLStatistics nor recorded by LogOnly, and that a criterion that cannot be decided (no
 * source address, no interface address, no query name) does not hold.
 *
 * Discrimination (the probe run on the tree before the change): 43 of 45 cases fall. The two that pass either way are
 * the WITNESS "limits the flood of a name that no list covers" (the lab limits, with no list, the flood that every case
 * below lifts with one) and the NON-REGRESSION "can be removed when no list names them" (the same removal before and
 * after).
 */
import { describe, it, expect } from 'vitest';
import { DEFAULT_FLOOD, lab, run, times, virtualClock } from './dnsRateLimitingLab';

const clock = virtualClock();

const ADD = 'Add-DnsServerResponseRateLimitingExceptionlist';
const GET = 'Get-DnsServerResponseRateLimitingExceptionlist';
const SET = 'Set-DnsServerResponseRateLimitingExceptionlist';
const REMOVE = 'Remove-DnsServerResponseRateLimitingExceptionlist';

const EXISTS = 'A policy with the same name already exists on this level (server level or zone level) on the DNS server.';
const MISSING = 'No policy with this name exists on this level (server level or zone level) on the DNS server.';
const INVALID_SETTINGS = 'At least one of the settings of this policy is invalid.';
const SUBNET_ACCESSED = 'The client subnet cannot be deleted while it is being accessed by a policy.';
const INVALID_SUBNET = 'The criterion client subnet provided in the policy is invalid.';
const INVALID_INTERFACE = 'The criterion interface provided in the policy is invalid.';
const INVALID_FQDN = 'The criterion FQDN provided in the policy is invalid.';

const WEB = ['web.corp.test'];
const MAIL = ['mail.corp.test'];

async function enabled() {
  const context = await lab();
  await context.rrl('Set-DnsServerRRL -Mode Enable');
  await run(context.server, 'Add-DnsServerClientSubnet -Name TrustedNet -IPv4Subnet 10.0.1.0/24');
  return context;
}

describe('the exception list cmdlets', () => {
  it('an empty server lists nothing and says nothing', async () => {
    const { rrl } = await lab();
    expect(await rrl(GET)).toBe('');
  });

  it('adds the list of the first example, writes nothing, and shows it under the five members of the class', async () => {
    const { rrl } = await lab();
    expect(await rrl(`${ADD} -Name "SafeList1" -Fqdn "EQ,*.contoso.com"`)).toBe('');
    expect(await rrl(`${GET} -Name "SafeList1" | Format-List`)).toBe([
      '',
      'Name              : SafeList1',
      'Condition         : And',
      'ClientSubnet      : ',
      'Fqdn              : EQ,*.contoso.com',
      'ServerInterfaceIP : ',
      '',
    ].join('\n'));
  });

  it('shows what -PassThru returns, with the three criteria and the condition', async () => {
    const { rrl, server } = await lab();
    await run(server, 'Add-DnsServerClientSubnet -Name America -IPv4Subnet 10.1.0.0/16');
    await run(server, 'Add-DnsServerClientSubnet -Name Asia -IPv4Subnet 10.2.0.0/16');
    await run(server, 'Add-DnsServerClientSubnet -Name Europe -IPv4Subnet 10.3.0.0/16');
    const out = await rrl(`${ADD} -Name Mixed -ClientSubnet "EQ, America, Asia, NE, Europe" -Fqdn "eq,a.test" -ServerInterfaceIP "EQ,10.0.0.3" -Condition OR -PassThru | Format-List`);
    expect(out).toContain('Name              : Mixed');
    expect(out).toContain('Condition         : Or');
    expect(out).toContain('ClientSubnet      : EQ,America,Asia,NE,Europe');
    expect(out).toContain('Fqdn              : EQ,a.test');
    expect(out).toContain('ServerInterfaceIP : EQ,10.0.0.3');
  });

  it('enumerates the lists in the order they were added, or one by name whatever its case', async () => {
    const { rrl } = await lab();
    await rrl(`${ADD} -Name First -Fqdn "EQ,a.test"`);
    await rrl(`${ADD} -Name Second -Fqdn "EQ,b.test"`);
    expect(await rrl(`(${GET}).Name -join ","`)).toBe('First,Second');
    expect(await rrl(`(${GET} -Name SECOND).Fqdn`)).toBe('EQ,b.test');
    expect(await rrl(`(${GET} -Name Second).Name`)).toBe('Second');
  });

  it('reports a list that does not exist with the text of 9972', async () => {
    const { rrl } = await lab();
    expect(await rrl(`${GET} -Name Nope`)).toContain(`${GET} : ${MISSING}`);
  });

  it('binds the positional parameters in the order of the pages: name, client subnet, FQDN, interface, condition', async () => {
    const { rrl, server } = await lab();
    await run(server, 'Add-DnsServerClientSubnet -Name Asia -IPv4Subnet 10.2.0.0/16');
    expect(await rrl(`${ADD} Positional "EQ,Asia" "EQ,*.x.test" "EQ,10.0.1.10" OR`)).toBe('');
    expect(await rrl(`(${GET} Positional).Condition`)).toBe('Or');
    expect(await rrl(`(${GET} Positional).ClientSubnet`)).toBe('EQ,Asia');
    expect(await rrl(`(${GET} Positional).Fqdn`)).toBe('EQ,*.x.test');
    expect(await rrl(`(${GET} Positional).ServerInterfaceIP`)).toBe('EQ,10.0.1.10');
    expect(await rrl(`${SET} Positional "EQ,Asia" "EQ,*.y.test" "EQ,10.0.1.11" AND`)).toBe('');
    expect(await rrl(`(${GET} Positional).Condition`)).toBe('And');
    expect(await rrl(`(${GET} Positional).Fqdn`)).toBe('EQ,*.y.test');
    expect(await rrl(`(${GET} Positional).ServerInterfaceIP`)).toBe('EQ,10.0.1.11');
  });

  it('sets the interface of the list of the example and keeps the other criteria', async () => {
    const { rrl } = await lab();
    await rrl(`${ADD} -Name "SafeList1" -Fqdn "EQ,*.contoso.com"`);
    expect(await rrl(`${SET} -Name "SafeList1" -ServerInterfaceIP "EQ,10.0.0.1"`)).toBe('');
    expect(await rrl(`(${GET} -Name SafeList1).ServerInterfaceIP`)).toBe('EQ,10.0.0.1');
    expect(await rrl(`(${GET} -Name SafeList1).Fqdn`)).toBe('EQ,*.contoso.com');
  });

  it('replaces a criterion it is given, changes the condition, and returns the list with -PassThru', async () => {
    const { rrl } = await lab();
    await rrl(`${ADD} -Name L -Fqdn "EQ,a.test" -ServerInterfaceIP "EQ,10.0.0.1"`);
    const out = await rrl(`${SET} -Name l -Fqdn "NE,b.test" -Condition Or -PassThru | Format-List`);
    expect(out).toContain('Name              : L');
    expect(out).toContain('Condition         : Or');
    expect(out).toContain('Fqdn              : NE,b.test');
    expect(out).toContain('ServerInterfaceIP : EQ,10.0.0.1');
  });

  it('removes the list of the example with -Force', async () => {
    const { rrl } = await lab();
    await rrl(`${ADD} -Name "SafeList1" -Fqdn "EQ,*.contoso.com"`);
    expect(await rrl(`${REMOVE} -Name "SafeList1" -Force`)).toBe('');
    expect(await rrl(GET)).toBe('');
  });

  it('asks before it removes, and goes on with -Confirm:$false, with -Force and with -PassThru', async () => {
    const { rrl } = await lab();
    await rrl(`${ADD} -Name L -Fqdn "EQ,a.test"`);
    expect(await rrl(`${REMOVE} -Name L`)).toContain(`${REMOVE} : Windows PowerShell is in NonInteractive mode.`);
    expect(await rrl(`${REMOVE} -Name Nope`)).toContain(`${REMOVE} : Windows PowerShell is in NonInteractive mode.`);
    expect(await rrl(`${REMOVE} -Name Nope -Confirm:$false`)).toContain(`${REMOVE} : ${MISSING}`);
    expect(await rrl(`(${GET} -Name L).Name`)).toBe('L');
    expect(await rrl(`${REMOVE} -Name L -Confirm:$false`)).toBe('');
    await rrl(`${ADD} -Name M -Fqdn "EQ,a.test"`);
    expect(await rrl(`${REMOVE} -Name M -Force -PassThru | Format-List`)).toContain('Name              : M');
  });

  it('names its target under -WhatIf and changes nothing', async () => {
    const { rrl } = await lab();
    expect(await rrl(`${ADD} -Name L -Fqdn "EQ,a.test" -WhatIf`)).toContain(`What if: Performing the operation "${ADD}" on target "L".`);
    expect(await rrl(GET)).toBe('');
    await rrl(`${ADD} -Name L -Fqdn "EQ,a.test"`);
    expect(await rrl(`${SET} -Name L -Fqdn "EQ,b.test" -WhatIf`)).toContain(`What if: Performing the operation "${SET}" on target "L".`);
    expect(await rrl(`${REMOVE} -Name L -WhatIf`)).toContain(`What if: Performing the operation "${REMOVE}" on target "L".`);
    expect(await rrl(`(${GET} -Name L).Fqdn`)).toBe('EQ,a.test');
  });

  it.each([
    ['a name that is taken, whatever its case', (name: string) => `${ADD} -Name ${name.toUpperCase()} -Fqdn "EQ,b.test"`, EXISTS],
    ['a list with no criterion', () => `${ADD} -Name Empty`, INVALID_SETTINGS],
    ['a client subnet that is no criterion', () => `${ADD} -Name Bad -ClientSubnet "TrustedNet"`, INVALID_SUBNET],
    ['a client subnet record that does not exist', () => `${ADD} -Name Bad -ClientSubnet "EQ,Atlantis"`, INVALID_SUBNET],
    ['an FQDN that is no criterion', () => `${ADD} -Name Bad -Fqdn "*.contoso.com"`, INVALID_FQDN],
    ['an FQDN that is no name', () => `${ADD} -Name Bad -Fqdn "EQ,a..b"`, INVALID_FQDN],
    ['a wildcard that is not the first label', () => `${ADD} -Name Bad -Fqdn "EQ,a.*.b"`, INVALID_FQDN],
    ['an empty FQDN criterion', () => `${ADD} -Name Bad -Fqdn ""`, INVALID_FQDN],
    ['an interface that is no criterion', () => `${ADD} -Name Bad -ServerInterfaceIP "10.0.0.1"`, INVALID_INTERFACE],
    ['an interface that is no address', () => `${ADD} -Name Bad -ServerInterfaceIP "EQ,eth0"`, INVALID_INTERFACE],
  ])('refuses %s with the text of the Win32 error and keeps the first list', async (_label, command, message) => {
    const { rrl } = await lab();
    await rrl(`${ADD} -Name Taken -Fqdn "EQ,a.test"`);
    expect(await rrl(command('Taken'))).toContain(`${ADD} : ${message}`);
    expect(await rrl('(Get-DnsServerResponseRateLimitingExceptionlist).Name -join ","')).toBe('Taken');
  });

  it.each([
    ['sets a list that does not exist', `${SET} -Name Nope -Fqdn "EQ,a.test"`, SET, MISSING],
    ['removes a list that does not exist', `${REMOVE} -Name Nope -Force`, REMOVE, MISSING],
    ['sets an FQDN that is no name', `${SET} -Name Held -Fqdn "EQ,a..b"`, SET, INVALID_FQDN],
    ['sets an interface that is no address', `${SET} -Name Held -ServerInterfaceIP "EQ,eth0"`, SET, INVALID_INTERFACE],
    ['sets a client subnet record that does not exist', `${SET} -Name Held -ClientSubnet "EQ,Atlantis"`, SET, INVALID_SUBNET],
  ])('%s with the text of the Win32 error', async (_label, command, cmdlet, message) => {
    const { rrl } = await lab();
    await rrl(`${ADD} -Name Held -Fqdn "EQ,a.test"`);
    expect(await rrl(command)).toContain(`${cmdlet} : ${message}`);
    expect(await rrl(`(${GET} -Name Held).Fqdn`)).toBe('EQ,a.test');
  });

  it('refuses a condition that is not AND or OR, and a call with no name', async () => {
    const { rrl } = await lab();
    expect(await rrl(`${ADD} -Name L -Fqdn "EQ,a.test" -Condition XOR`)).toContain(`Cannot validate argument on parameter 'Condition'. The argument "XOR" does not belong to the set "AND,OR".`);
    await rrl(`${ADD} -Name Held -Fqdn "EQ,a.test"`);
    expect(await rrl(`${SET} -Name Held -Condition XOR`)).toContain(`${SET} : Cannot validate argument on parameter 'Condition'. The argument "XOR" does not belong to the set "AND,OR".`);
    expect(await rrl(`(${GET} -Name Held).Condition`)).toBe('And');
    expect(await rrl(`${ADD} -Fqdn "EQ,a.test"`)).toContain('missing mandatory parameters: Name.');
    expect(await rrl(`${SET} -Fqdn "EQ,a.test"`)).toContain('missing mandatory parameters: Name.');
    expect(await rrl(`${REMOVE} -Force`)).toContain('missing mandatory parameters: Name.');
    expect(await rrl(`(${GET}).Name -join ","`)).toBe('Held');
  });

  it('does not change the list when a refused call carries a condition', async () => {
    const { rrl } = await lab();
    await rrl(`${ADD} -Name L -Fqdn "EQ,a.test" -Condition AND`);
    expect(await rrl(`${SET} -Name L -Condition OR -ServerInterfaceIP "EQ,eth0"`)).toContain(INVALID_INTERFACE);
    expect(await rrl(`(${GET} -Name L).Condition`)).toBe('And');
  });
});

describe('what an exception list exempts from response rate limiting', () => {
  it('WITNESS: limits the flood of a name that no list covers, which is what the lists below lift', async () => {
    const { clientA, flood } = await enabled();
    expect(await flood(clientA, WEB, 12)).toEqual(DEFAULT_FLOOD);
  });

  it('exempts the names under a wildcard, the name of the wildcard itself included, and no other', async () => {
    const { clientA, flood, rrl } = await enabled();
    expect(await flood(clientA, WEB, 12)).toEqual(DEFAULT_FLOOD);
    expect(await flood(clientA, ['corp.test'], 12)).toEqual(DEFAULT_FLOOD);
    await rrl(`${ADD} -Name Corp -Fqdn "EQ,*.corp.test"`);
    clock.advance(10_000);
    expect(await flood(clientA, WEB, 12)).toEqual(times(12, 'answered'));
    expect(await flood(clientA, ['corp.test'], 12)).toEqual(times(12, 'answered'));
    expect(await flood(clientA, ['x.example'], 8)).toEqual([...times(5, 'refused'), 'dropped', 'truncated', 'refused']);
  });

  it('exempts the one name an EQ names and the others not', async () => {
    const { clientA, flood, rrl } = await enabled();
    await rrl(`${ADD} -Name OneName -Fqdn "EQ,mail.corp.test"`);
    expect(await flood(clientA, MAIL, 12)).toEqual(times(12, 'answered'));
    expect(await flood(clientA, WEB, 12)).toEqual(DEFAULT_FLOOD);
  });

  it('exempts every name but the one an NE names', async () => {
    const { clientA, flood, rrl } = await enabled();
    await rrl(`${ADD} -Name AllButWeb -Fqdn "NE,web.corp.test"`);
    expect(await flood(clientA, MAIL, 12)).toEqual(times(12, 'answered'));
    expect(await flood(clientA, WEB, 12)).toEqual(DEFAULT_FLOOD);
  });

  it('exempts the requestors of a client subnet record, whatever the name, and not the others', async () => {
    const { clientA, clientB, clientC, flood, rrl } = await enabled();
    await rrl(`${ADD} -Name Trusted -ClientSubnet "EQ,TrustedNet"`);
    expect(await flood(clientA, WEB, 12)).toEqual(times(12, 'answered'));
    expect(await flood(clientB, MAIL, 12)).toEqual(times(12, 'answered'));
    expect(await flood(clientC, WEB, 12)).toEqual(DEFAULT_FLOOD);
  });

  it('exempts the requestors outside the record an NE names', async () => {
    const { clientA, clientC, flood, rrl } = await enabled();
    await rrl(`${ADD} -Name Outsiders -ClientSubnet "NE,TrustedNet"`);
    expect(await flood(clientC, WEB, 12)).toEqual(times(12, 'answered'));
    expect(await flood(clientA, WEB, 12)).toEqual(DEFAULT_FLOOD);
  });

  it('follows the client subnet record when its subnets change', async () => {
    const { clientA, clientC, flood, rrl, server } = await enabled();
    await rrl(`${ADD} -Name Trusted -ClientSubnet "EQ,TrustedNet"`);
    await run(server, 'Set-DnsServerClientSubnet -Name TrustedNet -Action REPLACE -IPv4Subnet 10.0.2.0/24');
    expect(await flood(clientC, WEB, 12)).toEqual(times(12, 'answered'));
    expect(await flood(clientA, WEB, 12)).toEqual(DEFAULT_FLOOD);
  });

  it('exempts the queries received on the interface an EQ names, and not those an NE names', async () => {
    const { clientA, flood, rrl } = await enabled();
    await rrl(`${ADD} -Name Elsewhere -ServerInterfaceIP "EQ,10.0.1.99"`);
    await rrl(`${ADD} -Name NotHere -ServerInterfaceIP "NE,10.0.1.10"`);
    expect(await flood(clientA, WEB, 12)).toEqual(DEFAULT_FLOOD);
    await rrl(`${ADD} -Name Here -ServerInterfaceIP "EQ,10.0.1.10"`);
    clock.advance(10_000);
    expect(await flood(clientA, WEB, 12)).toEqual(times(12, 'answered'));
  });

  it('exempts only the queries that meet every criterion under AND, which is the default', async () => {
    const { clientA, clientC, flood, rrl } = await enabled();
    await rrl(`${ADD} -Name Both -ClientSubnet "EQ,TrustedNet" -Fqdn "EQ,mail.corp.test"`);
    expect(await flood(clientA, MAIL, 12)).toEqual(times(12, 'answered'));
    expect(await flood(clientA, WEB, 12)).toEqual(DEFAULT_FLOOD);
    expect(await flood(clientC, MAIL, 12)).toEqual(DEFAULT_FLOOD);
  });

  it('exempts the queries that meet one of the criteria under OR', async () => {
    const { clientA, clientC, flood, rrl } = await enabled();
    await rrl(`${ADD} -Name Either -ClientSubnet "EQ,TrustedNet" -Fqdn "EQ,mail.corp.test" -Condition OR`);
    expect(await flood(clientA, WEB, 12)).toEqual(times(12, 'answered'));
    expect(await flood(clientC, MAIL, 12)).toEqual(times(12, 'answered'));
    expect(await flood(clientC, WEB, 12)).toEqual(DEFAULT_FLOOD);
  });

  it('combines EQ and NE of one criterion with the condition', async () => {
    const { clientA, clientB, flood, rrl, server } = await enabled();
    await run(server, 'Add-DnsServerClientSubnet -Name Narrow -IPv4Subnet 10.0.1.2/32');
    await rrl(`${ADD} -Name Combined -ClientSubnet "EQ,TrustedNet,NE,Narrow"`);
    expect(await flood(clientB, WEB, 12)).toEqual(times(12, 'answered'));
    expect(await flood(clientA, WEB, 12)).toEqual(DEFAULT_FLOOD);
  });

  it('exempts a query when any one of the lists holds for it', async () => {
    const { clientA, clientC, flood, rrl } = await enabled();
    await rrl(`${ADD} -Name ByName -Fqdn "EQ,mail.corp.test"`);
    await rrl(`${ADD} -Name BySubnet -ClientSubnet "EQ,TrustedNet"`);
    expect(await flood(clientC, MAIL, 12)).toEqual(times(12, 'answered'));
    expect(await flood(clientA, WEB, 12)).toEqual(times(12, 'answered'));
    expect(await flood(clientC, WEB, 12)).toEqual(DEFAULT_FLOOD);
  });

  it('limits again once the list is removed, and follows a Set', async () => {
    const { clientA, flood, rrl } = await enabled();
    await rrl(`${ADD} -Name Corp -Fqdn "EQ,*.corp.test"`);
    expect(await flood(clientA, WEB, 12)).toEqual(times(12, 'answered'));
    await rrl(`${SET} -Name Corp -Fqdn "EQ,*.other.test"`);
    clock.advance(10_000);
    expect(await flood(clientA, WEB, 12)).toEqual(DEFAULT_FLOOD);
    await rrl(`${SET} -Name Corp -Fqdn "EQ,*.corp.test"`);
    clock.advance(10_000);
    expect(await flood(clientA, WEB, 12)).toEqual(times(12, 'answered'));
    await rrl(`${REMOVE} -Name Corp -Force`);
    clock.advance(10_000);
    expect(await flood(clientA, WEB, 12)).toEqual(DEFAULT_FLOOD);
  });

  it('leaves what it exempts out of RRLStatistics', async () => {
    const { clientA, flood, rrl, statistic } = await enabled();
    await rrl(`${ADD} -Name Corp -Fqdn "EQ,*.corp.test"`);
    await flood(clientA, WEB, 12);
    expect(await statistic('TotalResponsesSent')).toBe('0');
    expect(await statistic('TotalResponsesDropped')).toBe('0');
    await flood(clientA, ['x.example'], 8);
    expect(await statistic('TotalResponsesSent')).toBe('5');
  });

  it('leaves what it exempts out of the record LogOnly keeps', async () => {
    const { clientA, flood, rrl, server } = await enabled();
    await rrl('wevtutil sl Microsoft-Windows-DNSServer/Analytical /e:true');
    await rrl('Set-DnsServerRRL -Mode LogOnly');
    await rrl(`${ADD} -Name Corp -Fqdn "EQ,*.corp.test"`);
    await flood(clientA, WEB, 12);
    expect(await run(server, 'Get-WinEvent -LogName Microsoft-Windows-DNSServer/Analytical | Select-Object -ExpandProperty Id')).toBe('');
    await rrl(`${REMOVE} -Name Corp -Force`);
    clock.advance(10_000);
    await flood(clientA, WEB, 12);
    expect((await run(server, 'Get-WinEvent -LogName Microsoft-Windows-DNSServer/Analytical | Select-Object -ExpandProperty Id')).split('\n')).toHaveLength(7);
  });
});

describe('the client subnet records the lists name', () => {
  it('cannot be removed while a list names them, under EQ or under NE, and can be once it does not', async () => {
    const { rrl, server } = await lab();
    await run(server, 'Add-DnsServerClientSubnet -Name Asia -IPv4Subnet 10.2.0.0/16');
    await run(server, 'Add-DnsServerClientSubnet -Name Europe -IPv4Subnet 10.3.0.0/16');
    await rrl(`${ADD} -Name L -ClientSubnet "EQ,Asia,NE,Europe"`);
    expect(await run(server, 'Remove-DnsServerClientSubnet -Name asia -Force')).toContain(`Remove-DnsServerClientSubnet : ${SUBNET_ACCESSED}`);
    expect(await run(server, 'Remove-DnsServerClientSubnet -Name Europe -Force')).toContain(SUBNET_ACCESSED);
    expect(await run(server, '(Get-DnsServerClientSubnet).Name -join ","')).toBe('Asia,Europe');
    await rrl(`${SET} -Name L -ClientSubnet "EQ,Europe"`);
    expect(await run(server, 'Remove-DnsServerClientSubnet -Name Asia -Force')).toBe('');
    expect(await run(server, 'Remove-DnsServerClientSubnet -Name Europe -Force')).toContain(SUBNET_ACCESSED);
    await rrl(`${REMOVE} -Name L -Force`);
    expect(await run(server, 'Remove-DnsServerClientSubnet -Name Europe -Force')).toBe('');
  });

  it('NON-REGRESSION: can be removed when no list names them, and a record that does not exist still says so', async () => {
    const { rrl, server } = await lab();
    await run(server, 'Add-DnsServerClientSubnet -Name Asia -IPv4Subnet 10.2.0.0/16');
    await rrl(`${ADD} -Name L -Fqdn "EQ,asia.test"`);
    expect(await run(server, 'Remove-DnsServerClientSubnet -Name Asia -Force')).toBe('');
    expect(await run(server, 'Remove-DnsServerClientSubnet -Name Asia -Force')).toContain('The client subnet does not exist on the DNS server.');
  });
});
