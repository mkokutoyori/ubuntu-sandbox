import { getDefaultScheduler } from '@/events/Scheduler';
import { PathClock } from '@/network/core/time/PathClock';
import { timestampFromMs, timestampToMs } from '@/network/ntp/timestamp';
import type { GachDelivery } from '../MplsEngine';
import { ChannelType, type GachPayload } from './GachPacket';
import type { MplsTpEngine } from './MplsTpEngine';
import {
  PerformanceDecodeError, QueryControlCode, ResponseControlCode, TimestampFormat,
  decodeDelay, decodeLoss, encodeDelay, encodeLoss,
  type DelayMeasurementMessage, type LossMeasurementMessage,
} from './PerformanceMessages';

const SUPPORTED_FORMATS: ReadonlySet<number> = new Set([TimestampFormat.Ptp, TimestampFormat.Ntp]);
const PREFERRED_FORMAT = TimestampFormat.Ptp;
const MS_PER_SECOND = 1000;
const NS_PER_MS = 1_000_000;
const MASK_32 = 0xffffffffn;

export interface DelayResult {
  readonly responseCode: number;
  readonly roundTripMs: number | null;
  readonly responderFormat: number;
  readonly responderPreferredFormat: number;
}

export interface LossResult {
  readonly responseCode: number;
  readonly forwardLoss: bigint | null;
  readonly reverseLoss: bigint | null;
  readonly unit: 'packets' | 'octets';
}

export interface DelayQueryOptions {
  readonly outLsp: string;
  readonly sessionId?: number;
  readonly ds?: number;
  readonly timestampFormat?: number;
  readonly controlCode?: number;
}

export interface LossQueryOptions {
  readonly outLsp: string;
  readonly sessionId?: number;
  readonly octets?: boolean;
  readonly extendedCounters?: boolean;
  readonly trafficClassSpecific?: boolean;
  readonly ds?: number;
  readonly controlCode?: number;
}

interface LossState {
  txPackets: bigint;
  rxAtResponder: bigint;
  responderTx: bigint;
  rxAtQuerier: bigint;
}

function nowMs(): number {
  return getDefaultScheduler().now() + PathClock.now();
}

export function encodeTimestamp(format: number, ms: number): bigint {
  if (format === TimestampFormat.Ntp) return timestampFromMs(ms);
  if (format === TimestampFormat.Ptp) {
    const seconds = Math.floor(ms / MS_PER_SECOND);
    const nanoseconds = Math.round((ms - seconds * MS_PER_SECOND) * NS_PER_MS);
    return (BigInt(seconds) << 32n) | BigInt(nanoseconds);
  }
  return 0n;
}

export function decodeTimestamp(format: number, timestamp: bigint, pivotMs: number): number | null {
  if (format === TimestampFormat.Ptp) {
    return Number(timestamp >> 32n) * MS_PER_SECOND + Number(timestamp & MASK_32) / NS_PER_MS;
  }
  if (format === TimestampFormat.Ntp) return timestampToMs(timestamp, pivotMs);
  return null;
}

function wrap(value: bigint, extended: boolean): bigint {
  return extended ? BigInt.asUintN(64, value) : BigInt.asUintN(32, value);
}

export class TpPerformanceEngine {
  private readonly returns = new Map<string, string>();
  private readonly lossStates = new Map<string, LossState>();
  private pendingDelay: DelayResult | null = null;
  private pendingLoss: LossResult | null = null;
  private nextSession = 1;

  constructor(private readonly tp: MplsTpEngine) {
    tp.registerChannel(ChannelType.DirectLossMeasurement, delivery => this.receiveLoss(delivery));
    tp.registerChannel(ChannelType.DelayMeasurement, delivery => this.receiveDelay(delivery));
  }

  bindReturn(inLsp: string, outLsp: string): void {
    this.returns.set(inLsp, outLsp);
  }

  queryDelay(options: DelayQueryOptions): DelayResult | null {
    const format = options.timestampFormat ?? PREFERRED_FORMAT;
    const query: DelayMeasurementMessage = {
      response: false, controlCode: options.controlCode ?? QueryControlCode.InBandResponse,
      querierTimestampFormat: format, responderTimestampFormat: 0, responderPreferredFormat: 0,
      sessionId: options.sessionId ?? this.nextSession++, ds: options.ds ?? 0,
      timestamps: [encodeTimestamp(format, nowMs()), 0n, 0n, 0n],
    };
    this.pendingDelay = null;
    this.tp.sendOverLsp(options.outLsp, { type: 'gach', channelType: ChannelType.DelayMeasurement, message: encodeDelay(query) });
    const result = this.pendingDelay;
    this.pendingDelay = null;
    return result;
  }

  queryLoss(options: LossQueryOptions): LossResult | null {
    const octets = options.octets === true;
    const counters = this.tp.dataCounters(options.outLsp);
    const query: LossMeasurementMessage = {
      response: false, trafficClassSpecific: options.trafficClassSpecific === true,
      controlCode: options.controlCode ?? QueryControlCode.InBandResponse,
      extendedCounters: options.extendedCounters !== false, octetCounts: octets,
      originTimestampFormat: PREFERRED_FORMAT, sessionId: options.sessionId ?? this.nextSession++, ds: options.ds ?? 0,
      originTimestamp: encodeTimestamp(PREFERRED_FORMAT, nowMs()),
      counters: [octets ? counters.txOctets : counters.txPackets, 0n, 0n, 0n],
    };
    this.pendingLoss = null;
    this.tp.sendOverLsp(options.outLsp, { type: 'gach', channelType: ChannelType.DirectLossMeasurement, message: encodeLoss(query) });
    const result = this.pendingLoss;
    this.pendingLoss = null;
    return result;
  }

