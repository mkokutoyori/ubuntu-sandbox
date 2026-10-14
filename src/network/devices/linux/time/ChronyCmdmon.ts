export const CMDMON_PORT = 323;
export const PROTO_VERSION = 6;
export const PKT_TYPE_REQUEST = 1;
export const PKT_TYPE_REPLY = 2;
export const REQUEST_HEADER_LENGTH = 20;
export const REPLY_HEADER_LENGTH = 28;
export const MAX_REQUEST_LENGTH = 856;
const MAX_PADDING_LENGTH = 484;
export const PROTO_VERSION_PADDING = 6;
export const PROTO_VERSION_MISMATCH_COMPAT_SERVER = 5;

export const REQ = {
  NULL: 0, ONLINE: 1, OFFLINE: 2, BURST: 3, MODIFY_MINPOLL: 4, MODIFY_MAXPOLL: 5, DUMP: 6, MODIFY_MAXDELAY: 7,
  MODIFY_MAXDELAYRATIO: 8, MODIFY_MAXUPDATESKEW: 9, LOGON: 10, SETTIME: 11, LOCAL: 12, MANUAL: 13, N_SOURCES: 14,
  SOURCE_DATA: 15, REKEY: 16, ALLOW: 17, ALLOWALL: 18, DENY: 19, DENYALL: 20, CMDALLOW: 21, CMDALLOWALL: 22,
  CMDDENY: 23, CMDDENYALL: 24, ACCHECK: 25, CMDACCHECK: 26, ADD_SERVER: 27, ADD_PEER: 28, DEL_SOURCE: 29,
  WRITERTC: 30, DFREQ: 31, DOFFSET: 32, TRACKING: 33, SOURCESTATS: 34, RTCREPORT: 35, TRIMRTC: 36, CYCLELOGS: 37,
  SUBNETS_ACCESSED: 38, CLIENT_ACCESSES: 39, CLIENT_ACCESSES_BY_INDEX: 40, MANUAL_LIST: 41, MANUAL_DELETE: 42,
  MAKESTEP: 43, ACTIVITY: 44, MODIFY_MINSTRATUM: 45, MODIFY_POLLTARGET: 46, MODIFY_MAXDELAYDEVRATIO: 47,
  RESELECT: 48, RESELECTDISTANCE: 49, MODIFY_MAKESTEP: 50, SMOOTHING: 51, SMOOTHTIME: 52, REFRESH: 53,
  SERVER_STATS: 54, CLIENT_ACCESSES_BY_INDEX2: 55, LOCAL2: 56, NTP_DATA: 57, ADD_SERVER2: 58, ADD_PEER2: 59,
  ADD_SERVER3: 60, ADD_PEER3: 61, SHUTDOWN: 62, ONOFFLINE: 63, ADD_SOURCE: 64, NTP_SOURCE_NAME: 65,
  RESET_SOURCES: 66, AUTH_DATA: 67, CLIENT_ACCESSES_BY_INDEX3: 68, SELECT_DATA: 69, RELOAD_SOURCES: 70,
  DOFFSET2: 71, MODIFY_SELECTOPTS: 72,
} as const;
export const N_REQUEST_TYPES = 73;

export const RPY = {
  NULL: 1, N_SOURCES: 2, SOURCE_DATA: 3, MANUAL_TIMESTAMP: 4, TRACKING: 5, SOURCESTATS: 6, RTC: 7,
  SUBNETS_ACCESSED: 8, CLIENT_ACCESSES: 9, CLIENT_ACCESSES_BY_INDEX: 10, MANUAL_LIST: 11, ACTIVITY: 12,
  SMOOTHING: 13, SERVER_STATS: 14, CLIENT_ACCESSES_BY_INDEX2: 15, NTP_DATA: 16, MANUAL_TIMESTAMP2: 17,
  MANUAL_LIST2: 18, NTP_SOURCE_NAME: 19, AUTH_DATA: 20, CLIENT_ACCESSES_BY_INDEX3: 21, SERVER_STATS2: 22,
  SELECT_DATA: 23, SERVER_STATS3: 24, SERVER_STATS4: 25,
} as const;
export const N_REPLY_TYPES = 26;

