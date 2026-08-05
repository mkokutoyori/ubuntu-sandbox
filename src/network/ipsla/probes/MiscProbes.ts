import type { IEventBus } from '@/events/EventBus';
import type { IScheduler } from '@/events/Scheduler';
import { IPAddress } from '../../core/types';
import { decodeDnsMessage, encodeDnsMessage } from '../../dns/wire/DnsMessageCodec';
import { DnsRcode, DnsOpcode } from '../../dns/wire/DnsHeaderFlags';
import type { DnsMessage } from '../../dns/wire/DnsMessage';
import { RRType, DnsClass } from '../../dns/wire/RRType';
import { parseHttpUrl } from '../../http/HttpClient';
import type {
  IpSlaHost, SlaJitterMeasurement, SlaOperationConfig, SlaProbeOutcome,
} from '../types';
import type { UdpTransport } from './UdpProbe';
import { sendIcmpEcho } from './IcmpEchoProbe';

const DNS_PORT = 53;

export async function runTcpConnectProbe(
  host: IpSlaHost,
  scheduler: IScheduler,
  config: SlaOperationConfig,
  destination: IPAddress,
): Promise<SlaProbeOutcome> {
  const egress = host.resolveEgress(destination, config.sourceInterface, config.sourceIp);
  if (!egress) {
    return {
      returnCode: 'notConnected', rttMs: null,
      diagText: `No route to ${destination.toString()}`, respondingAddress: null,
    };
  }
  const port = config.targetPort;
  if (port === null) {
    return {
      returnCode: 'notConnected', rttMs: null,
      diagText: 'No destination port configured', respondingAddress: null,
    };
  }
  const startedAt = scheduler.now();
  const result = await host.connectTcp(destination.toString(), port, config.timeoutMs);
  const elapsed = Math.max(0, scheduler.now() - startedAt);
  if (result.refused) {
    return {
      returnCode: 'dropped', rttMs: null,
      diagText: `Connection refused by ${destination.toString()}:${port}`,
      respondingAddress: destination.toString(),
    };
  }
  if (!result.connected) {
    return {
      returnCode: 'timeout', rttMs: null,
      diagText: `No connection to ${destination.toString()}:${port}`,
      respondingAddress: null,
    };
  }
  return {
    returnCode: elapsed > config.thresholdMs ? 'overThreshold' : 'ok',
    rttMs: elapsed,
    diagText: '',
    respondingAddress: destination.toString(),
  };
}

export async function runHttpProbe(
  host: IpSlaHost,
  scheduler: IScheduler,
  config: SlaOperationConfig,
): Promise<SlaProbeOutcome> {
  const url = config.http.url;
  if (!url) {
    return {
      returnCode: 'notConnected', rttMs: null,
      diagText: 'No URL configured', respondingAddress: null,
    };
  }
  const parsed = parseHttpUrl(url);
  if (!parsed) {
    return {
      returnCode: 'notConnected', rttMs: null,
      diagText: `Malformed URL ${url}`, respondingAddress: null,
    };
  }

  const dnsStartedAt = scheduler.now();
  let targetIp = parsed.host;
  let dnsRtt = 0;
  if (!IPAddress.tryParse(parsed.host)) {
    const resolved = host.resolveHostname(parsed.host);
    if (!resolved) {
      return {
        returnCode: 'applicationSpecific', rttMs: null,
        diagText: `Cannot resolve ${parsed.host}`, respondingAddress: null,
      };
    }
    targetIp = resolved;
    dnsRtt = Math.max(0, scheduler.now() - dnsStartedAt);
  }

  const destination = IPAddress.tryParse(targetIp);
  if (!destination) {
    return {
      returnCode: 'notConnected', rttMs: null,
      diagText: `Cannot resolve ${parsed.host}`, respondingAddress: null,
    };
  }
  const egress = host.resolveEgress(destination, config.sourceInterface, config.sourceIp);
  if (!egress) {
    return {
      returnCode: 'notConnected', rttMs: null,
      diagText: `No route to ${targetIp}`, respondingAddress: null,
    };
  }

  const connectStartedAt = scheduler.now();
  const result = host.fetchHttp(targetIp, parsed.port, parsed.path, 'GET');
  const transactionRtt = Math.max(0, scheduler.now() - connectStartedAt);
  const totalRtt = dnsRtt + transactionRtt;

  if (!result.ok) {
    return {
      returnCode: 'timeout', rttMs: null,
      diagText: result.error ?? 'no response',
      respondingAddress: targetIp,
      httpBreakdown: { dnsRttMs: dnsRtt, tcpConnectRttMs: 0, transactionRttMs: 0 },
    };
  }
  if (result.status < 200 || result.status >= 400) {
    return {
      returnCode: 'applicationSpecific', rttMs: totalRtt,
      diagText: `HTTP status ${result.status}`,
      respondingAddress: targetIp,
      httpBreakdown: { dnsRttMs: dnsRtt, tcpConnectRttMs: 0, transactionRttMs: transactionRtt },
    };
  }
  return {
    returnCode: totalRtt > config.thresholdMs ? 'overThreshold' : 'ok',
    rttMs: totalRtt,
    diagText: '',
    respondingAddress: targetIp,
    httpBreakdown: { dnsRttMs: dnsRtt, tcpConnectRttMs: 0, transactionRttMs: transactionRtt },
  };
}

let dnsTransactionId = 0x1000;

