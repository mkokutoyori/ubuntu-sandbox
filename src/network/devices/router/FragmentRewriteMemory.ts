import { simulationNowMs } from '@/network/core/SystemClock';
import { IPV4_FLAG_MF } from '@/network/core/Ipv4Fragmentation';
import type { IPv4Packet } from '@/network/core/types';
import { rewriteDestIP, rewriteSrcIP } from '@/network/nat/rewrite';

export type FragmentStage = 'inbound' | 'outbound';
export type FragmentRole = 'initial' | 'subsequent';

export interface FragmentRewrite {
  readonly source?: string;
  readonly destination?: string;
}

export function fragmentRole(packet: IPv4Packet): FragmentRole | null {
  if (packet.fragmentOffset > 0) return 'subsequent';
  return (packet.flags & IPV4_FLAG_MF) !== 0 ? 'initial' : null;
}

export function applyFragmentRewrite(packet: IPv4Packet, rewrite: FragmentRewrite): IPv4Packet {
  let result = packet;
  if (rewrite.source !== undefined) result = rewriteSrcIP(result, rewrite.source);
  if (rewrite.destination !== undefined) result = rewriteDestIP(result, rewrite.destination);
  return result;
}

interface Remembered {
  readonly rewrite: FragmentRewrite;
  readonly expiresAt: number;
}

export class FragmentRewriteMemory {
  private readonly entries = new Map<string, Remembered>();

  remember(stage: FragmentStage, iface: string, original: IPv4Packet, translated: IPv4Packet | null, lifetimeMs: number): void {
    const rewrite: FragmentRewrite = {
      ...(translated !== null && !translated.sourceIP.equals(original.sourceIP) ? { source: translated.sourceIP.toString() } : {}),
      ...(translated !== null && !translated.destinationIP.equals(original.destinationIP) ? { destination: translated.destinationIP.toString() } : {}),
    };
    this.entries.set(this.keyOf(stage, iface, original), { rewrite, expiresAt: simulationNowMs() + lifetimeMs });
  }

  recall(stage: FragmentStage, iface: string, fragment: IPv4Packet): FragmentRewrite | undefined {
    this.prune();
    const key = this.keyOf(stage, iface, fragment);
    const found = this.entries.get(key);
    if (found === undefined) return undefined;
    if ((fragment.flags & IPV4_FLAG_MF) === 0) this.entries.delete(key);
    return found.rewrite;
  }

  size(): number {
    this.prune();
    return this.entries.size;
  }

  private prune(): void {
    const now = simulationNowMs();
    for (const [key, remembered] of this.entries) if (remembered.expiresAt <= now) this.entries.delete(key);
  }

  private keyOf(stage: FragmentStage, iface: string, packet: IPv4Packet): string {
    return `${stage}|${iface}|${packet.sourceIP}|${packet.destinationIP}|${packet.protocol}|${packet.identification}`;
  }
}
