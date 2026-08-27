import type { IEventBus } from '@/events/EventBus';
import { ownBusProvider } from '@/events/BusHolder';
import { getDefaultScheduler, type IScheduler, type TimerHandle } from '@/events/Scheduler';
import { IPAddress } from '../core/types';
import {
  createOperationConfig,
  isResponding,
  RETURN_CODE_LABEL,
  type IpSlaHost,
  type SlaOperationConfig,
  type SlaOperationState,
  type SlaBatchMeasurement,
  type SlaProbeOutcome,
  type SlaReturnCode,
} from './types';
import {
  accumulateJitter,
  createDistribution,
  createErrorCounters,
  createJitterAccumulator,
  createRttAggregate,
  packetLossPercent,
  recordDistribution,
  recordReturnCode,
  recordRtt,
  type DistributionBucket,
  type ErrorCounters,
  type HistoryEntry,
  type JitterAccumulator,
  type RttAggregate,
} from './statistics';
import { evaluateEModel, type EModelResult } from './emodel';
import { sendIcmpEcho, sendIcmpv6Echo } from './probes/IcmpEchoProbe';
import { looksLikeIPv6 as looksLikeIpv6Target } from '../devices/shells/cisco/ciscoPing';
import { runUdpProbe, type UdpTransport } from './probes/UdpProbe';
import {
  runDnsProbe, runHttpProbe, runIcmpJitterProbe, runPathEchoProbe, runTcpConnectProbe,
} from './probes/MiscProbes';
import { IpSlaResponder } from './IpSlaResponder';
import {
  createReaction, evaluateReaction,
  type ReactionElement, type SlaReaction,
} from './reactions';
import type { UDPPacket } from '../core/types';

export const RTT_MON_THRESHOLD_NOTIFICATION = '1.3.6.1.4.1.9.9.42.2.0.3';
export const RTT_MON_TIMEOUT_NOTIFICATION = '1.3.6.1.4.1.9.9.42.2.0.2';
export const RTT_MON_CONNECTION_CHANGE_NOTIFICATION = '1.3.6.1.4.1.9.9.42.2.0.1';
export const RTT_MON_VERIFY_ERROR_NOTIFICATION = '1.3.6.1.4.1.9.9.42.2.0.4';

const TICK_INTERVAL_MS = 100;

export interface SlaOperationRuntime {
  config: SlaOperationConfig;
  state: SlaOperationState;
  activeSinceMs: number | null;
  lifeEndsAtMs: number | null;
  inactiveSinceMs: number | null;
  nextRunAtMs: number | null;
  lastRunAtMs: number | null;
  lastRunEpochMs: number | null;
  lastReturnCode: SlaReturnCode | null;
  lastRttMs: number | null;
  lastDiagText: string;
  lastRespondingAddress: string | null;
  lastBatch: SlaBatchMeasurement | null;
  running: boolean;
  sequence: number;
  identifier: number;
  aggregate: RttAggregate;
  counters: ErrorCounters;
  distribution: DistributionBucket[];
  history: HistoryEntry[];
  jitter: JitterAccumulator;
  emodel: EModelResult | null;
  modificationEpochMs: number;
  resetEpochMs: number;
}

let identifierCounter = 0x7000;

function freshRuntime(config: SlaOperationConfig, epochMs: number): SlaOperationRuntime {
  identifierCounter = identifierCounter >= 0x7fff ? 0x7000 : identifierCounter + 1;
  return {
    config,
    state: 'pending',
    activeSinceMs: null,
    lifeEndsAtMs: null,
    inactiveSinceMs: null,
    nextRunAtMs: null,
    lastRunAtMs: null,
    lastRunEpochMs: null,
    lastReturnCode: null,
    lastRttMs: null,
    lastDiagText: '',
    lastRespondingAddress: null,
    lastBatch: null,
    running: false,
    sequence: 0,
    identifier: identifierCounter,
    aggregate: createRttAggregate(),
    counters: createErrorCounters(),
    distribution: createDistribution(config.distributionsKept, config.distributionIntervalMs),
    history: [],
    jitter: createJitterAccumulator(),
    emodel: null,
    modificationEpochMs: epochMs,
    resetEpochMs: epochMs,
  };
}

