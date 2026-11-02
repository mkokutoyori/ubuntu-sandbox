import { internetChecksum } from '@/network/layers/transport/L4Checksum';
import { hexPrintLines } from './TcpdumpHex';
import { unsignedRelativeTime } from './TcpdumpTime';

type AddressName = (address: string) => string;
type Emit = (text: string) => void;
type AddressKind = 'unicast' | 'group' | 'source';

const TRUNCATED = ' [|pim]';
const INVALID = ' (invalid)';
const FAMILY_IPV4 = 1;
const FAMILY_IPV6 = 2;
const HOLDTIME_INFINITE = 0xffff;
const OPTION_INDENT = '\n\t    ';

const MESSAGE_NAMES: Readonly<Record<number, string>> = {
  0: 'Hello', 1: 'Register', 2: 'Register Stop', 3: 'Join / Prune', 4: 'Bootstrap', 5: 'Assert', 6: 'Graft',
  7: 'Graft Acknowledgement', 8: 'Candidate RP Advertisement', 9: 'Prune Refresh', 10: 'DF Election', 11: 'ECMP Redirect',
};
const OPTION_NAMES: Readonly<Record<number, string>> = {
  1: 'Hold Time', 2: 'LAN Prune Delay', 18: 'DR Priority (Old)', 19: 'DR Priority', 20: 'Generation ID',
  21: 'State Refresh Capability', 22: 'Bi-Directional Capability', 24: 'Address List', 65001: 'Address List (Old)',
};
const ELECTION_NAMES: Readonly<Record<number, string>> = { 1: 'Offer', 2: 'Winner', 3: 'Backoff', 4: 'Pass' };

class Truncated extends Error {}
class Invalid extends Error {}

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

function hex(value: number, width: number): string {
  return value.toString(16).padStart(width, '0');
}

function dotted(bytes: readonly number[], at: number, name: AddressName): string {
  u8(bytes, at + 3);
  return name(`${bytes[at]}.${bytes[at + 1]}.${bytes[at + 2]}.${bytes[at + 3]}`);
}

function address(bytes: readonly number[], at: number, available: number, kind: AddressKind, name: AddressName, emit: Emit): number {
  if (available < 2) throw new Truncated();
  const family = u8(bytes, at);
  if (family !== FAMILY_IPV4 && family !== FAMILY_IPV6) throw new Truncated();
  if (u8(bytes, at + 1) !== 0) throw new Truncated();
  const size = family === FAMILY_IPV4 ? 4 : 16;
  const body = at + 2;
  const left = available - 2;
  if (kind === 'unicast') {
    if (left < size) throw new Truncated();
    u8(bytes, body + size - 1);
    if (family === FAMILY_IPV4) emit(dotted(bytes, body, name));
    return 2 + size;
  }
  if (left < size + 2) throw new Truncated();
  u8(bytes, body + size + 1);
  if (family === FAMILY_IPV4) {
    emit(dotted(bytes, body + 2, name));
    if (u8(bytes, body + 1) !== 32) emit(`/${u8(bytes, body + 1)}`);
  }
  const flags = u8(bytes, body);
  if (flags !== 0) {
    if (kind === 'group') emit(`(0x${hex(flags, 2)})`);
    else {
      emit(`(${flags & 0x04 ? 'S' : ''}${flags & 0x02 ? 'W' : ''}${flags & 0x01 ? 'R' : ''}`);
      if (flags & 0xf8) emit(`+0x${hex(flags & 0xf8, 2)}`);
      emit(')');
    }
  }
  return 2 + 2 + size;
}