export const STT = {
  SUCCESS: 0, FAILED: 1, UNAUTH: 2, INVALID: 3, NOSUCHSOURCE: 4, INVALIDTS: 5, NOTENABLED: 6, BADSUBNET: 7,
  ACCESSALLOWED: 8, ACCESSDENIED: 9, NOHOSTACCESS: 10, SOURCEALREADYKNOWN: 11, TOOMANYSOURCES: 12, NORTC: 13,
  BADRTCFILE: 14, INACTIVE: 15, BADSAMPLE: 16, INVALIDAF: 17, BADPKTVERSION: 18, BADPKTLENGTH: 19, INVALIDNAME: 21,
} as const;

export const PERMIT_OPEN = new Set<number>([
  REQ.NULL, REQ.LOGON, REQ.N_SOURCES, REQ.SOURCE_DATA, REQ.TRACKING, REQ.SOURCESTATS, REQ.RTCREPORT, REQ.MANUAL_LIST,
  REQ.ACTIVITY, REQ.SMOOTHING, REQ.NTP_SOURCE_NAME,
]);

const IP = 20;
const TIMESPEC = 12;
const FLOAT = 4;
const INT64 = 8;

const REQUEST_DATA: Readonly<Record<number, number>> = {
  [REQ.NULL]: 0, [REQ.ONLINE]: 2 * IP, [REQ.OFFLINE]: 2 * IP, [REQ.BURST]: 2 * IP + 8, [REQ.MODIFY_MINPOLL]: IP + 4,
  [REQ.MODIFY_MAXPOLL]: IP + 4, [REQ.DUMP]: 4, [REQ.MODIFY_MAXDELAY]: IP + FLOAT, [REQ.MODIFY_MAXDELAYRATIO]: IP + FLOAT,
  [REQ.MODIFY_MAXUPDATESKEW]: FLOAT, [REQ.LOGON]: TIMESPEC, [REQ.SETTIME]: TIMESPEC, [REQ.MANUAL]: 4,
  [REQ.N_SOURCES]: 0, [REQ.SOURCE_DATA]: 4, [REQ.REKEY]: 0, [REQ.ALLOW]: IP + 4, [REQ.ALLOWALL]: IP + 4,
  [REQ.DENY]: IP + 4, [REQ.DENYALL]: IP + 4, [REQ.CMDALLOW]: IP + 4, [REQ.CMDALLOWALL]: IP + 4,
  [REQ.CMDDENY]: IP + 4, [REQ.CMDDENYALL]: IP + 4, [REQ.ACCHECK]: IP, [REQ.CMDACCHECK]: IP, [REQ.DEL_SOURCE]: IP,
  [REQ.WRITERTC]: 0, [REQ.DFREQ]: FLOAT, [REQ.TRACKING]: 0, [REQ.SOURCESTATS]: 4, [REQ.RTCREPORT]: 0,
  [REQ.TRIMRTC]: 0, [REQ.CYCLELOGS]: 0, [REQ.MANUAL_LIST]: 0, [REQ.MANUAL_DELETE]: 4, [REQ.MAKESTEP]: 0,
  [REQ.ACTIVITY]: 0, [REQ.MODIFY_MINSTRATUM]: IP + 4, [REQ.MODIFY_POLLTARGET]: IP + 4,
  [REQ.MODIFY_MAXDELAYDEVRATIO]: IP + FLOAT, [REQ.RESELECT]: 0, [REQ.RESELECTDISTANCE]: FLOAT,
  [REQ.MODIFY_MAKESTEP]: 8, [REQ.SMOOTHING]: 0, [REQ.SMOOTHTIME]: 4, [REQ.REFRESH]: 0, [REQ.SERVER_STATS]: 0,
  [REQ.LOCAL2]: 16, [REQ.NTP_DATA]: IP, [REQ.SHUTDOWN]: 0, [REQ.ONOFFLINE]: 0, [REQ.ADD_SOURCE]: 352,
  [REQ.NTP_SOURCE_NAME]: IP, [REQ.RESET_SOURCES]: 0, [REQ.AUTH_DATA]: IP, [REQ.CLIENT_ACCESSES_BY_INDEX3]: 16,
  [REQ.SELECT_DATA]: 4, [REQ.RELOAD_SOURCES]: 0, [REQ.DOFFSET2]: FLOAT, [REQ.MODIFY_SELECTOPTS]: IP + 12,
};