export class IpSlaEngine {
  private readonly operations = new Map<number, SlaOperationRuntime>();
  private tickHandle: TimerHandle | null = null;
  private scheduler: IScheduler | null = null;
  private running = false;

  globalEnabled = true;
  loggingTrapsEnabled = false;

  private readonly udpListeners = new Map<number, (sourceIp: IPAddress, payload: unknown) => void>();
  private ephemeralCursor = 49152;
  private readonly responder: IpSlaResponder;

  constructor(
    private readonly host: IpSlaHost,
    private readonly getBus: () => IEventBus = ownBusProvider(),
    private readonly getScheduler: () => IScheduler = () => getDefaultScheduler(),
  ) {
    this.responder = new IpSlaResponder(
      {
        id: host.id,
        getHostname: () => host.getHostname(),
        sendUdp: (destination, sourcePort, destinationPort, payload) =>
          host.sendUdp(destination, sourcePort, destinationPort, payload),
        isClockSynchronized: () => host.isClockSynchronized(),
        resolveKeyDigest: (chain, keyId, material) =>
          host.computeKeyDigest(chain, keyId, material),
      },
      getBus,
      getScheduler,
    );
  }

  getResponder(): IpSlaResponder { return this.responder; }

  private readonly transport: UdpTransport = {
    allocateSourcePort: () => {
      for (let attempt = 0; attempt < 16384; attempt++) {
        this.ephemeralCursor = this.ephemeralCursor >= 65535 ? 49152 : this.ephemeralCursor + 1;
        if (!this.udpListeners.has(this.ephemeralCursor)) return this.ephemeralCursor;
      }
      return this.ephemeralCursor;
    },
    releaseSourcePort: (port) => { this.udpListeners.delete(port); },
    listen: (port, handler) => { this.udpListeners.set(port, handler); },
    send: (destination, sourcePort, destinationPort, payload) =>
      this.host.sendUdp(destination, sourcePort, destinationPort, payload),
    computeDigest: (keyId, material) => this.keyChain === null
      ? null
      : this.host.computeKeyDigest(this.keyChain, keyId, material),
    activeKeyId: () => this.keyChain === null ? null : this.host.activeKeyId(this.keyChain),
    keyChainConfigured: () => this.keyChain !== null,
  };

  private readonly reactions: SlaReaction[] = [];
  private readonly reactionTriggers = new Map<number, number>();

  ensureReaction(operationId: number, element: ReactionElement): SlaReaction {
    const existing = this.reactions.find((reaction) =>
      reaction.operationId === operationId && reaction.element === element);
    if (existing) return existing;
    const reaction = createReaction(operationId, element);
    this.reactions.push(reaction);
    return reaction;
  }

  removeReaction(operationId: number, element?: ReactionElement): void {
    for (let index = this.reactions.length - 1; index >= 0; index--) {
      const reaction = this.reactions[index];
      if (reaction.operationId !== operationId) continue;
      if (element !== undefined && reaction.element !== element) continue;
      this.reactions.splice(index, 1);
    }
  }

  listReactions(operationId?: number): readonly SlaReaction[] {
    return operationId === undefined
      ? [...this.reactions]
      : this.reactions.filter((reaction) => reaction.operationId === operationId);
  }

  setReactionTrigger(sourceOperationId: number, targetOperationId: number): boolean {
    const target = this.operations.get(targetOperationId);
    if (!target) return false;
    this.reactionTriggers.set(sourceOperationId, targetOperationId);
    return true;
  }

  removeReactionTrigger(sourceOperationId: number): void {
    this.reactionTriggers.delete(sourceOperationId);
  }

  listReactionTriggers(): Array<{ source: number; target: number }> {
    return [...this.reactionTriggers.entries()]
      .map(([source, target]) => ({ source, target }))
      .sort((a, b) => a.source - b.source);
  }

