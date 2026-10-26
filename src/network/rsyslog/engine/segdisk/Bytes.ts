import { bytesToBinaryString } from '@/crypto/encoding';

export function put16(value: number): string {
  return String.fromCharCode((value >>> 8) & 0xff, value & 0xff);
}

export function put32(value: number): string {
  return String.fromCharCode((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
}

export function put64(value: number | bigint): string {
  const wide = BigInt.asUintN(64, BigInt(value));
  return put32(Number(wide >> 32n)) + put32(Number(wide & 0xffffffffn));
}

export function get16(bytes: string, at: number): number {
  return (bytes.charCodeAt(at) << 8) | bytes.charCodeAt(at + 1);
}

export function get32(bytes: string, at: number): number {
  return ((bytes.charCodeAt(at) << 24) | (bytes.charCodeAt(at + 1) << 16) | (bytes.charCodeAt(at + 2) << 8) | bytes.charCodeAt(at + 3)) >>> 0;
}

export function get64(bytes: string, at: number): number {
  return get32(bytes, at) * 0x1_0000_0000 + get32(bytes, at + 4);
}

export function get64Big(bytes: string, at: number): bigint {
  return (BigInt(get32(bytes, at)) << 32n) | BigInt(get32(bytes, at + 4));
}

export function signed64(value: number): number {
  return value >= 2 ** 63 ? value - 2 ** 64 : value;
}

export function utf8Bytes(text: string): string {
  return bytesToBinaryString(new TextEncoder().encode(text));
}

export function utf8Text(bytes: string): string {
  const raw = new Uint8Array(bytes.length);
  for (let index = 0; index < bytes.length; index++) raw[index] = bytes.charCodeAt(index);
  return new TextDecoder('utf-8').decode(raw);
}
