export type NtpTimestamp = bigint;

export const NTP_TIMESTAMP_ZERO: NtpTimestamp = 0n;
export const NTP_ERA_OFFSET_SEC = 2208988800n;

const FRACTION_BITS = 32n;
const FRACTION_UNITS = 1n << FRACTION_BITS;
const TIMESTAMP_MASK = (1n << 64n) - 1n;
const MICROSECONDS = 1_000_000n;

export function timestampFromMs(ms: number): NtpTimestamp {
  if (!ms) return NTP_TIMESTAMP_ZERO;
  const micros = BigInt(Math.round(ms * 1000));
  const seconds = micros / MICROSECONDS;
  const remainder = micros % MICROSECONDS;
  return (((seconds + NTP_ERA_OFFSET_SEC) << FRACTION_BITS) | ((remainder * FRACTION_UNITS) / MICROSECONDS)) & TIMESTAMP_MASK;
}

export function timestampToMs(timestamp: NtpTimestamp, pivotMs: number): number {
  if (timestamp === NTP_TIMESTAMP_ZERO) return 0;
  const seconds = timestamp >> FRACTION_BITS;
  const fraction = timestamp & (FRACTION_UNITS - 1n);
  const pivotSeconds = BigInt(Math.floor(pivotMs / 1000)) + NTP_ERA_OFFSET_SEC;
  const eraLength = 1n << 32n;
  const diff = pivotSeconds - seconds;
  const era = diff >= 0n ? (diff + eraLength / 2n) / eraLength : -((-diff + eraLength / 2n) / eraLength);
  const absolute = seconds + era * eraLength;
  return Number(absolute - NTP_ERA_OFFSET_SEC) * 1000 + (Number(fraction) / Number(FRACTION_UNITS)) * 1000;
}

export function timestampDifferenceMs(later: NtpTimestamp, earlier: NtpTimestamp): number {
  const difference = BigInt.asIntN(64, later - earlier);
  return (Number(difference) / Number(FRACTION_UNITS)) * 1000;
}

export function splitTimestamp(timestamp: NtpTimestamp): { seconds: number; fraction: number } {
  return { seconds: Number(timestamp >> FRACTION_BITS), fraction: Number(timestamp & (FRACTION_UNITS - 1n)) };
}

export function joinTimestamp(seconds: number, fraction: number): NtpTimestamp {
  return (BigInt(seconds >>> 0) << FRACTION_BITS) | BigInt(fraction >>> 0);
}