  private applyReactions(runtime: SlaOperationRuntime): void {
    for (const reaction of this.reactions) {
      if (reaction.operationId !== runtime.config.id) continue;
      const { verdict, value } = evaluateReaction(reaction, runtime);
      if (verdict === 'none') continue;
      const threshold = verdict === 'triggered'
        ? reaction.thresholdUpper : reaction.thresholdLower;
      this.getBus().publish({
        topic: verdict === 'triggered' ? 'ipsla.reaction.triggered' : 'ipsla.reaction.cleared',
        payload: {
          deviceId: this.host.id,
          hostname: this.host.getHostname(),
          operationId: runtime.config.id,
          element: reaction.element,
          thresholdValue: threshold,
          measuredValue: value,
          actionType: reaction.actionType,
        },
      });
      if (this.loggingTrapsEnabled) {
        this.host.log(
          'errors',
          verdict === 'triggered' ? 'RTT-3-IPSLATHRESHOLD' : 'RTT-3-IPSLACLEAR',
          `IP SLAs(${runtime.config.id}): Threshold `
          + `${verdict === 'triggered' ? 'exceeded' : 'cleared'} for ${reaction.element}`,
        );
      }
      const sendsTrap = reaction.actionType === 'trapOnly'
        || reaction.actionType === 'trapAndTrigger';
      if (sendsTrap) {
        this.host.sendTrap(this.notificationOid(reaction.element), [
          { oid: '1.3.6.1.4.1.9.9.42.1.2.1.1.1', kind: 'integer', value: runtime.config.id },
          { oid: '1.3.6.1.4.1.9.9.42.1.2.10.1.1', kind: 'gauge', value: Math.round(value) },
        ]);
      }
      const fires = reaction.actionType === 'triggerOnly'
        || reaction.actionType === 'trapAndTrigger';
      if (fires && verdict === 'triggered') {
        const target = this.reactionTriggers.get(runtime.config.id);
        if (target !== undefined) this.triggerOperation(target);
      }
    }
  }

  private notificationOid(element: ReactionElement): string {
    if (element === 'timeout') return RTT_MON_TIMEOUT_NOTIFICATION;
    if (element === 'connectionLoss') return RTT_MON_CONNECTION_CHANGE_NOTIFICATION;
    if (element === 'verifyError') return RTT_MON_VERIFY_ERROR_NOTIFICATION;
    return RTT_MON_THRESHOLD_NOTIFICATION;
  }

  private keyChain: string | null = null;
  getKeyChain(): string | null { return this.keyChain; }

  setKeyChain(chain: string | null): void {
    this.keyChain = chain;
    this.responder.setKeyChain(chain);
  }

  handleUdp(sourceIp: IPAddress, udp: UDPPacket): boolean {
    const listener = this.udpListeners.get(udp.destinationPort);
    if (listener) {
      listener(sourceIp, udp.payload);
      return true;
    }
    return this.responder.handleUdp(sourceIp, udp);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const scheduler = this.getScheduler();
    this.scheduler = scheduler;
    this.tickHandle = scheduler.setInterval(() => this.tick(), TICK_INTERVAL_MS);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    const scheduler = this.scheduler ?? this.getScheduler();
    if (this.tickHandle !== null) {
      scheduler.clear(this.tickHandle);
      this.tickHandle = null;
    }
  }

  private mibRegistrar: ((operationId: number) => void) | null = null;
  private readonly mibRegistered = new Set<number>();

  setMibRegistrar(registrar: ((operationId: number) => void) | null): void {
    this.mibRegistrar = registrar;
    for (const id of this.operations.keys()) this.registerMibFor(id);
  }

  private registerMibFor(id: number): void {
    if (!this.mibRegistrar || this.mibRegistered.has(id)) return;
    this.mibRegistered.add(id);
    this.mibRegistrar(id);
  }

