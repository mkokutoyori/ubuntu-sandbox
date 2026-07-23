import type { NetworkPdu } from '@/network/core/NetworkPdu';

/**
 * NHRP (Next Hop Resolution Protocol, RFC 2332) wire packet types.
 *
 * Scope: Resolution Request/Reply and Registration Request/Reply — the
 * exchange a hub-and-spoke DMVPN lab needs to demonstrate real dynamic
 * NBMA-address learning. Purge and Error Indication are not modelled.
 *
 * On real Cisco DMVPN (mGRE), NHRP travels as a GRE payload (protocol
 * type 0x2001) inside the tunnel rather than as a standalone IP
 * protocol, and this simulator's GreAgent only tunnels IP-in-GRE
 * payloads. So — like OSPF/EIGRP/GRE/VXLAN elsewhere in this codebase —
 * NHRP here is sent as its own direct IP protocol between the tunnel
 * endpoints' real underlay (NBMA) addresses, the way NHRP runs over
 * non-GRE NBMA media (Frame Relay, ATM, X.25) per RFC 2332 §5.2.
 */
export const IP_PROTO_NHRP = 54;

export type NhrpOpcode =
  | 'resolution-request'
  | 'resolution-reply'
  | 'registration-request'
  | 'registration-reply';

/** RFC 2332 §5.2.7: 0 = success; non-zero = failure. */
export const NHRP_ERROR_NONE = 0;
export const NHRP_ERROR_AUTHENTICATION_FAILURE = 4;
export const NHRP_ERROR_NO_BINDING_EXISTS = 13;

interface NhrpPacketBase extends NetworkPdu {
  type: 'nhrp';
  opcode: NhrpOpcode;
  requestId: number;
  /** Protocol (tunnel/overlay) address of the packet's true originator. */
  srcProtoAddr: string;
  /** NBMA (underlay) address of the packet's true originator. */
  srcNbmaAddr: string;
  /** The address being registered (registration) or resolved (resolution). */
  dstProtoAddr: string;
  authentication?: string;
}

export interface NhrpResolutionRequest extends NhrpPacketBase {
  opcode: 'resolution-request';
  /** Tunnel address of the NHS being queried — lets the receiver identify
   *  which of its own tunnel interfaces this request is addressed to,
   *  distinct from `dstProtoAddr` (the target being resolved). */
  nhsProtoAddr: string;
}

export interface NhrpResolutionReply extends NhrpPacketBase {
  opcode: 'resolution-reply';
  errorCode: number;
  /** Tunnel address of the original requester — lets the requester identify
   *  which of its own tunnel interfaces this reply is addressed to, distinct
   *  from `dstProtoAddr` (the target that was resolved). */
  requesterProtoAddr: string;
  /** NBMA address resolved for dstProtoAddr — set only when errorCode === NHRP_ERROR_NONE. */
  resolvedNbmaAddr?: string;
}

export interface NhrpRegistrationRequest extends NhrpPacketBase {
  opcode: 'registration-request';
  holdtimeSec: number;
}

export interface NhrpRegistrationReply extends NhrpPacketBase {
  opcode: 'registration-reply';
  errorCode: number;
  holdtimeSec: number;
}

export type NhrpPacket =
  | NhrpResolutionRequest
  | NhrpResolutionReply
  | NhrpRegistrationRequest
  | NhrpRegistrationReply;

let nextRequestId = 1;
export function nextNhrpRequestId(): number { return nextRequestId++; }
/** Test-only: make request IDs deterministic across a suite run. */
export function resetNhrpRequestIds(): void { nextRequestId = 1; }
