import { IPAddress, IPv6Address, SubnetMask } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import type { EndHost } from '@/network/devices/EndHost';
import { WindowsDnsServerRole } from '@/network/devices/windows/server/dns/WindowsDnsServerRole';
import type { DnsAnalyticEvent } from '@/network/devices/windows/server/dns/DnsAnalyticLog';
import { queryDnsOverUdp } from '@/network/dns/transport/DnsUdpTransport';
import { queryDnsOverTcp } from '@/network/dns/transport/DnsTcpTransport';
import { RRType, DnsClass } from '@/network/dns/wire/RRType';
import { DnsOpcode, DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';

export const SERVER_V4 = '10.0.1.10';
export const SERVER_V6 = '2001:db8::53';
export const REMOTE_V4 = '10.0.1.30';
export const CLIENT_V4: readonly string[] = ['10.0.1.2', '10.0.1.3', '10.0.1.4'];
export const CLIENT_V6: readonly string[] = ['2001:db8::10', '2001:db8::11', '2001:db8:0:100::10'];

export const QUERY_ID = 0x7a7a;

export type Verdict = 'answered' | 'nxdomain' | 'refused' | 'formerr' | 'servfail' | 'truncated' | 'dropped';

export function question(
  qname: string, qtype: number = RRType.A, opcode: number = DnsOpcode.QUERY, recursionDesired = true,
): DnsMessage {
  return {
    id: QUERY_ID,
    flags: { qr: false, opcode, aa: false, tc: false, rd: recursionDesired, ra: false, ad: false, cd: false, rcode: DnsRcode.NOERROR },
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

export interface RoleLabOptions {
  readonly sink?: (event: DnsAnalyticEvent) => void;
  readonly timeZone?: string;
  readonly remote?: boolean;
}

export function roleLab(options: RoleLabOptions = {}) {
  let at = 1_700_000_000_000;
  let zone = options.timeZone ?? 'UTC';
  const server = new LinuxPC('linux-pc', 'DNSHOST');
  const clients = [0, 1, 2].map(index => new LinuxPC('linux-pc', `CLIENT${index}`));
  const sw = new GenericSwitch('switch-generic', 'SW1');
  new Cable('c0').connect(server.getPorts()[0], sw.getPorts()[0]);
  clients.forEach((client, index) => new Cable(`c${index + 1}`).connect(client.getPorts()[0], sw.getPorts()[index + 1]));
  const mask = new SubnetMask('255.255.255.0');
  server.getPorts()[0].configureIP(new IPAddress(SERVER_V4), mask);
  server.configureIPv6Interface('eth0', new IPv6Address(SERVER_V6), 48);
  clients.forEach((client, index) => {
    client.getPorts()[0].configureIP(new IPAddress(CLIENT_V4[index]), mask);
    client.configureIPv6Interface('eth0', new IPv6Address(CLIENT_V6[index]), 48);
  });
  const role = new WindowsDnsServerRole(server as unknown as EndHost, {
    now: () => at, timeZone: () => zone, analytic: options.sink,
  });
  role.addPrimaryZone('corp.test');
  role.addARecord('corp.test', 'web', '10.0.9.1');
  role.start();
  let remote: WindowsDnsServerRole | null = null;
  if (options.remote === true) {
    const host = new LinuxPC('linux-pc', 'REMOTE');
    new Cable('c4').connect(host.getPorts()[0], sw.getPorts()[4]);
    host.getPorts()[0].configureIP(new IPAddress(REMOTE_V4), mask);
    remote = new WindowsDnsServerRole(host as unknown as EndHost, { now: () => at });
    remote.addPrimaryZone('ext.test');
    remote.addARecord('ext.test', 'host', '10.0.7.7');
    remote.start();
    role.setForwarders([REMOTE_V4]);
  }
  const ask = (client: number, over: 4 | 6, message: DnsMessage, transport: 'udp' | 'tcp' = 'udp'): Promise<DnsMessage | null> => {
    const address = over === 4 ? new IPAddress(SERVER_V4) : new IPv6Address(SERVER_V6);
    return transport === 'udp'
      ? queryDnsOverUdp(clients[client], address, message, 53, 40)
      : queryDnsOverTcp(clients[client], address, message, 53, 300);
  };
  return {
    role,
    remote,
    clients,
    ask,
    advance: (milliseconds: number) => { at += milliseconds; },
    setClock: (epochMilliseconds: number) => { at = epochMilliseconds; },
    setZone: (name: string) => { zone = name; },
  };
}
