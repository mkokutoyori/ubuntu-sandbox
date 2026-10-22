import type { IPAddress } from '@/network/core/types';
import type { MplsLabel } from '@/network/mpls/MplsLabel';
import type { LdpIdentifier } from './LdpIdentifier';

export const LDP_VERSION = 1;
export const LDP_PORT = 646;
export const LDP_ALL_ROUTERS_GROUP = '224.0.0.2';
export const LDP_DEFAULT_MAX_PDU_LENGTH = 4096;
export const LDP_HOLD_TIME_INFINITE = 0xffff;
export const LDP_LINK_HELLO_DEFAULT_HOLD_SECONDS = 15;
export const LDP_TARGETED_HELLO_DEFAULT_HOLD_SECONDS = 45;
export const ADDRESS_FAMILY_IPV4 = 1;

export const MessageType = {
  Notification: 0x0001,
  Hello: 0x0100,
  Initialization: 0x0200,
  KeepAlive: 0x0201,
  Address: 0x0300,
  AddressWithdraw: 0x0301,
  LabelMapping: 0x0400,
  LabelRequest: 0x0401,
  LabelWithdraw: 0x0402,
  LabelRelease: 0x0403,
  LabelAbortRequest: 0x0404,
} as const;

export const TlvType = {
  Fec: 0x0100,
  AddressList: 0x0101,
  HopCount: 0x0103,
  PathVector: 0x0104,
  GenericLabel: 0x0200,
  Status: 0x0300,
  ExtendedStatus: 0x0301,
  ReturnedPdu: 0x0302,
  ReturnedMessage: 0x0303,
  CommonHelloParameters: 0x0400,
  Ipv4TransportAddress: 0x0401,
  ConfigurationSequenceNumber: 0x0402,
  CommonSessionParameters: 0x0500,
  LabelRequestMessageId: 0x0600,
} as const;

export const StatusCode = {
  Success: 0x00000000,
  BadLdpIdentifier: 0x00000001,
  BadProtocolVersion: 0x00000002,
  BadPduLength: 0x00000003,
  UnknownMessageType: 0x00000004,
  BadMessageLength: 0x00000005,
  UnknownTlv: 0x00000006,
  BadTlvLength: 0x00000007,
  MalformedTlvValue: 0x00000008,
  HoldTimerExpired: 0x00000009,
  Shutdown: 0x0000000a,
  LoopDetected: 0x0000000b,
  UnknownFec: 0x0000000c,
  NoRoute: 0x0000000d,
  NoLabelResources: 0x0000000e,
  LabelResourcesAvailable: 0x0000000f,
  SessionRejectedNoHello: 0x00000010,
  SessionRejectedAdvertisementMode: 0x00000011,
  SessionRejectedMaxPduLength: 0x00000012,
  SessionRejectedLabelRange: 0x00000013,
  KeepAliveTimerExpired: 0x00000014,
  LabelRequestAborted: 0x00000015,
  MissingMessageParameters: 0x00000016,
  UnsupportedAddressFamily: 0x00000017,
  SessionRejectedBadKeepAliveTime: 0x00000018,
  InternalError: 0x00000019,
} as const;

export const FATAL_STATUS_CODES: ReadonlySet<number> = new Set([
  StatusCode.BadLdpIdentifier, StatusCode.BadProtocolVersion, StatusCode.BadPduLength, StatusCode.BadMessageLength,
  StatusCode.BadTlvLength, StatusCode.MalformedTlvValue, StatusCode.HoldTimerExpired, StatusCode.Shutdown,
  StatusCode.SessionRejectedNoHello, StatusCode.SessionRejectedAdvertisementMode, StatusCode.SessionRejectedMaxPduLength,
  StatusCode.SessionRejectedLabelRange, StatusCode.KeepAliveTimerExpired, StatusCode.SessionRejectedBadKeepAliveTime,
  StatusCode.InternalError,
]);

export type FecElement =
  | { readonly kind: 'wildcard' }
  | { readonly kind: 'prefix'; readonly prefix: IPAddress; readonly length: number };

export type AdvertisementMode = 'unsolicited' | 'on-demand';

export interface HelloMessage {
  readonly kind: 'hello';
  readonly id: number;
  readonly holdTimeSeconds: number;
  readonly targeted: boolean;
  readonly requestTargetedHellos: boolean;
  readonly transportAddress?: IPAddress;
  readonly configurationSequenceNumber?: number;
}

export interface InitializationMessage {
  readonly kind: 'initialization';
  readonly id: number;
  readonly protocolVersion: number;
  readonly keepAliveTimeSeconds: number;
  readonly advertisementMode: AdvertisementMode;
  readonly loopDetection: boolean;
  readonly pathVectorLimit: number;
  readonly maxPduLength: number;
  readonly receiver: LdpIdentifier;
}

export interface KeepAliveMessage { readonly kind: 'keepalive'; readonly id: number }

export interface AddressMessage {
  readonly kind: 'address' | 'address-withdraw';
  readonly id: number;
  readonly addresses: readonly IPAddress[];
}

export interface LabelMappingMessage {
  readonly kind: 'label-mapping';
  readonly id: number;
  readonly fec: readonly FecElement[];
  readonly label: MplsLabel;
  readonly requestMessageId?: number;
  readonly hopCount?: number;
  readonly pathVector?: readonly IPAddress[];
}

export interface LabelRequestMessage {
  readonly kind: 'label-request';
  readonly id: number;
  readonly fec: readonly FecElement[];
  readonly hopCount?: number;
  readonly pathVector?: readonly IPAddress[];
}

export interface LabelWithdrawMessage {
  readonly kind: 'label-withdraw' | 'label-release';
  readonly id: number;
  readonly fec: readonly FecElement[];
  readonly label?: MplsLabel;
}

export interface NotificationMessage {
  readonly kind: 'notification';
  readonly id: number;
  readonly statusCode: number;
  readonly forward: boolean;
  readonly referencedMessageId: number;
  readonly referencedMessageType: number;
}

export interface UnknownMessage {
  readonly kind: 'unknown';
  readonly id: number;
  readonly messageType: number;
  readonly unknownBit: boolean;
}

export type LdpMessage =
  | HelloMessage | InitializationMessage | KeepAliveMessage | AddressMessage
  | LabelMappingMessage | LabelRequestMessage | LabelWithdrawMessage | NotificationMessage | UnknownMessage;

export interface LdpPdu {
  readonly version: number;
  readonly sender: LdpIdentifier;
  readonly messages: readonly LdpMessage[];
}

export function isFatalStatus(statusCode: number): boolean {
  return FATAL_STATUS_CODES.has(statusCode);
}