const REPLY_OF_REQUEST: Readonly<Record<number, number | undefined>> = {
  [REQ.SETTIME]: RPY.MANUAL_TIMESTAMP2, [REQ.N_SOURCES]: RPY.N_SOURCES, [REQ.SOURCE_DATA]: RPY.SOURCE_DATA,
  [REQ.TRACKING]: RPY.TRACKING, [REQ.SOURCESTATS]: RPY.SOURCESTATS, [REQ.RTCREPORT]: RPY.RTC,
  [REQ.MANUAL_LIST]: RPY.MANUAL_LIST2, [REQ.ACTIVITY]: RPY.ACTIVITY, [REQ.SMOOTHING]: RPY.SMOOTHING,
  [REQ.SERVER_STATS]: RPY.SERVER_STATS4, [REQ.NTP_DATA]: RPY.NTP_DATA, [REQ.NTP_SOURCE_NAME]: RPY.NTP_SOURCE_NAME,
  [REQ.AUTH_DATA]: RPY.AUTH_DATA, [REQ.CLIENT_ACCESSES_BY_INDEX3]: RPY.CLIENT_ACCESSES_BY_INDEX3,
  [REQ.SELECT_DATA]: RPY.SELECT_DATA,
};

const REPLY_DATA: Readonly<Record<number, number>> = {
  [RPY.NULL]: 0, [RPY.N_SOURCES]: 4, [RPY.SOURCE_DATA]: IP + 12 + 4 + 3 * FLOAT,
  [RPY.TRACKING]: 4 + IP + 4 + TIMESPEC + 9 * FLOAT,
  [RPY.SOURCESTATS]: 4 + IP + 12 + 5 * FLOAT, [RPY.RTC]: TIMESPEC + 8 + 2 * FLOAT,
  [RPY.ACTIVITY]: 20, [RPY.SMOOTHING]: 4 + 5 * FLOAT,
  [RPY.NTP_DATA]: 2 * IP + 8 + 2 * FLOAT + 4 + TIMESPEC + 5 * FLOAT + 4 + 16 + 12,
  [RPY.MANUAL_TIMESTAMP2]: 3 * FLOAT, [RPY.MANUAL_LIST2]: 4 + 16 * (TIMESPEC + 3 * FLOAT),
  [RPY.NTP_SOURCE_NAME]: 256, [RPY.AUTH_DATA]: 24, [RPY.CLIENT_ACCESSES_BY_INDEX3]: 12 + 8 * (IP + 24 + 4 + 12),
  [RPY.SERVER_STATS4]: 21 * INT64, [RPY.SELECT_DATA]: 4 + IP + 4 + 4 + 4 + 3 * FLOAT,
};

export function replyLengthForCode(replyCode: number): number {
  if (replyCode < 1 || replyCode >= N_REPLY_TYPES) return 0;
  const data = REPLY_DATA[replyCode];
  return data === undefined ? 0 : REPLY_HEADER_LENGTH + data;
}

export function requestLength(command: number, version: number): number {
  if (command >= N_REQUEST_TYPES) return 0;
  const data = REQUEST_DATA[command];
  if (data === undefined) return 0;
  const base = REQUEST_HEADER_LENGTH + data;
  if (version < PROTO_VERSION_PADDING) return base;
  const reply = REPLY_OF_REQUEST[command];
  const replyLength = reply === undefined ? REPLY_HEADER_LENGTH : replyLengthForCode(reply);
  const padding = base < replyLength ? replyLength - base : 0;
  return base + Math.min(padding, MAX_PADDING_LENGTH);
}

export function requestPaddingLength(command: number, version: number): number {
  if (version < PROTO_VERSION_PADDING || command >= N_REQUEST_TYPES) return 0;
  return requestLength(command, version) - (REQUEST_HEADER_LENGTH + (REQUEST_DATA[command] ?? 0));
}

const FLOAT_EXP_BITS = 7;
const FLOAT_COEF_BITS = 32 - FLOAT_EXP_BITS;
const FLOAT_EXP_MIN = -(1 << (FLOAT_EXP_BITS - 1));
const FLOAT_EXP_MAX = -FLOAT_EXP_MIN - 1;
const FLOAT_COEF_MIN = -(1 << (FLOAT_COEF_BITS - 1));
const FLOAT_COEF_MAX = -FLOAT_COEF_MIN - 1;

