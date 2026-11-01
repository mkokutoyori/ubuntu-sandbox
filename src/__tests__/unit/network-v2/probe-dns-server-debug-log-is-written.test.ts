/*
 * Probe — Get-/Set-DnsServerDiagnostics exist, keep their 28 properties in the registry under the names and bits of
 * [MS-DNSP] (LogLevel, OperationsLogLevel, OperationsLogLevel2, EventLogLevel, UseSystemEventLog, LogFilePath,
 * LogFileMaxSize, LogIPFilterList), and the Windows DNS server writes the debug log those bits ask for: dns.log, in the
 * system32\dns directory unless LogFilePath says otherwise, with the header and the key of the real file, one PACKET line
 * per packet that passes the four independent filters of DNS_LOG_LEVELS (content, type, direction, transport), only for
 * the remote addresses of LogIPFilterList, restarted when it reaches LogFileMaxSize.
 *
 * Measured first (a Windows DNS server holding corp.test, a UDP client): neither cmdlet existed, no dns.log was ever
 * created, whatever was configured; the packets the server receives, sends, forwards, notifies and transfers left no trace.
 *
 * Authority: Microsoft Learn, Get-DnsServerDiagnostics / Set-DnsServerDiagnostics (the default sample of 28 properties
 * in order, the effect of -All in the Windows Server DNS logging article: every flag on, EventLogLevel 7, rollover on,
 * UseSystemEventLog, MaxMBFileSize and LogFilePath untouched); [MS-DNSP] 2.2.9.1.1 DNS_LOG_LEVELS (the four filters,
 * "a packet is logged only if allowed by all filters"), 2.2.9.1.2 and 3.1.1.1.1 (OperationsLogLevel bits, LogFileMaxSize:
 * "delete the log file and create a new log file", zero literal); dnscmd /config /logfilepath, /logipfilterlist. The
 * line format (date, time, thread, PACKET, internal identifier, UDP/TCP, Snd/Rcv, remote IP, Xid, R, opcode letter,
 * [flags hex, flag letters, response code], question type, name in length-prefixed labels) and the key table are those of
 * published dns.log transcripts; the flags hex is the Windows internal header word (the wire flags with their two
 * bytes swapped: a recursive query is 0001, an authoritative recursive answer 8085). Not sourced, said here: the two
 * first header lines (creation and wrap times) and the tab before the key rows, the tab-less rest, the thread
 * and packet identifiers (any stable value), the registry name of EnableLogFileRollover, the default of
 * OperationsLogLevel (0x10: EnableLoggingToFile is True in the Microsoft sample, [MS-DNSP] says 0).
 * Stored, shown, NOT evaluated (no source for the output, or nothing in the simulator to produce it): FullPackets (the
 * packet dump layout), the operational log lines of OperationsLogLevel, EventLogLevel and UseSystemEventLog (the DNS role
 * writes no events), EnableLogFileRollover (the name of the archived file), WriteThrough, UnmatchedResponse,
 * SaveLogsToPersistentStorage.
 *
 * Discrimination (the probe run on the tree before the change): 54 of 55 cases fall. The one that passes either way is
 * the CONTROL "no dns.log exists while no packet class is enabled, although the server answered": the file is absent
 * before and after, and the same case asserts that the lab answered the datagram, so an absent file cannot be a lab
 * that never ran. The cases that read the log after a query are the witness of the same lab on the changed tree.
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
import { DnsOpcode, DnsRcode, encodeDnsHeaderFlags } from '@/network/dns/wire/DnsHeaderFlags';
import { buildUpdateMessage } from '@/network/dns/update/DnsUpdate';
import { makeARecord } from '@/network/dns/wire/ResourceRecord';
import { queryDnsOverUdp } from '@/network/dns/transport/DnsUdpTransport';
import { queryDnsOverTcp } from '@/network/dns/transport/DnsTcpTransport';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

const PARAMETERS = 'HKLM\\SYSTEM\\CurrentControlSet\\Services\\DNS\\Parameters';
const LOG = 'C:\\Windows\\System32\\dns\\dns.log';
const SERVER = '10.0.1.10';
const CLIENT = '10.0.1.2';
const MASTER = '10.0.1.30';

const EVERYTHING = '-Queries $true -Answers $true -QuestionTransactions $true -ReceivePackets $true -SendPackets $true -UdpPackets $true -TcpPackets $true';

beforeEach(() => { resetCounters(); resetDeviceCounters(); Logger.clear(); });

const run = async (machine: WindowsServer, line: string): Promise<string> =>
  (await PowerShellSubShell.create(machine).subShell.processLine(line)).output.join('\n');

function question(qname: string, qtype: number = RRType.A, rd = true): DnsMessage {
  return {
    id: 0xd8dd,
    flags: { qr: false, opcode: DnsOpcode.QUERY, aa: false, tc: false, rd, ra: false, ad: false, cd: false, rcode: DnsRcode.NOERROR },
    questions: [{ qname, qtype, qclass: DnsClass.IN }],
    answers: [], authorities: [], additionals: [],
  };
}

interface Packet {
  readonly raw: string;
  readonly stamp: string;
  readonly thread: string;
  readonly identifier: string;
  readonly transport: string;
  readonly direction: string;
  readonly remote: string;
  readonly xid: string;
  readonly response: boolean;
  readonly opcode: string;
  readonly flags: string;
  readonly letters: string;
  readonly rcode: string;
  readonly type: string;
  readonly name: string;
}

const PACKET = /^(\d+\/\d+\/\d{4} \d+:\d{2}:\d{2} (?:AM|PM)) ([0-9A-F]{4}) PACKET {2}([0-9A-F]{16}) (UDP|TCP) (Snd|Rcv) (\S+) +([0-9a-f]{4}) ([R ]) ([QNU?]) \[([0-9a-f]{4}) (.{5}) (\w+)\] (\S+) +(\S+)$/;

function packetsIn(machine: WindowsServer, path: string = LOG): Packet[] {
  const file = machine.getFileSystem().readFile(path);
  return (file.ok ? file.content ?? '' : '').split('\r\n').filter((line) => line.includes(' PACKET  ')).map((raw) => {
    const match = PACKET.exec(raw);
    if (match === null) throw new Error(`not a dns.log packet line: ${JSON.stringify(raw)}`);
    return {
      raw, stamp: match[1], thread: match[2], identifier: match[3], transport: match[4], direction: match[5], remote: match[6],
      xid: match[7], response: match[8] === 'R', opcode: match[9], flags: match[10], letters: match[11], rcode: match[12],
      type: match[13], name: match[14],
    };
  });
}

const summary = (packets: readonly Packet[]): string[] =>
  packets.map((packet) => `${packet.transport} ${packet.direction} ${packet.remote} ${packet.response ? 'R' : 'Q'} ${packet.opcode} ${packet.type} ${packet.name}`);

const swapBytes = (flags: DnsMessage['flags']): string => {
  const wire = encodeDnsHeaderFlags(flags);
  return ((((wire & 0xff) << 8) | (wire >> 8)) >>> 0).toString(16).padStart(4, '0');
};

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
  for (const name of ['web', 'a1', 'a2', 'a3']) {
    await run(server, `Add-DnsServerResourceRecordA -ZoneName corp.test -Name ${name} -IPv4Address 10.0.9.1`);
  }
  await run(master, 'Add-DnsServerPrimaryZone -Name ext.test');
  await run(master, 'Add-DnsServerResourceRecordA -ZoneName ext.test -Name host -IPv4Address 10.0.7.7');
  await run(master, 'Set-DnsServerPrimaryZone -Name ext.test -SecureSecondaries TransferAnyServer');
  const ask = (qname: string, qtype: number = RRType.A, rd = true) =>
    queryDnsOverUdp(client, new IPAddress(SERVER), question(qname, qtype, rd), 53, 9000);
  const askOverTcp = (qname: string) => queryDnsOverTcp(client, new IPAddress(SERVER), question(qname), 53, 9000);
  const update = (name: string) => queryDnsOverUdp(
    client, new IPAddress(SERVER),
    buildUpdateMessage({
      zone: 'corp.test', zoneClass: DnsClass.IN, prerequisites: [],
      updates: [{ kind: 'add' as const, record: makeARecord(name, 300, '10.0.7.1') }],
    }, 4242),
    53, 9000,
  );
  return { server, master, client, ask, askOverTcp, update };
}

const DEFAULT_PROPERTIES = [
  'SaveLogsToPersistentStorage', 'Queries', 'Answers', 'Notifications', 'Update', 'QuestionTransactions', 'UnmatchedResponse',
  'SendPackets', 'ReceivePackets', 'TcpPackets', 'UdpPackets', 'FullPackets', 'FilterIPAddressList', 'EventLogLevel',
  'UseSystemEventLog', 'EnableLoggingToFile', 'EnableLogFileRollover', 'LogFilePath', 'MaxMBFileSize', 'WriteThrough',
  'EnableLoggingForLocalLookupEvent', 'EnableLoggingForPluginDllEvent', 'EnableLoggingForRecursiveLookupEvent',
  'EnableLoggingForRemoteServerEvent', 'EnableLoggingForServerStartStopEvent', 'EnableLoggingForTombstoneEvent',
  'EnableLoggingForZoneDataWriteEvent', 'EnableLoggingForZoneLoadingEvent',
];

const propertyNames = (out: string): string[] =>
  out.split(/\r?\n/).map((line) => line.split(':')[0].trim()).filter((name) => name !== '');

describe('the diagnostics surface', () => {
  it('shows the 28 properties of the Microsoft sample, in its order, with its defaults', async () => {
    const { server } = await lab();
    const out = await run(server, 'Get-DnsServerDiagnostics');
    expect(propertyNames(out)).toEqual(DEFAULT_PROPERTIES);
    expect(out).toMatch(/EventLogLevel\s+:\s+4\n/);
    expect(out).toMatch(/EnableLoggingToFile\s+:\s+True/);
    expect(out).toMatch(/MaxMBFileSize\s+:\s+500000000/);
    expect(out).toMatch(/UseSystemEventLog\s+:\s+False/);
    expect(out).toMatch(/FilterIPAddressList\s+:\s*\n/);
    expect(out.match(/:\s+True/g)).toHaveLength(1);
  });

  it('-All $true switches every flag on, raises EventLogLevel to 7 and the rollover on, and leaves the paths alone', async () => {
    const { server } = await lab();
    await run(server, 'Set-DnsServerDiagnostics -LogFilePath "dnsdebug.log" -MaxMBFileSize 1234567');
    await run(server, 'Set-DnsServerDiagnostics -All $true');
    const out = await run(server, 'Get-DnsServerDiagnostics');
    expect(propertyNames(out)).toEqual(DEFAULT_PROPERTIES);
    const flags = DEFAULT_PROPERTIES.filter((name) => new RegExp(`^${name}\\s+:\\s+True$`, 'm').test(out));
    expect(flags).toHaveLength(23);
    expect(out).toMatch(/UseSystemEventLog\s+:\s+False/);
    expect(out).toMatch(/EventLogLevel\s+:\s+7/);
    expect(out).toMatch(/LogFilePath\s+:\s+dnsdebug\.log/);
    expect(out).toMatch(/MaxMBFileSize\s+:\s+1234567/);
    const registry = await server.executeCommand(`reg query ${PARAMETERS}`);
    expect(registry).toMatch(/LogLevel\s+REG_DWORD\s+0x8300f331/);
    expect(registry).toMatch(/OperationsLogLevel\s+REG_DWORD\s+0x[0-9a-f]+/);
  });

  it('-All $false switches the flags off again', async () => {
    const { server } = await lab();
    await run(server, 'Set-DnsServerDiagnostics -All $true');
    await run(server, 'Set-DnsServerDiagnostics -All $false');
    const out = await run(server, 'Get-DnsServerDiagnostics');
    expect(out.match(/:\s+True/g)).toBeNull();
    const registry = await server.executeCommand(`reg query ${PARAMETERS}`);
    expect(registry).toMatch(/LogLevel\s+REG_DWORD\s+0x0\b/);
  });

  it('Example 1 of the Microsoft page: the four parameters set their four properties and nothing else', async () => {
    const { server } = await lab();
    await run(server, 'Set-DnsServerDiagnostics -SendPackets $True -TcpPackets $True -Answers $True -Updates $True');
    const out = await run(server, 'Get-DnsServerDiagnostics');
    const on = DEFAULT_PROPERTIES.filter((name) => new RegExp(`^${name}\\s+:\\s+True$`, 'm').test(out));
    expect(on.sort()).toEqual(['Answers', 'EnableLoggingToFile', 'SendPackets', 'TcpPackets', 'Update']);
    expect(await server.executeCommand(`reg query ${PARAMETERS}`)).toMatch(/LogLevel\s+REG_DWORD\s+0x9220/);
  });

  it.each([
    ['Queries', 'LogLevel', 0x1], ['Notifications', 'LogLevel', 0x10], ['Updates', 'LogLevel', 0x20],
    ['QuestionTransactions', 'LogLevel', 0x100], ['Answers', 'LogLevel', 0x200], ['SendPackets', 'LogLevel', 0x1000],
    ['ReceivePackets', 'LogLevel', 0x2000], ['UdpPackets', 'LogLevel', 0x4000], ['TcpPackets', 'LogLevel', 0x8000],
    ['FullPackets', 'LogLevel', 0x1000000], ['UnmatchedResponse', 'LogLevel', 0x2000000], ['WriteThrough', 'LogLevel', 0x80000000],
    ['SaveLogsToPersistentStorage', 'OperationsLogLevel', 0x11],
    ['EnableLoggingForServerStartStopEvent', 'OperationsLogLevel', 0x30],
    ['EnableLoggingForZoneLoadingEvent', 'OperationsLogLevel', 0x2010],
    ['EnableLoggingForZoneDataWriteEvent', 'OperationsLogLevel', 0x4010],
    ['EnableLoggingForTombstoneEvent', 'OperationsLogLevel', 0x20010],
    ['EnableLoggingForLocalLookupEvent', 'OperationsLogLevel', 0x100010],
    ['EnableLoggingForRecursiveLookupEvent', 'OperationsLogLevel', 0x200010],
    ['EnableLoggingForRemoteServerEvent', 'OperationsLogLevel', 0x400010],
    ['EnableLoggingForPluginDllEvent', 'OperationsLogLevel2', 0x1000000],
  ])('-%s on sets the bit of [MS-DNSP] in %s', async (parameter, word, expected) => {
    const { server } = await lab();
    await run(server, `Set-DnsServerDiagnostics -${parameter} $true`);
    const registry = await server.executeCommand(`reg query ${PARAMETERS}`);
    expect(registry).toMatch(new RegExp(`\\b${word}\\s+REG_DWORD\\s+0x${expected.toString(16)}\\b`));
  });

  it('-EnableLoggingToFile $false clears the event bit of OperationsLogLevel', async () => {
    const { server } = await lab();
    await run(server, 'Set-DnsServerDiagnostics -EnableLoggingToFile $false');
    expect(await server.executeCommand(`reg query ${PARAMETERS}`)).toMatch(/OperationsLogLevel\s+REG_DWORD\s+0x0\b/);
    expect(await run(server, '(Get-DnsServerDiagnostics).EnableLoggingToFile')).toBe('False');
  });

  it('-DebugLogging and the operation levels replace the whole word', async () => {
    const { server } = await lab();
    await run(server, 'Set-DnsServerDiagnostics -Queries $true -UdpPackets $true');
    await run(server, 'Set-DnsServerDiagnostics -DebugLogging 0x2000 -OperationLogLevel1 0x20 -OperationLogLevel2 0x1000000');
    const out = await run(server, 'Get-DnsServerDiagnostics');
    const on = DEFAULT_PROPERTIES.filter((name) => new RegExp(`^${name}\\s+:\\s+True$`, 'm').test(out));
    expect(on.sort()).toEqual(['EnableLoggingForPluginDllEvent', 'EnableLoggingForServerStartStopEvent', 'ReceivePackets']);
    const registry = await server.executeCommand(`reg query ${PARAMETERS}`);
    expect(registry).toMatch(/\bLogLevel\s+REG_DWORD\s+0x2000\b/);
    expect(registry).toMatch(/OperationsLogLevel\s+REG_DWORD\s+0x20\b/);
    expect(registry).toMatch(/OperationsLogLevel2\s+REG_DWORD\s+0x1000000\b/);
  });

  it('the paths, the size and the address filter go to the registry under the names of the protocol', async () => {
    const { server } = await lab();
    await run(server, 'Set-DnsServerDiagnostics -LogFilePath "C:\\logs\\dns.log" -MaxMBFileSize 2000000 -IPFilterList "10.0.1.2","10.0.1.99" -EventLogLevel 2 -UseSystemEventLog $true -EnableLogFileRollover $true');
    const registry = await server.executeCommand(`reg query ${PARAMETERS}`);
    expect(registry).toMatch(/LogFilePath\s+REG_SZ\s+C:\\logs\\dns\.log/);
    expect(registry).toMatch(/LogFileMaxSize\s+REG_DWORD\s+0x1e8480/);
    expect(registry).toMatch(/LogIPFilterList\s+REG_MULTI_SZ\s+10\.0\.1\.2\\010\.0\.1\.99/);
    expect(registry).toMatch(/EventLogLevel\s+REG_DWORD\s+0x2/);
    expect(registry).toMatch(/UseSystemEventLog\s+REG_DWORD\s+0x1/);
    expect(registry).not.toMatch(/\bLogLevel\b/);
    expect(registry).not.toMatch(/OperationsLogLevel/);
    const out = await run(server, 'Get-DnsServerDiagnostics');
    expect(out).toMatch(/FilterIPAddressList\s+:\s+\{10\.0\.1\.2, 10\.0\.1\.99\}/);
    expect(out).toMatch(/EventLogLevel\s+:\s+2/);
    expect(out).toMatch(/EnableLogFileRollover\s+:\s+True/);
  });

  it('a value written with reg.exe is what Get-DnsServerDiagnostics reads', async () => {
    const { server } = await lab();
    await server.executeCommand(`reg add ${PARAMETERS} /v LogLevel /t REG_DWORD /d 0x4201 /f`);
    const out = await run(server, 'Get-DnsServerDiagnostics');
    const on = DEFAULT_PROPERTIES.filter((name) => new RegExp(`^${name}\\s+:\\s+True$`, 'm').test(out));
    expect(on.sort()).toEqual(['Answers', 'EnableLoggingToFile', 'Queries', 'UdpPackets']);
  });

  it('refuses an address that is not an IPv4 address, and a number that is not a UInt32, writing nothing', async () => {
    const { server } = await lab();
    const before = await server.executeCommand(`reg query ${PARAMETERS}`);
    expect(await run(server, 'Set-DnsServerDiagnostics -Queries $true -IPFilterList "999.1.1.1"')).toContain('"999.1.1.1" is not a valid IPv4 address.');
    expect(await run(server, 'Set-DnsServerDiagnostics -MaxMBFileSize -5')).toContain('Value was either too large or too small for a UInt32.');
    expect(await run(server, 'Set-DnsServerDiagnostics -MaxMBFileSize 4294967296')).toContain('Value was either too large or too small for a UInt32.');
    expect(await run(server, 'Set-DnsServerDiagnostics -EventLogLevel abc')).toContain('Input string was not in a correct format.');
    expect(await server.executeCommand(`reg query ${PARAMETERS}`)).toBe(before);
  });

  it('refuses parameters of two parameter sets in one call, writing nothing', async () => {
    const { server } = await lab();
    const before = await server.executeCommand(`reg query ${PARAMETERS}`);
    expect(await run(server, 'Set-DnsServerDiagnostics -All $true -Queries $true')).toContain('Parameter set cannot be resolved using the specified named parameters.');
    expect(await run(server, 'Set-DnsServerDiagnostics -DebugLogging 1 -Queries $true')).toContain('Parameter set cannot be resolved using the specified named parameters.');
    expect(await server.executeCommand(`reg query ${PARAMETERS}`)).toBe(before);
  });

  it('-PassThru returns the settings, and the properties of a piped object bind by name', async () => {
    const { server } = await lab();
    expect(await run(server, 'Set-DnsServerDiagnostics -Queries $true -PassThru')).toMatch(/Queries\s+:\s+True/);
    await run(server, 'Set-DnsServerDiagnostics -TcpPackets $true -UdpPackets $true');
    await run(server, '[pscustomobject]@{ TcpPackets = $false; UdpPackets = $false } | Set-DnsServerDiagnostics');
    const out = await run(server, 'Get-DnsServerDiagnostics');
    expect(out).toMatch(/TcpPackets\s+:\s+False/);
    expect(out).toMatch(/UdpPackets\s+:\s+False/);
    expect(out).toMatch(/Queries\s+:\s+True/);
  });
});

describe('the file the server writes', () => {
  it('CONTROL: no dns.log exists while no packet class is enabled, although the server answered', async () => {
    const { server, ask } = await lab();
    const reply = await ask('web.corp.test');
    expect(reply!.answers.map((record) => record.name)).toEqual(['web.corp.test']);
    expect(server.getFileSystem().readFile(LOG).ok).toBe(false);
  });

  it('a query and its answer are two PACKET lines with the format of the real file, after the header and the key', async () => {
    const { server, ask } = await lab();
    await run(server, `Set-DnsServerDiagnostics ${EVERYTHING}`);
    const reply = await ask('web.corp.test');
    const text = server.getFileSystem().readFile(LOG).content ?? '';
    expect(text).toMatch(/^DNS Server log file creation at \d+\/\d+\/\d{4} \d+:\d{2}:\d{2} (AM|PM)\r\nLog file wrap at /);
    expect(text).toContain('Message logging key (for packets - other items use a subset of these fields):\r\n');
    expect(text).toContain('\t  10     Query/Response      R = Response\r\n\t                             blank = Query\r\n');
    expect(text).toContain('\t  13     Flags (char codes)  A = Authoritative Answer\r\n\t                             T = Truncated Response\r\n');
    expect(text).toContain('\t  16     Question Name\r\n\r\n');
    const [received, sent] = packetsIn(server);
    expect(packetsIn(server)).toHaveLength(2);
    expect(received.raw).toMatch(/ UDP Rcv 10\.0\.1\.2 {8}d8dd {3}Q \[0001 {3}D {3}NOERROR\] A {6}\(3\)web\(4\)corp\(4\)test\(0\)$/);
    expect(sent.raw).toMatch(/ UDP Snd 10\.0\.1\.2 {8}d8dd R Q \[[0-9a-f]{4} .{5} NOERROR\] A {6}\(3\)web\(4\)corp\(4\)test\(0\)$/);
    expect(sent.flags).toBe(swapBytes(reply!.flags));
    expect(sent.letters).toBe(`A${reply!.flags.tc ? 'T' : ' '}${reply!.flags.rd ? 'D' : ' '}${reply!.flags.ra ? 'R' : ' '} `);
    expect(sent.identifier).toBe(received.identifier);
    expect(received.thread).toBe(sent.thread);
    expect(received.stamp).toMatch(/^\d+\/\d+\/\d{4} \d+:\d{2}:\d{2} (AM|PM)$/);
  });

  it('the file reads back through Get-Content like any text file', async () => {
    const { server, ask } = await lab();
    await run(server, `Set-DnsServerDiagnostics ${EVERYTHING}`);
    await ask('web.corp.test');
    const out = await run(server, `Get-Content ${LOG}`);
    expect(out).toContain('Message logging key');
    expect(out.split('\n').filter((line) => line.includes(' PACKET '))).toHaveLength(2);
  });

  it('two exchanges have two identifiers; a second answer from the same zone keeps the lines in order', async () => {
    const { server, ask } = await lab();
    await run(server, `Set-DnsServerDiagnostics ${EVERYTHING}`);
    await ask('a1.corp.test');
    await ask('a2.corp.test');
    const packets = packetsIn(server);
    expect(packets.map((packet) => `${packet.direction} ${packet.name}`)).toEqual([
      'Rcv (2)a1(4)corp(4)test(0)', 'Snd (2)a1(4)corp(4)test(0)', 'Rcv (2)a2(4)corp(4)test(0)', 'Snd (2)a2(4)corp(4)test(0)',
    ]);
    expect(new Set(packets.map((packet) => packet.identifier)).size).toBe(2);
  });

  it('an answer that does not exist is logged with its response code and the type of the question', async () => {
    const { server, ask } = await lab();
    await run(server, `Set-DnsServerDiagnostics ${EVERYTHING}`);
    await ask('nothing.corp.test', RRType.MX);
    const sent = packetsIn(server)[1];
    expect(sent.rcode).toBe('NXDOMAIN');
    expect(sent.type).toBe('MX');
    expect(sent.name).toBe('(7)nothing(4)corp(4)test(0)');
  });

  it.each([
    ['QuestionTransactions', 'a question is not logged without it', '-Queries $true -Answers $true -ReceivePackets $true -SendPackets $true -UdpPackets $true', ['UDP Snd 10.0.1.2 R Q A (3)web(4)corp(4)test(0)']],
    ['Answers', 'an answer is not logged without it', '-Queries $true -QuestionTransactions $true -ReceivePackets $true -SendPackets $true -UdpPackets $true', ['UDP Rcv 10.0.1.2 Q Q A (3)web(4)corp(4)test(0)']],
    ['SendPackets', 'nothing the server sends is logged without it', '-Queries $true -Answers $true -QuestionTransactions $true -ReceivePackets $true -UdpPackets $true', ['UDP Rcv 10.0.1.2 Q Q A (3)web(4)corp(4)test(0)']],
    ['ReceivePackets', 'nothing the server receives is logged without it', '-Queries $true -Answers $true -QuestionTransactions $true -SendPackets $true -UdpPackets $true', ['UDP Snd 10.0.1.2 R Q A (3)web(4)corp(4)test(0)']],
  ])('the %s filter: %s', async (_name, _title, switches, expected) => {
    const { server, ask } = await lab();
    await run(server, `Set-DnsServerDiagnostics ${switches}`);
    await ask('web.corp.test');
    expect(summary(packetsIn(server))).toEqual(expected);
  });

  it('the transport filter: UDP alone logs the UDP exchange and not the TCP one, TCP alone the reverse', async () => {
    const { server, ask, askOverTcp } = await lab();
    await run(server, 'Set-DnsServerDiagnostics -Queries $true -Answers $true -QuestionTransactions $true -ReceivePackets $true -SendPackets $true -UdpPackets $true');
    await ask('a1.corp.test');
    await askOverTcp('a2.corp.test');
    expect(summary(packetsIn(server)).map((line) => line.split(' ')[0])).toEqual(['UDP', 'UDP']);
    await run(server, 'Set-DnsServerDiagnostics -UdpPackets $false -TcpPackets $true');
    await ask('a1.corp.test');
    await askOverTcp('a3.corp.test');
    expect(summary(packetsIn(server)).slice(2)).toEqual([
      'TCP Rcv 10.0.1.2 Q Q A (2)a3(4)corp(4)test(0)', 'TCP Snd 10.0.1.2 R Q A (2)a3(4)corp(4)test(0)',
    ]);
  });

  it('the content filter: a dynamic update needs the update bit, a query the query bit, and the letter says which', async () => {
    const { server, ask, update } = await lab();
    await run(server, 'Set-DnsServerDiagnostics -Queries $true -Answers $true -QuestionTransactions $true -ReceivePackets $true -SendPackets $true -UdpPackets $true');
    await update('dyn1');
    expect(packetsIn(server)).toHaveLength(0);
    await run(server, 'Set-DnsServerDiagnostics -Updates $true -Queries $false -Answers $true -QuestionTransactions $true -ReceivePackets $true -SendPackets $true -UdpPackets $true');
    await ask('a1.corp.test');
    expect(packetsIn(server)).toHaveLength(0);
    await update('dyn2');
    const packets = packetsIn(server);
    expect(packets.map((packet) => `${packet.direction} ${packet.opcode} ${packet.response ? 'R' : 'Q'}`)).toEqual(['Rcv U Q', 'Snd U R']);
    expect(packets[0].name).toBe('(4)corp(4)test(0)');
    expect(packets[0].type).toBe('SOA');
  });

  it('the address filter keeps the packets of the listed remote addresses only', async () => {
    const { server, ask } = await lab();
    await run(server, `Set-DnsServerDiagnostics ${EVERYTHING} -IPFilterList "10.0.1.99"`);
    await ask('a1.corp.test');
    expect(packetsIn(server)).toHaveLength(0);
    await run(server, 'Set-DnsServerDiagnostics -IPFilterList "10.0.1.99","10.0.1.2"');
    await ask('a2.corp.test');
    expect(packetsIn(server)).toHaveLength(2);
  });

  it('a settings change is effective on the next packet and stops at the next change', async () => {
    const { server, ask } = await lab();
    await run(server, `Set-DnsServerDiagnostics ${EVERYTHING}`);
    await ask('a1.corp.test');
    await run(server, 'Set-DnsServerDiagnostics -Queries $false');
    await ask('a2.corp.test');
    expect(summary(packetsIn(server)).map((line) => line.split(' ').pop())).toEqual(['(2)a1(4)corp(4)test(0)', '(2)a1(4)corp(4)test(0)']);
  });

  it('the stamp of a line is the time of the machine zone', async () => {
    const { server, ask } = await lab();
    await run(server, "Set-TimeZone -Id 'Tokyo Standard Time'");
    await run(server, `Set-DnsServerDiagnostics ${EVERYTHING}`);
    await ask('a1.corp.test');
    const stamp = packetsIn(server)[0].stamp;
    const [, hour12, meridiem] = / (\d+):\d{2}:\d{2} (AM|PM)$/.exec(stamp)!;
    const logged = (Number(hour12) % 12) + (meridiem === 'PM' ? 12 : 0);
    expect(logged).toBe(Number(await run(server, '(Get-Date).Hour')));
    expect(logged).not.toBe(new Date().getUTCHours());
  });

  it('a path with a directory is where the file goes, and not the default one', async () => {
    const { server, ask } = await lab();
    await run(server, 'New-Item -ItemType Directory -Path C:\\dnslogs');
    await run(server, `Set-DnsServerDiagnostics ${EVERYTHING} -LogFilePath "C:\\dnslogs\\queries.log"`);
    await ask('web.corp.test');
    expect(packetsIn(server, 'C:\\dnslogs\\queries.log')).toHaveLength(2);
    expect(server.getFileSystem().readFile(LOG).ok).toBe(false);
  });

  it('a file that reaches LogFileMaxSize is deleted and created again, with a header of the new time', async () => {
    const { server, ask } = await lab();
    await run(server, `Set-DnsServerDiagnostics ${EVERYTHING}`);
    await ask('a1.corp.test');
    const first = server.getFileSystem().readFile(LOG).content ?? '';
    const limit = first.length + 10;
    await run(server, `Set-DnsServerDiagnostics -MaxMBFileSize ${limit}`);
    server._stepSystemClock(150000);
    await ask('a2.corp.test');
    const second = server.getFileSystem().readFile(LOG).content ?? '';
    expect(second.length).toBeLessThanOrEqual(limit);
    expect(packetsIn(server).map((packet) => packet.name)).toEqual(['(2)a2(4)corp(4)test(0)', '(2)a2(4)corp(4)test(0)']);
    expect(second.split('\r\n')[1]).not.toBe(first.split('\r\n')[1]);
    expect(second).toContain('Message logging key');
  });

  it('a limit of zero is taken literally: the file holds its header and no packet', async () => {
    const { server, ask } = await lab();
    await run(server, `Set-DnsServerDiagnostics ${EVERYTHING} -MaxMBFileSize 0`);
    await ask('a1.corp.test');
    const text = server.getFileSystem().readFile(LOG).content ?? '';
    expect(text).toContain('Message logging key');
    expect(packetsIn(server)).toHaveLength(0);
  });

  it('a server that forwards a query logs the query it sends and the answer it receives, apart from the client exchange', async () => {
    const { server, ask } = await lab();
    await run(server, `Set-DnsServerForwarder -IPAddress ${MASTER} -UseRootHint $false`);
    await run(server, `Set-DnsServerDiagnostics ${EVERYTHING}`);
    const reply = await ask('host.ext.test');
    expect(reply?.answers).toHaveLength(1);
    const packets = packetsIn(server);
    expect(summary(packets)).toEqual([
      'UDP Rcv 10.0.1.2 Q Q A (4)host(3)ext(4)test(0)',
      'UDP Snd 10.0.1.30 Q Q A (4)host(3)ext(4)test(0)',
      'UDP Rcv 10.0.1.30 R Q A (4)host(3)ext(4)test(0)',
      'UDP Snd 10.0.1.2 R Q A (4)host(3)ext(4)test(0)',
    ]);
    expect(packets[1].identifier).toBe(packets[2].identifier);
    expect(packets[0].identifier).toBe(packets[3].identifier);
    expect(packets[0].identifier).not.toBe(packets[1].identifier);
    expect(packets[1].flags).toBe('0001');
  });

  it('an answer cut short by the forwarded server is asked again over TCP, and both exchanges are logged', async () => {
    const { server, master, ask } = await lab();
    for (let index = 0; index < 400; index++) {
      master.getDnsServerRole()!.addARecord('ext.test', 'big', `10.9.${Math.floor(index / 200)}.${(index % 200) + 1}`);
    }
    await run(server, `Set-DnsServerForwarder -IPAddress ${MASTER} -UseRootHint $false`);
    await run(server, `Set-DnsServerDiagnostics ${EVERYTHING}`);
    await ask('big.ext.test');
    const packets = packetsIn(server);
    expect(summary(packets)).toEqual([
      'UDP Rcv 10.0.1.2 Q Q A (3)big(3)ext(4)test(0)',
      'UDP Snd 10.0.1.30 Q Q A (3)big(3)ext(4)test(0)',
      'UDP Rcv 10.0.1.30 R Q A (3)big(3)ext(4)test(0)',
      'TCP Snd 10.0.1.30 Q Q A (3)big(3)ext(4)test(0)',
      'TCP Rcv 10.0.1.30 R Q A (3)big(3)ext(4)test(0)',
      'UDP Snd 10.0.1.2 R Q A (3)big(3)ext(4)test(0)',
    ]);
    expect(packets[2].letters).toContain('T');
    expect(packets[4].letters).not.toContain('T');
    expect(packets[3].identifier).toBe(packets[4].identifier);
    expect(packets[3].identifier).not.toBe(packets[1].identifier);
  }, 30000);

  it('a query refused with a format error is asked again without the EDNS option, and both exchanges are logged', async () => {
    const { server, master, ask } = await lab();
    await run(master, 'Set-DnsServerEDns -EnableReception $false');
    await run(server, `Set-DnsServerForwarder -IPAddress ${MASTER} -UseRootHint $false`);
    await run(server, `Set-DnsServerDiagnostics ${EVERYTHING}`);
    const reply = await ask('host.ext.test');
    expect(reply?.answers).toHaveLength(1);
    const packets = packetsIn(server);
    expect(summary(packets)).toEqual([
      'UDP Rcv 10.0.1.2 Q Q A (4)host(3)ext(4)test(0)',
      'UDP Snd 10.0.1.30 Q Q A (4)host(3)ext(4)test(0)',
      'UDP Rcv 10.0.1.30 R Q A (4)host(3)ext(4)test(0)',
      'UDP Snd 10.0.1.30 Q Q A (4)host(3)ext(4)test(0)',
      'UDP Rcv 10.0.1.30 R Q A (4)host(3)ext(4)test(0)',
      'UDP Snd 10.0.1.2 R Q A (4)host(3)ext(4)test(0)',
    ]);
    expect(packets[2].rcode).toBe('FORMERR');
    expect(packets[4].rcode).toBe('NOERROR');
  });

  it('a conditional forwarder that does not recurse is logged like any other server the DNS server asks', async () => {
    const { server, ask } = await lab();
    await run(server, `Add-DnsServerConditionalForwarderZone -Name ext.test -MasterServers ${MASTER} -UseRecursion $false`);
    await run(server, `Set-DnsServerDiagnostics ${EVERYTHING}`);
    const reply = await ask('host.ext.test');
    expect(reply?.answers).toHaveLength(1);
    expect(summary(packetsIn(server)).filter((line) => line.includes('10.0.1.30'))).toEqual([
      'UDP Snd 10.0.1.30 Q Q A (4)host(3)ext(4)test(0)',
      'UDP Rcv 10.0.1.30 R Q A (4)host(3)ext(4)test(0)',
    ]);
  });

  it('a notification the server sends is a question with the letter N', async () => {
    const { server } = await lab();
    await run(server, 'Set-DnsServerPrimaryZone -Name corp.test -Notify NotifyServers -NotifyServers 10.0.1.77');
    await run(server, 'Set-DnsServerDiagnostics -Notifications $true -QuestionTransactions $true -SendPackets $true -UdpPackets $true');
    await run(server, 'Add-DnsServerResourceRecordA -ZoneName corp.test -Name later -IPv4Address 10.0.9.5');
    const packets = packetsIn(server);
    expect(summary(packets)).toEqual(['UDP Snd 10.0.1.77 Q N SOA (4)corp(4)test(0)']);
  });

  it('a secondary zone logs the exchanges with its primary: the serial question over UDP, the transfer over TCP', async () => {
    const { server } = await lab();
    await run(server, `Set-DnsServerDiagnostics ${EVERYTHING}`);
    await run(server, `Add-DnsServerSecondaryZone -Name ext.test -MasterServers ${MASTER}`);
    const deadline = Date.now() + 8000;
    while (!packetsIn(server).some((packet) => packet.transport === 'TCP' && packet.direction === 'Rcv') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const lines = summary(packetsIn(server));
    expect(lines).toContain('UDP Snd 10.0.1.30 Q Q SOA (3)ext(4)test(0)');
    expect(lines).toContain('UDP Rcv 10.0.1.30 R Q SOA (3)ext(4)test(0)');
    expect(lines).toContain('TCP Snd 10.0.1.30 Q Q AXFR (3)ext(4)test(0)');
    expect(lines.some((line) => line.startsWith('TCP Rcv 10.0.1.30 R Q AXFR'))).toBe(true);
  }, 20000);
});
