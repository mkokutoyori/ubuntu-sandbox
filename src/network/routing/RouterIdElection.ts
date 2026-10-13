export interface RouterIdCandidate {
  readonly iface: string;
  readonly ip: string;
}

function toUint32(ip: string): number {
  return ip.split('.').reduce((acc, octet) => acc * 256 + Number(octet), 0);
}

function highest(candidates: readonly RouterIdCandidate[]): string | null {
  let best: RouterIdCandidate | null = null;
  for (const candidate of candidates) {
    if (best === null || toUint32(candidate.ip) > toUint32(best.ip)) best = candidate;
  }
  return best === null ? null : best.ip;
}

export function electRouterId(candidates: Iterable<RouterIdCandidate>): string | null {
  const all = [...candidates];
  return highest(all.filter((c) => /^Loopback/i.test(c.iface))) ?? highest(all);
}
