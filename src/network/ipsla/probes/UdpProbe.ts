import type { IScheduler } from '@/events/Scheduler';
import { IPAddress } from '../../core/types';
import type {
  IpSlaHost, SlaJitterMeasurement, SlaOperationConfig, SlaProbeOutcome,
} from '../types';
import { UDP_PORT_IPSLA_CONTROL } from '../types';
import type {
  IpSlaControlReply, IpSlaControlRequest, IpSlaProbeReply, IpSlaProbeRequest,
} from '../IpSlaResponder';
import { controlDigestMaterial } from '../IpSlaResponder';
import { verificationPattern } from './IcmpEchoProbe';

export interface UdpTransport {
  allocateSourcePort(): number;
  releaseSourcePort(port: number): void;
  listen(port: number, handler: (sourceIp: IPAddress, payload: unknown) => void): void;
  send(destination: IPAddress, sourcePort: number, destinationPort: number, payload: unknown): boolean;
  computeDigest(keyId: number, material: string): string | null;
  activeKeyId(): number | null;
  keyChainConfigured(): boolean;
}

export interface UdpProbeRequest {
  host: IpSlaHost;
  scheduler: IScheduler;
  transport: UdpTransport;
  config: SlaOperationConfig;
  destination: IPAddress;
}

interface CollectedReply {
  sequence: number;
  t1: number;
  t2: number;
  t3: number;
  t4: number;
  clockSynchronized: boolean;
  receivedSequences: number[];
  verifyPattern: number | null;
}

const CONTROL_TIMEOUT_MS = 5000;

async function negotiate(
  request: UdpProbeRequest,
  sourcePort: number,
  probePort: number,
  protocol: 'udp-echo' | 'udp-jitter',
): Promise<{ ok: boolean; reason: string }> {
  const { transport, config, destination, scheduler } = request;

  const keyId = transport.keyChainConfigured() ? transport.activeKeyId() : null;
  const control: IpSlaControlRequest = {
    type: 'ipsla-control-request',
    operationId: config.id,
    protocol,
    port: probePort,
    durationSeconds: Math.max(1, Math.ceil(
      (config.timeoutMs + config.numPackets * config.intervalMs) / 1000,
    ) + 1),
    keyId,
    digest: null,
  };
  if (keyId !== null) control.digest = transport.computeDigest(keyId, controlDigestMaterial(control));

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: { ok: boolean; reason: string }) => {
      if (settled) return;
      settled = true;
      scheduler.clear(timer);
      resolve(result);
    };
    const timer = scheduler.setTimeout(
      () => finish({ ok: false, reason: 'IP SLA Control Protocol: no response from responder' }),
      CONTROL_TIMEOUT_MS,
    );
    transport.listen(sourcePort, (_sourceIp, payload) => {
      const reply = payload as IpSlaControlReply | undefined;
      if (!reply || reply.type !== 'ipsla-control-reply') return;
      if (reply.operationId !== config.id) return;
      finish(reply.accepted
        ? { ok: true, reason: '' }
        : { ok: false, reason: `IP SLA Control Protocol: ${reply.reason}` });
    });
    if (!transport.send(destination, sourcePort, UDP_PORT_IPSLA_CONTROL, control)) {
      finish({ ok: false, reason: 'No route to responder' });
    }
  });
}

