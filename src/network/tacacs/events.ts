import type { TacacsAuthenStatus, TacacsAuthorStatus, TacacsAcctFlag, TacacsAcctStatus } from './types';

export interface TacacsDeviceRef {
  deviceId: string;
  hostname: string;
}

export interface TacacsPacketSentPayload extends TacacsDeviceRef {
  destinationIp: string;
  sessionId: number;
  bodyType: string;
}

export interface TacacsPacketReceivedPayload extends TacacsDeviceRef {
  fromIp: string;
  sessionId: number;
  bodyType: string;
}

export interface TacacsAuthenCompletedPayload extends TacacsDeviceRef {
  serverIp: string;
  username: string;
  status: TacacsAuthenStatus | 'timeout';
  privLvl: number | null;
}

export interface TacacsAuthorCompletedPayload extends TacacsDeviceRef {
  serverIp: string;
  username: string;
  status: TacacsAuthorStatus | 'timeout';
  command: string | null;
}

export interface TacacsAcctCompletedPayload extends TacacsDeviceRef {
  serverIp: string;
  username: string;
  flags: TacacsAcctFlag[];
  status: TacacsAcctStatus | 'timeout';
}

export type TacacsDomainEvent =
  | { topic: 'tacacs.packet.sent'; payload: TacacsPacketSentPayload }
  | { topic: 'tacacs.packet.received'; payload: TacacsPacketReceivedPayload }
  | { topic: 'tacacs.authen.completed'; payload: TacacsAuthenCompletedPayload }
  | { topic: 'tacacs.author.completed'; payload: TacacsAuthorCompletedPayload }
  | { topic: 'tacacs.acct.completed'; payload: TacacsAcctCompletedPayload };
