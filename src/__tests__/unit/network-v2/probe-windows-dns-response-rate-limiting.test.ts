/*
 * Probe — Get-/Set-DnsServerResponseRateLimiting exist and a Windows DNS server really limits the responses it sends over
 * UDP: per requestor network (the address masked to IPv4PrefixLength or IPv6PrefixLength), per imputed name (the wildcard
 * that matched, else the zone name when the name does not exist, else the query name) and per error flag, at most
 * ResponsesPerSec full responses in any second (ErrorsPerSec for REFUSED, FORMERR and SERVFAIL); beyond that a query
 * "would be dropped" and is dropped, answered truncated once per TruncateRate or answered in full once per LeakRate; and at
 * most MaximumResponsesPerWindow responses of any kind per WindowInSec. Mode Disable (the default) limits nothing, Enable
 * limits and counts (RRLStatistics, and ZoneRRLStatistics per zone), LogOnly counts nothing and answers everything but
 * records what Enable would have done as events 281 (dropped), 282 (truncated) and 283 (leaked) in the
 * Microsoft-Windows-DNSServer/Analytical channel, which exists from the start and is disabled until wevtutil enables it.
 * TCP answers and answers fetched by recursion are not limited.
 *
 * Measured first (a Windows DNS server holding corp.test, three UDP clients, a second Windows server): neither cmdlet
 * existed, twelve identical queries were all answered whatever was configured, RRLStatistics and ZoneRRLStatistics
 * were absent, and the analytic channel did not exist.
 *
 * Authority: [MS-DNSP] DNS_RPC_RRL_PARAMS (the parameters, their defaults, the definition of a unique response),
 * DNS_RRL_MODE_ENUM, the SetRRL operation (what is validated, the order of the errors, fSetDefault leaving the mode alone),
 * DNSSRV_RRL_STATS and DNSSRV_ZONE_RRL_STATS (the four counters, kept only when RRL is enabled), the Win32 error table
 * (9912 to 9917 and their texts), the ETW manifest and the provider keyword table of Microsoft-Windows-DNSServer (events
 * 281 to 283, the RRLArgs fields, the channel name); the Learn pages of both cmdlets (parameter sets, ranges, the
 * examples with the Get-/Set-DnsServerRRL aliases) and of the provider classes DnsServerResponseRateLimiting,
 * DnsServerRRLStatistics and DnsServerZoneRRLStatistics; ISC-TN-2012-1 (the algorithm, the rates, not for recursive servers).
 * Not sourced, said here: which of a leak and a truncation wins when both are due (the truncation), that the leak and
 * truncation cadence counts the queries over the rate since the window began, that an answer fetched by recursion and
 * a TCP answer are not limited, that Set-DnsServerResponseRateLimiting without -Mode enables (the blog says it enables with
 * default settings), the root as the imputed name of an error with no zone behind it, a Leak Rate equal to the TC Rate
 * being accepted (the operation says "less than", the error text "greater than"), TruncateRate 10 being accepted (the error
 * text says "less than 10", the cmdlet page "2 to 10"), 0 being refused for the three counts the page says are positive
 * ("The parameter is incorrect."), the QNAME of an event written with its final dot, and the message of an event being
 * the name of its keyword.
 *
 * Discrimination (the probe run on the tree before the change): 58 of 59 cases fall. The one that passes either way is the
 * CONTROL "the lab answers twelve identical queries when nothing is configured": the same servers, switch and clients
 * answering the same queries before the cmdlets exist. Every case that says a query is NOT limited, or that nothing is
 * recorded, first shows in the same lab that the limit or the record does happen, so none of them passes for want of a
 * mechanism.
 */
