import { tryIpToUint32, prefixLengthToMaskUint32 } from '@/network/core/ip';

export type ReceiveConnectorAuthMechanism = 'TLS' | 'BasicAuth' | 'ExchangeServer';

export interface ReceiveConnectorDef {
  readonly name: string;
  readonly bindings: readonly string[];
  readonly remoteIpRanges: readonly string[];
  readonly authMechanisms: readonly ReceiveConnectorAuthMechanism[];
}

export interface SendConnectorDef {
  readonly name: string;
  readonly addressSpaces: readonly string[];
  readonly smartHosts: readonly string[];
  readonly costMetric: number;
}

export interface ParsedBinding {
  readonly host: string;
  readonly port: number;
}

export function parseBinding(binding: string): ParsedBinding | null {
  const idx = binding.lastIndexOf(':');
  if (idx === -1) return null;
  const port = Number(binding.slice(idx + 1));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { host: binding.slice(0, idx), port };
}

function ipInCidr(ip: string, range: string): boolean {
  const [network, prefixStr] = range.split('/');
  const prefix = prefixStr !== undefined ? Number(prefixStr) : 32;
  const ipValue = tryIpToUint32(ip);
  const netValue = tryIpToUint32(network);
  if (ipValue === null || netValue === null) return false;
  const mask = prefixLengthToMaskUint32(prefix);
  return (ipValue & mask) === (netValue & mask);
}

export function ipAllowedByRanges(ip: string, ranges: readonly string[]): boolean {
  if (ranges.length === 0) return true;
  return ranges.some((range) => ipInCidr(ip, range));
}

export function matchesAddressSpace(domain: string, addressSpaces: readonly string[]): boolean {
  return addressSpaces.some((space) => space === '*' || space.toLowerCase() === domain.toLowerCase());
}

export function selectSendConnector(domain: string, connectors: readonly SendConnectorDef[]): SendConnectorDef | null {
  const matching = connectors.filter((c) => matchesAddressSpace(domain, c.addressSpaces));
  if (matching.length === 0) return null;
  return [...matching].sort((a, b) => a.costMetric - b.costMetric)[0];
}
