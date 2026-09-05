import { IPAddress } from '@/network/core/types';

export type OctetSet = readonly [
  ReadonlyArray<boolean>, ReadonlyArray<boolean>,
  ReadonlyArray<boolean>, ReadonlyArray<boolean>,
];

export const MAX_SPEC_HOSTS = 1024;

function emptyOctets(): boolean[][] {
  return [
    new Array<boolean>(256).fill(false), new Array<boolean>(256).fill(false),
    new Array<boolean>(256).fill(false), new Array<boolean>(256).fill(false),
  ];
}

function splitNetmask(expr: string): { host: string; bits: number } | null {
  const slash = expr.lastIndexOf('/');
  if (slash < 0) return { host: expr, bits: -1 };
  const tail = expr.slice(slash + 1);
  if (!/^\d+$/.test(tail)) return null;
  return { host: expr.slice(0, slash), bits: Number(tail) };
}

function parseIpv4Ranges(spec: string): boolean[][] | null {
  const octets = emptyOctets();
  let p = 0;
  let index = 0;
  while (p < spec.length && index < 4) {
    if (spec[p] === '*') {
      for (let i = 0; i < 256; i++) octets[index][i] = true;
      p++;
    } else {
      for (;;) {
        const digits = /^\d+/.exec(spec.slice(p));
        let start: number;
        if (digits === null) {
          if (spec[p] !== '-') return null;
          start = 0;
        } else {
          start = Number(digits[0]);
          if (start > 255) return null;
          p += digits[0].length;
        }
        let end: number;
        if (spec[p] === '-') {
          p++;
          const upper = /^\d+/.exec(spec.slice(p));
          if (upper === null) {
            end = 255;
          } else {
            end = Number(upper[0]);
            if (end > 255 || end < start) return null;
            p += upper[0].length;
          }
        } else {
          end = start;
        }
        for (let i = start; i <= end; i++) octets[index][i] = true;
        if (spec[p] !== ',') break;
        p++;
      }
    }
    index++;
    if (index < 4) {
      if (spec[p] !== '.') return null;
      p++;
    }
  }
  if (p !== spec.length || index < 4) return null;
  return octets;
}

function applyNetmaskOctet(bits: boolean[], mask: number): void {
  for (let chunk = 1; chunk < 256; chunk <<= 1) {
    if ((mask & chunk) !== 0) continue;
    for (let i = 0; i < 256; i += chunk * 2) {
      for (let j = 0; j < chunk; j++) {
        if (bits[i + j]) bits[i + j + chunk] = true;
        else if (bits[i + j + chunk]) bits[i + j] = true;
      }
    }
  }
}

function applyNetmask(octets: boolean[][], bits: number): void {
  if (bits > 32) return;
  const width = bits < 0 ? 32 : bits;
  const mask = width === 0 ? 0 : (0xffffffff << (32 - width)) >>> 0;
  applyNetmaskOctet(octets[0], (mask >>> 24) & 0xff);
  applyNetmaskOctet(octets[1], (mask >>> 16) & 0xff);
  applyNetmaskOctet(octets[2], (mask >>> 8) & 0xff);
  applyNetmaskOctet(octets[3], mask & 0xff);
}

export function parseTargetSpec(expr: string): OctetSet | null {
  const split = splitNetmask(expr);
  if (split === null) return null;
  if (split.bits > 32) return null;
  const octets = parseIpv4Ranges(split.host);
  if (octets === null) return null;
  applyNetmask(octets, split.bits);
  return octets as unknown as OctetSet;
}

export function specSize(octets: OctetSet): number {
  return octets.reduce((n, bits) => n * bits.filter(Boolean).length, 1);
}

export function specMatches(octets: OctetSet, ip: string): boolean {
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  return parts.every((part, i) => {
    if (!/^\d+$/.test(part)) return false;
    const value = Number(part);
    return value < 256 && octets[i][value] === true;
  });
}

export function enumerateSpec(octets: OctetSet): string[] {
  const values = octets.map(
    (bits) => bits.reduce<number[]>((acc, set, i) => (set ? [...acc, i] : acc), []));
  const out: string[] = [];
  for (const a of values[0]) {
    for (const b of values[1]) {
      for (const c of values[2]) {
        for (const d of values[3]) out.push(`${a}.${b}.${c}.${d}`);
      }
    }
  }
  return out;
}

export function enumerateTargets(target: string): string[] {
  const octets = parseTargetSpec(target);
  if (octets === null) return [target];
  if (specSize(octets) > MAX_SPEC_HOSTS) return [target];
  return enumerateSpec(octets);
}

export type AddrSet = ReadonlyArray<OctetSet>;

export function addrSetContains(set: AddrSet, ip: string): boolean {
  return set.some((octets) => specMatches(octets, ip));
}

export function randomTargets(count: number, avoid: AddrSet): string[] {
  const out: string[] = [];
  while (out.length < count) {
    const n = Math.floor(Math.random() * 0x100000000) >>> 0;
    const candidate = IPAddress.fromUint32(n);
    if (candidate.isReserved()) continue;
    const text = candidate.toString();
    if (addrSetContains(avoid, text)) continue;
    out.push(text);
  }
  return out;
}

export function readHostSpecs(text: string): string[] {
  const specs: string[] = [];
  for (const line of text.split('\n')) {
    const body = line.split('#')[0];
    for (const token of body.split(/\s+/)) {
      if (token.length > 0) specs.push(token);
    }
  }
  return specs;
}