function helloOptions(bytes: readonly number[], start: number, length: number, verbose: number, name: AddressName, emit: Emit): void {
  let at = start;
  let left = length;
  while (left !== 0) {
    if (left < 4) throw new Truncated();
    const type = u16(bytes, at);
    const size = u16(bytes, at + 2);
    emit(`\n\t  ${OPTION_NAMES[type] ?? 'Unknown'} Option (${type}), length ${size}, Value: `);
    at += 4;
    left -= 4;
    if (left < size) throw new Truncated();
    if (size > 0) u8(bytes, at + size - 1);
    if (type === 1) {
      if (size !== 2) {
        emit(`[option length ${size} != 2]`);
        throw new Invalid();
      }
      emit(unsignedRelativeTime(u16(bytes, at)));
    } else if (type === 2) {
      if (size !== 4) {
        emit(`[option length ${size} != 4]`);
        throw new Invalid();
      }
      const delay = u16(bytes, at);
      emit(`\n\t    T-bit=${delay & 0x8000 ? 1 : 0}, LAN delay ${delay & ~0x8000}ms, Override interval ${u16(bytes, at + 2)}ms`);
    } else if (type === 18 || type === 19) {
      if (size === 0) emit('Bi-Directional Capability (Old)');
      else if (size === 4) emit(`${u32(bytes, at)}`);
      else {
        emit(`[option length ${size} != 4]`);
        throw new Invalid();
      }
    } else if (type === 20) {
      if (size !== 4) {
        emit(`[option length ${size} != 4]`);
        throw new Invalid();
      }
      emit(`0x${hex(u32(bytes, at), 8)}`);
    } else if (type === 21) {
      if (size !== 4) {
        emit(`[option length ${size} != 4]`);
        throw new Invalid();
      }
      emit(`v${u8(bytes, at)}`);
      if (u8(bytes, at + 1) !== 0) emit(`, interval ${unsignedRelativeTime(u8(bytes, at + 1))}`);
      if (u16(bytes, at + 2) !== 0) emit(` ?0x${hex(u16(bytes, at + 2), 4)}?`);
    } else if (type === 24 || type === 65001) {
      if (verbose > 1) {
        let cursor = at;
        let remaining = left;
        while (cursor < at + size) {
          emit(OPTION_INDENT);
          const advance = address(bytes, cursor, remaining, 'unicast', name, emit);
          cursor += advance;
          remaining -= advance;
        }
      }
    } else if (type !== 22 && verbose <= 1) {
      emit(hexPrintLines(bytes.slice(at, at + size), OPTION_INDENT));
    }
    if (verbose > 1) emit(hexPrintLines(bytes.slice(at, at + size), OPTION_INDENT));
    at += size;
    left -= size;
  }
}

function joinPrune(bytes: readonly number[], start: number, length: number, type: number, name: AddressName, emit: Emit): void {
  let at = start;
  let left = length;
  const step = (kind: AddressKind): void => {
    const advance = address(bytes, at, left, kind, name, emit);
    at += advance;
    left -= advance;
  };
  if (type !== 7) {
    emit(', upstream-neighbor: ');
    step('unicast');
  }
  if (left < 4) throw new Truncated();
  u8(bytes, at + 3);
  const groups = u8(bytes, at + 1);
  const holdtime = u16(bytes, at + 2);
  emit(`\n\t  ${groups} group(s)`);
  if (type !== 7) emit(`, holdtime: ${holdtime === HOLDTIME_INFINITE ? 'infinite' : unsignedRelativeTime(holdtime)}`);
  at += 4;
  left -= 4;
  for (let index = 0; index < groups; index++) {
    emit(`\n\t    group #${index + 1}: `);
    step('group');
    if (left < 4) throw new Truncated();
    u8(bytes, at + 3);
    const joined = u16(bytes, at);
    const pruned = u16(bytes, at + 2);
    emit(`, joined sources: ${joined}, pruned sources: ${pruned}`);
    at += 4;
    left -= 4;
    for (let source = 0; source < joined; source++) {
      emit(`\n\t      joined source #${source + 1}: `);
      step('source');
    }
    for (let source = 0; source < pruned; source++) {
      emit(`\n\t      pruned source #${source + 1}: `);
      step('source');
    }
  }
}

function bootstrap(bytes: readonly number[], start: number, length: number, name: AddressName, emit: Emit): void {
  let at = start;
  let left = length;
  const step = (kind: AddressKind): void => {
    const advance = address(bytes, at, left, kind, name, emit);
    at += advance;
    left -= advance;
  };
  if (left < 2) throw new Truncated();
  emit(` tag=${u16(bytes, at).toString(16)}`);
  at += 2;
  left -= 2;
  if (left < 1) throw new Truncated();
  emit(` hashmlen=${u8(bytes, at)}`);
  if (left < 2) throw new Truncated();
  emit(` BSRprio=${u8(bytes, at + 1)}`);
  at += 2;
  left -= 2;
  emit(' BSR=');
  step('unicast');
  for (let index = 0; left > 0; index++) {
    emit(` (group${index}: `);
    step('group');
    if (left < 1) throw new Truncated();
    emit(` RPcnt=${u8(bytes, at)}`);
    if (left < 2) throw new Truncated();
    const fragmentCount = u8(bytes, at + 1);
    emit(` FRPcnt=${fragmentCount}`);
    if (left < 4) throw new Truncated();
    at += 4;
    left -= 4;
    for (let rp = 0; rp < fragmentCount && left > 0; rp++) {
      emit(` RP${rp}=`);
      step('unicast');
      if (left < 2) throw new Truncated();
      emit(`,holdtime=${unsignedRelativeTime(u16(bytes, at))}`);
      if (left < 3) throw new Truncated();
      emit(`,prio=${u8(bytes, at + 2)}`);
      if (left < 4) throw new Truncated();
      at += 4;
      left -= 4;
    }
    emit(')');
  }
}

