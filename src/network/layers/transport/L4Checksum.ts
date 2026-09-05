import { IPv6Address } from '@/network/core/types';

export const IP_PROTO_TCP_NUMBER = 6;
export const IP_PROTO_UDP_NUMBER = 17;

export function pushPseudoHeader(
  words: number[], srcIp: string, dstIp: string, protocol: number, l4Length: number,
): void {
  if (srcIp.includes(':') || dstIp.includes(':')) {
    for (const ip of [srcIp, dstIp]) {
      for (const hextet of new IPv6Address(ip).getHextets()) words.push(hextet & 0xffff);
    }
    words.push((l4Length >>> 16) & 0xffff, l4Length & 0xffff);
    words.push(0x0000, protocol & 0xffff);
    return;
  }
  for (const ip of [srcIp, dstIp]) {
    const o = ip.split('.').map(Number);
    words.push(((o[0] ?? 0) << 8) | (o[1] ?? 0), ((o[2] ?? 0) << 8) | (o[3] ?? 0));
  }
  words.push(protocol & 0xffff, l4Length & 0xffff);
}

/**
 * Ce que `--badsum` de `nmap` fait d'une somme JUSTE (`ipv4_cksum`,
 * `tcpip.cc:434`) : la decrementer d'un — et, si le protocole est UDP et
 * que le resultat tombe a zero, prendre `0xffff`, une somme UDP nulle
 * valant « pas de somme » en IPv4 et laissant donc passer le paquet.
 */
export function bogusChecksum(sum: number, protocol: number): number {
  const lowered = (sum - 1) & 0xffff;
  return protocol === IP_PROTO_UDP_NUMBER && lowered === 0 ? 0xffff : lowered;
}

export function payloadBytes(payload: unknown): number[] {
  if (typeof payload === 'string') {
    const bytes: number[] = [];
    for (let i = 0; i < payload.length; i++) bytes.push(payload.charCodeAt(i) & 0xff);
    return bytes;
  }
  if (payload instanceof Uint8Array) return Array.from(payload);
  return [];
}

export function pushBytesAsWords(words: number[], bytes: number[]): void {
  for (let i = 0; i < bytes.length; i += 2) {
    const hi = bytes[i] & 0xff;
    const lo = i + 1 < bytes.length ? bytes[i + 1] & 0xff : 0;
    words.push((hi << 8) | lo);
  }
}

export function onesComplement(words: number[]): number {
  let sum = 0;
  for (const w of words) {
    sum += w;
    sum = (sum & 0xffff) + (sum >>> 16);
  }
  return (~sum) & 0xffff;
}