export function floatToWire(value: number): number {
  let x = value;
  let neg = 0;
  if (x < 0) { x = -x; neg = 1; } else if (!(x >= 0)) { x = 0; }
  let exp: number;
  let coef: number;
  if (x < 1.0e-100) {
    exp = 0; coef = 0;
  } else if (x > 1.0e100) {
    exp = FLOAT_EXP_MAX; coef = FLOAT_COEF_MAX + neg;
  } else {
    exp = Math.trunc(Math.log(x) / Math.log(2) + 1);
    coef = Math.trunc(x * 2 ** (-exp + FLOAT_COEF_BITS) + 0.5);
    while (coef > FLOAT_COEF_MAX + neg) { coef >>= 1; exp++; }
    if (exp > FLOAT_EXP_MAX) {
      exp = FLOAT_EXP_MAX; coef = FLOAT_COEF_MAX + neg;
    } else if (exp < FLOAT_EXP_MIN) {
      if (exp + FLOAT_COEF_BITS >= FLOAT_EXP_MIN) { coef >>= FLOAT_EXP_MIN - exp; exp = FLOAT_EXP_MIN; } else { exp = 0; coef = 0; }
    }
  }
  if (neg) coef = ((-coef) << FLOAT_EXP_BITS) >>> FLOAT_EXP_BITS;
  return (((exp << FLOAT_COEF_BITS) >>> 0) | (coef >>> 0)) >>> 0;
}

export function floatFromWire(word: number): number {
  const x = word >>> 0;
  let exp = x >>> FLOAT_COEF_BITS;
  if (exp >= 1 << (FLOAT_EXP_BITS - 1)) exp -= 1 << FLOAT_EXP_BITS;
  exp -= FLOAT_COEF_BITS;
  let coef = x % (2 ** FLOAT_COEF_BITS);
  if (coef >= 2 ** (FLOAT_COEF_BITS - 1)) coef -= 2 ** FLOAT_COEF_BITS;
  return coef * 2 ** exp;
}

export class WireWriter {
  readonly bytes: Uint8Array;
  private readonly view: DataView;
  offset = 0;

  constructor(length: number) {
    this.bytes = new Uint8Array(length);
    this.view = new DataView(this.bytes.buffer);
  }

  u8(value: number): this { this.view.setUint8(this.offset, value & 0xff); this.offset += 1; return this; }
  i8(value: number): this { this.view.setInt8(this.offset, value); this.offset += 1; return this; }
  u16(value: number): this { this.view.setUint16(this.offset, value & 0xffff); this.offset += 2; return this; }
  i16(value: number): this { this.view.setInt16(this.offset, value); this.offset += 2; return this; }
  u32(value: number): this { this.view.setUint32(this.offset, value >>> 0); this.offset += 4; return this; }
  float(value: number): this { return this.u32(floatToWire(value)); }
  int64(value: number): this {
    const big = BigInt(Math.max(0, Math.trunc(value)));
    this.view.setBigUint64(this.offset, big);
    this.offset += 8;
    return this;
  }
  skip(count: number): this { this.offset += count; return this; }
  ip(address: string | null): this {
    const start = this.offset;
    if (address !== null) {
      const parts = address.split('.').map(Number);
      if (parts.length === 4 && parts.every((p) => p >= 0 && p <= 255)) {
        for (let i = 0; i < 4; i++) this.bytes[start + i] = parts[i];
        this.view.setUint16(start + 16, 1);
      }
    }
    this.offset = start + IP;
    return this;
  }
  timespec(seconds: number): this {
    const whole = Math.floor(seconds);
    const nanos = Math.min(999999999, Math.max(0, Math.round((seconds - whole) * 1e9)));
    const big = BigInt(Math.max(0, whole));
    this.u32(Number(big >> 32n)).u32(Number(big & 0xffffffffn)).u32(nanos);
    return this;
  }
  text(value: string, length: number): this {
    for (let i = 0; i < Math.min(value.length, length - 1); i++) this.bytes[this.offset + i] = value.charCodeAt(i) & 0xff;
    this.offset += length;
    return this;
  }
}

export class WireReader {
  private readonly view: DataView;
  offset = 0;