  ensureOperation(id: number): SlaOperationRuntime {
    let runtime = this.operations.get(id);
    if (!runtime) {
      runtime = freshRuntime(createOperationConfig(id), this.host.epochMs());
      this.operations.set(id, runtime);
    }
    this.registerMibFor(id);
    return runtime;
  }

  getOperation(id: number): SlaOperationRuntime | undefined {
    return this.operations.get(id);
  }

  listOperations(): SlaOperationRuntime[] {
    return [...this.operations.values()].sort((a, b) => a.config.id - b.config.id);
  }

  removeOperation(id: number): boolean {
    return this.operations.delete(id);
  }

  noteConfigChange(id: number): void {
    const runtime = this.operations.get(id);
    if (!runtime) return;
    runtime.modificationEpochMs = this.host.epochMs();
    runtime.distribution = createDistribution(
      runtime.config.distributionsKept,
      runtime.config.distributionIntervalMs,
    );
  }

  resetStatistics(id?: number): void {
    const targets = id === undefined ? this.listOperations() : [this.operations.get(id)];
    for (const runtime of targets) {
      if (!runtime) continue;
      runtime.aggregate = createRttAggregate();
      runtime.counters = createErrorCounters();
      runtime.distribution = createDistribution(
        runtime.config.distributionsKept,
        runtime.config.distributionIntervalMs,
      );
      runtime.history = [];
      runtime.jitter = createJitterAccumulator();
      runtime.emodel = null;
      runtime.resetEpochMs = this.host.epochMs();
    }
  }

  schedule(id: number): { ok: boolean; error?: string } {
    const runtime = this.operations.get(id);
    if (!runtime) return { ok: false, error: `% Entry ${id} does not exist` };
    const schedule = runtime.config.schedule;
    if (schedule.ageoutSeconds > 0 && schedule.lifeSeconds === 'forever') {
      return { ok: false, error: '% Ageout value cannot be set with life forever' };
    }
    if (schedule.recurring && schedule.lifeSeconds !== 'forever'
      && schedule.lifeSeconds > 86400) {
      return { ok: false, error: '% Life value should be less than 24 hours for recurring' };
    }
    schedule.configured = true;
    if (schedule.startPending) {
      this.transition(runtime, 'pending', 'schedule');
      return { ok: true };
    }
    const now = this.now();
    const delayMs = this.startDelayMs(schedule);
    if (delayMs <= 0) this.activate(runtime, 'schedule');
    else {
      this.transition(runtime, 'pending', 'schedule');
      runtime.nextRunAtMs = now + delayMs;
    }
    return { ok: true };
  }

  unschedule(id: number): void {
    const runtime = this.operations.get(id);
    if (!runtime) return;
    runtime.config.schedule.configured = false;
    runtime.nextRunAtMs = null;
    runtime.activeSinceMs = null;
    runtime.lifeEndsAtMs = null;
    this.transition(runtime, 'pending', 'schedule');
  }

  restart(id: number): boolean {
    const runtime = this.operations.get(id);
    if (!runtime || !runtime.config.schedule.configured) return false;
    this.activate(runtime, 'restart');
    return true;
  }

  triggerOperation(id: number): boolean {
    const runtime = this.operations.get(id);
    if (!runtime || runtime.state === 'active') return false;
    this.activate(runtime, 'trigger');
    return true;
  }

  private startDelayMs(schedule: SlaOperationConfig['schedule']): number {
    if (schedule.startAfterSeconds !== null) return schedule.startAfterSeconds * 1000;
    if (schedule.startAtSecondsOfDay === null) return 0;
    const dayMs = 86400000;
    const secondsIntoDay = Math.floor((this.host.epochMs() % dayMs) / 1000);
    let delta = schedule.startAtSecondsOfDay - secondsIntoDay;
    if (delta < 0) delta += 86400;
    return delta * 1000;
  }

