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

export interface Icmpv6ErrorFacts {
  code: number;
  quotedDestination: string;
  quotedSource: string;
  quotedProtocol?: number;
  quotedTransport?: 'tcp' | 'udp' | 'other';
  quotedDestinationPort?: number | string;
}

const ICMPV6_UNREACHABLE_NAMES: Readonly<Record<number, string>> = {
  0: 'unreachable route',
  1: ' unreachable prohibited',
  2: 'beyond scope',
  3: 'unreachable address',
  4: 'unreachable port',
};

export function icmpv6UnreachablePhrase(facts: Icmpv6ErrorFacts): string {
  const name = ICMPV6_UNREACHABLE_NAMES[facts.code] ?? `unknown unreach code (${facts.code})`;
  const destination = facts.quotedDestination;
  if (facts.code === 0 || facts.code === 1 || facts.code === 3) return `${name} ${destination}`;
  if (facts.code === 2) return `${name} ${destination}, source address ${facts.quotedSource}`;
  if (facts.code !== 4) return name;
  const port = facts.quotedDestinationPort ?? 0;
  if (facts.quotedTransport === 'tcp') return `${name}, ${destination} tcp port ${port}`;
  if (facts.quotedTransport === 'udp') return `${name}, ${destination} udp port ${port}`;
  return `${name}, ${destination} protocol ${facts.quotedProtocol ?? 0} port ${port} unreachable`;
}

export function icmpv6TimeExceededPhrase(code: number, quotedDestination: string): string {
  if (code === 0) return `time exceeded in-transit for ${quotedDestination}`;
  if (code === 1) return 'time exceeded in-transit (reassembly)';
  return `time exceeded in-transit, unknown code (${code})`;
}

const ICMPV6_PARAMETER_PROBLEM_NAMES: Readonly<Record<number, string>> = {
  0: 'erroneous',
  1: 'next header',
  2: 'option',
  3: 'incomplete header chain',
};

export function icmpv6ParameterProblemPhrase(code: number, pointer: number): string {
  const name = ICMPV6_PARAMETER_PROBLEM_NAMES[code];
  return name === undefined ? `parameter problem, code-#${code}` : `parameter problem, ${name} - octet ${pointer}`;
}
