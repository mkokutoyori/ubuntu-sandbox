/**
 * TrackRepository — config-driven object-tracking state (Lot C).
 *
 * `track <id> …` objects are recorded as real config; their Up/Down
 * state is RESOLVED from real device state: a port's line-protocol,
 * a prefix in the real routing table, or an IP SLA's real
 * reachability. Composite (list) objects combine member states.
 */
import type { Router } from '../../Router';
import type { IpSlaRepository } from './IpSlaRepository';

export type TrackType =
  | 'interface-line' | 'interface-routing' | 'route'
  | 'ipsla-reach' | 'ipsla-state' | 'list-boolean' | 'list-threshold'
  | 'stub';

export interface TrackObject {
  id: number;
  type: TrackType;
  iface?: string;
  prefix?: string;
  slaId?: number;
  boolOp?: 'and' | 'or';
  members: Array<{ id: number; weight?: number; negate?: boolean }>;
  thresholdUp?: number;
  thresholdDown?: number;
  delayUp?: number;
  delayDown?: number;
}

export class TrackRepository {
  private readonly objs = new Map<number, TrackObject>();

  ensure(id: number, type: TrackType): TrackObject {
    let o = this.objs.get(id);
    if (!o) { o = { id, type, members: [] }; this.objs.set(id, o); }
    else o.type = type;
    return o;
  }
  get(id: number): TrackObject | undefined { return this.objs.get(id); }
  all(): TrackObject[] {
    return [...this.objs.values()].sort((a, b) => a.id - b.id);
  }
  remove(id: number): void { this.objs.delete(id); }

  /** Resolve REAL Up/Down for object <id> (recursive for lists). */
  state(router: Router, sla: IpSlaRepository, id: number,
        seen = new Set<number>()): 'Up' | 'Down' {
    if (seen.has(id)) return 'Down';
    seen.add(id);
    const o = this.objs.get(id);
    if (!o) return 'Down';
    switch (o.type) {
      case 'interface-line': {
        const p = o.iface ? router._getPortsInternal().get(o.iface) : undefined;
        return p && p.getIsUp() && p.isConnected() ? 'Up' : 'Down';
      }
      case 'interface-routing': {
        const p = o.iface ? router._getPortsInternal().get(o.iface) : undefined;
        return p && p.getIsUp() && !!p.getIPAddress() ? 'Up' : 'Down';
      }
      case 'route': {
        const has = router.getRoutingTable().some((r) =>
          o.prefix && String(r.network) === o.prefix);
        return has ? 'Up' : 'Down';
      }
      case 'ipsla-reach':
      case 'ipsla-state':
        return o.slaId !== undefined && sla.reachable(router, o.slaId)
          ? 'Up' : 'Down';
      case 'list-boolean': {
        const states = o.members.map((m) => {
          const s = this.state(router, sla, m.id, seen) === 'Up';
          return m.negate ? !s : s;
        });
        if (!states.length) return 'Down';
        return (o.boolOp === 'or' ? states.some(Boolean) : states.every(Boolean))
          ? 'Up' : 'Down';
      }
      case 'list-threshold': {
        const w = o.members.reduce((acc, m) =>
          acc + (this.state(router, sla, m.id, seen) === 'Up'
            ? (m.weight ?? 10) : 0), 0);
        return w >= (o.thresholdUp ?? 1) ? 'Up' : 'Down';
      }
      default:
        return 'Down';
    }
  }

  reset(): void { this.objs.clear(); }
}