function candidateRp(bytes: readonly number[], start: number, length: number, name: AddressName, emit: Emit): void {
  let at = start;
  let left = length;
  const step = (kind: AddressKind): void => {
    const advance = address(bytes, at, left, kind, name, emit);
    at += advance;
    left -= advance;
  };
  if (left < 1) throw new Truncated();
  const prefixes = u8(bytes, at);
  emit(` prefix-cnt=${prefixes}`);
  if (left < 2) throw new Truncated();
  emit(` prio=${u8(bytes, at + 1)}`);
  if (left < 4) throw new Truncated();
  emit(` holdtime=${unsignedRelativeTime(u16(bytes, at + 2))}`);
  at += 4;
  left -= 4;
  emit(' RP=');
  step('unicast');
  for (let index = 0; index < prefixes && left > 0; index++) {
    emit(` Group${index}=`);
    step('group');
  }
}

function body(bytes: readonly number[], start: number, length: number, type: number, verbose: number, name: AddressName, emit: Emit): void {
  let at = start;
  let left = length;
  const step = (kind: AddressKind): void => {
    const advance = address(bytes, at, left, kind, name, emit);
    at += advance;
    left -= advance;
  };
  if (type === 0) helloOptions(bytes, start, length, verbose, name, emit);
  else if (type === 2) {
    emit(' group=');
    step('group');
    emit(' source=');
    step('unicast');
  } else if (type === 3 || type === 6 || type === 7) joinPrune(bytes, start, length, type, name, emit);
  else if (type === 4) bootstrap(bytes, start, length, name, emit);
  else if (type === 5) {
    emit(' group=');
    step('group');
    emit(' src=');
    step('unicast');
    if (left < 8) throw new Truncated();
    u8(bytes, at + 7);
    if (bytes[at] & 0x80) emit(' RPT');
    emit(` pref=${u32(bytes, at) & 0x7fffffff} metric=${u32(bytes, at + 4)}`);
  } else if (type === 8) candidateRp(bytes, start, length, name, emit);
  else if (type === 9) {
    emit(' src=');
    step('unicast');
    emit(' grp=');
    step('group');
    emit(' forwarder=');
    step('unicast');
    if (left < 2) throw new Truncated();
    emit(` TUNR ${unsignedRelativeTime(u16(bytes, at))}`);
  } else if (type === 10) {
    const subtype = u8(bytes, 1) >> 4;
    emit(`\n\t  ${ELECTION_NAMES[subtype] ?? 'Unknown'},`);
    emit(' rpa=');
    step('unicast');
    emit(` sender pref=${u32(bytes, at)} sender metric=${u32(bytes, at + 4)}`);
    at += 8;
    left -= 8;
    if (subtype === 3 || subtype === 4) {
      const label = subtype === 3 ? 'offer' : 'new winner';
      emit(`\n\t  ${label} addr=`);
      step('unicast');
      emit(` ${label} pref=${u32(bytes, at)} ${label} metric=${u32(bytes, at + 4)}`);
      at += 8;
      if (subtype === 3) emit(` interval ${u16(bytes, at)}ms`);
    }
  } else if (type !== 1) emit(` [type ${type}]`);
}

function print(bytes: readonly number[], length: number, verbose: number, name: AddressName, emit: Emit): void {
  const first = u8(bytes, 0);
  const version = first >> 4;
  const type = first & 0x0f;
  if (version !== 2) {
    emit(`PIMv${version}, length ${length}`);
    return;
  }
  if (verbose < 1) {
    emit(`PIMv2, ${MESSAGE_NAMES[type] ?? 'Unknown Type'}, length ${length}`);
    return;
  }
  emit(`PIMv2, length ${length}\n\t${MESSAGE_NAMES[type] ?? 'Unknown Type'}`);
  if (length < 2) {
    emit(`[length ${length} < 2]`);
    throw new Invalid();
  }
  if ((u8(bytes, 1) & 0x0f) !== 0) emit(', RFC2117-encoding');
  if (length < 4) {
    emit(`[length ${length} < 4]`);
    throw new Invalid();
  }
  const checksum = u16(bytes, 2);
  emit(`, cksum 0x${hex(checksum, 4)} `);
  if (checksum === 0) emit('(unverified)');
  else if (bytes.length < length) emit('(unverified)');
  else emit(internetChecksum(bytes.slice(0, length)) === 0 ? '(correct)' : '(incorrect)');
  body(bytes, 4, length - 4, type, verbose, name, emit);
}

export function pimText(bytes: readonly number[], length: number, verbose: number, name: AddressName): string {
  let text = '';
  try {
    print(bytes, length, verbose, name, (piece) => { text += piece; });
  } catch (error) {
    if (error instanceof Truncated) return `${text}${TRUNCATED}`;
    if (error instanceof Invalid) return `${text}${INVALID}`;
    throw error;
  }
  return text;
}