export async function runDnsProbe(
  host: IpSlaHost,
  scheduler: IScheduler,
  transport: UdpTransport,
  config: SlaOperationConfig,
): Promise<SlaProbeOutcome> {
  const name = config.dns.name;
  const server = config.dns.nameServer;
  if (!name || !server) {
    return {
      returnCode: 'notConnected', rttMs: null,
      diagText: 'DNS operation incompletely configured', respondingAddress: null,
    };
  }
  const destination = IPAddress.tryParse(server);
  if (!destination) {
    return {
      returnCode: 'notConnected', rttMs: null,
      diagText: `Invalid name server ${server}`, respondingAddress: null,
    };
  }
  const egress = host.resolveEgress(destination, config.sourceInterface, config.sourceIp);
  if (!egress) {
    return {
      returnCode: 'notConnected', rttMs: null,
      diagText: `No route to ${server}`, respondingAddress: null,
    };
  }

  dnsTransactionId = dnsTransactionId >= 0xfffe ? 0x1000 : dnsTransactionId + 1;
  const query: DnsMessage = {
    id: dnsTransactionId,
    flags: {
      qr: false, opcode: DnsOpcode.QUERY, aa: false, tc: false,
      rd: true, ra: false, ad: false, cd: false, rcode: DnsRcode.NOERROR,
    },
    questions: [{ qname: name, qtype: RRType.A, qclass: DnsClass.IN }],
    answers: [], authorities: [], additionals: [],
  };

  const sourcePort = transport.allocateSourcePort();
  const startedAt = scheduler.now();

  const response = await new Promise<DnsMessage | null>((resolve) => {
    let settled = false;
    const finish = (message: DnsMessage | null) => {
      if (settled) return;
      settled = true;
      scheduler.clear(timer);
      resolve(message);
    };
    const timer = scheduler.setTimeout(() => finish(null), config.timeoutMs);
    transport.listen(sourcePort, (_sourceIp, payload) => {
      if (!(payload instanceof Uint8Array)) return;
      try {
        const decoded = decodeDnsMessage(payload);
        if (decoded.id === query.id) finish(decoded);
      } catch {
        return;
      }
    });
    if (!transport.send(destination, sourcePort, DNS_PORT, encodeDnsMessage(query))) {
      finish(null);
    }
  });
  transport.releaseSourcePort(sourcePort);

  if (!response) {
    return {
      returnCode: 'timeout', rttMs: null,
      diagText: `No response from ${server}`, respondingAddress: null,
    };
  }
  const elapsed = Math.max(0, scheduler.now() - startedAt);
  if (response.flags.rcode !== DnsRcode.NOERROR) {
    return {
      returnCode: 'applicationSpecific', rttMs: elapsed,
      diagText: `DNS rcode ${response.flags.rcode}`, respondingAddress: server,
    };
  }
  return {
    returnCode: elapsed > config.thresholdMs ? 'overThreshold' : 'ok',
    rttMs: elapsed,
    diagText: '',
    respondingAddress: server,
  };
}

export async function runIcmpJitterProbe(
  host: IpSlaHost,
  bus: IEventBus,
  scheduler: IScheduler,
  config: SlaOperationConfig,
  identifier: number,
  baseSequence: number,
  destination: IPAddress,
): Promise<SlaProbeOutcome> {
  const packetCount = Math.max(1, config.numPackets);
  const rtts: number[] = [];
  let lost = 0;
  let lastCode: SlaProbeOutcome['returnCode'] = 'ok';
  let diagText = '';

  for (let index = 0; index < packetCount; index++) {
    const outcome = await sendIcmpEcho({
      host, bus, scheduler, config,
      identifier,
      sequence: (baseSequence + index) & 0xffff,
      destination,
      timeoutMs: config.timeoutMs,
    });
    if (outcome.rttMs === null) {
      lost++;
      lastCode = outcome.returnCode;
      diagText = outcome.diagText;
    } else {
      rtts.push(outcome.rttMs);
    }
    if (index < packetCount - 1 && config.intervalMs > 0) {
      await scheduler.delay(config.intervalMs);
    }
  }

  if (rtts.length === 0) {
    return {
      returnCode: lastCode === 'ok' ? 'timeout' : lastCode,
      rttMs: null, diagText, respondingAddress: null,
    };
  }

  const measurement: SlaJitterMeasurement = {
    rtts,
    sourceToDestination: [],
    destinationToSource: [],
    oneWayValid: false,
    packetLossSD: 0,
    packetLossDS: 0,
    packetMIA: lost,
    packetOutOfSequence: 0,
    packetLateArrival: 0,
    packetsSent: packetCount,
  };
  const meanRtt = rtts.reduce((total, value) => total + value, 0) / rtts.length;
  return {
    returnCode: meanRtt > config.thresholdMs ? 'overThreshold' : 'ok',
    rttMs: meanRtt,
    diagText: '',
    respondingAddress: destination.toString(),
    jitter: measurement,
  };
}

export async function runPathEchoProbe(
  host: IpSlaHost,
  bus: IEventBus,
  scheduler: IScheduler,
  config: SlaOperationConfig,
  identifier: number,
  destination: IPAddress,
): Promise<SlaProbeOutcome> {
  const hops = await host.tracePath(destination, config.maxHops, config.timeoutMs);
  if (hops.length === 0) {
    return {
      returnCode: 'notConnected', rttMs: null,
      diagText: `No path to ${destination.toString()}`, respondingAddress: null,
    };
  }
  const finalHop = hops[hops.length - 1];
  const outcome = await sendIcmpEcho({
    host, bus, scheduler, config, identifier, sequence: 1, destination,
    timeoutMs: config.timeoutMs,
  });
  return {
    ...outcome,
    hops: hops.map((hop, index) => ({
      hop: index + 1,
      address: hop.address,
      rttMs: hop.rttMs,
      returnCode: hop.rttMs === null ? 'timeout' : 'ok',
    })),
    respondingAddress: outcome.respondingAddress ?? finalHop.address,
  };
}