export async function runUdpProbe(request: UdpProbeRequest): Promise<SlaProbeOutcome> {
  const { host, scheduler, transport, config, destination } = request;
  const jitterMode = config.type === 'udp-jitter';

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

  const probePort = config.targetPort ?? 0;
  if (probePort <= 0) {
    return {
      returnCode: 'notConnected',
      rttMs: null,
      diagText: 'No destination port configured',
      respondingAddress: null,
    };
  }

  const sourcePort = config.sourcePort ?? transport.allocateSourcePort();
  const packetCount = jitterMode ? Math.max(1, config.numPackets) : 1;
  const replies = new Map<number, CollectedReply>();
  const arrivalOrder: number[] = [];

  try {
    if (config.controlEnabled) {
      const negotiated = await negotiate(
        request, sourcePort, probePort, jitterMode ? 'udp-jitter' : 'udp-echo',
      );
      if (!negotiated.ok) {
        return {
          returnCode: 'dropped',
          rttMs: null,
          diagText: negotiated.reason,
          respondingAddress: destination.toString(),
        };
      }
    }

    transport.listen(sourcePort, (_sourceIp, payload) => {
      const reply = payload as IpSlaProbeReply | undefined;
      if (!reply || reply.type !== 'ipsla-probe-reply') return;
      if (reply.operationId !== config.id) return;
      if (replies.has(reply.sequence)) return;
      replies.set(reply.sequence, {
        sequence: reply.sequence,
        t1: reply.sentAtMs,
        t2: reply.receivedAtResponderMs,
        t3: reply.transmittedAtResponderMs,
        t4: scheduler.now(),
        clockSynchronized: reply.clockSynchronized,
        receivedSequences: reply.receivedSequences ?? [],
        verifyPattern: reply.verifyPattern,
      });
      arrivalOrder.push(reply.sequence);
    });

    for (let sequence = 1; sequence <= packetCount; sequence++) {
      const probe: IpSlaProbeRequest = {
        type: 'ipsla-probe-request',
        operationId: config.id,
        sequence,
        sentAtMs: scheduler.now(),
        payloadSize: config.requestDataSize,
        verifyPattern: config.verifyData ? verificationPattern(config.id, sequence) : null,
      };
      transport.send(destination, sourcePort, probePort, probe);
      if (sequence < packetCount && config.intervalMs > 0) {
        await scheduler.delay(config.intervalMs);
      }
    }

    await waitForCompletion(scheduler, config.timeoutMs, () => replies.size >= packetCount);
  } finally {
    transport.releaseSourcePort(sourcePort);
  }

  if (replies.size === 0) {
    return {
      returnCode: 'timeout',
      rttMs: null,
      diagText: `No response from ${destination.toString()}:${probePort}`,
      respondingAddress: null,
    };
  }

  const measurement = summarize(replies, arrivalOrder, packetCount, host.isClockSynchronized());
  const meanRtt = measurement.rtts.reduce((total, value) => total + value, 0)
    / measurement.rtts.length;

  if (config.verifyData) {
    for (const reply of replies.values()) {
      if (reply.verifyPattern !== null
        && reply.verifyPattern !== verificationPattern(config.id, reply.sequence)) {
        return {
          returnCode: 'verifyError',
          rttMs: meanRtt,
          diagText: 'Data pattern mismatch',
          respondingAddress: destination.toString(),
          jitter: jitterMode ? measurement : undefined,
        };
      }
    }
  }

  const outOfSequence = measurement.packetOutOfSequence > 0;
  const returnCode = outOfSequence
    ? 'sequenceError'
    : meanRtt > config.thresholdMs ? 'overThreshold' : 'ok';

  return {
    returnCode,
    rttMs: meanRtt,
    diagText: '',
    respondingAddress: destination.toString(),
    jitter: jitterMode ? measurement : undefined,
  };
}

function waitForCompletion(
  scheduler: IScheduler,
  timeoutMs: number,
  done: () => boolean,
): Promise<void> {
  if (done()) return Promise.resolve();
  return new Promise((resolve) => {
    const deadline = scheduler.now() + timeoutMs;
    const poll = scheduler.setInterval(() => {
      if (done() || scheduler.now() >= deadline) {
        scheduler.clear(poll);
        resolve();
      }
    }, 10);
  });
}

function summarize(
  replies: Map<number, CollectedReply>,
  arrivalOrder: number[],
  packetsSent: number,
  senderClockSynchronized: boolean,
): SlaJitterMeasurement {
  const ordered = [...replies.values()].sort((a, b) => a.sequence - b.sequence);
  const oneWayValid = senderClockSynchronized
    && ordered.every((reply) => reply.clockSynchronized);

  const rtts = ordered.map((reply) => (reply.t4 - reply.t1) - (reply.t3 - reply.t2));
  const sourceToDestination = oneWayValid ? ordered.map((reply) => reply.t2 - reply.t1) : [];
  const destinationToSource = oneWayValid ? ordered.map((reply) => reply.t4 - reply.t3) : [];

  const responderSaw = new Set<number>();
  for (const reply of ordered) {
    responderSaw.add(reply.sequence);
    for (const sequence of reply.receivedSequences) responderSaw.add(sequence);
  }
  const highestAnswered = ordered.length === 0 ? 0 : ordered[ordered.length - 1].sequence;

  let packetLossSD = 0;
  let packetLossDS = 0;
  let packetMIA = 0;
  for (let sequence = 1; sequence <= packetsSent; sequence++) {
    if (replies.has(sequence)) continue;
    if (responderSaw.has(sequence)) packetLossDS++;
    else if (sequence < highestAnswered) packetLossSD++;
    else packetMIA++;
  }

  let packetOutOfSequence = 0;
  let highestSeen = 0;
  for (const sequence of arrivalOrder) {
    if (sequence < highestSeen) packetOutOfSequence++;
    else highestSeen = sequence;
  }

  return {
    rtts,
    sourceToDestination,
    destinationToSource,
    oneWayValid,
    packetLossSD,
    packetLossDS,
    packetMIA,
    packetOutOfSequence,
    packetLateArrival: 0,
    packetsSent,
  };
}
