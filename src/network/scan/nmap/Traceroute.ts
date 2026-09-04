import { NMAP_TABLE, renderTable } from '@/network/devices/shells/cli/TextTable';

/**
 * `--traceroute` : le chemin jusqu'a chaque hote, rendu comme
 * `printtraceroute_normal` (`output.cc:2246`) le rend.
 *
 * Ce module ne SONDE pas — la marche par TTL est celle de la machine,
 * `executeTraceroute`, qui est deja le seul emetteur de paquets a duree
 * de vie limitee du depot. Il decide ce que l'en-tete NOMME, quels
 * sauts se replient, et la mise en page.
 */

/** Ce que l'en-tete annonce, selon la sonde qui a fait repondre l'hote. */
export type TraceProbe =
  | { readonly kind: 'none' }
  | { readonly kind: 'port'; readonly port: number; readonly proto: 'tcp' | 'udp' }
  | { readonly kind: 'proto'; readonly proto: number; readonly name: string };

export interface TraceHop {
  readonly ttl: number;
  /** Absente quand le saut n'a pas repondu. */
  readonly ip?: string;
  readonly rttMs?: number;
  readonly name?: string;
  /**
   * L'adresse de l'hote dont la trace a DECOUVERT ce saut. Deux cibles
   * derriere le meme routeur partagent leurs premiers sauts, et c'est
   * cette etiquette qui le dit — `TracerouteHop.tag` (`Target.h:104`).
   */
  readonly tag: string;
}

export interface HostTrace {
  readonly probe: TraceProbe;
  readonly hops: readonly TraceHop[];
}

/**
 * `pingprobe_score` (`scan_engine.cc:1755`) : parmi les sondes qui ont
 * fait repondre l'hote, `--traceroute` emprunte celle dont le score est
 * le plus haut, et c'est le score qui explique un choix contre-intuitif
 * — un RST de port FERME (60) l'emporte sur un echo ICMP (50), qui
 * l'emporte sur un SYN/ACK de port OUVERT (30) : plus la reponse est
 * difficile a contrefaire, plus elle est sure.
 */
const SPOOFED_PORTS: ReadonlySet<number> = new Set([25, 113, 135, 139, 445]);

export type ProbeState = 'open' | 'closed' | 'filtered';

export type TraceCandidate =
  | { readonly kind: 'icmp-echo'; readonly family: 4 | 6 }
  | { readonly kind: 'tcp'; readonly port: number; readonly state: ProbeState };

export function candidateScore(candidate: TraceCandidate): number {
  if (candidate.kind === 'icmp-echo') return 50;
  if (candidate.state === 'filtered') return 20;
  if (candidate.state === 'open') return 30;
  return SPOOFED_PORTS.has(candidate.port) ? 50 : 60;
}

/**
 * `HostState::get_probe` (`traceroute.cc:533`) : sans sonde ayant
 * repondu — l'operateur a saute la decouverte ET le balayage — c'est
 * l'echo ICMP qui est suppose, « as the most likely to get a response ».
 */
export function chooseTraceProbe(
  candidates: readonly TraceCandidate[], family: 4 | 6,
): TraceProbe {
  let best: TraceCandidate | null = null;
  let bestScore = 0;
  for (const candidate of candidates) {
    const score = candidateScore(candidate);
    if (score > bestScore) { best = candidate; bestScore = score; }
  }
  if (!best || best.kind === 'icmp-echo') return icmpEchoProbe(family);
  return { kind: 'port', port: best.port, proto: 'tcp' };
}

export function icmpEchoProbe(family: 4 | 6): TraceProbe {
  return family === 6
    ? { kind: 'proto', proto: 58, name: 'ipv6-icmp' }
    : { kind: 'proto', proto: 1, name: 'icmp' };
}

function headerLine(probe: TraceProbe): string {
  if (probe.kind === 'port') return `TRACEROUTE (using port ${probe.port}/${probe.proto})`;
  if (probe.kind === 'proto') return `TRACEROUTE (using proto ${probe.proto}/${probe.name})`;
  return 'TRACEROUTE';
}

interface Row {
  readonly hop: string;
  readonly rtt: string;
  readonly address: string;
  readonly measured: boolean;
}

function displayName(hop: TraceHop): string {
  if (!hop.ip) return '';
  return hop.name ? `${hop.name} (${hop.ip})` : hop.ip;
}

/**
 * Rend la section, en-tete compris. Un hote sans aucun saut n'en a pas :
 * « No trace, must be localhost » (`output.cc:2255`).
 */
export function renderTrace(trace: HostTrace, targetIp: string): string[] {
  if (trace.hops.length === 0) return [];

  const rows: Row[] = [];
  const hops = trace.hops;
  let i = 0;

  // Les sauts decouverts par la trace d'une AUTRE cible se replient sur
  // une ligne (`output.cc:2290`) : c'est le cache de sauts qui evite de
  // refaire le meme trajet, et la ligne le dit plutot que de le cacher.
  let shared: TraceHop | null = null;
  while (i < hops.length && hops[i].tag !== targetIp) { shared = hops[i]; i++; }
  if (shared) {
    rows.push({
      hop: '-',
      rtt: shared.ttl === 1
        ? `Hop 1 is the same as for ${shared.tag}`
        : `Hops 1-${shared.ttl} are the same as for ${shared.tag}`,
      address: '',
      measured: false,
    });
  }

  while (i < hops.length) {
    const hop = hops[i];
    if (!hop.ip) {
      const begin = hop.ttl;
      let end = hop.ttl;
      while (i < hops.length && !hops[i].ip) { end = hops[i].ttl; i++; }
      rows.push({
        hop: `${begin}`,
        rtt: begin === end ? '...' : `... ${end}`,
        address: '',
        measured: true,
      });
      continue;
    }
    rows.push({
      hop: `${hop.ttl}`,
      rtt: hop.rttMs === undefined || hop.rttMs < 0 ? '--' : `${hop.rttMs.toFixed(2)} ms`,
      address: displayName(hop),
      measured: true,
    });
    i++;
  }

  return [
    '',
    headerLine(trace.probe),
    ...renderTable<Row>(rows, [
      { header: 'HOP', value: (r) => r.hop },
      { header: 'RTT', value: (r) => r.rtt, measured: (r) => r.measured },
      { header: 'ADDRESS', value: (r) => r.address },
    ], NMAP_TABLE),
  ];
}
