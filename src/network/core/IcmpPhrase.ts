export interface IcmpErrorFacts {
  code: number;
  quotedDestination: string;
  quotedProtocol?: number;
  quotedTransport?: 'tcp' | 'udp' | 'other';
  quotedDestinationPort?: number | string;
  nextHopMtu?: number;
}

const UNREACH_PHRASES: Readonly<Record<number, (host: string) => string>> = {
  0: (h) => `net ${h} unreachable`,
  1: (h) => `host ${h} unreachable`,
  5: (h) => `${h} unreachable - source route failed`,
  6: (h) => `net ${h} unreachable - unknown`,
  7: (h) => `host ${h} unreachable - unknown`,
  8: (h) => `${h} unreachable - source host isolated`,
  9: (h) => `net ${h} unreachable - admin prohibited`,
  10: (h) => `host ${h} unreachable - admin prohibited`,
  11: (h) => `net ${h} unreachable - tos prohibited`,
  12: (h) => `host ${h} unreachable - tos prohibited`,
  13: (h) => `host ${h} unreachable - admin prohibited filter`,
  14: (h) => `host ${h} unreachable - host precedence violation`,
  15: (h) => `host ${h} unreachable - precedence cutoff`,
};

export function icmpUnreachablePhrase(facts: IcmpErrorFacts): string {
  const host = facts.quotedDestination;
  if (facts.code === 2) return `${host} protocol ${facts.quotedProtocol ?? 0} unreachable`;
  if (facts.code === 3) {
    const port = facts.quotedDestinationPort;
    if (port === undefined) return `${host} unreachable`;
    if (facts.quotedTransport === 'tcp') return `${host} tcp port ${port} unreachable`;
    if (facts.quotedTransport === 'udp') return `${host} udp port ${port} unreachable`;
    return `${host} protocol ${facts.quotedProtocol ?? 0} port ${port} unreachable`;
  }
  if (facts.code === 4) {
    return facts.nextHopMtu === undefined
      ? `${host} unreachable - need to frag`
      : `${host} unreachable - need to frag (mtu ${facts.nextHopMtu})`;
  }
  const phrase = UNREACH_PHRASES[facts.code];
  return phrase === undefined ? `${host} unreachable - #${facts.code}` : phrase(host);
}

export function icmpTimeExceededPhrase(code: number): string {
  return code === 1 ? 'ip reassembly time exceeded' : 'time exceeded in-transit';
}