  private activate(runtime: SlaOperationRuntime, reason: 'schedule' | 'restart' | 'trigger'): void {
    const now = this.now();
    runtime.activeSinceMs = now;
    runtime.inactiveSinceMs = null;
    const life = runtime.config.schedule.lifeSeconds;
    runtime.lifeEndsAtMs = life === 'forever' ? null : now + life * 1000;
    this.transition(runtime, 'active', reason);
    if (!this.globalEnabled) { runtime.nextRunAtMs = now; return; }
    runtime.nextRunAtMs = now + runtime.config.frequencySeconds * 1000;
    void this.runProbe(runtime);
  }

  private transition(
    runtime: SlaOperationRuntime,
    newState: SlaOperationState,
    reason: 'config' | 'schedule' | 'life-expired' | 'ageout' | 'restart' | 'trigger',
  ): void {
    if (runtime.state === newState) return;
    const oldState = runtime.state;
    runtime.state = newState;
    if (newState === 'inactive') runtime.inactiveSinceMs = this.now();
    this.getBus().publish({
      topic: 'ipsla.operation.state-changed',
      payload: {
        deviceId: this.host.id,
        hostname: this.host.getHostname(),
        operationId: runtime.config.id,
        oldState,
        newState,
        reason,
      },
    });
  }

  nowMs(): number {
    return (this.scheduler ?? this.getScheduler()).now();
  }

  private now(): number {
    return this.nowMs();
  }

  private tick(): void {
    if (!this.globalEnabled) return;
    const now = this.now();
    for (const runtime of [...this.operations.values()]) {
      if (runtime.state === 'inactive') {
        const ageout = runtime.config.schedule.ageoutSeconds;
        if (ageout > 0 && runtime.inactiveSinceMs !== null
          && now - runtime.inactiveSinceMs >= ageout * 1000) {
          this.operations.delete(runtime.config.id);
          this.mibRegistered.delete(runtime.config.id);
        }
        continue;
      }
      if (runtime.state === 'pending') {
        if (runtime.config.schedule.configured && runtime.nextRunAtMs !== null
          && now >= runtime.nextRunAtMs) {
          this.activate(runtime, 'schedule');
        }
        continue;
      }
      if (runtime.lifeEndsAtMs !== null && now >= runtime.lifeEndsAtMs) {
        if (runtime.config.schedule.recurring) this.activate(runtime, 'schedule');
        else this.transition(runtime, 'inactive', 'life-expired');
        continue;
      }
      if (runtime.running) continue;
      if (runtime.nextRunAtMs !== null && now >= runtime.nextRunAtMs) {
        runtime.nextRunAtMs = now + runtime.config.frequencySeconds * 1000;
        void this.runProbe(runtime);
      }
    }
  }

  async runProbe(runtime: SlaOperationRuntime): Promise<SlaProbeOutcome> {
    runtime.running = true;
    const startedAt = this.now();
    this.getBus().publish({
      topic: 'ipsla.probe.started',
      payload: {
        deviceId: this.host.id,
        hostname: this.host.getHostname(),
        operationId: runtime.config.id,
        type: runtime.config.type,
        target: runtime.config.target,
      },
    });

    let outcome: SlaProbeOutcome;
    try {
      outcome = await this.dispatch(runtime);
    } catch (error) {
      outcome = {
        returnCode: 'notConnected',
        rttMs: null,
        diagText: error instanceof Error ? error.message : 'probe failed',
        respondingAddress: null,
      };
    } finally {
      runtime.running = false;
    }

    this.record(runtime, outcome, startedAt);
    return outcome;
  }