  private respond(delivery: GachDelivery, channelType: number, bytes: Uint8Array): void {
    const out = delivery.lsp === null ? undefined : this.returns.get(delivery.lsp);
    if (out === undefined) return;
    const payload: GachPayload = { type: 'gach', channelType, message: bytes };
    this.tp.sendOverLsp(out, payload);
  }

  private receiveDelay(delivery: GachDelivery): void {
    if (delivery.reason !== 'terminated' || !(delivery.payload.message instanceof Uint8Array)) return;
    let message: DelayMeasurementMessage;
    try { message = decodeDelay(delivery.payload.message); } catch (error) {
      if (error instanceof PerformanceDecodeError) return;
      throw error;
    }
    if (message.response) {
      this.completeDelay(message);
      return;
    }
    const receivedAt = nowMs();
    if (message.controlCode === QueryControlCode.NoResponse) return;
    const supported = SUPPORTED_FORMATS.has(message.querierTimestampFormat);
    const responderFormat = supported ? message.querierTimestampFormat : PREFERRED_FORMAT;
    const unsupportedCode = message.controlCode !== QueryControlCode.InBandResponse;
    const response: DelayMeasurementMessage = {
      response: true,
      controlCode: unsupportedCode ? ResponseControlCode.UnsupportedControlCode : ResponseControlCode.Success,
      querierTimestampFormat: message.querierTimestampFormat, responderTimestampFormat: responderFormat,
      responderPreferredFormat: PREFERRED_FORMAT, sessionId: message.sessionId, ds: message.ds,
      timestamps: [encodeTimestamp(responderFormat, nowMs()), 0n, message.timestamps[0], encodeTimestamp(responderFormat, receivedAt)],
    };
    this.respond(delivery, ChannelType.DelayMeasurement, encodeDelay(response));
  }

  private completeDelay(message: DelayMeasurementMessage): void {
    const receivedAt = nowMs();
    const base = {
      responseCode: message.controlCode, responderFormat: message.responderTimestampFormat,
      responderPreferredFormat: message.responderPreferredFormat,
    };
    if (message.controlCode !== ResponseControlCode.Success) {
      this.pendingDelay = { ...base, roundTripMs: null };
      return;
    }
    const t1 = decodeTimestamp(message.querierTimestampFormat, message.timestamps[2], receivedAt);
    const t2 = decodeTimestamp(message.responderTimestampFormat, message.timestamps[3], receivedAt);
    const t3 = decodeTimestamp(message.responderTimestampFormat, message.timestamps[0], receivedAt);
    this.pendingDelay = { ...base, roundTripMs: t1 === null || t2 === null || t3 === null ? null : (receivedAt - t1) - (t3 - t2) };
  }

  private receiveLoss(delivery: GachDelivery): void {
    if (delivery.reason !== 'terminated' || !(delivery.payload.message instanceof Uint8Array)) return;
    let message: LossMeasurementMessage;
    try { message = decodeLoss(delivery.payload.message); } catch (error) {
      if (error instanceof PerformanceDecodeError) return;
      throw error;
    }
    if (message.response) {
      this.completeLoss(delivery, message);
      return;
    }
    if (message.controlCode === QueryControlCode.NoResponse) return;
    const outLsp = delivery.lsp === null ? undefined : this.returns.get(delivery.lsp);
    if (outLsp === undefined || delivery.lsp === null) return;
    const rejection = message.controlCode !== QueryControlCode.InBandResponse
      ? ResponseControlCode.UnsupportedControlCode
      : message.trafficClassSpecific ? ResponseControlCode.UnsupportedDataFormat : null;
    const received = this.tp.dataCounters(delivery.lsp);
    const sent = this.tp.dataCounters(outLsp);
    const response: LossMeasurementMessage = {
      response: true, trafficClassSpecific: message.trafficClassSpecific,
      controlCode: rejection ?? ResponseControlCode.Success, extendedCounters: message.extendedCounters, octetCounts: message.octetCounts,
      originTimestampFormat: message.originTimestampFormat, sessionId: message.sessionId, ds: message.ds,
      originTimestamp: message.originTimestamp,
      counters: [
        message.octetCounts ? sent.txOctets : sent.txPackets, 0n, message.counters[0],
        message.octetCounts ? received.rxOctets : received.rxPackets,
      ],
    };
    this.respond(delivery, ChannelType.DirectLossMeasurement, encodeLoss(response));
  }

  private completeLoss(delivery: GachDelivery, message: LossMeasurementMessage): void {
    const unit = message.octetCounts ? 'octets' : 'packets';
    if (message.controlCode !== ResponseControlCode.Success || delivery.lsp === null) {
      this.pendingLoss = { responseCode: message.controlCode, forwardLoss: null, reverseLoss: null, unit };
      return;
    }
    const received = this.tp.dataCounters(delivery.lsp);
    const key = `${delivery.lsp}|${message.sessionId}`;
    const current: LossState = {
      txPackets: message.counters[2], rxAtResponder: message.counters[3], responderTx: message.counters[0],
      rxAtQuerier: message.octetCounts ? received.rxOctets : received.rxPackets,
    };
    const previous = this.lossStates.get(key);
    this.lossStates.set(key, current);
    const extended = message.extendedCounters;
    this.pendingLoss = {
      responseCode: message.controlCode, unit,
      forwardLoss: previous === undefined ? null
        : wrap((current.txPackets - previous.txPackets) - (current.rxAtResponder - previous.rxAtResponder), extended),
      reverseLoss: previous === undefined ? null
        : wrap((current.responderTx - previous.responderTx) - (current.rxAtQuerier - previous.rxAtQuerier), extended),
    };
  }
}