  constructor(readonly bytes: Uint8Array, start = 0) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.offset = start;
  }

  u8(): number { const v = this.view.getUint8(this.offset); this.offset += 1; return v; }
  i8(): number { const v = this.view.getInt8(this.offset); this.offset += 1; return v; }
  u16(): number { const v = this.view.getUint16(this.offset); this.offset += 2; return v; }
  i16(): number { const v = this.view.getInt16(this.offset); this.offset += 2; return v; }
  u32(): number { const v = this.view.getUint32(this.offset); this.offset += 4; return v; }
  float(): number { return floatFromWire(this.u32()); }
  int64(): number { const v = this.view.getBigUint64(this.offset); this.offset += 8; return Number(v); }
  skip(count: number): this { this.offset += count; return this; }
  ip(): string | null {
    const family = this.view.getUint16(this.offset + 16);
    const start = this.offset;
    this.offset += IP;
    if (family !== 1) return null;
    return `${this.bytes[start]}.${this.bytes[start + 1]}.${this.bytes[start + 2]}.${this.bytes[start + 3]}`;
  }
  timespec(): number {
    const { seconds, nanoseconds } = this.timespecParts();
    return seconds + nanoseconds / 1e9;
  }
  timespecParts(): { seconds: number; nanoseconds: number } {
    const high = this.u32();
    const low = this.u32();
    const nanoseconds = this.u32();
    return { seconds: high * 2 ** 32 + low, nanoseconds };
  }
  text(length: number): string {
    let out = '';
    for (let i = 0; i < length; i++) {
      const c = this.bytes[this.offset + i];
      if (c === 0) break;
      out += String.fromCharCode(c);
    }
    this.offset += length;
    return out;
  }
}

export interface RequestHeader {
  version: number;
  packetType: number;
  res1: number;
  res2: number;
  command: number;
  attempt: number;
  sequence: number;
}

export function parseRequestHeader(bytes: Uint8Array): RequestHeader {
  const r = new WireReader(bytes);
  const version = r.u8();
  const packetType = r.u8();
  const res1 = r.u8();
  const res2 = r.u8();
  const command = r.u16();
  const attempt = r.u16();
  const sequence = r.u32();
  return { version, packetType, res1, res2, command, attempt, sequence };
}

export function encodeRequest(
  command: number, sequence: number, attempt: number, fill?: (writer: WireWriter) => void, version = PROTO_VERSION,
): Uint8Array {
  const length = requestLength(command, version);
  const w = new WireWriter(length);
  w.u8(version).u8(PKT_TYPE_REQUEST).u8(0).u8(0).u16(command).u16(attempt).u32(sequence).u32(0).u32(0);
  fill?.(w);
  return w.bytes;
}

export interface ReplyHeader {
  version: number;
  packetType: number;
  res1: number;
  res2: number;
  command: number;
  reply: number;
  status: number;
  sequence: number;
}

export function parseReplyHeader(bytes: Uint8Array): ReplyHeader {
  const r = new WireReader(bytes);
  const version = r.u8();
  const packetType = r.u8();
  const res1 = r.u8();
  const res2 = r.u8();
  const command = r.u16();
  const reply = r.u16();
  const status = r.u16();
  r.skip(6);
  const sequence = r.u32();
  return { version, packetType, res1, res2, command, reply, status, sequence };
}

export function encodeReply(
  header: { command: number; sequence: number; reply?: number; status?: number },
  fill?: (writer: WireWriter) => void,
): Uint8Array {
  const reply = header.reply ?? RPY.NULL;
  const length = Math.max(REPLY_HEADER_LENGTH, replyLengthForCode(reply));
  const w = new WireWriter(length);
  w.u8(PROTO_VERSION).u8(PKT_TYPE_REPLY).u8(0).u8(0).u16(header.command).u16(reply).u16(header.status ?? STT.SUCCESS)
    .u16(0).u16(0).u16(0).u32(header.sequence).u32(0).u32(0);
  fill?.(w);
  return w.bytes;
}

export interface TrackingWire {
  refId: number; ip: string | null; stratum: number; leap: number; refTime: number; refTimeNanoseconds?: number;
  currentCorrection: number; lastOffset: number; rmsOffset: number; frequencyPpm: number; residualFrequencyPpm: number;
  skewPpm: number; rootDelay: number; rootDispersion: number; lastUpdateInterval: number;
}

export function writeTracking(w: WireWriter, t: TrackingWire): void {
  w.u32(t.refId).ip(t.ip).u16(t.stratum).u16(t.leap).timespec(t.refTime)
    .float(t.currentCorrection).float(t.lastOffset).float(t.rmsOffset).float(t.frequencyPpm)
    .float(t.residualFrequencyPpm).float(t.skewPpm).float(t.rootDelay).float(t.rootDispersion).float(t.lastUpdateInterval);
}