import { describe, it, expect } from 'vitest';
import { IPAddress } from '@/network/core/types';
import { RRType, DnsClass } from '@/network/dns/wire/RRType';
import { DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import { queryDnsOverUdp } from '@/network/dns/transport/DnsUdpTransport';
import type { WindowsServer } from '@/network/devices/WindowsServer';
import { DEFAULT_FLOOD, MASTER, SERVER, WEB, lab, question, run, times, verdictOf, virtualClock, type Verdict } from './dnsRateLimitingLab';

const clock = virtualClock();

describe('the settings of response rate limiting', () => {
  it('CONTROL: the lab answers twelve identical queries when nothing is configured', async () => {
    const { clientA, flood } = await lab();
    expect(await flood(clientA, WEB, 12)).toEqual(times(12, 'answered'));
  });

  it('reports nine members, the defaults of DNS_RPC_RRL_PARAMS and the mode off', async () => {
    const { rrl } = await lab();
    expect(await rrl('Get-DnsServerResponseRateLimiting')).toBe([
      '',
      'ResponsesPerSec           : 5',
      'ErrorsPerSec              : 5',
      'WindowInSec               : 5',
      'IPv4PrefixLength          : 24',
      'IPv6PrefixLength          : 56',
      'LeakRate                  : 3',
      'TruncateRate              : 2',
      'MaximumResponsesPerWindow : 1024',
      'Mode                      : Disable',
      '',
    ].join('\n'));
  });

  it('sets the parameters of the first example of the page and enables the mode', async () => {
    const { rrl } = await lab();
    const out = await rrl('Set-DnsServerResponseRateLimiting -WindowInSec 7 -LeakRate 4 -TruncateRate 3 -ErrorsPerSec 8 -ResponsesPerSec 8 -PassThru');
    expect(out).toContain('ResponsesPerSec           : 8');
    expect(out).toContain('ErrorsPerSec              : 8');
    expect(out).toContain('WindowInSec               : 7');
    expect(out).toContain('LeakRate                  : 4');
    expect(out).toContain('TruncateRate              : 3');
    expect(out).toContain('IPv4PrefixLength          : 24');
    expect(out).toContain('Mode                      : Enable');
  });

  it('reports each member from its own setting', async () => {
    const { rrl } = await lab();
    const out = await rrl('Set-DnsServerRRL -ResponsesPerSec 11 -ErrorsPerSec 12 -WindowInSec 13 -IPv4PrefixLength 14 -IPv6PrefixLength 15 -LeakRate 6 -TruncateRate 4 -MaximumResponsesPerWindow 16 -Mode LogOnly -PassThru');
    expect(out).toBe([
      '',
      'ResponsesPerSec           : 11',
      'ErrorsPerSec              : 12',
      'WindowInSec               : 13',
      'IPv4PrefixLength          : 14',
      'IPv6PrefixLength          : 15',
      'LeakRate                  : 6',
      'TruncateRate              : 4',
      'MaximumResponsesPerWindow : 16',
      'Mode                      : LogOnly',
      '',
    ].join('\n'));
  });

  it('writes nothing without -PassThru and enables RRL with the default settings when given no parameter', async () => {
    const { rrl } = await lab();
    expect(await rrl('Set-DnsServerResponseRateLimiting')).toBe('');
    expect(await rrl('(Get-DnsServerResponseRateLimiting).Mode')).toBe('Enable');
    expect(await rrl('(Get-DnsServerResponseRateLimiting).ResponsesPerSec')).toBe('5');
  });

  it('puts every parameter back to its default with -ResetToDefault and leaves the mode', async () => {
    const { rrl } = await lab();
    await rrl('Set-DnsServerResponseRateLimiting -ResponsesPerSec 9 -WindowInSec 9 -IPv4PrefixLength 20 -Mode LogOnly');
    await rrl('Set-DnsServerResponseRateLimiting -ResetToDefault');
    expect(await rrl('(Get-DnsServerResponseRateLimiting).ResponsesPerSec')).toBe('5');
    expect(await rrl('(Get-DnsServerResponseRateLimiting).WindowInSec')).toBe('5');
    expect(await rrl('(Get-DnsServerResponseRateLimiting).IPv4PrefixLength')).toBe('24');
    expect(await rrl('(Get-DnsServerResponseRateLimiting).Mode')).toBe('LogOnly');
  });

  it('answers to the aliases Set-DnsServerRRL and Get-DnsServerRRL of the examples', async () => {
    const { rrl } = await lab();
    expect(await rrl('Set-DnsServerRRL -Mode LogOnly')).toBe('');
    expect(await rrl('(Get-DnsServerRRL).Mode')).toBe('LogOnly');
  });

  it('feeds what Get returns to Set, by property name, as the second example of Get does', async () => {
    const { rrl } = await lab();
    await rrl('Set-DnsServerRRL -ResponsesPerSec 9 -LeakRate 6 -TruncateRate 4 -Mode LogOnly');
    expect(await rrl('$saved = Get-DnsServerRRL; Set-DnsServerRRL -ResetToDefault; Set-DnsServerRRL -Mode Disable; (Get-DnsServerRRL).ResponsesPerSec')).toBe('5');
    expect(await rrl('$saved = Get-DnsServerRRL; Set-DnsServerRRL -ResponsesPerSec 9 -LeakRate 6 -TruncateRate 4 -Mode LogOnly; $saved | Set-DnsServerRRL -Force')).toBe('');
    expect(await rrl('(Get-DnsServerRRL).ResponsesPerSec')).toBe('5');
    expect(await rrl('(Get-DnsServerRRL).LeakRate')).toBe('3');
    expect(await rrl('(Get-DnsServerRRL).Mode')).toBe('Disable');
  });

  it('disables the mode again', async () => {
    const { rrl } = await lab();
    await rrl('Set-DnsServerRRL -Mode Enable');
    await rrl('Set-DnsServerRRL -Mode Disable');
    expect(await rrl('(Get-DnsServerRRL).Mode')).toBe('Disable');
  });

  it.each([
    ['-LeakRate 1', 'The Leak Rate parameter is invalid. It should be either 0, or between 2 and 10.'],
    ['-LeakRate 11', 'The Leak Rate parameter is invalid. It should be either 0, or between 2 and 10.'],
    ['-TruncateRate 11', 'The TC Rate parameter is invalid. It should be 0, or between 2 and 10.'],
    ['-WindowInSec 0', 'The window size parameter is invalid. It should be greater than or equal to 1.'],
    ['-IPv4PrefixLength 33', 'The IPv4 prefix length parameter is invalid. It should be less than or equal to 32.'],
    ['-IPv6PrefixLength 129', 'The IPv6 prefix length parameter is invalid. It should be less than or equal to 128.'],
    ['-LeakRate 2 -TruncateRate 3', 'The Leak Rate or TC Rate parameter is invalid. Leak Rate should be greater than TC Rate.'],
    ['-TruncateRate 5', 'The Leak Rate or TC Rate parameter is invalid. Leak Rate should be greater than TC Rate.'],
    ['-ResponsesPerSec 0', 'The parameter is incorrect.'],
    ['-ErrorsPerSec 0', 'The parameter is incorrect.'],
    ['-MaximumResponsesPerWindow 0', 'The parameter is incorrect.'],
  ])('refuses %s with the text of the Win32 error', async (parameters, message) => {
    const { rrl } = await lab();
    expect(await rrl(`Set-DnsServerResponseRateLimiting ${parameters}`)).toContain(`Set-DnsServerResponseRateLimiting : ${message}`);
  });

  it('accepts the limits of the ranges and a Leak Rate equal to the TC Rate', async () => {
    const { rrl } = await lab();
    expect(await rrl('Set-DnsServerRRL -LeakRate 10 -TruncateRate 10 -IPv4PrefixLength 0 -IPv6PrefixLength 128 -WindowInSec 1')).toBe('');
    expect(await rrl('Set-DnsServerRRL -LeakRate 0 -TruncateRate 0 -IPv4PrefixLength 32 -IPv6PrefixLength 0')).toBe('');
    expect(await rrl('Set-DnsServerRRL -LeakRate 4 -TruncateRate 4')).toBe('');
  });

  it('changes nothing when it refuses', async () => {
    const { rrl } = await lab();
    await rrl('Set-DnsServerRRL -ResponsesPerSec 9 -Mode LogOnly');
    await rrl('Set-DnsServerRRL -ResponsesPerSec 7 -WindowInSec 0 -Mode Enable');
    expect(await rrl('(Get-DnsServerRRL).ResponsesPerSec')).toBe('9');
    expect(await rrl('(Get-DnsServerRRL).Mode')).toBe('LogOnly');
  });

  it('refuses a mode that is not one of the three and a number that is none', async () => {
    const { rrl } = await lab();
    expect(await rrl('Set-DnsServerRRL -Mode Bogus')).toContain('Cannot validate argument on parameter \'Mode\'. The argument "Bogus" does not belong to the set "LogOnly,Enable,Disable".');
    expect(await rrl('Set-DnsServerRRL -LeakRate abc')).toContain('Cannot convert value "abc" to type "System.UInt32"');
    expect(await rrl('(Get-DnsServerRRL).Mode')).toBe('Disable');
  });

  it('accepts the largest UInt32 and refuses the next number with the range message', async () => {
    const { rrl } = await lab();
    expect(await rrl('Set-DnsServerRRL -MaximumResponsesPerWindow 4294967295')).toBe('');
    expect(await rrl('(Get-DnsServerRRL).MaximumResponsesPerWindow')).toBe('4294967295');
    expect(await rrl('Set-DnsServerRRL -MaximumResponsesPerWindow 4294967296')).toContain('The 4294967296 argument is greater than the maximum allowed range of 4294967295.');
    expect(await rrl('(Get-DnsServerRRL).MaximumResponsesPerWindow')).toBe('4294967295');
  });

  it('asks for confirmation when the preference reaches the impact, and -Force goes without', async () => {
    const { rrl } = await lab();
    const asked = await rrl('$ConfirmPreference = "Medium"; Set-DnsServerResponseRateLimiting -Mode LogOnly');
    expect(asked).toContain('Set-DnsServerResponseRateLimiting : Windows PowerShell is in NonInteractive mode.');
    expect(await rrl('(Get-DnsServerRRL).Mode')).toBe('Disable');
    expect(await rrl('$ConfirmPreference = "Medium"; Set-DnsServerRRL -Mode LogOnly -Force')).toBe('');
    expect(await rrl('(Get-DnsServerRRL).Mode')).toBe('LogOnly');
    expect(await rrl('Set-DnsServerRRL -Mode Enable -Confirm')).toContain('NonInteractive mode');
    expect(await rrl('(Get-DnsServerRRL).Mode')).toBe('LogOnly');
  });

  it('names its target under -WhatIf and changes nothing', async () => {
    const { rrl } = await lab();
    expect(await rrl('Set-DnsServerResponseRateLimiting -WhatIf')).toContain('What if: Performing the operation "Set-DnsServerResponseRateLimiting" on target "WNS1".');
    expect(await rrl('(Get-DnsServerRRL).Mode')).toBe('Disable');
  });
});

describe('what Enable does to a flood of identical queries', () => {
  it('limits nothing in mode Disable, which is the default', async () => {
    const { clientA, flood, rrl } = await lab();
    expect(await rrl('(Get-DnsServerRRL).Mode')).toBe('Disable');
    expect(await flood(clientA, WEB, 12)).toEqual(times(12, 'answered'));
  });

  it('answers five in full, then drops, truncates and leaks by the rates', async () => {
    const { clientA, flood, rrl } = await lab();
    await rrl('Set-DnsServerRRL -Mode Enable');
    expect(await flood(clientA, WEB, 12)).toEqual(DEFAULT_FLOOD);
  });

  it('does not limit another name', async () => {
    const { clientA, flood, rrl } = await lab();
    await rrl('Set-DnsServerRRL -Mode Enable');
    expect(await flood(clientA, WEB, 12)).toEqual(DEFAULT_FLOOD);
    expect(await flood(clientA, ['mail.corp.test'], 5)).toEqual(times(5, 'answered'));
  });

  it('groups the clients of one /24 and keeps another /24 apart', async () => {
    const { clientA, clientB, clientC, flood, rrl } = await lab();
    await rrl('Set-DnsServerRRL -Mode Enable');
    await flood(clientA, WEB, 5);
    expect(await flood(clientB, WEB, 2)).toEqual(['dropped', 'truncated']);
    expect(await flood(clientC, WEB, 5)).toEqual(times(5, 'answered'));
  });

  it('follows IPv4PrefixLength: 32 separates the clients of one /24', async () => {
    const { clientA, clientB, flood, rrl } = await lab();
    await rrl('Set-DnsServerRRL -Mode Enable');
    await flood(clientA, WEB, 5);
    expect(await flood(clientB, WEB, 1)).toEqual(['dropped']);
    await rrl('Set-DnsServerRRL -IPv4PrefixLength 32');
    expect(await flood(clientB, WEB, 5)).toEqual(times(5, 'answered'));
  });

  it('gives the allowance back a second after the responses that used it, not before', async () => {
    const { clientA, flood, rrl } = await lab();
    await rrl('Set-DnsServerRRL -Mode Enable -LeakRate 0 -TruncateRate 0');
    await flood(clientA, WEB, 5);
    clock.advance(900);
    expect(await flood(clientA, WEB, 1)).toEqual(['dropped']);
    clock.advance(1200);
    expect(await flood(clientA, WEB, 1)).toEqual(['answered']);
  });

  it('counts the names a wildcard answers as one response', async () => {
    const { clientA, flood, rrl } = await lab();
    await rrl('Set-DnsServerRRL -Mode Enable');
    const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(label => `${label}.wild.corp.test`);
    expect(await flood(clientA, names)).toEqual([...times(5, 'answered'), 'dropped', 'truncated']);
  });

  it('counts the names that do not exist in a zone as one response, under the name of the zone', async () => {
    const { clientA, flood, rrl } = await lab();
    await rrl('Set-DnsServerRRL -Mode Enable');
    const names = ['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7'].map(label => `${label}.corp.test`);
    expect(await flood(clientA, names)).toEqual([...times(5, 'nxdomain'), 'dropped', 'truncated']);
  });

  it('counts an error against ErrorsPerSec, apart from the answers', async () => {
    const { clientA, flood, rrl } = await lab();
    await rrl('Set-DnsServerRRL -Mode Enable -ErrorsPerSec 2');
    const outside = ['x1.example', 'x2.example', 'x3.example', 'x4.example'];
    expect(await flood(clientA, outside)).toEqual(['refused', 'refused', 'dropped', 'truncated']);
    expect(await flood(clientA, WEB, 5)).toEqual(times(5, 'answered'));
  });

  it('counts a SERVFAIL, a REFUSED and a FORMERR each against ErrorsPerSec, under the name of their own cause', async () => {
    const { clientA, flood, rrl, server } = await lab();
    await rrl('Set-DnsServerRRL -Mode Enable -ErrorsPerSec 2');
    await run(server, `Add-DnsServerSecondaryZone -Name nozone.test -ZoneFile nozone.test.dns -MasterServers ${MASTER}`);
    const unloaded = ['a', 'b', 'c', 'd'].map(label => `${label}.nozone.test`);
    expect(await flood(clientA, unloaded)).toEqual(['servfail', 'servfail', 'dropped', 'truncated']);
    const outside = ['x1.example', 'x2.example', 'x3.example', 'x4.example'];
    expect(await flood(clientA, outside)).toEqual(['refused', 'refused', 'dropped', 'truncated']);
    clock.advance(10_000);
    const malformed = { ...question('web.corp.test'), questions: [question('web.corp.test').questions[0], question('mail.corp.test').questions[0]] };
    const verdicts: Verdict[] = [];
    for (let index = 0; index < 4; index++) verdicts.push(verdictOf(await queryDnsOverUdp(clientA, new IPAddress(SERVER), malformed, 53, 25)));
    expect(verdicts).toEqual(['formerr', 'formerr', 'dropped', 'truncated']);
  });

  it('counts a name error against ResponsesPerSec, not against ErrorsPerSec', async () => {
    const { clientA, flood, rrl } = await lab();
    await rrl('Set-DnsServerRRL -Mode Enable -ErrorsPerSec 2');
    const names = ['n1', 'n2', 'n3', 'n4', 'n5'].map(label => `${label}.corp.test`);
    expect(await flood(clientA, names, 8)).toEqual([...times(5, 'nxdomain'), 'dropped', 'truncated', 'nxdomain']);
  });

  it('does not limit an answer to a global name that is resolved by recursion', async () => {
    const { clientA, flood, rrl, server } = await lab();
    await run(server, `Set-DnsServerForwarder -IPAddress ${MASTER} -UseRootHint $false`);
    await run(server, 'Set-DnsServerGlobalNameZone -Enable $true');
    await run(server, 'Add-DnsServerPrimaryZone -Name GlobalNames');
    await run(server, 'Add-DnsServerResourceRecordCName -ZoneName GlobalNames -Name remote -HostNameAlias host.ext.test');
    await rrl('Set-DnsServerRRL -Mode Enable');
    const verdicts: Verdict[] = [];
    for (let index = 0; index < 8; index++) {
      verdicts.push(verdictOf(await queryDnsOverUdp(clientA, new IPAddress(SERVER), question('remote'), 53, 3000)));
    }
    expect(verdicts).toEqual(times(8, 'answered'));
    expect(await flood(clientA, WEB, 12)).toEqual(DEFAULT_FLOOD);
  });

  it('limits an answer taken from the global names zone by the name asked', async () => {
    const { clientA, flood, rrl, server } = await lab();
    await run(server, 'Set-DnsServerGlobalNameZone -Enable $true');
    await run(server, 'Add-DnsServerPrimaryZone -Name GlobalNames');
    await run(server, 'Add-DnsServerResourceRecordA -ZoneName GlobalNames -Name intranet -IPv4Address 10.0.9.5');
    await run(server, 'Add-DnsServerResourceRecordA -ZoneName GlobalNames -Name portal -IPv4Address 10.0.9.6');
    await rrl('Set-DnsServerRRL -Mode Enable');
    expect(await flood(clientA, ['intranet'], 12)).toEqual(DEFAULT_FLOOD);
    expect(await flood(clientA, ['portal'], 5)).toEqual(times(5, 'answered'));
  });

  it('only drops when the Leak Rate and the TC Rate are 0', async () => {
    const { clientA, flood, rrl } = await lab();
    await rrl('Set-DnsServerRRL -Mode Enable -LeakRate 0 -TruncateRate 0');
    expect(await flood(clientA, WEB, 9)).toEqual([...times(5, 'answered'), ...times(4, 'dropped')]);
  });

  it('gives no more responses than MaximumResponsesPerWindow in a window, and starts again after it', async () => {
    const { clientA, flood, rrl } = await lab();
    await rrl('Set-DnsServerRRL -Mode Enable -MaximumResponsesPerWindow 3');
    expect(await flood(clientA, WEB, 8)).toEqual([...times(3, 'answered'), ...times(5, 'dropped')]);
    clock.advance(5100);
    expect(await flood(clientA, WEB, 4)).toEqual([...times(3, 'answered'), 'dropped']);
  });

  it('sends a truncated response with the TC bit, no record and the question', async () => {
    const { clientA, ask, flood, rrl } = await lab();
    await rrl('Set-DnsServerRRL -Mode Enable');
    await flood(clientA, WEB, 6);
    const truncated = await ask(clientA, 'web.corp.test');
    expect(truncated).not.toBeNull();
    expect(truncated!.flags.tc).toBe(true);
    expect(truncated!.flags.rcode).toBe(DnsRcode.NOERROR);
    expect(truncated!.answers).toEqual([]);
    expect(truncated!.questions).toEqual([{ qname: 'web.corp.test', qtype: RRType.A, qclass: DnsClass.IN }]);
  });

  it('does not limit a TCP answer, and a TCP answer does not use the allowance', async () => {
    const { clientA, askOverTcp, flood, rrl, statistic } = await lab();
    await rrl('Set-DnsServerRRL -Mode Enable');
    await flood(clientA, WEB, 12);
    const over = await askOverTcp('web.corp.test');
    expect(over!.answers).toHaveLength(1);
    expect(over!.flags.tc).toBe(false);
    expect(await statistic('TotalResponsesSent')).toBe('5');
  });

  it('does not limit the answers fetched by recursion while it limits the zone it serves', async () => {
    const { clientA, flood, rrl, server } = await lab();
    await run(server, `Set-DnsServerForwarder -IPAddress ${MASTER} -UseRootHint $false`);
    await rrl('Set-DnsServerRRL -Mode Enable');
    const verdicts: Verdict[] = [];
    for (let index = 0; index < 8; index++) {
      verdicts.push(verdictOf(await queryDnsOverUdp(clientA, new IPAddress(SERVER), question('host.ext.test'), 53, 3000)));
    }
    expect(verdicts).toEqual(times(8, 'answered'));
    expect(await flood(clientA, WEB, 12)).toEqual(DEFAULT_FLOOD);
  });

  it('forgets the allowance when the service restarts', async () => {
    const { clientA, flood, rrl, server } = await lab();
    await rrl('Set-DnsServerRRL -Mode Enable -LeakRate 0 -TruncateRate 0');
    await flood(clientA, WEB, 6);
    await run(server, 'Restart-Service DNS');
    expect(await flood(clientA, WEB, 6)).toEqual([...times(5, 'answered'), 'dropped']);
  });

  it('counts the dropped queries as received and the dropped responses as not sent', async () => {
    const { clientA, flood, rrl, server } = await lab();
    await rrl('Set-DnsServerRRL -Mode Enable');
    await flood(clientA, WEB, 12);
    expect(await run(server, '(Get-DnsServerStatistics).QueryStatistics.UdpQueries')).toBe('12');
    expect(await run(server, '(Get-DnsServerStatistics).QueryStatistics.UdpResponses')).toBe('9');
  });
});

describe('the statistics of response rate limiting', () => {
  it('count what Enable sent, dropped, leaked and truncated, for the server', async () => {
    const { clientA, flood, rrl, statistic } = await lab();
    await rrl('Set-DnsServerRRL -Mode Enable');
    await flood(clientA, WEB, 12);
    expect(await statistic('TotalResponsesSent')).toBe('5');
    expect(await statistic('TotalResponsesDropped')).toBe('3');
    expect(await statistic('TotalResponsesLeaked')).toBe('1');
    expect(await statistic('TotalResponsesTruncated')).toBe('3');
  });

  it('open the group in the order of the class, last of the groups', async () => {
    const { rrl } = await lab();
    expect(await rrl('(Get-DnsServerStatistics).RRLStatistics | Format-List')).toBe([
      '',
      'TotalResponsesSent      : 0',
      'TotalResponsesDropped   : 0',
      'TotalResponsesLeaked    : 0',
      'TotalResponsesTruncated : 0',
      '',
    ].join('\n'));
  });

  it('count per zone, apart from another zone', async () => {
    const { clientA, flood, rrl, server } = await lab();
    await run(server, 'Add-DnsServerPrimaryZone -Name other.test');
    await run(server, 'Add-DnsServerResourceRecordA -ZoneName other.test -Name www -IPv4Address 10.0.9.9');
    await rrl('Set-DnsServerRRL -Mode Enable');
    await flood(clientA, WEB, 12);
    await flood(clientA, ['www.other.test'], 2);
    const zone = (member: string, name: string) =>
      run(server, `(Get-DnsServerStatistics -ZoneName ${name}).ZoneRRLStatistics.${member}`);
    expect(await zone('TotalResponsesSent', 'corp.test')).toBe('5');
    expect(await zone('TotalResponsesDropped', 'corp.test')).toBe('3');
    expect(await zone('TotalResponsesLeaked', 'corp.test')).toBe('1');
    expect(await zone('TotalResponsesTruncated', 'corp.test')).toBe('3');
    expect(await zone('TotalResponsesSent', 'other.test')).toBe('2');
    expect(await zone('TotalResponsesDropped', 'other.test')).toBe('0');
  });

  it('stay at zero in mode LogOnly and in mode Disable', async () => {
    const { clientA, flood, rrl, statistic } = await lab();
    await flood(clientA, WEB, 12);
    await rrl('Set-DnsServerRRL -Mode LogOnly');
    clock.advance(10_000);
    await flood(clientA, WEB, 12);
    expect(await statistic('TotalResponsesSent')).toBe('0');
    expect(await statistic('TotalResponsesDropped')).toBe('0');
  });

  it('are cleared with the server statistics and with the service', async () => {
    const { clientA, flood, rrl, statistic, server } = await lab();
    await rrl('Set-DnsServerRRL -Mode Enable');
    await flood(clientA, WEB, 12);
    await run(server, 'Clear-DnsServerStatistics -Force');
    expect(await statistic('TotalResponsesSent')).toBe('0');
    clock.advance(10_000);
    await flood(clientA, WEB, 6);
    expect(await statistic('TotalResponsesSent')).toBe('5');
    await run(server, 'Restart-Service DNS');
    expect(await statistic('TotalResponsesSent')).toBe('0');
  });

  it('are cleared for one zone by Clear-DnsServerStatistics -ZoneName', async () => {
    const { clientA, flood, rrl, server } = await lab();
    await rrl('Set-DnsServerRRL -Mode Enable');
    await flood(clientA, WEB, 12);
    await run(server, 'Clear-DnsServerStatistics -ZoneName corp.test -Force');
    expect(await run(server, '(Get-DnsServerStatistics -ZoneName corp.test).ZoneRRLStatistics.TotalResponsesSent')).toBe('0');
    expect(await run(server, '(Get-DnsServerStatistics).RRLStatistics.TotalResponsesSent')).toBe('5');
  });
});

describe('the mode LogOnly', () => {
  const ANALYTICAL = 'Microsoft-Windows-DNSServer/Analytical';
  const events = (machine: WindowsServer) =>
    run(machine, `Get-WinEvent -LogName ${ANALYTICAL} | Select-Object -ExpandProperty Id`);

  it('answers every query in full', async () => {
    const { clientA, flood, rrl } = await lab();
    await rrl('Set-DnsServerRRL -Mode LogOnly');
    expect(await rrl('(Get-DnsServerRRL).Mode')).toBe('LogOnly');
    expect(await flood(clientA, WEB, 12)).toEqual(times(12, 'answered'));
  });

  it('has an analytic channel that exists and is disabled until it is enabled', async () => {
    const { rrl } = await lab();
    const channel = await rrl(`wevtutil gl ${ANALYTICAL}`);
    expect(channel).toContain(`name: ${ANALYTICAL}`);
    expect(channel).toContain('enabled: false');
    expect(channel).toContain('type: Analytic');
  });

  it('records nothing while the channel is disabled', async () => {
    const { clientA, flood, rrl, server } = await lab();
    await rrl('Set-DnsServerRRL -Mode LogOnly');
    await flood(clientA, WEB, 12);
    expect(await events(server)).toBe('');
    await rrl(`wevtutil sl ${ANALYTICAL} /e:true`);
    clock.advance(10_000);
    await flood(clientA, WEB, 12);
    expect((await events(server)).split('\n')).toHaveLength(7);
  });

  it('records what Enable would have dropped, truncated and leaked once the channel is enabled', async () => {
    const { clientA, flood, rrl, server } = await lab();
    await rrl(`wevtutil sl ${ANALYTICAL} /e:true`);
    await rrl('Set-DnsServerRRL -Mode LogOnly');
    await flood(clientA, WEB, 12);
    expect((await events(server)).split('\n').reverse()).toEqual(['281', '282', '283', '282', '281', '282', '281']);
  });

  it('names each event after its keyword, with the provider and the level of the manifest', async () => {
    const { clientA, flood, rrl, server } = await lab();
    await rrl(`wevtutil sl ${ANALYTICAL} /e:true`);
    await rrl('Set-DnsServerRRL -Mode LogOnly');
    await flood(clientA, WEB, 9);
    const rows = await run(server, `Get-WinEvent -LogName ${ANALYTICAL} | ForEach-Object { "$($_.Id) $($_.Message) $($_.ProviderName) $($_.LevelDisplayName)" }`);
    const seen = new Set(rows.split('\n'));
    expect(seen).toEqual(new Set([
      '281 RRL_TO_BE_DROPPED_RESPONSE Microsoft-Windows-DNSServer Information',
      '282 RRL_TO_BE_TRUNCATED_RESPONSE Microsoft-Windows-DNSServer Information',
      '283 RRL_TO_BE_LEAKED_RESPONSE Microsoft-Windows-DNSServer Information',
    ]));
  });

  it('fills the fields of the event: interface, requestor, name, type, id, response code, port, size and packet', async () => {
    const { clientA, flood, rrl, server } = await lab();
    await rrl(`wevtutil sl ${ANALYTICAL} /e:true`);
    await rrl('Set-DnsServerRRL -Mode LogOnly');
    await flood(clientA, WEB, 6);
    const properties = await run(server, `(Get-WinEvent -LogName ${ANALYTICAL} -MaxEvents 1).Properties -join "|"`);
    const [interfaceIp, destination, qname, qtype, xid, rcode, port, size, packet] = properties.split('|');
    expect([interfaceIp, destination, qname, qtype, xid, rcode]).toEqual([SERVER, '10.0.1.2', 'web.corp.test.', '1', String(0x7a7a), '0']);
    expect(Number(port)).toBeGreaterThan(0);
    expect(packet).toMatch(/^7a7a[0-9a-f]+$/);
    expect(Number(size)).toBe(packet.length / 2);
    expect(await run(server, `(Get-WinEvent -LogName ${ANALYTICAL} -MaxEvents 1).Message`)).toBe('RRL_TO_BE_DROPPED_RESPONSE');
  });

  it('records nothing in mode Enable and in mode Disable', async () => {
    const { clientA, flood, rrl, server } = await lab();
    await rrl(`wevtutil sl ${ANALYTICAL} /e:true`);
    await flood(clientA, WEB, 8);
    await rrl('Set-DnsServerRRL -Mode Enable');
    clock.advance(10_000);
    await flood(clientA, WEB, 8);
    expect(await events(server)).toBe('');
    await rrl('Set-DnsServerRRL -Mode LogOnly');
    clock.advance(10_000);
    await flood(clientA, WEB, 8);
    expect((await events(server)).split('\n')).toHaveLength(3);
  });
});