  private async dispatch(runtime: SlaOperationRuntime): Promise<SlaProbeOutcome> {
    if (runtime.config.aggregateProbes <= 1) return this.dispatchOne(runtime);

    const scheduler = this.scheduler ?? this.getScheduler();
    const config = runtime.config;
    const count = config.aggregateProbes;
    const rtts: number[] = [];
    let overThreshold = 0;
    let lastFailure: SlaProbeOutcome | null = null;

    for (let index = 0; index < count; index++) {
      const outcome = await this.dispatchOne(runtime);
      if (outcome.rttMs === null) lastFailure = outcome;
      else {
        rtts.push(outcome.rttMs);
        if (outcome.returnCode === 'overThreshold') overThreshold++;
      }
      if (index < count - 1 && config.intervalMs > 0) {
        await scheduler.delay(config.intervalMs);
      }
    }

    const batch = { sent: count, received: rtts.length, rtts, overThreshold };
    if (rtts.length === 0) {
      return {
        returnCode: lastFailure?.returnCode ?? 'timeout',
        rttMs: null,
        diagText: lastFailure?.diagText ?? '',
        respondingAddress: lastFailure?.respondingAddress ?? null,
        batch,
      };
    }
    const lossPercent = ((count - rtts.length) / count) * 100;
    const mean = rtts.reduce((total, value) => total + value, 0) / rtts.length;
    return {
      returnCode: lossPercent >= config.failPercent
        ? (lastFailure?.returnCode ?? 'timeout')
        : 'ok',
      rttMs: mean,
      diagText: lossPercent > 0 ? (lastFailure?.diagText ?? '') : '',
      respondingAddress: lastFailure?.respondingAddress
        ?? (rtts.length > 0 ? config.target : null),
      batch,
    };
  }

  private async dispatchOne(runtime: SlaOperationRuntime): Promise<SlaProbeOutcome> {
    const config = runtime.config;
    const scheduler = this.scheduler ?? this.getScheduler();
    if (!config.target) {
      return {
        returnCode: 'notConnected',
        rttMs: null,
        diagText: 'No target configured',
        respondingAddress: null,
      };
    }
    // An IPv6 target is a different data plane, not a different
    // spelling of an IPv4 one: only `icmp-echo` has a v6 path today, and
    // the other types say which brick is missing rather than answering
    // `Cannot resolve` for an address that is perfectly well formed.
    if (looksLikeIpv6Target(config.target)) {
      if (config.type !== 'icmp-echo') {
        return {
          returnCode: 'notConnected', rttMs: null,
          diagText: `IPv6 target not supported for ${config.type} (no IPv6 transport for this operation)`,
          respondingAddress: null,
        };
      }
      runtime.sequence = (runtime.sequence + 1) & 0xffff;
      return sendIcmpv6Echo({
        host: this.host,
        bus: this.getBus(),
        scheduler,
        config,
        identifier: runtime.identifier,
        sequence: runtime.sequence,
        destination: config.target,
        timeoutMs: config.timeoutMs,
      });
    }

    const destination = this.resolveTarget(config.target);
    if (!destination) {
      return {
        returnCode: 'notConnected',
        rttMs: null,
        diagText: `Cannot resolve ${config.target}`,
        respondingAddress: null,
      };
    }

    switch (config.type) {
      case 'icmp-echo':
        runtime.sequence = (runtime.sequence + 1) & 0xffff;
        return sendIcmpEcho({
          host: this.host,
          bus: this.getBus(),
          scheduler,
          config,
          identifier: runtime.identifier,
          sequence: runtime.sequence,
          destination,
          timeoutMs: config.timeoutMs,
        });
      case 'icmp-jitter': {
        const base = (runtime.sequence + 1) & 0xffff;
        runtime.sequence = (base + config.numPackets) & 0xffff;
        return runIcmpJitterProbe(
          this.host, this.getBus(), scheduler, config, runtime.identifier, base, destination,
        );
      }
      case 'udp-echo':
      case 'udp-jitter':
        return runUdpProbe({
          host: this.host,
          scheduler,
          transport: this.transport,
          config,
          destination,
        });
      case 'tcp-connect':
        return runTcpConnectProbe(this.host, scheduler, config, destination);
      case 'http':
        return runHttpProbe(this.host, scheduler, config);
      case 'dns':
        return runDnsProbe(this.host, scheduler, this.transport, config);
      case 'path-echo':
        runtime.sequence = (runtime.sequence + 1) & 0xffff;
        return runPathEchoProbe(
          this.host, this.getBus(), scheduler, config, runtime.identifier, destination,
        );
      default:
        return {
          returnCode: 'notConnected',
          rttMs: null,
          diagText: `Operation type ${config.type} not supported`,
          respondingAddress: null,
        };
    }
  }

