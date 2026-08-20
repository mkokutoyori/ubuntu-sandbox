import type { TcpState } from '../../../tcp/types';

export type ObservedTcpState = Exclude<TcpState, 'listen'>;

export interface ObservedTcpFlags {
  readonly syn: boolean;
  readonly ack: boolean;
  readonly fin: boolean;
  readonly rst: boolean;
  readonly psh: boolean;
  readonly urg: boolean;
}

export type FlowDirection = 'c2s' | 's2c';

export type TcpRejectReason =
  | 'no-session-non-syn'
  | 'invalid-tcp-flags'
  | 'tcp-state-violation';

export interface TcpVerdict {
  readonly accepted: boolean;
  readonly reason?: TcpRejectReason;
  readonly refreshes: boolean;
}

export interface TcpTimeouts {
  readonly established: number;
  readonly handshake: number;
  readonly timeWait: number;
  readonly closing: number;
}

export interface TcpStateMachineOptions {
  synCheck?: boolean;
  timeouts?: TcpTimeouts;
}

export const DEFAULT_TCP_TIMEOUTS: TcpTimeouts = Object.freeze({
  established: 3600,
  handshake: 30,
  timeWait: 30,
  closing: 30,
});

const ACCEPTED: TcpVerdict = Object.freeze({ accepted: true, refreshes: true });

function rejected(reason: TcpRejectReason): TcpVerdict {
  return Object.freeze({ accepted: false, reason, refreshes: false });
}

export function tcpFlagsAreValid(flags: ObservedTcpFlags): boolean {
  if (!flags.syn && !flags.ack && !flags.fin && !flags.rst) return false;
  if (flags.syn && flags.fin) return false;
  if (flags.syn && flags.rst) return false;
  if (flags.fin && flags.rst) return false;
  if (flags.fin && !flags.ack) return false;
  return true;
}

export class TcpStateMachine {
  private current: ObservedTcpState = 'closed';
  private readonly synCheck: boolean;
  private readonly timeouts: TcpTimeouts;

  constructor(options: TcpStateMachineOptions = {}) {
    this.synCheck = options.synCheck ?? true;
    this.timeouts = options.timeouts ?? DEFAULT_TCP_TIMEOUTS;
  }

  get state(): ObservedTcpState {
    return this.current;
  }

  get timeoutSec(): number {
    switch (this.current) {
      case 'syn-sent':
      case 'syn-received':
        return this.timeouts.handshake;
      case 'established':
        return this.timeouts.established;
      case 'time-wait':
        return this.timeouts.timeWait;
      default:
        return this.timeouts.closing;
    }
  }

  onFirstPacket(flags: ObservedTcpFlags): TcpVerdict {
    if (!tcpFlagsAreValid(flags)) return rejected('invalid-tcp-flags');

    if (flags.syn && !flags.ack) {
      this.current = 'syn-sent';
      return ACCEPTED;
    }
    if (!this.synCheck) {
      this.current = 'established';
      return ACCEPTED;
    }
    return rejected('no-session-non-syn');
  }

  onPacket(flags: ObservedTcpFlags, direction: FlowDirection): TcpVerdict {
    if (!tcpFlagsAreValid(flags)) return rejected('invalid-tcp-flags');

    if (flags.rst) {
      this.current = 'closed';
      return ACCEPTED;
    }

    const next = this.nextState(flags, direction);
    if (next === undefined) return rejected('tcp-state-violation');

    this.current = next;
    return ACCEPTED;
  }

  private nextState(flags: ObservedTcpFlags, direction: FlowDirection): ObservedTcpState | undefined {
    switch (this.current) {
      case 'syn-sent':
        if (flags.syn && flags.ack) return direction === 's2c' ? 'syn-received' : undefined;
        if (flags.syn) return direction === 'c2s' ? 'syn-sent' : undefined;
        return undefined;

      case 'syn-received':
        if (flags.syn && flags.ack) return direction === 's2c' ? 'syn-received' : undefined;
        if (flags.ack && !flags.fin) return direction === 'c2s' ? 'established' : undefined;
        return undefined;

      case 'established':
        if (flags.fin) return 'fin-wait-1';
        return 'established';

      case 'fin-wait-1':
        if (flags.fin) return 'closing';
        if (flags.ack) return 'fin-wait-2';
        return 'fin-wait-1';

      case 'fin-wait-2':
        if (flags.fin) return 'last-ack';
        return 'fin-wait-2';

      case 'closing':
        if (flags.ack && !flags.fin) return 'time-wait';
        return 'closing';

      case 'last-ack':
        if (flags.ack && !flags.fin) return 'time-wait';
        return 'last-ack';

      case 'close-wait':
        if (flags.fin) return 'last-ack';
        return 'close-wait';

      case 'time-wait':
        return 'time-wait';

      case 'closed':
      default:
        return undefined;
    }
  }
}
