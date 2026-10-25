import { latin1Bytes } from './engine/Latin1';
import { snappyCompress } from './Snappy';

const TIMESERIES_FIELD = 0x0a;
const LABELS_FIELD = 0x0a;
const SAMPLES_FIELD = 0x12;
const LABEL_NAME_FIELD = 0x0a;
const LABEL_VALUE_FIELD = 0x12;
const SAMPLE_VALUE_FIELD = 0x09;
const SAMPLE_TIMESTAMP_FIELD = 0x10;
const NAME_LABEL = '__name__';

export interface WriteLabel {
  readonly name: Uint8Array;
  readonly value: Uint8Array;
}

export interface WriteSeries {
  readonly labels: readonly WriteLabel[];
  readonly value: number;
  readonly timestampMs: number;
}

function varintBytes(value: bigint): number[] {
  const bytes: number[] = [];
  let remaining = BigInt.asUintN(64, value);
  while (remaining >= 0x80n) {
    bytes.push(Number(remaining & 0x7fn) | 0x80);
    remaining >>= 7n;
  }
  bytes.push(Number(remaining));
  return bytes;
}

function lengthDelimited(field: number, payload: readonly number[] | Uint8Array): number[] {
  return [field, ...varintBytes(BigInt(payload.length)), ...payload];
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const common = Math.min(left.length, right.length);
  for (let index = 0; index < common; index++) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return left.length - right.length;
}

function packLabel(label: WriteLabel): number[] {
  const payload: number[] = [];
  if (label.name.length > 0) payload.push(...lengthDelimited(LABEL_NAME_FIELD, label.name));
  if (label.value.length > 0) payload.push(...lengthDelimited(LABEL_VALUE_FIELD, label.value));
  return payload;
}

function packSample(value: number, timestampMs: number): number[] {
  const payload: number[] = [];
  const bits = new DataView(new ArrayBuffer(8));
  bits.setFloat64(0, value, true);
  if (bits.getBigUint64(0, true) !== 0n) payload.push(SAMPLE_VALUE_FIELD, ...new Uint8Array(bits.buffer));
  if (timestampMs !== 0) payload.push(SAMPLE_TIMESTAMP_FIELD, ...varintBytes(BigInt(timestampMs)));
  return payload;
}

function packSeries(series: WriteSeries): number[] {
  const payload: number[] = [];
  for (const label of series.labels) payload.push(...lengthDelimited(LABELS_FIELD, packLabel(label)));
  payload.push(...lengthDelimited(SAMPLES_FIELD, packSample(series.value, series.timestampMs)));
  return payload;
}

export function buildSeries(metricName: string, value: number, timestampMs: number, labelPairs: readonly string[]): WriteSeries {
  const labels: WriteLabel[] = [{ name: latin1Bytes(NAME_LABEL), value: latin1Bytes(metricName) }];
  for (const pair of labelPairs) {
    const separator = pair.indexOf('=');
    if (separator === -1) continue;
    labels.push({ name: latin1Bytes(pair.slice(0, separator)), value: latin1Bytes(pair.slice(separator + 1)) });
  }
  labels.sort((left, right) => compareBytes(left.name, right.name));
  return { labels, value, timestampMs };
}

export function packWriteRequest(series: readonly WriteSeries[]): Uint8Array {
  const payload: number[] = [];
  for (const entry of series) payload.push(...lengthDelimited(TIMESERIES_FIELD, packSeries(entry)));
  return Uint8Array.from(payload);
}

export function packedWriteRequestSize(series: readonly WriteSeries[]): number {
  return packWriteRequest(series).length;
}

export function encodeWriteRequest(series: readonly WriteSeries[]): Uint8Array {
  return snappyCompress(packWriteRequest(series));
}
