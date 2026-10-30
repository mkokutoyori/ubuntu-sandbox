import { NTP_MULTICAST_ADDRESS, NTP_VERSION, type NtpBroadcastServer, type NtpVersion } from '../../../ntp/types';
import { isMulticastIpv4, isValidIPv4 } from '../../../core/ip';

export interface NtpBroadcastParse {
  readonly ok: boolean;
  readonly refusedAt?: number;
  readonly client?: { readonly group: string | null };
  readonly server?: NtpBroadcastServer;
}

const POLL_EXPONENT = 6;

export function parseNtpBroadcast(kind: 'broadcast' | 'multicast', words: readonly string[]): NtpBroadcastParse {
  const refuse = (at: number): NtpBroadcastParse => ({ ok: false, refusedAt: at });
  if (words[0]?.toLowerCase() === 'client') {
    if (kind === 'broadcast') return words.length === 1 ? { ok: true, client: { group: null } } : refuse(1);
    const group = words[1] ?? NTP_MULTICAST_ADDRESS;
    return words.length <= 2 && isValidIPv4(group) && isMulticastIpv4(group) ? { ok: true, client: { group } } : refuse(1);
  }
  let destination: string | null = kind === 'multicast' ? NTP_MULTICAST_ADDRESS : null;
  let version = NTP_VERSION as NtpVersion;
  let keyId: number | undefined;
  let ttl: number | undefined;
  for (let i = 0; i < words.length; i++) {
    const word = words[i].toLowerCase();
    const next = words[i + 1];
    if (word === 'version' && next !== undefined && /^[1-4]$/.test(next)) { version = Number(next) as NtpVersion; i++; continue; }
    if (word === 'key' && next !== undefined && /^\d+$/.test(next) && Number(next) >= 1 && Number(next) <= 4294967295) { keyId = Number(next); i++; continue; }
    if (word === 'ttl' && kind === 'multicast' && next !== undefined && /^\d+$/.test(next) && Number(next) >= 1 && Number(next) <= 255) { ttl = Number(next); i++; continue; }
    if (word === 'destination' && kind === 'broadcast' && next !== undefined && isValidIPv4(next)) { destination = next; i++; continue; }
    if (kind === 'multicast' && i === 0 && isValidIPv4(words[0]) && isMulticastIpv4(words[0])) { destination = words[0]; continue; }
    return refuse(i);
  }
  return { ok: true, server: { destination, version, keyId, ttl, pollExponent: POLL_EXPONENT } };
}

export function renderNtpBroadcastLines(server: NtpBroadcastServer | undefined, client: string | null | undefined): string[] {
  const lines: string[] = [];
  if (server !== undefined) {
    const multicast = server.destination !== null && isMulticastIpv4(server.destination);
    const head = multicast ? ' ntp multicast' : ' ntp broadcast';
    const parts = [
      multicast && server.destination !== NTP_MULTICAST_ADDRESS ? ` ${server.destination}` : '',
      !multicast && server.destination !== null ? ` destination ${server.destination}` : '',
      server.version !== NTP_VERSION ? ` version ${server.version}` : '',
      server.keyId !== undefined ? ` key ${server.keyId}` : '',
      server.ttl !== undefined ? ` ttl ${server.ttl}` : '',
    ];
    lines.push(`${head}${parts.join('')}`);
  }
  if (client !== undefined) {
    lines.push(client === null ? ' ntp broadcast client' : ` ntp multicast client${client === NTP_MULTICAST_ADDRESS ? '' : ` ${client}`}`);
  }
  return lines;
}
