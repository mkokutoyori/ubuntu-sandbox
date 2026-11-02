import { beforeEach, afterEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { RRType, DnsClass } from '@/network/dns/wire/RRType';
import { DnsOpcode, DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import { queryDnsOverUdp } from '@/network/dns/transport/DnsUdpTransport';
import { queryDnsOverTcp } from '@/network/dns/transport/DnsTcpTransport';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';

export const SERVER = '10.0.1.10';
export const MASTER = '10.0.1.30';
export const WEB = ['web.corp.test'];

export type Verdict = 'answered' | 'nxdomain' | 'refused' | 'formerr' | 'servfail' | 'truncated' | 'dropped';

export function virtualClock(): { advance(milliseconds: number): void } {
  let clock: VirtualTimeScheduler;
  beforeEach(() => {
    resetCounters();
    resetDeviceCounters();
    Logger.clear();
    clock = new VirtualTimeScheduler();
    __setDefaultScheduler(clock);
  });
  afterEach(() => {
    __setDefaultScheduler(null);
  });
  return { advance: milliseconds => clock.advance(milliseconds) };
}

export const run = async (machine: WindowsServer, line: string): Promise<string> =>
  (await PowerShellSubShell.create(machine).subShell.processLine(line)).output.join('\n');

export function question(qname: string, qtype: number = RRType.A): DnsMessage {
  return {
    id: 0x7a7a,
    flags: { qr: false, opcode: DnsOpcode.QUERY, aa: false, tc: false, rd: true, ra: false, ad: false, cd: false, rcode: DnsRcode.NOERROR },
    questions: [{ qname, qtype, qclass: DnsClass.IN }],
    answers: [], authorities: [], additionals: [],
  };
}

export function verdictOf(reply: DnsMessage | null): Verdict {
  if (reply === null) return 'dropped';
  if (reply.flags.tc) return 'truncated';
  if (reply.flags.rcode === DnsRcode.NXDOMAIN) return 'nxdomain';
  if (reply.flags.rcode === DnsRcode.REFUSED) return 'refused';
  if (reply.flags.rcode === DnsRcode.FORMERR) return 'formerr';
  if (reply.flags.rcode === DnsRcode.SERVFAIL) return 'servfail';
  return 'answered';
}

export const times = (count: number, verdict: Verdict): Verdict[] => Array.from({ length: count }, () => verdict);

export const DEFAULT_FLOOD: Verdict[] = [
  ...times(5, 'answered'), 'dropped', 'truncated', 'answered', 'truncated', 'dropped', 'truncated', 'dropped',
];

export async function lab() {
  const sw = new GenericSwitch('switch-generic', 'sw1', 8, 0, 0);
  const server = new WindowsServer('WNS1');
  const master = new WindowsServer('WNS2');
  const clientA = new LinuxPC('linux-pc', 'PC1');
  const clientB = new LinuxPC('linux-pc', 'PC2');
  const clientC = new LinuxPC('linux-pc', 'PC3');
  const mask = new SubnetMask('255.255.0.0');
  [server, master, clientA, clientB, clientC].forEach((device, index) => {
    new Cable(`c${index}`).connect(device.getPorts()[0], sw.getPorts()[index]);
    device.getPorts()[0].configureIP(new IPAddress([SERVER, MASTER, '10.0.1.2', '10.0.1.3', '10.0.2.2'][index]), mask);
  });
  for (const machine of [server, master]) {
    machine.setCurrentUser('Administrator');
    await run(machine, 'Install-WindowsFeature DNS');
    await run(machine, 'Set-DnsServerForwarder -UseRootHint $false');
  }
  await run(server, 'Add-DnsServerPrimaryZone -Name corp.test');
  await run(server, 'Add-DnsServerResourceRecordA -ZoneName corp.test -Name web -IPv4Address 10.0.9.1');
  await run(server, 'Add-DnsServerResourceRecordA -ZoneName corp.test -Name mail -IPv4Address 10.0.9.3');
  await run(server, 'Add-DnsServerResourceRecordA -ZoneName corp.test -Name *.wild -IPv4Address 10.0.9.2');
  await run(master, 'Add-DnsServerPrimaryZone -Name ext.test');
  await run(master, 'Add-DnsServerResourceRecordA -ZoneName ext.test -Name host -IPv4Address 10.0.7.7');
  const ask = (from: LinuxPC, qname: string, qtype: number = RRType.A, timeoutMs = 25) =>
    queryDnsOverUdp(from, new IPAddress(SERVER), question(qname, qtype), 53, timeoutMs);
  const flood = async (from: LinuxPC, names: readonly string[], count: number = names.length): Promise<Verdict[]> => {
    const verdicts: Verdict[] = [];
    for (let index = 0; index < count; index++) verdicts.push(verdictOf(await ask(from, names[index % names.length])));
    return verdicts;
  };
  const askOverTcp = (qname: string) => queryDnsOverTcp(clientA, new IPAddress(SERVER), question(qname), 53, 9000);
  const rrl = (line: string) => run(server, line);
  const statistic = (member: string) => run(server, `(Get-DnsServerStatistics).RRLStatistics.${member}`);
  return { server, master, clientA, clientB, clientC, ask, flood, askOverTcp, rrl, statistic };
}
