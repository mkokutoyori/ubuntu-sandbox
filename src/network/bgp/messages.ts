/**
 * BGP-4 protocol messages (RFC 4271 §4).
 *
 * These are the four message types a BGP speaker exchanges over an
 * established TCP/179 connection. They are modelled as structured
 * payloads carried on the router's real TCP byte stream — the simulator
 * ships the struct as the TCP segment payload, exactly as EIGRP ships its
 * packet structs inside IPv4 protocol-88 frames (see `eigrp/packets.ts`).
 * No hand-rolled octet (de)serialisation: the transport is the simulated
 * TcpStack, the cable carries the segment, the peer re-enters its stack.
 *
 * SRP: data shapes and protocol constants only — no FSM/engine behaviour.
 */
import type { BgpOrigin } from './bestPath';

/** Well-known TCP port for BGP (RFC 4271 §4.1). */
export const BGP_PORT = 179;
/** Current BGP version carried in OPEN (RFC 4271 §4.2). */
export const BGP_VERSION = 4;
/** Default Hold Time advertised in OPEN, seconds (RFC 4271 §4.2 / §10). */
export const BGP_DEFAULT_HOLD_SEC = 90;
/** Default KEEPALIVE interval — Hold Time / 3 (RFC 4271 §4.4). */
export const BGP_DEFAULT_KEEPALIVE_SEC = 30;

export type BgpMessageType = 'open' | 'update' | 'keepalive' | 'notification';

/**
 * OPEN (RFC 4271 §4.2) — the first message after the TCP connection is
 * up; it negotiates version, the peer's AS, the Hold Time and the BGP
 * Identifier (router-id).
 */
export interface BgpOpenMessage {
  readonly type: 'bgp';
  readonly message: 'open';
  readonly version: number;
  readonly asn: number;
  readonly holdTimeSec: number;
  /** BGP Identifier (router-id), dotted quad (RFC 4271 §4.2). */
  readonly bgpIdentifier: string;
}

/** A single NLRI prefix, announced or withdrawn (RFC 4271 §4.3). */
export interface BgpNlri {
  readonly network: string;
  readonly prefixLength: number;
}

/**
 * Path attributes carried with announced NLRI (RFC 4271 §5.1). LOCAL_PREF
 * is only meaningful inside an AS (§5.1.5) and MED only between paths from
 * the same neighbouring AS (§5.1.4); both are optional on the wire.
 */
export interface BgpPathAttributes {
  readonly origin: BgpOrigin;            // §5.1.1 ORIGIN
  readonly asPath: readonly number[];    // §5.1.2 AS_PATH
  readonly nextHop: string;              // §5.1.3 NEXT_HOP
  readonly med?: number;                 // §5.1.4 MULTI_EXIT_DISC
  readonly localPref?: number;           // §5.1.5 LOCAL_PREF (iBGP)
}

/**
 * UPDATE (RFC 4271 §4.3) — advertises feasible routes (NLRI + a single
 * set of path attributes) and/or withdraws routes that are no longer
 * feasible. Attributes are present iff at least one prefix is announced.
 */
export interface BgpUpdateMessage {
  readonly type: 'bgp';
  readonly message: 'update';
  readonly withdrawn: readonly BgpNlri[];
  readonly announced: readonly BgpNlri[];
  readonly attributes?: BgpPathAttributes;
}

/** KEEPALIVE (RFC 4271 §4.4) — header only; resets the peer's Hold Timer. */
export interface BgpKeepaliveMessage {
  readonly type: 'bgp';
  readonly message: 'keepalive';
}

/**
 * NOTIFICATION (RFC 4271 §4.5) — sent on any error; the sender closes the
 * connection immediately afterwards.
 */
export interface BgpNotificationMessage {
  readonly type: 'bgp';
  readonly message: 'notification';
  readonly errorCode: number;
  readonly errorSubcode: number;
  readonly data?: string;
}

export type BgpMessage =
  | BgpOpenMessage
  | BgpUpdateMessage
  | BgpKeepaliveMessage
  | BgpNotificationMessage;

/** NOTIFICATION Error Codes (RFC 4271 §4.5 / §6). */
export const BGP_ERROR = {
  MESSAGE_HEADER: 1,
  OPEN_MESSAGE: 2,
  UPDATE_MESSAGE: 3,
  HOLD_TIMER_EXPIRED: 4,
  FSM_ERROR: 5,
  CEASE: 6,
} as const;

/** OPEN Message Error subcodes (RFC 4271 §6.2). */
export const BGP_OPEN_ERROR = {
  UNSUPPORTED_VERSION: 1,
  BAD_PEER_AS: 2,
  BAD_BGP_IDENTIFIER: 3,
  UNSUPPORTED_OPTIONAL_PARAM: 4,
  UNACCEPTABLE_HOLD_TIME: 6,
} as const;

/** Structural guard for a payload arriving on the BGP TCP stream. */
export function isBgpMessage(p: unknown): p is BgpMessage {
  if (!p || typeof p !== 'object') return false;
  const c = p as { type?: unknown; message?: unknown };
  if (c.type !== 'bgp') return false;
  return c.message === 'open' || c.message === 'update'
    || c.message === 'keepalive' || c.message === 'notification';
}

/** Build a KEEPALIVE (the only message with no parameters). */
export function keepalive(): BgpKeepaliveMessage {
  return { type: 'bgp', message: 'keepalive' };
}
