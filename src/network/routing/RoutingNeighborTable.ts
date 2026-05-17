/**
 * RoutingNeighborTable — a small, reusable neighbour store with FSM
 * transitions. Single Responsibility: track peers + their state and
 * notify on change; it knows nothing about any specific protocol's
 * packet format. Engines own one of these via composition.
 */
import type { NeighborFsmState, ProtocolNeighborView } from './types';

interface NeighborRecord {
  id: string;
  address: string;
  iface: string;
  state: NeighborFsmState;
  remoteId?: string;
  since: number;
}

const UP_STATES: ReadonlySet<NeighborFsmState> = new Set([
  'Established', 'Up',
]);

export class RoutingNeighborTable {
  private readonly peers = new Map<string, NeighborRecord>();
  private readonly listeners = new Set<() => void>();

  /** Subscribe to any neighbour change (reactive, no polling). */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  /** Insert/refresh a neighbour; transitions state if it changed. */
  upsert(id: string, address: string, iface: string,
         state: NeighborFsmState, remoteId?: string): void {
    const prev = this.peers.get(id);
    if (prev && prev.state === state && prev.remoteId === remoteId) return;
    this.peers.set(id, {
      id, address, iface, state, remoteId,
      since: prev && prev.state === state ? prev.since : Date.now(),
    });
    this.emit();
  }

  remove(id: string): void {
    if (this.peers.delete(id)) this.emit();
  }

  /** Drop every neighbour not in `keep` (peers that disappeared). */
  retainOnly(keep: ReadonlySet<string>): void {
    let changed = false;
    for (const id of [...this.peers.keys()]) {
      if (!keep.has(id)) { this.peers.delete(id); changed = true; }
    }
    if (changed) this.emit();
  }

  clear(): void {
    if (this.peers.size) { this.peers.clear(); this.emit(); }
  }

  view(): ProtocolNeighborView[] {
    const now = Date.now();
    return [...this.peers.values()].map((p) => ({
      id: p.id,
      address: p.address,
      iface: p.iface,
      state: p.state,
      isUp: UP_STATES.has(p.state),
      uptimeSec: UP_STATES.has(p.state)
        ? Math.floor((now - p.since) / 1000) : 0,
      remoteId: p.remoteId,
    }));
  }

  hasEstablished(): boolean {
    return [...this.peers.values()].some((p) => UP_STATES.has(p.state));
  }
}