  private resolveTarget(target: string): IPAddress | null {
    const direct = IPAddress.tryParse(target);
    if (direct) return direct;
    const resolved = this.host.resolveHostname(target);
    return resolved ? IPAddress.tryParse(resolved) : null;
  }

  private record(runtime: SlaOperationRuntime, outcome: SlaProbeOutcome, startedAtMs: number): void {
    runtime.lastRunAtMs = startedAtMs;
    runtime.lastRunEpochMs = this.host.epochMs();
    runtime.lastReturnCode = outcome.returnCode;
    runtime.lastRttMs = outcome.rttMs;
    runtime.lastDiagText = outcome.diagText;
    runtime.lastRespondingAddress = outcome.respondingAddress;
    runtime.lastBatch = outcome.batch ?? null;

    recordReturnCode(runtime.counters, outcome.returnCode);
    if (outcome.rttMs !== null) {
      recordRtt(runtime.aggregate, outcome.rttMs);
      recordDistribution(runtime.distribution, outcome.rttMs);
    }
    if (outcome.jitter) {
      accumulateJitter(runtime.jitter, outcome.jitter);
      if (runtime.config.codec) {
        const oneWay = runtime.jitter.oneWaySD.numSamples > 0
          ? runtime.jitter.oneWaySD.sum / runtime.jitter.oneWaySD.numSamples
          : (outcome.rttMs ?? 0) / 2;
        runtime.emodel = evaluateEModel({
          codec: runtime.config.codec,
          packetLossPercent: packetLossPercent(runtime.jitter),
          oneWayDelayMs: oneWay,
          advantageFactor: runtime.config.advantageFactor,
        });
      }
    }
    this.appendHistory(runtime, outcome);
    this.applyReactions(runtime);

    this.getBus().publish({
      topic: 'ipsla.probe.completed',
      payload: {
        deviceId: this.host.id,
        hostname: this.host.getHostname(),
        operationId: runtime.config.id,
        type: runtime.config.type,
        target: runtime.config.target,
        returnCode: outcome.returnCode,
        rttMs: outcome.rttMs,
        diagText: outcome.diagText,
      },
    });
  }

  private appendHistory(runtime: SlaOperationRuntime, outcome: SlaProbeOutcome): void {
    const config = runtime.config;
    if (config.historyLivesKept === 0 && config.historyFilter === 'none') return;
    const keep = config.historyFilter === 'all'
      || (config.historyFilter === 'failures' && !isResponding(outcome.returnCode))
      || (config.historyFilter === 'overThreshold' && outcome.returnCode === 'overThreshold');
    if (!keep) return;
    runtime.history.push({
      sampleTimeMs: this.host.epochMs(),
      returnCode: outcome.returnCode,
      rttMs: outcome.rttMs,
      respondingAddress: outcome.respondingAddress,
    });
    const capacity = Math.max(1, config.historyBucketsKept);
    while (runtime.history.length > capacity) runtime.history.shift();
  }

  latestReturnLabel(id: number): string {
    const runtime = this.operations.get(id);
    if (!runtime || runtime.lastReturnCode === null) return 'Unknown';
    return RETURN_CODE_LABEL[runtime.lastReturnCode];
  }

  isReachable(id: number): boolean {
    const runtime = this.operations.get(id);
    if (!runtime || runtime.state !== 'active' || runtime.lastReturnCode === null) return false;
    return isResponding(runtime.lastReturnCode);
  }

  isWithinThreshold(id: number): boolean {
    const runtime = this.operations.get(id);
    if (!runtime || runtime.state !== 'active' || runtime.lastReturnCode === null) return false;
    return runtime.lastReturnCode === 'ok';
  }

  reset(): void {
    this.operations.clear();
    this.reactions.length = 0;
    this.reactionTriggers.clear();
    this.udpListeners.clear();
    this.responder.reset();
    this.keyChain = null;
    this.globalEnabled = true;
    this.loggingTrapsEnabled = false;
  }
}
