import { internetChecksum } from '@/network/layers/transport/L4Checksum';
import { unsignedRelativeTime } from './TcpdumpTime';

type AddressName = (address: string) => string;

const TRUNCATED = ' [|igmp]';
const V3_QUERY_MIN_BYTES = 12;
const V3_REPORT_MIN_BYTES = 16;
const IGMP_V1_DEFAULT_RESPONSE = 100;
const RECORD_TYPES: Readonly<Record<number, string>> = { 1: 'is_in', 2: 'is_ex', 3: 'to_in', 4: 'to_ex', 5: 'allow', 6: 'block' };

class Truncated extends Error {}

function u8(bytes: readonly number[], at: number): number {
  if (at >= bytes.length) throw new Truncated();
  return bytes[at];
}

function u16(bytes: readonly number[], at: number): number {
  return (u8(bytes, at) << 8) | u8(bytes, at + 1);
}

function u32(bytes: readonly number[], at: number): number {
  return ((u8(bytes, at) << 24) | (u8(bytes, at + 1) << 16) | (u8(bytes, at + 2) << 8) | u8(bytes, at + 3)) >>> 0;
}

function dotted(bytes: readonly number[], at: number, name: AddressName): string {
  u8(bytes, at + 3);
  return name(`${bytes[at]}.${bytes[at + 1]}.${bytes[at + 2]}.${bytes[at + 3]}`);
}

function responseTime(code: number): number {
  return code < 128 ? code : ((code & 0x0f) | 0x10) << (((code & 0x70) >> 4) + 3);
}

function versionThreeQuery(bytes: readonly number[], length: number, verbose: number, name: AddressName, emit: (text: string) => void): void {
  emit(' v3');
  if (length < V3_QUERY_MIN_BYTES || (length & 3) !== 0) {
    emit(` [invalid len ${length}]`);
    return;
  }
  const code = u8(bytes, 1);
  const tenths = responseTime(code);
  if (code !== IGMP_V1_DEFAULT_RESPONSE) emit(` [max resp time ${tenths < 600 ? `${(tenths * 0.1).toFixed(1)}s` : unsignedRelativeTime(Math.floor(tenths / 10))}]`);
  if (u32(bytes, 4) === 0) return;
  emit(` [gaddr ${dotted(bytes, 4, name)}`);
  const sources = u16(bytes, 10);
  if (sources > 0) {
    if (length < 12 + (sources << 2)) emit(' [invalid number of sources]');
    else if (verbose > 1) {
      emit(' {');
      for (let index = 0; index < sources; index++) emit(` ${dotted(bytes, 12 + (index << 2), name)}`);
      emit(' }');
    } else emit(`, ${sources} source(s)`);
  }
  emit(']');
}

function versionThreeReport(bytes: readonly number[], length: number, verbose: number, name: AddressName, emit: (text: string) => void): void {
  if (length < V3_REPORT_MIN_BYTES || (length & 3) !== 0) {
    emit(` [invalid len ${length}]`);
    return;
  }
  const groups = u16(bytes, 6);
  emit(`, ${groups} group record(s)`);
  if (verbose < 1) return;
  let group = 8;
  for (let index = 0; index < groups; index++) {
    if (length < group + 8) {
      emit(' [invalid number of groups]');
      return;
    }
    emit(` [gaddr ${dotted(bytes, group + 4, name)}`);
    const type = u8(bytes, group);
    emit(` ${RECORD_TYPES[type] ?? ` [v3-report-#${type}]`}`);
    const sources = u16(bytes, group + 2);
    if (length < group + 8 + (sources << 2)) {
      emit(` [invalid number of sources ${sources}]`);
      return;
    }
    if (verbose === 1) emit(`, ${sources} source(s)`);
    else {
      emit(' {');
      for (let source = 0; source < sources; source++) emit(` ${dotted(bytes, group + 8 + (source << 2), name)}`);
      emit(' }');
    }
    group += 8 + (sources << 2);
    emit(']');
  }
}

function print(bytes: readonly number[], length: number, verbose: number, quiet: boolean, name: AddressName, emit: (text: string) => void): void {
  if (quiet) {
    emit('igmp');
    return;
  }
  const type = u8(bytes, 0);
  if (type === 0x11) {
    emit('igmp query');
    if (length >= V3_QUERY_MIN_BYTES) versionThreeQuery(bytes, length, verbose, name, emit);
    else {
      const response = u8(bytes, 1);
      if (response !== 0) {
        emit(' v2');
        if (response !== IGMP_V1_DEFAULT_RESPONSE) emit(` [max resp time ${response}]`);
      } else emit(' v1');
      if (u32(bytes, 4) !== 0) emit(` [gaddr ${dotted(bytes, 4, name)}]`);
      if (length !== 8) emit(` [len ${length}]`);
    }
  } else if (type === 0x12) {
    emit(`igmp v1 report ${dotted(bytes, 4, name)}`);
    if (length !== 8) emit(` [len ${length}]`);
  } else if (type === 0x16) {
    emit(`igmp v2 report ${dotted(bytes, 4, name)}`);
  } else if (type === 0x22) {
    emit('igmp v3 report');
    versionThreeReport(bytes, length, verbose, name, emit);
  } else if (type === 0x17) {
    emit(`igmp leave ${dotted(bytes, 4, name)}`);
  } else {
    emit(`igmp-${type}`);
  }
  if (verbose > 0 && length >= 4 && bytes.length >= length && internetChecksum(bytes.slice(0, length)) !== 0) {
    emit(` bad igmp cksum ${u16(bytes, 2).toString(16)}!`);
  }
}

export function igmpText(bytes: readonly number[], length: number, verbose: number, quiet: boolean, name: AddressName): string {
  let text = '';
  try {
    print(bytes, length, verbose, quiet, name, (piece) => { text += piece; });
  } catch (error) {
    if (error instanceof Truncated) return text + TRUNCATED;
    throw error;
  }
  return text;
}