export function readTracking(r: WireReader): TrackingWire {
  const refId = r.u32();
  const ip = r.ip();
  const stratum = r.u16();
  const leap = r.u16();
  const time = r.timespecParts();
  return {
    refId, ip, stratum, leap, refTime: time.seconds + time.nanoseconds / 1e9, refTimeNanoseconds: time.nanoseconds,
    currentCorrection: r.float(), lastOffset: r.float(), rmsOffset: r.float(), frequencyPpm: r.float(),
    residualFrequencyPpm: r.float(), skewPpm: r.float(), rootDelay: r.float(), rootDispersion: r.float(),
    lastUpdateInterval: r.float(),
  };
}

export interface SourceDataWire {
  ip: string | null; poll: number; stratum: number; state: number; mode: number; flags: number; reachability: number;
  sinceSample: number; originalLatestMeasurement: number; latestMeasurement: number; latestMeasurementError: number;
}

export function writeSourceData(w: WireWriter, s: SourceDataWire): void {
  w.ip(s.ip).i16(s.poll).u16(s.stratum).u16(s.state).u16(s.mode).u16(s.flags).u16(s.reachability).u32(s.sinceSample)
    .float(s.originalLatestMeasurement).float(s.latestMeasurement).float(s.latestMeasurementError);
}

export function readSourceData(r: WireReader): SourceDataWire {
  return {
    ip: r.ip(), poll: r.i16(), stratum: r.u16(), state: r.u16(), mode: r.u16(), flags: r.u16(), reachability: r.u16(),
    sinceSample: r.u32(), originalLatestMeasurement: r.float(), latestMeasurement: r.float(), latestMeasurementError: r.float(),
  };
}

export interface SourcestatsWire {
  refId: number; ip: string | null; samples: number; runs: number; spanSeconds: number; standardDeviation: number;
  residualFrequencyPpm: number; skewPpm: number; estimatedOffset: number; estimatedOffsetError: number;
}

export function writeSourcestats(w: WireWriter, s: SourcestatsWire): void {
  w.u32(s.refId).ip(s.ip).u32(s.samples).u32(s.runs).u32(s.spanSeconds).float(s.standardDeviation)
    .float(s.residualFrequencyPpm).float(s.skewPpm).float(s.estimatedOffset).float(s.estimatedOffsetError);
}

export function readSourcestats(r: WireReader): SourcestatsWire {
  return {
    refId: r.u32(), ip: r.ip(), samples: r.u32(), runs: r.u32(), spanSeconds: r.u32(), standardDeviation: r.float(),
    residualFrequencyPpm: r.float(), skewPpm: r.float(), estimatedOffset: r.float(), estimatedOffsetError: r.float(),
  };
}

export interface ActivityWire { online: number; offline: number; burstOnline: number; burstOffline: number; unresolved: number }

export function writeActivity(w: WireWriter, a: ActivityWire): void {
  w.u32(a.online).u32(a.offline).u32(a.burstOnline).u32(a.burstOffline).u32(a.unresolved);
}

export function readActivity(r: WireReader): ActivityWire {
  return { online: r.u32(), offline: r.u32(), burstOnline: r.u32(), burstOffline: r.u32(), unresolved: r.u32() };
}

export interface SmoothingWire {
  flags: number; offset: number; frequencyPpm: number; wanderPpm: number; lastUpdateAgo: number; remainingTime: number;
}

export function writeSmoothing(w: WireWriter, s: SmoothingWire): void {
  w.u32(s.flags).float(s.offset).float(s.frequencyPpm).float(s.wanderPpm).float(s.lastUpdateAgo).float(s.remainingTime);
}

export function readSmoothing(r: WireReader): SmoothingWire {
  return { flags: r.u32(), offset: r.float(), frequencyPpm: r.float(), wanderPpm: r.float(), lastUpdateAgo: r.float(), remainingTime: r.float() };
}

export interface ManualSampleWire { when: number; slewedOffset: number; originalOffset: number; residual: number }

export function writeManualList(w: WireWriter, samples: readonly ManualSampleWire[]): void {
  w.u32(samples.length);
  for (let i = 0; i < 16; i++) {
    const s = samples[i];
    w.timespec(s?.when ?? 0).float(s?.slewedOffset ?? 0).float(s?.originalOffset ?? 0).float(s?.residual ?? 0);
  }
}

export function readManualList(r: WireReader): ManualSampleWire[] {
  const count = r.u32();
  const samples: ManualSampleWire[] = [];
  for (let i = 0; i < 16; i++) {
    const sample = { when: r.timespec(), slewedOffset: r.float(), originalOffset: r.float(), residual: r.float() };
    if (i < count) samples.push(sample);
  }
  return samples;
}
