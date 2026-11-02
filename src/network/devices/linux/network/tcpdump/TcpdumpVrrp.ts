import { internetChecksum } from '@/network/layers/transport/L4Checksum';
import { nullPaddedText } from './TcpdumpHex';

type AddressName = (address: string) => string;

const ADVERTISEMENT = 1;
const AUTH_SIMPLE = 1;
const AUTH_NAMES: Readonly<Record<number, string>> = { 0: 'none', 1: 'simple', 2: 'ah' };
const TRUNCATED = ' [|vrrp]';
const MULTICAST_TTL = 255;
const HEADER_BYTES = 8;
const AUTH_DATA_BYTES = 8;

class Truncated extends Error {}

function u8(bytes: readonly number[], at: number): number {
  if (at >= bytes.length) throw new Truncated();
  return bytes[at];
}

function u16(bytes: readonly number[], at: number): number {
  return (u8(bytes, at) << 8) | u8(bytes, at + 1);
}

function dotted(bytes: readonly number[], at: number, name: AddressName): string {
  u8(bytes, at + 3);
  return name(`${bytes[at]}.${bytes[at + 1]}.${bytes[at + 2]}.${bytes[at + 3]}`);
}

function print(bytes: readonly number[], length: number, ttl: number, verbose: number, name: AddressName, emit: (text: string) => void): void {
  const first = u8(bytes, 0);
  const version = first >> 4;
  const type = first & 0x0f;
  emit(`VRRPv${version}, ${type === ADVERTISEMENT ? 'Advertisement' : `unknown type (${type})`}`);
  if (ttl !== MULTICAST_TTL) emit(`, (ttl ${ttl})`);
  if (version < 2 || version > 3 || type !== ADVERTISEMENT) return;
  emit(`, vrid ${u8(bytes, 1)}, prio ${u8(bytes, 2)}`);
  const authType = u8(bytes, 4);
  if (version === 2) emit(`, authtype ${AUTH_NAMES[authType] ?? 'none'}, intvl ${u8(bytes, 5)}s, length ${length}`);
  else emit(`, intvl ${((u8(bytes, 4) & 0x0f) << 8) | u8(bytes, 5)}cs, length ${length}`);
  if (verbose < 1) return;
  const count = u8(bytes, 3);
  if (version === 2 && bytes.length >= length && internetChecksum(bytes.slice(0, length)) !== 0) emit(`, (bad vrrp cksum ${u16(bytes, 6).toString(16)})`);
  emit(`, addrs${count > 1 ? `(${count})` : ''}:`);
  let at = HEADER_BYTES;
  for (let index = 0; index < count; index++) {
    emit(`${index === 0 ? ' ' : ','}${dotted(bytes, at, name)}`);
    at += 4;
  }
  if (version === 2 && authType === AUTH_SIMPLE) {
    emit(` auth "${nullPaddedText(bytes.slice(at, at + AUTH_DATA_BYTES))}"`);
  }
}

export function vrrpText(bytes: readonly number[], length: number, ttl: number, verbose: number, name: AddressName): string {
  let text = '';
  try {
    print(bytes, length, ttl, verbose, name, (piece) => { text += piece; });
  } catch (error) {
    if (error instanceof Truncated) return text + TRUNCATED;
    throw error;
  }
  return text;
}
