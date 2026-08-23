import { IPAddress } from '../../../core/types';
import type { IPv4Packet, UDPPacket, TCPPacket } from '../../../core/types';

export const DEFAULT_REFLEXIVE_TIMEOUT_SEC = 300;
export const REFLEXIVE_TIMEOUT_MIN = 0;
export const REFLEXIVE_TIMEOUT_MAX = 2147483;

export interface ReflexiveEntry {
  protocol: string;
  sourceIP: IPAddress;
  sourcePort?: number;
  destinationIP: IPAddress;
  destinationPort?: number;
  matchCount: number;
  timeoutSec: number;
  lastUsedMs: number;
}

interface FlowTuple {
  protocol: string;
  sourceIP: string;
  sourcePort?: number;
  destinationIP: string;
  destinationPort?: number;
}

function protocolName(protocol: number): string {
  if (protocol === 1) return 'icmp';
  if (protocol === 6) return 'tcp';
  if (protocol === 17) return 'udp';
  return String(protocol);
}

function portsOf(packet: IPv4Packet): { source?: number; destination?: number } {
  const l4 = packet.payload as Partial<UDPPacket> | undefined;
  if (typeof l4?.sourcePort !== 'number') return {};
  return { source: l4.sourcePort, destination: l4.destinationPort };
}

function isConnectionTeardown(packet: IPv4Packet): boolean {
  const tcp = packet.payload as TCPPacket | undefined;
  if (!tcp || tcp.type !== 'tcp') return false;
  return !!(tcp.flags?.rst || tcp.flags?.fin);
}

function tupleOf(packet: IPv4Packet): FlowTuple {
  const ports = portsOf(packet);
  return {
    protocol: protocolName(packet.protocol),
    sourceIP: packet.sourceIP.toString(),
    sourcePort: ports.source,
    destinationIP: packet.destinationIP.toString(),
    destinationPort: ports.destination,
  };
}

/**
 * La table des sessions miroir d'une ACL réflexive.
 *
 * Une ACE sortante marquée `reflect NOM` qui PERMET un paquet y dépose
 * l'entrée symétrique : la source du retour attendu est la destination
 * de l'aller, et réciproquement. `evaluate NOM` la consulte.
 *
 * L'expiration est calculée à la LECTURE et jamais par minuteur : une
 * entrée dont l'inactivité dépasse son délai n'est simplement plus
 * trouvée, ce qui donne le même contrat observable sans faire tourner un
 * compteur par session.
 */
export class ReflexiveSessions {
  private lists = new Map<string, Map<string, ReflexiveEntry>>();
  private defaultTimeoutSec = DEFAULT_REFLEXIVE_TIMEOUT_SEC;

  setDefaultTimeout(seconds: number): void {
    this.defaultTimeoutSec = seconds;
  }

  getDefaultTimeout(): number { return this.defaultTimeoutSec; }

  names(): string[] { return [...this.lists.keys()]; }

  has(name: string): boolean { return this.lists.has(name); }

  record(name: string, packet: IPv4Packet, timeoutSec: number | undefined, nowMs: number): void {
    const flow = tupleOf(packet);
    const mirrored: FlowTuple = {
      protocol: flow.protocol,
      sourceIP: flow.destinationIP,
      sourcePort: flow.destinationPort,
      destinationIP: flow.sourceIP,
      destinationPort: flow.sourcePort,
    };
    let list = this.lists.get(name);
    if (!list) {
      list = new Map();
      this.lists.set(name, list);
    }
    const key = keyOf(mirrored);
    const existing = list.get(key);
    if (existing) {
      existing.lastUsedMs = nowMs;
      return;
    }
    list.set(key, {
      protocol: mirrored.protocol,
      sourceIP: new IPAddress(mirrored.sourceIP),
      sourcePort: mirrored.sourcePort,
      destinationIP: new IPAddress(mirrored.destinationIP),
      destinationPort: mirrored.destinationPort,
      matchCount: 0,
      timeoutSec: timeoutSec ?? this.defaultTimeoutSec,
      lastUsedMs: nowMs,
    });
  }

  /**
   * Ce paquet correspond-il à une session ouverte ?
   *
   * Une correspondance RAFRAÎCHIT l'entrée, comme sur un vrai routeur :
   * un flux qui vit ne doit pas expirer sous lui. Un RST ou un FIN la
   * retire — c'est la fin de la conversation, et laisser l'entrée ouvrir
   * le retour pendant cinq minutes de plus serait un trou.
   */
  matches(name: string, packet: IPv4Packet, nowMs: number): boolean {
    const list = this.lists.get(name);
    if (!list) return false;
    const flow = tupleOf(packet);
    const entry = this.liveEntry(list, flow, nowMs);
    if (!entry) return false;
    entry.matchCount++;
    entry.lastUsedMs = nowMs;
    if (isConnectionTeardown(packet)) list.delete(keyOf(flow));
    return true;
  }

  entries(name: string, nowMs: number): ReflexiveEntry[] {
    const list = this.lists.get(name);
    if (!list) return [];
    this.prune(list, nowMs);
    return [...list.values()];
  }

  timeLeft(entry: ReflexiveEntry, nowMs: number): number {
    const elapsed = Math.floor((nowMs - entry.lastUsedMs) / 1000);
    return Math.max(0, entry.timeoutSec - elapsed);
  }

  clear(): void { this.lists.clear(); }

  private liveEntry(
    list: Map<string, ReflexiveEntry>, flow: FlowTuple, nowMs: number,
  ): ReflexiveEntry | undefined {
    this.prune(list, nowMs);
    const exact = list.get(keyOf(flow));
    if (exact) return exact;
    if (flow.protocol !== 'icmp') return undefined;
    return [...list.values()].find(e =>
      e.protocol === 'icmp'
      && e.sourceIP.toString() === flow.sourceIP
      && e.destinationIP.toString() === flow.destinationIP);
  }

  private prune(list: Map<string, ReflexiveEntry>, nowMs: number): void {
    for (const [key, entry] of list) {
      if (this.timeLeft(entry, nowMs) <= 0) list.delete(key);
    }
  }
}

function keyOf(flow: FlowTuple): string {
  return `${flow.protocol}|${flow.sourceIP}:${flow.sourcePort ?? ''}`
    + `|${flow.destinationIP}:${flow.destinationPort ?? ''}`;
}
