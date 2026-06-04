/**
 * IpSlaRepository — config-driven IP SLA state (Lot C).
 *
 * `ip sla <id>` operations are recorded as real config; their
 * reachability is derived from the device's REAL routing table (no
 * fabricated probe results). State is Pending until scheduled.
 */
import type { Router } from '../../Router';

export type SlaType =
  | 'icmp-echo' | 'udp-jitter' | 'tcp-connect' | 'http' | 'dns' | 'unknown';

export interface SlaOperation {
  id: number;
  type: SlaType;
  target: string | null;
  frequency: number;        // seconds (default 60, real IOS default)
  scheduled: boolean;
  responder: boolean;
}

function ipReachable(router: Router, ip: string | null): boolean {
  if (!ip) return false;
  // Connected/own address?
  for (const p of router._getPortsInternal().values()) {
    if (p.getIPAddress() && String(p.getIPAddress()) === ip) return true;
  }
  // Covered by any route in the REAL routing table?
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(Number.isNaN)) return false;
  const ipNum = ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
  for (const r of router.getRoutingTable()) {
    const np = String(r.network).split('.').map(Number);
    const netNum = ((np[0] << 24) | (np[1] << 16) | (np[2] << 8) | np[3]) >>> 0;
    const bits = r.mask.toCIDR();
    const maskNum = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if ((ipNum & maskNum) === (netNum & maskNum)) return true;
  }
  return false;
}

export interface SlaReactionConfiguration {
  opId: number;
  reactionType: string;
  thresholdType?: string;
  thresholdValueLow?: number;
  thresholdValueHigh?: number;
  actionType?: 'none' | 'trapAndTrigger' | 'trapOnly' | 'triggerOnly';
}

export class IpSlaRepository {
  private readonly ops = new Map<number, SlaOperation>();
  private readonly reactions: SlaReactionConfiguration[] = [];
  responderEnabled = false;
  globalEnabled = true;
  loggingTrapsEnabled = false;

  addReaction(r: SlaReactionConfiguration): void { this.reactions.push(r); }
  getReactions(opId?: number): readonly SlaReactionConfiguration[] {
    return opId === undefined ? [...this.reactions] : this.reactions.filter(r => r.opId === opId);
  }

  ensure(id: number): SlaOperation {
    let op = this.ops.get(id);
    if (!op) {
      op = { id, type: 'unknown', target: null, frequency: 60,
        scheduled: false, responder: false };
      this.ops.set(id, op);
    }
    return op;
  }

  get(id: number): SlaOperation | undefined { return this.ops.get(id); }
  all(): SlaOperation[] {
    return [...this.ops.values()].sort((a, b) => a.id - b.id);
  }
  schedule(id: number): void {
    const op = this.ops.get(id);
    if (op) op.scheduled = true;
  }

  /** Real reachability of op <id> via the routing table. */
  reachable(router: Router, id: number): boolean {
    const op = this.ops.get(id);
    return op ? ipReachable(router, op.target) : false;
  }

  state(router: Router, id: number): 'Active' | 'Pending' {
    const op = this.ops.get(id);
    return op && op.scheduled ? 'Active' : 'Pending';
  }

  reset(): void {
    this.ops.clear();
    this.responderEnabled = false;
  }
}
