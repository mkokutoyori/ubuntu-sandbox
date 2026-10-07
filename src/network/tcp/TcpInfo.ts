import type { TcpState } from './types';

export type TcpCaState = 'Open' | 'Disorder' | 'CWR' | 'Recovery' | 'Loss';

export type TcpTimerKind = 'on' | 'persist' | 'keepalive' | 'timewait';

export interface TcpTimer {
  readonly kind: TcpTimerKind;
  readonly expiresInMs: number;
  readonly retransmits: number;
}

export interface TcpQueues {
  readonly receive: number;
  readonly send: number;
}

export interface TcpSocketFacts {
  readonly receiveShutdown: boolean;
  readonly sendShutdown: boolean;
  readonly orphaned: boolean;
  readonly typeOfService: number;
}

export interface TcpListenerQueues {
  readonly accept: number;
  readonly backlog: number;
}

export interface TcpInfo {
  readonly state: TcpState;
  readonly caState: TcpCaState;
  readonly congestionControl: string;
  readonly retransmits: number;
  readonly probes: number;
  readonly backoff: number;
  readonly timestamps: boolean;
  readonly sack: boolean;
  readonly windowScale: { readonly send: number; readonly receive: number } | null;
  readonly ecn: boolean;
  readonly ecnSeen: boolean;
  readonly rtoMs: number;
  readonly atoMs: number;
  readonly sendMss: number;
  readonly receiveMss: number;
  readonly unacked: number;
  readonly sacked: number;
  readonly lost: number;
  readonly retrans: number;
  readonly lastDataSentMs: number;
  readonly lastDataReceivedMs: number;
  readonly lastAckReceivedMs: number;
  readonly pathMtu: number;
  readonly receiveSsthresh: number;
  readonly rttMs: number;
  readonly rttVarianceMs: number;
  readonly sendSsthresh: number | null;
  readonly sendCwnd: number;
  readonly advertisedMss: number;
  readonly reordering: number;
  readonly receiveSpace: number;
  readonly totalRetrans: number;
  readonly bytesAcked: number;
  readonly bytesReceived: number;
  readonly bytesSent: number;
  readonly bytesRetrans: number;
  readonly segmentsOut: number;
  readonly segmentsIn: number;
  readonly dataSegmentsOut: number;
  readonly dataSegmentsIn: number;
  readonly delivered: number;
  readonly notSentBytes: number;
  readonly minRttMs: number | null;
  readonly sendWindow: number;
}
