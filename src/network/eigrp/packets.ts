/**
 * EIGRP wire packets (RFC 7868).
 *
 * The simulator models the two packet types the lightweight engine
 * needs — Hello (neighbor discovery, §5.2) and Update (topology
 * exchange, §5.3) — as structured payloads carried in IPv4 protocol 88
 * frames addressed to the AllEIGRPRouters multicast group 224.0.0.10
 * (TTL 1, link-local), or unicast back to a discovered neighbor.
 *
 * SRP: data shapes and constants only — no engine behaviour.
 */
import type { EigrpKValues } from './metric';

/** AllEIGRPRouters group (RFC 7868 §4.2). */
export const EIGRP_MULTICAST_IP = '224.0.0.10';

/** Default hold time advertised in Hellos (IOS LAN default, §5.3.4). */
export const EIGRP_DEFAULT_HOLD_SEC = 15;

/** Protocol version carried in the EIGRP header (§5.1). */
export const EIGRP_VERSION = 2;

/**
 * One route TLV (§6.6) with the classic vector metric as seen by the
 * advertiser: minimum bandwidth and cumulative delay along ITS path.
 * The receiver folds in the ingress link before computing distances.
 */
export interface EigrpRouteTlv {
  /** Network address, dotted quad. */
  readonly network: string;
  /** Prefix length (0–32). */
  readonly prefixLength: number;
  /** Path minimum bandwidth (kbps) at the advertiser. */
  readonly bandwidthKbps: number;
  /** Path cumulative delay (µs) at the advertiser. */
  readonly delayUsec: number;
  /** External TLV (§6.6.3, redistributed) — AD 170 at the receiver. */
  readonly external: boolean;
}

/** Hello — neighbor discovery and adjacency parameter check (§5.3.4). */
export interface EigrpHelloPacket {
  readonly type: 'eigrp';
  readonly opcode: 'hello';
  readonly asn: number;
  readonly kValues: EigrpKValues;
  readonly holdTimeSec: number;
  readonly routerId?: string;
}

/** Update — full topology advertisement with vector metrics (§5.3.2). */
export interface EigrpUpdatePacket {
  readonly type: 'eigrp';
  readonly opcode: 'update';
  readonly asn: number;
  readonly routes: readonly EigrpRouteTlv[];
}

export type EigrpPacket = EigrpHelloPacket | EigrpUpdatePacket;

/** Structural guard for payloads arriving from the wire. */
export function isEigrpPacket(p: unknown): p is EigrpPacket {
  if (!p || typeof p !== 'object') return false;
  const c = p as { type?: unknown; opcode?: unknown };
  return c.type === 'eigrp' && (c.opcode === 'hello' || c.opcode === 'update');
}

/**
 * Transport seam injected into the engine by the device integration:
 * frames leave through the device's real port (Port → Cable → peer
 * `handleFrame`), never through any object registry.
 */
export interface EigrpWire {
  send(iface: string, destIp: string, packet: EigrpPacket): void;
}
