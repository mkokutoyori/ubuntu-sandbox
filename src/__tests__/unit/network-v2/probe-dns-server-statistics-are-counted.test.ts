/*
 * Probe — Get-/Clear-DnsServerStatistics exist and count what a Windows DNS server really does: the queries it receives
 * and the responses it sends over UDP and TCP, per question type and response code; the queries it sends to forwarders
 * and the responses it gets; the dynamic updates it applies or refuses; the zone transfers it serves, refuses and
 * requests; the NOTIFY it sends and receives; and, per zone, the queries by record type, the transfers and the updates.
 * Clearing resets the server counters at a new LastClearTime and leaves the zone statistics alone; -ZoneName -Clear and
 * Clear-DnsServerStatistics -ZoneName reset one zone; restarting the service resets everything.
 *
 * Measured first (a Windows DNS server holding corp.test, a UDP client, a second Windows server): neither cmdlet existed,
 * and nothing in the server counted anything.
 *
 * Authority: the Windows DNS PowerShell provider classes (DnsServerStatistics and its 21 member classes, with the meaning of
 * every counter; DnsServerZoneStatistics, DnsServerZoneQueryStatistics, DnsServerZoneTransferStatistics,
 * DnsServerZoneUpdateStatistics), [MS-DNSP] DNSSRV_TIME_STATS (the time fields) and DNS_ZONE_STATS_TYPE (the 32 record
 * types), the Get-/Clear-DnsServerStatistics pages (parameter sets, -Clear on a zone, the confirmation of the clear).
 * Not sourced, said here: the default display of the nested groups (the object is returned, its members are read with
 * the usual dotted access); the page describes UpdateStatistics.Received as WINS lookups, a copy of the neighbouring class,
 * and the count here is the number of dynamic update requests; the counters of mechanisms the simulator does not have
 * (memory pools, heap, directory-server timing, WINS, NetBIOS, security contexts, packet buffers) are present and stay
 * at zero.
 *
 * Discrimination (the probe run on the tree before the change): 52 of 53 cases fall. The one that passes either way is the
 * CONTROL "the lab answers the questions the counters are about to count, over UDP and over TCP": it is the witness that
 * the lab itself is sound, the same servers, switch and client answering the same questions before the counters exist.
 * The cases of "connections, timeouts, cache and zone loads", the TCP connection pinned in "counts a TCP query apart from
 * UDP" and the timeouts of the silent forwarder were added with the counters of mechanisms the server already had: on the
 * tree before that change 7 of the 60 fall. Of the cases added then, the two that pass either way are the NON-REGRESSION
 * "keeps the cache count when the statistics are cleared" and the WITNESS "does not count a remembered name error among the
 * records the cache holds".
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
import { buildUpdateMessage } from '@/network/dns/update/DnsUpdate';
import { makeARecord } from '@/network/dns/wire/ResourceRecord';
import { makeOptRecord } from '@/network/dns/wire/EdnsOptRecord';
import { queryDnsOverUdp } from '@/network/dns/transport/DnsUdpTransport';
import { queryDnsOverTcp } from '@/network/dns/transport/DnsTcpTransport';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

const SERVER = '10.0.1.10';
const CLIENT = '10.0.1.2';
const MASTER = '10.0.1.30';
const NOBODY = '10.0.1.99';

const GROUPS = [
  'TimeStatistics', 'QueryStatistics', 'Query2Statistics', 'RecursionStatistics', 'DnssecStatistics', 'MasterStatistics',
  'SecondaryStatistics', 'WinsStatistics', 'UpdateStatistics', 'SecurityStatistics', 'DsStatistics', 'MemoryStatistics',
  'TimeoutStatistics', 'DatabaseStatistics', 'RecordStatistics', 'PacketStatistics', 'NetBiosStatistics', 'PrivateStatistics',
  'ErrorStatistics', 'CacheStatistics', 'RRLStatistics',
];

beforeEach(() => { resetCounters(); resetDeviceCounters(); Logger.clear(); });

const run = async (machine: WindowsServer, line: string): Promise<string> =>
  (await PowerShellSubShell.create(machine).subShell.processLine(line)).output.join('\n');

function question(qname: string, qtype: number = RRType.A): DnsMessage {
  return {
    id: 0x7a7a,
    flags: { qr: false, opcode: DnsOpcode.QUERY, aa: false, tc: false, rd: true, ra: false, ad: false, cd: false, rcode: DnsRcode.NOERROR },
    questions: [{ qname, qtype, qclass: DnsClass.IN }],
    answers: [], authorities: [], additionals: [],
  };
}

const nsupdate = (client: LinuxPC, key: string, secret: string, ...lines: string[]) =>
  client.executeCommand(`printf 'server ${SERVER}\\nzone corp.test\\n${lines.map((line) => `${line}\\n`).join('')}send\\n' | nsupdate -y hmac-sha256:${key}:${secret}`);

function notification(qnames: string[]): DnsMessage {
  return {
    ...question('ext.test', RRType.SOA),
    flags: { ...question('ext.test').flags, opcode: DnsOpcode.NOTIFY, aa: true, rd: false },
    questions: qnames.map((qname) => ({ qname, qtype: RRType.SOA, qclass: DnsClass.IN })),
  };
}

function nonZero(machine: WindowsServer): Record<string, number> {
  const out: Record<string, number> = {};
  const { groups } = machine.getDnsServerRole()!.getStatistics();
  for (const [group, counters] of Object.entries(groups)) {
    for (const [counter, value] of Object.entries(counters)) if (value !== 0) out[`${group}.${counter}`] = value;
  }
  return out;
}

async function eventually(condition: () => boolean, milliseconds = 8000): Promise<void> {
  const deadline = Date.now() + milliseconds;
  while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
}

async function lab() {
  const sw = new GenericSwitch('switch-generic', 'sw1', 8, 0, 0);
  const server = new WindowsServer('WNS1');
  const master = new WindowsServer('WNS2');
  const client = new LinuxPC('linux-pc', 'PC1');
  const mask = new SubnetMask('255.255.255.0');
  [server, master, client].forEach((device, index) => {
    new Cable(`c${index}`).connect(device.getPorts()[0], sw.getPorts()[index]);
    device.getPorts()[0].configureIP(new IPAddress([SERVER, MASTER, CLIENT][index]), mask);
  });
  for (const machine of [server, master]) {
    machine.setCurrentUser('Administrator');
    await run(machine, 'Install-WindowsFeature DNS');
    await run(machine, 'Set-DnsServerForwarder -UseRootHint $false');
  }
  await run(server, 'Add-DnsServerPrimaryZone -Name corp.test -DynamicUpdate NonsecureAndSecure');
  await run(server, 'Add-DnsServerResourceRecordA -ZoneName corp.test -Name web -IPv4Address 10.0.9.1');
  await run(master, 'Add-DnsServerPrimaryZone -Name ext.test');
  await run(master, 'Add-DnsServerResourceRecordA -ZoneName ext.test -Name host -IPv4Address 10.0.7.7');
  await run(master, 'Set-DnsServerPrimaryZone -Name ext.test -SecureSecondaries TransferAnyServer');
  const ask = (qname: string, qtype: number = RRType.A, target: string = SERVER) =>
    queryDnsOverUdp(client, new IPAddress(target), question(qname, qtype), 53, 9000);
  const askOverTcp = (qname: string, qtype: number = RRType.A) =>
    queryDnsOverTcp(client, new IPAddress(SERVER), question(qname, qtype), 53, 9000);
  const update = (zone: string, name: string) => queryDnsOverUdp(
    client, new IPAddress(SERVER),
    buildUpdateMessage({
      zone, zoneClass: DnsClass.IN, prerequisites: [],
      updates: [{ kind: 'add' as const, record: makeARecord(`${name}.${zone}`, 300, '10.0.7.1') }],
    }, 4242),
    53, 9000,
  );
  const send = (message: DnsMessage, timeoutMs = 9000) => queryDnsOverUdp(client, new IPAddress(SERVER), message, 53, timeoutMs);
  return { server, master, client, ask, askOverTcp, update, send };
}

const COUNTERS = (machine: WindowsServer, expression: string): Promise<string> =>
  run(machine, `(Get-DnsServerStatistics).${expression}`);

describe('the statistics surface', () => {
  it('CONTROL: the lab answers the questions the counters are about to count, over UDP and over TCP', async () => {
    const { ask, askOverTcp } = await lab();
    const udp = await ask('web.corp.test');
    const tcp = await askOverTcp('web.corp.test');
    const absent = await ask('absent.corp.test');
    expect([udp!.answers.length, tcp!.answers.length, absent!.flags.rcode]).toEqual([1, 1, DnsRcode.NXDOMAIN]);
    expect(udp!.flags).toMatchObject({ qr: true, aa: true });
  });

  it('shows the time statistics and the 20 counter groups, all at zero on a server nobody asked', async () => {
    const { server } = await lab();
    const out = await run(server, 'Get-DnsServerStatistics | Format-List');
    const names = out.split(/\r?\n/).map((line) => /^(\w+)\s*:/.exec(line)?.[1]).filter((name): name is string => name !== undefined);
    expect(names).toEqual(GROUPS);
    expect(nonZero(server)).toEqual({});
    expect(await COUNTERS(server, 'QueryStatistics.UdpQueries')).toBe('0');
    expect(await COUNTERS(server, 'UpdateStatistics.Received')).toBe('0');
  });

  it('reads one counter through the dotted access of the returned object', async () => {
    const { server, ask } = await lab();
    await ask('web.corp.test');
    expect(await COUNTERS(server, 'QueryStatistics.UdpQueries')).toBe('1');
    expect(await COUNTERS(server, 'Query2Statistics.TypeA')).toBe('1');
    expect(await COUNTERS(server, 'ErrorStatistics.NoError')).toBe('1');
  });

  it('gives the time statistics the six members of DnsServerTimeStatistics, in their order', async () => {
    const { server } = await lab();
    const out = await run(server, '(Get-DnsServerStatistics).TimeStatistics | Format-List');
    expect(out.split(/\r?\n/).filter((line) => line.includes(':')).map((line) => line.split(':')[0].trim())).toEqual([
      'TimeElapsedSinceServerStartBetweenRestart', 'TimeElapsedSinceLastClearedStatisticsBetweenRestart', 'TimeElapsedSinceServerStart',
      'TimeElapsedSinceLastClearedStatistics', 'ServerStartTime', 'LastClearTime',
    ]);
    expect(await run(server, '(Get-DnsServerStatistics).TimeStatistics.ServerStartTime -is [datetime]')).toBe('True');
  });
});

describe('what the server receives and answers', () => {
  it('counts a UDP query, its answer and its type', async () => {
    const { server, ask } = await lab();
    const reply = await ask('web.corp.test');
    expect(reply!.answers).toHaveLength(1);
    expect(nonZero(server)).toEqual({
      'QueryStatistics.UdpQueries': 1, 'QueryStatistics.UdpResponses': 1, 'Query2Statistics.TotalQueries': 1,
      'Query2Statistics.Standard': 1, 'Query2Statistics.TypeA': 1, 'ErrorStatistics.NoError': 1,
    });
  });

  it('counts a TCP query apart from UDP', async () => {
    const { server, askOverTcp } = await lab();
    const reply = await askOverTcp('web.corp.test');
    expect(reply!.answers).toHaveLength(1);
    expect(nonZero(server)).toEqual({
      'QueryStatistics.TcpClientConnections': 1, 'QueryStatistics.TcpQueries': 1, 'QueryStatistics.TcpResponses': 1,
      'Query2Statistics.TotalQueries': 1, 'Query2Statistics.Standard': 1, 'Query2Statistics.TypeA': 1, 'ErrorStatistics.NoError': 1,
    });
  });

  it.each([
    ['NS', RRType.NS, 'TypeNs'], ['SOA', RRType.SOA, 'TypeSoa'], ['MX', RRType.MX, 'TypeMx'], ['PTR', RRType.PTR, 'TypePtr'],
    ['SRV', RRType.SRV, 'TypeSrv'], ['ANY', RRType.ANY, 'TypeAll'], ['AAAA', RRType.AAAA, 'TypeOther'], ['TXT', RRType.TXT, 'TypeOther'],
  ])('puts a %s question under %s', async (_name, qtype, counter) => {
    const { server, ask } = await lab();
    await ask('web.corp.test', qtype);
    expect(nonZero(server)).toEqual({
      'QueryStatistics.UdpQueries': 1, 'QueryStatistics.UdpResponses': 1, 'Query2Statistics.TotalQueries': 1,
      'Query2Statistics.Standard': 1, [`Query2Statistics.${counter}`]: 1, 'ErrorStatistics.NoError': 1,
    });
  });

  it('counts the name error of an absent name and the refusal of a name outside every zone', async () => {
    const { server, ask } = await lab();
    await ask('absent.corp.test');
    await run(server, 'Set-DnsServerRecursion -Enable $false');
    await ask('www.elsewhere.test');
    const counters = nonZero(server);
    expect(counters['ErrorStatistics.NxDomain']).toBe(1);
    expect(counters['ErrorStatistics.Refused']).toBe(1);
    expect(counters['QueryStatistics.UdpResponses']).toBe(2);
    expect(counters['ErrorStatistics.NoError']).toBeUndefined();
  });
});

describe('dynamic updates', () => {
  it('counts an update that changed the zone, as an update request and in the zone statistics', async () => {
    const { server, update } = await lab();
    const reply = await update('corp.test', 'added');
    expect(reply!.flags.rcode).toBe(DnsRcode.NOERROR);
    expect(nonZero(server)).toEqual({
      'QueryStatistics.UdpQueries': 1, 'QueryStatistics.UdpResponses': 1, 'Query2Statistics.TotalQueries': 1,
      'Query2Statistics.Update': 1, 'ErrorStatistics.NoError': 1, 'UpdateStatistics.Received': 1, 'UpdateStatistics.Completed': 1,
    });
    const zone = await run(server, '(Get-DnsServerStatistics -ZoneName corp.test).ZoneUpdateStatistics.DynamicUpdateReceived');
    expect(zone).toBe('1');
  });

  it('counts an update without update records as empty and as changing nothing', async () => {
    const { server, client } = await lab();
    const message = buildUpdateMessage({ zone: 'corp.test', zoneClass: DnsClass.IN, prerequisites: [], updates: [] }, 4343);
    const reply = await queryDnsOverUdp(client, new IPAddress(SERVER), message, 53, 9000);
    expect(reply!.flags.rcode).toBe(DnsRcode.NOERROR);
    expect(nonZero(server)).toMatchObject({ 'UpdateStatistics.Empty': 1, 'UpdateStatistics.NoOps': 1, 'UpdateStatistics.Completed': 1 });
  });

  it('files an update under the zone whatever the case of the zone name in the message', async () => {
    const { server, update } = await lab();
    const reply = await update('CORP.TEST', 'upper');
    expect(reply!.flags.rcode).toBe(DnsRcode.NOERROR);
    expect(await run(server, '(Get-DnsServerStatistics -ZoneName corp.test).ZoneUpdateStatistics.DynamicUpdateReceived')).toBe('1');
  });

  it('counts an update signed with the wrong secret as a secure failure, not as an unsigned one', async () => {
    const { server, client } = await lab();
    await run(server, 'Add-DnsServerTsigKey -Name alice -Secret YWxpY2Utc2VjcmV0');
    await run(server, 'Set-DnsServerPrimaryZone -Name corp.test -DynamicUpdate Secure');
    await nsupdate(client, 'alice', 'Ym9iLXNlY3JldA==', 'update add forged.corp.test 300 A 10.0.6.1');
    const counters = nonZero(server);
    expect(counters['UpdateStatistics.Received']).toBe(1);
    expect(counters['UpdateStatistics.Rejected']).toBe(1);
    expect(counters['UpdateStatistics.SecureFailure']).toBe(1);
    expect(counters['UpdateStatistics.RefusedNonSecure']).toBeUndefined();
    expect(counters['UpdateStatistics.Completed']).toBeUndefined();
  });

  it('counts a signed update that changed the zone as a secure success, and refuses another key the record it owns', async () => {
    const { server, client } = await lab();
    await run(server, 'Add-DnsServerTsigKey -Name alice -Secret YWxpY2Utc2VjcmV0');
    await run(server, 'Add-DnsServerTsigKey -Name bob -Secret Ym9iLXNlY3JldA==');
    await run(server, 'Set-DnsServerPrimaryZone -Name corp.test -DynamicUpdate Secure');
    await nsupdate(client, 'alice', 'YWxpY2Utc2VjcmV0', 'update add owned.corp.test 300 A 10.0.6.1');
    expect(nonZero(server)).toMatchObject({ 'UpdateStatistics.Completed': 1, 'UpdateStatistics.SecureSuccess': 1 });
    await nsupdate(client, 'bob', 'Ym9iLXNlY3JldA==', 'update delete owned.corp.test A');
    const counters = nonZero(server);
    expect(counters).toMatchObject({
      'UpdateStatistics.Received': 2, 'UpdateStatistics.Completed': 1, 'UpdateStatistics.Rejected': 1,
      'UpdateStatistics.Refused': 1, 'UpdateStatistics.RefusedAccessDenied': 1, 'UpdateStatistics.SecureFailure': 1,
    });
    expect(counters['UpdateStatistics.RefusedNonSecure']).toBeUndefined();
  });

  it('counts an update for a zone the server does not hold as not authoritative', async () => {
    const { server, update } = await lab();
    await update('absent.test', 'x');
    const counters = nonZero(server);
    expect(counters['UpdateStatistics.Received']).toBe(1);
    expect(counters['UpdateStatistics.Rejected']).toBe(1);
    expect(counters['UpdateStatistics.NotAuthoritative']).toBe(1);
    expect(counters['UpdateStatistics.Completed']).toBeUndefined();
  });

  it('counts an unsigned update to a secure zone as refused for being non-secure', async () => {
    const { server, update } = await lab();
    await run(server, 'Set-DnsServerPrimaryZone -Name corp.test -DynamicUpdate Secure');
    await update('corp.test', 'x');
    const counters = nonZero(server);
    expect(counters['UpdateStatistics.Rejected']).toBe(1);
    expect(counters['UpdateStatistics.RefusedNonSecure']).toBe(1);
    expect(counters['UpdateStatistics.NotAuthoritative']).toBe(1);
    expect(await run(server, '(Get-DnsServerStatistics -ZoneName corp.test).ZoneUpdateStatistics.DynamicUpdateRejected')).toBe('1');
  });

  it('counts an update to a zone that takes none as refused', async () => {
    const { server, update } = await lab();
    await run(server, 'Set-DnsServerPrimaryZone -Name corp.test -DynamicUpdate None');
    await update('corp.test', 'x');
    const counters = nonZero(server);
    expect(counters['UpdateStatistics.Refused']).toBe(1);
    expect(counters['UpdateStatistics.Rejected']).toBe(1);
    expect(counters['ErrorStatistics.Refused']).toBe(1);
  });
});

describe('queries sent to forwarders', () => {
  it('counts the query to the forwarder, its answer and the recursion', async () => {
    const { server, ask } = await lab();
    await run(server, `Set-DnsServerForwarder -IPAddress ${MASTER} -UseRootHint $false`);
    const reply = await ask('host.ext.test');
    expect(reply!.answers).toHaveLength(1);
    const counters = nonZero(server);
    expect(counters).toMatchObject({
      'QueryStatistics.UdpQueries': 1, 'QueryStatistics.UdpResponses': 1, 'QueryStatistics.UdpQueriesSent': 1,
      'QueryStatistics.UdpResponsesReceived': 1, 'RecursionStatistics.QueriesRecursed': 1,
      'RecursionStatistics.OriginalQuestionRecursed': 1, 'RecursionStatistics.TotalQuestionsRecursed': 1,
      'RecursionStatistics.Forwards': 1, 'RecursionStatistics.Sends': 1, 'RecursionStatistics.Responses': 1,
      'RecursionStatistics.ResponseFromForwarder': 1, 'RecursionStatistics.ResponseAnswer': 1,
      'RecursionStatistics.ResponseAuthoritative': 1, 'ErrorStatistics.NoError': 1,
    });
    expect(counters['RecursionStatistics.ServerFailure']).toBeUndefined();
    expect(counters['RecursionStatistics.TimedoutQueries']).toBeUndefined();
  });

  it('counts a query iterated from the root hints as sent and answered, but not as forwarded', async () => {
    const { server, ask } = await lab();
    await run(server, 'foreach ($h in Get-DnsServerRootHint) { Remove-DnsServerRootHint -NameServer $h.NameServer -Force }');
    await run(server, `Add-DnsServerRootHint -NameServer a.root.test -IPAddress ${MASTER}`);
    await run(server, 'Set-DnsServerForwarder -UseRootHint $true');
    const reply = await ask('host.ext.test');
    expect(reply!.answers).toHaveLength(1);
    const counters = nonZero(server);
    expect(counters['RecursionStatistics.QueriesRecursed']).toBe(1);
    expect(counters['RecursionStatistics.Sends']).toBeGreaterThanOrEqual(1);
    expect(counters['RecursionStatistics.Responses']).toBeGreaterThanOrEqual(1);
    expect(counters['RecursionStatistics.Forwards']).toBeUndefined();
    expect(counters['RecursionStatistics.ResponseFromForwarder']).toBeUndefined();
  }, 20000);

  it('counts the failure sent to the client when the forwarder does not answer', async () => {
    const { server, ask } = await lab();
    await run(server, `Set-DnsServerForwarder -IPAddress ${NOBODY} -UseRootHint $false -Timeout 1`);
    const reply = await ask('host.ext.test');
    expect(reply!.flags.rcode).toBe(DnsRcode.SERVFAIL);
    const counters = nonZero(server);
    expect(counters['RecursionStatistics.QueriesRecursed']).toBe(1);
    expect(counters['RecursionStatistics.TimedoutQueries']).toBe(counters['RecursionStatistics.Forwards']);
    expect(counters['RecursionStatistics.ServerFailure']).toBe(1);
    expect(counters['ErrorStatistics.ServFail']).toBe(1);
    expect(counters['RecursionStatistics.Forwards']).toBeGreaterThanOrEqual(1);
    expect(counters['RecursionStatistics.Responses']).toBeUndefined();
  }, 20000);
});

describe('connections, timeouts, cache and zone loads', () => {
  it('counts the TCP connections the server accepts, one per client connection, none for UDP', async () => {
    const { server, ask, askOverTcp } = await lab();
    await ask('web.corp.test');
    expect(nonZero(server)['QueryStatistics.TcpClientConnections']).toBeUndefined();
    await askOverTcp('web.corp.test');
    await askOverTcp('web.corp.test');
    expect(nonZero(server)['QueryStatistics.TcpClientConnections']).toBe(2);
    expect(await COUNTERS(server, 'QueryStatistics.TcpClientConnections')).toBe('2');
  });

  it('counts the records the cache holds right now, and none once the cache is cleared', async () => {
    const { server, ask } = await lab();
    await run(server, `Set-DnsServerForwarder -IPAddress ${MASTER} -UseRootHint $false`);
    expect(await COUNTERS(server, 'RecordStatistics.CacheCurrent')).toBe('0');
    await ask('host.ext.test');
    expect(Number(await COUNTERS(server, 'RecordStatistics.CacheCurrent'))).toBeGreaterThanOrEqual(1);
    await run(server, 'Clear-DnsServerCache -Force');
    expect(await COUNTERS(server, 'RecordStatistics.CacheCurrent')).toBe('0');
  });

  it('does not count a remembered name error among the records the cache holds', async () => {
    const { server, ask } = await lab();
    await run(server, `Set-DnsServerForwarder -IPAddress ${MASTER} -UseRootHint $false`);
    expect((await ask('nosuch.ext.test'))!.flags.rcode).toBe(DnsRcode.NXDOMAIN);
    const sent = nonZero(server)['RecursionStatistics.Sends'];
    expect((await ask('nosuch.ext.test'))!.flags.rcode).toBe(DnsRcode.NXDOMAIN);
    expect(nonZero(server)['RecursionStatistics.Sends']).toBe(sent);
    expect(await COUNTERS(server, 'RecordStatistics.CacheCurrent')).toBe('0');
  });

  it('keeps the cache count when the statistics are cleared', async () => {
    const { server, ask } = await lab();
    await run(server, `Set-DnsServerForwarder -IPAddress ${MASTER} -UseRootHint $false`);
    await ask('host.ext.test');
    const before = await COUNTERS(server, 'RecordStatistics.CacheCurrent');
    await run(server, 'Clear-DnsServerStatistics -Force');
    expect(await COUNTERS(server, 'RecordStatistics.CacheCurrent')).toBe(before);
  });

  it('counts the zone transfer a secondary zone starts', async () => {
    const { master, server } = await lab();
    await run(master, 'Set-DnsServerPrimaryZone -Name ext.test -SecureSecondaries TransferAnyServer');
    await run(server, `Add-DnsServerSecondaryZone -Name ext.test -ZoneFile ext.test.dns -MasterServers ${MASTER}`);
    await eventually(() => (server.getDnsServerRole()!.getRecords('ext.test') ?? []).length > 0);
    expect(nonZero(server)['PrivateStatistics.ZoneLoadInit']).toBe(1);
  }, 20000);

  it('counts a transfer asked while another one runs once, when it runs, not when it is put off', async () => {
    const { master, server } = await lab();
    await run(master, 'Set-DnsServerPrimaryZone -Name ext.test -SecureSecondaries TransferAnyServer');
    const role = server.getDnsServerRole()!;
    role.addSecondaryZone('ext.test', [MASTER], 'ext.test.dns');
    role.startZoneTransfer('ext.test');
    await eventually(() => (nonZero(server)['PrivateStatistics.ZoneLoadInit'] ?? 0) >= 2);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(nonZero(server)['PrivateStatistics.ZoneLoadInit']).toBe(2);
  }, 20000);

  it('counts the zone loaded from a zone file', async () => {
    const { server } = await lab();
    await run(server, 'Add-DnsServerPrimaryZone -Name kept.test -ZoneFile kept.test.dns');
    await run(server, 'Copy-Item C:\\Windows\\System32\\dns\\kept.test.dns C:\\Windows\\System32\\dns\\saved.dns');
    await run(server, 'Remove-DnsServerZone -Name kept.test -Force');
    expect(nonZero(server)['PrivateStatistics.ZoneLoadInit']).toBeUndefined();
    await run(server, 'Add-DnsServerPrimaryZone -Name kept.test -ZoneFile saved.dns -LoadExisting');
    expect(nonZero(server)['PrivateStatistics.ZoneLoadInit']).toBe(1);
  });
});

describe('zone transfers served', () => {
  it('counts an AXFR served over TCP, in the master and zone statistics', async () => {
    const { server, askOverTcp } = await lab();
    await run(server, 'Set-DnsServerPrimaryZone -Name corp.test -SecureSecondaries TransferAnyServer');
    const reply = await askOverTcp('corp.test', RRType.AXFR);
    expect(reply!.flags.rcode).toBe(DnsRcode.NOERROR);
    const counters = nonZero(server);
    expect(counters).toMatchObject({
      'MasterStatistics.Request': 1, 'MasterStatistics.AxfrRequest': 1, 'MasterStatistics.AxfrSuccess': 1,
      'QueryStatistics.TcpQueries': 1, 'Query2Statistics.TypeAxfr': 1,
    });
    expect(counters['MasterStatistics.Refused']).toBeUndefined();
    expect(Object.keys(counters).filter((key) => key.startsWith('MasterStatistics.Ixfr'))).toEqual([]);
    const zone = await run(server, '(Get-DnsServerStatistics -ZoneName corp.test).ZoneTransferStatistics | Where-Object { $_.TransferType -eq "AXFR" } | ForEach-Object { "$($_.RequestReceived) $($_.SuccessSent)" }');
    expect(zone).toBe('1 1');
  });

  it('counts an IXFR answered with the whole zone', async () => {
    const { server, askOverTcp } = await lab();
    await run(server, 'Set-DnsServerPrimaryZone -Name corp.test -SecureSecondaries TransferAnyServer');
    await askOverTcp('corp.test', RRType.IXFR);
    expect(nonZero(server)).toMatchObject({
      'MasterStatistics.Request': 1, 'MasterStatistics.IxfrRequest': 1, 'MasterStatistics.IxfrTcpRequest': 1,
      'MasterStatistics.IxfrAxfr': 1, 'MasterStatistics.IxfrTcpSuccess': 1,
    });
  });

  it.each([
    ['a zone that does not transfer', 'NoTransfer', 'corp.test', 'RefuseShutdown'],
    ['a transfer restricted to secure servers the requester is not one of', 'TransferToSecureServers', 'corp.test', 'RefuseSecurity'],
    ['a transfer restricted to the name servers of the zone the requester is not one of', 'TransferToZoneNameServer', 'corp.test', 'RefuseSecurity'],
    ['a zone the server is not authoritative for', 'TransferAnyServer', 'absent.test', 'RefuseNotAuth'],
  ])('refuses %s', async (_label, policy, zone, reason) => {
    const { server, askOverTcp } = await lab();
    await run(server, `Set-DnsServerPrimaryZone -Name corp.test -SecureSecondaries ${policy}`);
    const reply = await askOverTcp(zone, RRType.AXFR);
    expect(reply!.flags.rcode).toBe(DnsRcode.REFUSED);
    const counters = nonZero(server);
    expect(counters['MasterStatistics.Refused']).toBe(1);
    expect(counters[`MasterStatistics.${reason}`]).toBe(1);
    expect(counters['MasterStatistics.AxfrSuccess']).toBeUndefined();
  });

  it('refuses a transfer asked over UDP without naming a reason', async () => {
    const { server, ask } = await lab();
    const reply = await ask('corp.test', RRType.AXFR);
    expect(reply!.flags.rcode).toBe(DnsRcode.REFUSED);
    const counters = nonZero(server);
    expect(counters['MasterStatistics.Refused']).toBe(1);
    expect(counters['MasterStatistics.AxfrRequest']).toBe(1);
    expect(Object.keys(counters).filter((key) => key.startsWith('MasterStatistics.Refuse') && key !== 'MasterStatistics.Refused')).toEqual([]);
    expect(Object.keys(counters).filter((key) => key.startsWith('MasterStatistics.Ixfr'))).toEqual([]);
  });
});

describe('a secondary zone and its primary', () => {
  it('counts the serial question and the transfer on both sides, then the NOTIFY and the refresh it triggers', async () => {
    const { server, master } = await lab();
    await run(server, 'Set-DnsServerPrimaryZone -Name corp.test -SecureSecondaries TransferAnyServer -Notify NotifyServers -NotifyServers ' + MASTER);
    await run(master, `Add-DnsServerSecondaryZone -Name corp.test -ZoneFile corp.test.dns -MasterServers ${SERVER}`);
    await eventually(() => (master.getDnsServerRole()!.getRecords('corp.test') ?? []).length > 0);
    const secondary = nonZero(master);
    expect(secondary).toMatchObject({
      'SecondaryStatistics.SoaRequest': 1, 'SecondaryStatistics.SoaResponse': 1, 'SecondaryStatistics.AxfrRequest': 1,
      'SecondaryStatistics.AxfrResponse': 1, 'SecondaryStatistics.AxfrSuccess': 1,
      'QueryStatistics.UdpQueriesSent': 1, 'QueryStatistics.TcpQueriesSent': 1,
      'QueryStatistics.UdpResponsesReceived': 1, 'QueryStatistics.TcpResponsesReceived': 1,
    });
    expect(nonZero(server)).toMatchObject({
      'MasterStatistics.Request': 1, 'MasterStatistics.AxfrRequest': 1, 'MasterStatistics.AxfrSuccess': 1,
      'QueryStatistics.UdpQueries': 1, 'QueryStatistics.TcpQueries': 1,
    });
    await run(server, 'Add-DnsServerResourceRecordA -ZoneName corp.test -Name later -IPv4Address 10.0.9.5');
    await eventually(() => (nonZero(master)['SecondaryStatistics.IxfrTcpSuccess'] ?? 0) >= 1);
    expect(nonZero(server)['MasterStatistics.NotifySent']).toBe(1);
    expect(nonZero(master)).toMatchObject({
      'SecondaryStatistics.NotifyReceived': 1, 'SecondaryStatistics.NotifyNonPrimary': 1, 'SecondaryStatistics.NotifyNewVersion': 1,
      'SecondaryStatistics.SoaRequest': 2, 'SecondaryStatistics.IxfrTcpRequest': 1, 'SecondaryStatistics.IxfrTcpResponse': 1,
      'SecondaryStatistics.IxfrTcpSuccess': 1,
    });
    const requested = await run(master, '(Get-DnsServerStatistics -ZoneName corp.test).ZoneTransferStatistics | ForEach-Object { "$($_.TransferType)=$($_.RequestSent)/$($_.SuccessReceived)" }');
    expect(requested).toBe('AXFR=1/1\nIXFR=1/1');
    const served = await run(server, '(Get-DnsServerStatistics -ZoneName corp.test).ZoneTransferStatistics | ForEach-Object { "$($_.TransferType)=$($_.RequestReceived)/$($_.SuccessSent)" }');
    expect(served).toBe('AXFR=1/1\nIXFR=1/1');
  }, 30000);

  it('counts a NOTIFY without exactly one question as invalid', async () => {
    const { server, send } = await lab();
    await send(notification([]), 300);
    expect(nonZero(server)).toMatchObject({ 'SecondaryStatistics.NotifyReceived': 1, 'SecondaryStatistics.NotifyInvalid': 1 });
    expect(nonZero(server)['SecondaryStatistics.NotifyNoVersion']).toBeUndefined();
  });

  it('refuses and counts a NOTIFY for a secondary zone from a sender that is not one of its masters', async () => {
    const { server, send } = await lab();
    await run(server, `Add-DnsServerSecondaryZone -Name ext.test -ZoneFile ext.test.dns -MasterServers ${MASTER}`);
    await eventually(() => (server.getDnsServerRole()!.getRecords('ext.test') ?? []).length > 0);
    const reply = await send(notification(['ext.test']));
    expect(reply!.flags.rcode).toBe(DnsRcode.REFUSED);
    expect(nonZero(server)).toMatchObject({
      'SecondaryStatistics.NotifyReceived': 1, 'SecondaryStatistics.NotifyNonPrimary': 1, 'SecondaryStatistics.NotifyMasterUnknown': 1,
    });
    expect(nonZero(server)['SecondaryStatistics.NotifyNewVersion']).toBeUndefined();
  }, 20000);

  it('counts a NOTIFY for a zone the receiver holds as primary', async () => {
    const { server, master } = await lab();
    await run(master, `Set-DnsServerPrimaryZone -Name ext.test -Notify NotifyServers -NotifyServers ${SERVER}`);
    await run(server, 'Add-DnsServerPrimaryZone -Name ext.test');
    await run(master, 'Add-DnsServerResourceRecordA -ZoneName ext.test -Name more -IPv4Address 10.0.7.8');
    await eventually(() => (nonZero(server)['SecondaryStatistics.NotifyReceived'] ?? 0) >= 1);
    expect(nonZero(server)).toMatchObject({ 'SecondaryStatistics.NotifyReceived': 1, 'SecondaryStatistics.NotifyPrimary': 1 });
    expect(nonZero(server)['MasterStatistics.NotifySent']).toBeUndefined();
  }, 20000);
});

describe('the statistics of a zone', () => {
  it('counts the queries of a zone by record type, with the name errors apart', async () => {
    const { server, ask } = await lab();
    await ask('web.corp.test');
    await ask('web.corp.test', RRType.AAAA);
    await ask('absent.corp.test', RRType.TXT);
    await ask('www.elsewhere.test');
    const out = await run(server, '(Get-DnsServerStatistics -ZoneName corp.test).ZoneQueryStatistics | Where-Object { $_.QueriesReceived -gt 0 } | ForEach-Object { "$($_.RecordType) $($_.QueriesReceived) $($_.QueriesResponded) $($_.QueriesFailure) $($_.QueriesNameError)" }');
    expect(out.split(/\r?\n/)).toEqual(['A 1 1 0 0', 'AAAA 1 1 0 0', 'TEXT 1 1 0 1']);
  });

  it('counts neither an update nor a refused transfer as a query of the zone', async () => {
    const { server, askOverTcp, update } = await lab();
    const applied = await update('corp.test', 'fresh');
    expect(applied!.flags.rcode).toBe(DnsRcode.NOERROR);
    const refused = await askOverTcp('corp.test', RRType.AXFR);
    expect(refused!.flags.rcode).toBe(DnsRcode.REFUSED);
    const queried = '(Get-DnsServerStatistics -ZoneName corp.test).ZoneQueryStatistics | Where-Object { $_.QueriesReceived -gt 0 } | ForEach-Object { $_.RecordType }';
    expect(await run(server, queried)).toBe('');
    expect(await run(server, '(Get-DnsServerStatistics -ZoneName corp.test).ZoneUpdateStatistics.DynamicUpdateReceived')).toBe('1');
    expect(await run(server, '(Get-DnsServerStatistics -ZoneName corp.test).ZoneTransferStatistics | ForEach-Object { "$($_.TransferType)=$($_.RequestReceived)" }')).toBe('AXFR=1\nIXFR=0');
  });

  it('counts a response other than a name error or a server failure as a response of the zone', async () => {
    const { server, send } = await lab();
    await run(server, 'Set-DnsServerEDns -EnableReception $false');
    const reply = await send({ ...question('web.corp.test'), additionals: [makeOptRecord(1232)] });
    expect(reply!.flags.rcode).toBe(DnsRcode.FORMERR);
    const row = '(Get-DnsServerStatistics -ZoneName corp.test).ZoneQueryStatistics | Where-Object { $_.QueriesReceived -gt 0 } | ForEach-Object { "$($_.RecordType) $($_.QueriesReceived) $($_.QueriesResponded) $($_.QueriesFailure) $($_.QueriesNameError)" }';
    expect(await run(server, row)).toBe('A 1 1 0 0');
  });

  it('shows the 32 record types, the two transfer types and the update counters', async () => {
    const { server } = await lab();
    expect(await run(server, '(Get-DnsServerStatistics -ZoneName corp.test).ZoneQueryStatistics.Count')).toBe('32');
    expect(await run(server, '(Get-DnsServerStatistics -ZoneName corp.test).ZoneTransferStatistics | ForEach-Object { $_.TransferType }')).toBe('AXFR\nIXFR');
    expect(await run(server, '(Get-DnsServerStatistics -ZoneName corp.test).Name')).toBe('corp.test');
  });

  it('finds a zone whatever the case of the name it is asked for', async () => {
    const { server } = await lab();
    expect(await run(server, '(Get-DnsServerStatistics -ZoneName CORP.TEST).Name')).toBe('corp.test');
    expect(await run(server, 'Clear-DnsServerStatistics -ZoneName CORP.TEST -Force')).toBe('');
  });

  it('answers each zone of a list and refuses the whole list when one zone is missing', async () => {
    const { server } = await lab();
    await run(server, 'Add-DnsServerPrimaryZone -Name two.test');
    expect(await run(server, 'Get-DnsServerStatistics -ZoneName corp.test,two.test | ForEach-Object { $_.Name }')).toBe('corp.test\ntwo.test');
    const refusal = await run(server, 'Get-DnsServerStatistics -ZoneName corp.test,nosuch.test');
    expect(refusal).toContain('Zone "nosuch.test" does not exist on this server.');
    expect(refusal).not.toContain('Name ');
  });

  it('reads the zone then clears it with -Clear, at a later start time', async () => {
    const { server, ask } = await lab();
    await ask('web.corp.test');
    const first = await run(server, '(Get-DnsServerStatistics -ZoneName corp.test -Clear).ZoneQueryStatistics | Where-Object { $_.RecordType -eq "A" } | ForEach-Object { $_.QueriesReceived }');
    expect(first).toBe('1');
    const second = await run(server, '(Get-DnsServerStatistics -ZoneName corp.test).ZoneQueryStatistics | Where-Object { $_.RecordType -eq "A" } | ForEach-Object { $_.QueriesReceived }');
    expect(second).toBe('0');
  });

  it('refuses -Clear without a zone name', async () => {
    const { server } = await lab();
    const out = await run(server, 'Get-DnsServerStatistics -Clear');
    expect(out).toContain('missing mandatory parameters: ZoneName');
  });
});

describe('clearing', () => {
  it('asks for a confirmation a non-interactive host cannot give, and clears with -Force', async () => {
    const { server, ask } = await lab();
    await ask('web.corp.test');
    const refused = await run(server, 'Clear-DnsServerStatistics');
    expect(refused).toContain('NonInteractive');
    expect(nonZero(server)['QueryStatistics.UdpQueries']).toBe(1);
    await run(server, 'Clear-DnsServerStatistics -Force');
    expect(nonZero(server)).toEqual({});
  });

  it('clears without asking under -Confirm:$false and does nothing under -WhatIf', async () => {
    const { server, ask } = await lab();
    await ask('web.corp.test');
    const whatIf = await run(server, 'Clear-DnsServerStatistics -WhatIf');
    expect(whatIf).toContain('What if');
    expect(whatIf).toContain('WNS1');
    expect(await run(server, 'Clear-DnsServerStatistics -ZoneName corp.test -WhatIf')).toContain('corp.test');
    expect(nonZero(server)['QueryStatistics.UdpQueries']).toBe(1);
    await run(server, 'Clear-DnsServerStatistics -Confirm:$false');
    expect(nonZero(server)).toEqual({});
  });

  it('leaves the zone statistics alone when the server statistics are cleared, and clears a zone on its own', async () => {
    const { server, ask } = await lab();
    await ask('web.corp.test');
    await run(server, 'Clear-DnsServerStatistics -Force');
    const received = '(Get-DnsServerStatistics -ZoneName corp.test).ZoneQueryStatistics | Where-Object { $_.RecordType -eq "A" } | ForEach-Object { $_.QueriesReceived }';
    expect(await run(server, received)).toBe('1');
    await run(server, 'Clear-DnsServerStatistics -ZoneName corp.test -Force');
    expect(await run(server, received)).toBe('0');
  });

  it('refuses to clear a zone that does not exist', async () => {
    const { server } = await lab();
    const out = await run(server, 'Clear-DnsServerStatistics -ZoneName nosuch.test -Force');
    expect(out).toContain('Clear-DnsServerStatistics : Zone "nosuch.test" does not exist on this server.');
  });

  it('starts counting again from zero when the service is restarted', async () => {
    const { server, ask } = await lab();
    await ask('web.corp.test');
    await run(server, 'Stop-Service DNS');
    await run(server, 'Start-Service DNS');
    expect(nonZero(server)).toEqual({});
    await ask('web.corp.test');
    expect(nonZero(server)['QueryStatistics.UdpQueries']).toBe(1);
  });

  it('counts the updates of a zone from the start of the service, before any query or reading has met it', async () => {
    const { server, update } = await lab();
    await run(server, 'Stop-Service DNS');
    await run(server, 'Start-Service DNS');
    await update('corp.test', 'after');
    expect(await run(server, '(Get-DnsServerStatistics -ZoneName corp.test).ZoneUpdateStatistics.DynamicUpdateReceived')).toBe('1');
  });

  it('gives a zone that was removed and created again fresh statistics', async () => {
    const { server, ask } = await lab();
    await run(server, 'Add-DnsServerPrimaryZone -Name two.test');
    await ask('www.two.test');
    const received = '(Get-DnsServerStatistics -ZoneName two.test).ZoneQueryStatistics | Where-Object { $_.RecordType -eq "A" } | ForEach-Object { $_.QueriesReceived }';
    expect(await run(server, received)).toBe('1');
    await run(server, 'Remove-DnsServerZone -Name two.test -Force');
    await run(server, 'Add-DnsServerPrimaryZone -Name two.test');
    expect(await run(server, received)).toBe('0');
  });

  it('forgets the statistics of a zone that is removed', async () => {
    const { server } = await lab();
    await run(server, 'Add-DnsServerPrimaryZone -Name two.test');
    await run(server, 'Remove-DnsServerZone -Name two.test -Force');
    const out = await run(server, 'Get-DnsServerStatistics -ZoneName two.test');
    expect(out).toContain('Zone "two.test" does not exist on this server.');
  });
});
