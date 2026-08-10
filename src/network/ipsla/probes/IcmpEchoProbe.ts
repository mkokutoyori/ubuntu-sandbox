import type { IEventBus } from '@/events/EventBus';
import type { IScheduler } from '@/events/Scheduler';
import { waitForEvent, WaitForEventTimeoutError } from '@/events/waitForEvent';
import {
  IPAddress, ETHERTYPE_IPV4, IP_PROTO_ICMP, createIPv4Packet,
  type ICMPPacket,
} from '../../core/types';
import type { IpSlaHost, SlaOperationConfig, SlaProbeOutcome } from '../types';

export interface IcmpEchoRequest {
  host: IpSlaHost;
  bus: IEventBus;
  scheduler: IScheduler;
  config: SlaOperationConfig;
  identifier: number;
  sequence: number;
  destination: IPAddress;
  timeoutMs: number;
}

export function verificationPattern(operationId: number, sequence: number): number {
  return ((operationId * 0x9e37 + sequence * 0x7f4a) >>> 0) & 0xffff;
}

/**
 * The IPv6 leg of the same operation. It waits on the SAME two bus
 * topics the IPv4 one does — a router publishes `host.icmp.echo-reply`
 * for an ICMPv6 reply too — so the outcome vocabulary is identical and
 * `track` cannot behave differently by address family.
 */
export async function sendIcmpv6Echo(request: {
  host: IpSlaHost; bus: IEventBus; scheduler: IScheduler;
  config: SlaOperationConfig; identifier: number; sequence: number;
  destination: string; timeoutMs: number;
}): Promise<SlaProbeOutcome> {
  const { host, bus, scheduler, config, identifier, sequence, destination, timeoutMs } = request;

  const replyWait = waitForEvent(
    bus, 'host.icmp.echo-reply',
    (p) => p.deviceId === host.id && p.id === identifier && p.seq === sequence,
    { timeoutMs, scheduler },
  );
  const failureWait = waitForEvent(
    bus, 'host.icmp.echo-failed',
    (p) => p.deviceId === host.id && (p.id === -1 || (p.id === identifier && p.seq === sequence)),
    { timeoutMs, scheduler },
  );
  replyWait.catch(() => {});
  failureWait.catch(() => {});

  const startedAt = scheduler.now();
  const sent = host.sendIcmpv6Echo({
    destination, identifier, sequence,
    dataSize: Math.max(0, config.requestDataSize),
    sourceInterface: config.sourceInterface,
    sourceIp: config.sourceIp,
  });
  if (!sent) {
    return {
      returnCode: 'notConnected', rttMs: null,
      diagText: config.sourceInterface
        ? `Source interface ${config.sourceInterface} unusable`
        : `No route to ${destination}`,
      respondingAddress: null,
    };
  }

  try {
    const winner = await Promise.race([
      replyWait.then((r) => ({ kind: 'reply' as const, r })),
      failureWait.then((r) => ({ kind: 'failed' as const, r })),
    ]);
    if (winner.kind === 'failed') {
      return {
        returnCode: 'dropped', rttMs: null,
        diagText: winner.r.reason, respondingAddress: winner.r.fromIp ?? null,
      };
    }
    return {
      returnCode: 'ok', rttMs: scheduler.now() - startedAt,
      diagText: '', respondingAddress: destination,
    };
  } catch (err) {
    if (err instanceof WaitForEventTimeoutError) {
      return {
        returnCode: 'timeout', rttMs: null,
        diagText: `No reply from ${destination}`, respondingAddress: null,
      };
    }
    throw err;
  }
}

export async function sendIcmpEcho(request: IcmpEchoRequest): Promise<SlaProbeOutcome> {
  const { host, bus, scheduler, config, identifier, sequence, destination, timeoutMs } = request;

  const egress = host.resolveEgress(destination, config.sourceInterface, config.sourceIp);
  if (!egress) {
    return {
      returnCode: 'notConnected',
      rttMs: null,
      diagText: config.sourceInterface
        ? `Source interface ${config.sourceInterface} unusable`
        : `No route to ${destination.toString()}`,
      respondingAddress: null,
    };
  }

  const targetIp = destination.toString();
  const replyWait = waitForEvent(
    bus,
    'host.icmp.echo-reply',
    (payload) => payload.deviceId === host.id
      && payload.id === identifier
      && payload.seq === sequence,
    { timeoutMs, scheduler },
  );
  const failureWait = waitForEvent(
    bus,
    'host.icmp.echo-failed',
    (payload) => payload.deviceId === host.id
      && payload.id === identifier
      && payload.seq === sequence,
    { timeoutMs, scheduler },
  );

  const icmp: ICMPPacket = {
    type: 'icmp',
    icmpType: 'echo-request',
    code: 0,
    id: identifier,
    sequence,
    dataSize: Math.max(0, config.requestDataSize),
  };
  if (config.verifyData) {
    (icmp as unknown as Record<string, unknown>).ipSlaVerify =
      verificationPattern(config.id, sequence);
  }

  const packet = createIPv4Packet(
    egress.sourceIp, destination, IP_PROTO_ICMP, 255, icmp,
    8 + Math.max(0, config.requestDataSize),
    { tos: config.tos },
  );

  const startedAt = scheduler.now();
  host.sendFrame(egress.iface, {
    srcMAC: egress.sourceMac,
    dstMAC: egress.destinationMac,
    etherType: ETHERTYPE_IPV4,
    payload: packet,
  });

  const replyOutcome = replyWait.then((payload) => ({ kind: 'reply' as const, payload }));
  const failureOutcome = failureWait.then((payload) => ({ kind: 'failure' as const, payload }));
  replyOutcome.catch(() => {});
  failureOutcome.catch(() => {});

  try {
    const settled = await Promise.race([replyOutcome, failureOutcome]);
    const elapsed = Math.max(0, scheduler.now() - startedAt);
    if (settled.kind === 'failure') {
      return {
        returnCode: 'dropped',
        rttMs: null,
        diagText: settled.payload.reason,
        respondingAddress: settled.payload.fromIp || null,
      };
    }
    if (config.verifyData) {
      const echoed = (settled.payload as unknown as Record<string, unknown>).ipSlaVerify;
      if (echoed !== undefined && echoed !== verificationPattern(config.id, sequence)) {
        return {
          returnCode: 'verifyError',
          rttMs: elapsed,
          diagText: 'Data pattern mismatch',
          respondingAddress: settled.payload.fromIp,
        };
      }
    }
    return {
      returnCode: elapsed > config.thresholdMs ? 'overThreshold' : 'ok',
      rttMs: elapsed,
      diagText: '',
      respondingAddress: settled.payload.fromIp,
    };
  } catch (error) {
    if (error instanceof WaitForEventTimeoutError) {
      return {
        returnCode: 'timeout',
        rttMs: null,
        diagText: `No response from ${targetIp}`,
        respondingAddress: null,
      };
    }
    throw error;
  }
}
