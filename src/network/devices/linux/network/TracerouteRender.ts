import type { TracerouteHop } from '../LinuxNetKernel';

export const TRACEROUTE_VERSION_TEXT = 'Modern traceroute for Linux, version 2.1.0\n'
  + 'Copyright (c) 2016  Dmitry Butskoy,   License: GPL v2 or any later';

const ICMP_ANNOTATION_BY_CODE: Readonly<Record<number, string>> = {
  0: '!N', 6: '!N', 8: '!N', 11: '!N',
  1: '!H', 7: '!H', 12: '!H',
  9: '!X', 10: '!X', 13: '!X',
  2: '!P',
  3: '',
  5: '!S',
  14: '!V',
  15: '!C',
};

export function tracerouteIcmpAnnotation(code: number | undefined, mtu?: number): string {
  if (code === undefined) return '';
  if (code === 4) return `!F-${mtu ?? 0}`;
  const known = ICMP_ANNOTATION_BY_CODE[code];
  return known === undefined ? `!<${code}>` : known;
}

export function tracerouteHeader(
  targetName: string, targetIp: string, maxHops: number, packetBytes: number,
): string {
  return `traceroute to ${targetName} (${targetIp}), ${maxHops} hops max,`
    + ` ${packetBytes} byte packets`;
}

export interface TracerouteRenderOptions {
  numeric: boolean;
  nameOf?: (ip: string) => string | null;
}

function addressText(ip: string, options: TracerouteRenderOptions): string {
  if (options.numeric) return ` ${ip}`;
  const name = options.nameOf?.(ip);
  return ` ${name ?? ip} (${ip})`;
}

export function tracerouteHopLine(hop: TracerouteHop, options: TracerouteRenderOptions): string {
  let line = `${String(hop.hop).padStart(2, ' ')} `;
  const probes = hop.probes ?? [];
  let previousIp: string | undefined;
  probes.forEach((probe, index) => {
    if (!probe.responded || probe.ip === undefined) {
      line += ' *';
      return;
    }
    if (index === 0 || previousIp === undefined || probe.ip !== previousIp) {
      line += addressText(probe.ip, options);
    }
    previousIp = probe.ip;
    line += `  ${(probe.rttMs ?? 0).toFixed(3)} ms`;
    const annotation = probe.unreachable ? tracerouteIcmpAnnotation(probe.icmpCode) : '';
    if (annotation !== '') line += ` ${annotation}`;
  });
  return line;
}
