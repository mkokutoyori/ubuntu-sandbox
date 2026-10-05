import { EcnCodepoint } from '@/network/core/IpHeaderFields';
import { seqLt, type TcpFlags } from './types';

export type TcpEcnPolicy = 'off' | 'accept' | 'request';

export type TcpEmission = 'new' | 'retransmission' | 'probe';

export interface TcpEcnMarking {
  readonly flags: TcpFlags;
  readonly codepoint: EcnCodepoint;
}

export function ecnPolicyOfSetting(setting: number): TcpEcnPolicy {
  if (setting === 0) return 'off';
  return setting === 1 ? 'request' : 'accept';
}

type Negotiation = 'off' | 'requested' | 'on';

export class TcpEcn {
  private negotiation: Negotiation = 'off';
  private echoing = false;
  private cwrPending = false;
  private reductionEnd: number | null = null;
  holdTimer: symbol | null = null;

  get negotiated(): boolean {
    return this.negotiation === 'on';
  }

  get echoingCongestion(): boolean {
    return this.echoing;
  }

  get holdingNewData(): boolean {
    return this.holdTimer !== null;
  }

  requestOnSyn(flags: TcpFlags): void {
    flags.ece = true;
    flags.cwr = true;
    this.negotiation = 'requested';
  }

  acceptSyn(policy: TcpEcnPolicy, syn: TcpFlags, arrival: EcnCodepoint): void {
    const isSetup = syn.ece && syn.cwr;
    this.negotiation = policy !== 'off' && isSetup && !arrival.capable ? 'on' : 'off';
  }

  answerSyn(flags: TcpFlags): void {
    flags.ece = this.negotiated;
    flags.cwr = false;
  }

  learnFromSynAck(synAck: TcpFlags): void {
    if (this.negotiation !== 'requested') return;
    this.negotiation = synAck.ece && !synAck.cwr ? 'on' : 'off';
  }

  learnFromSimultaneousSyn(syn: TcpFlags): void {
    if (this.negotiation !== 'requested') return;
    this.negotiation = syn.ece && syn.cwr ? 'on' : 'off';
  }

  withdrawFromSyn(flags: TcpFlags): TcpFlags {
    if (this.negotiation !== 'requested') return flags;
    this.negotiation = 'off';
    return { ...flags, ece: false, cwr: false };
  }

  noteArrival(flags: TcpFlags, codepoint: EcnCodepoint, carriesData: boolean): boolean {
    if (!this.negotiated) return false;
    let promptAck = false;
    if (flags.cwr) {
      this.echoing = false;
      promptAck = carriesData;
    }
    if (carriesData && codepoint.congestionExperienced) {
      this.echoing = true;
      promptAck = true;
    }
    return promptAck;
  }

  mark(flags: TcpFlags, emission: TcpEmission, payloadBytes: number): TcpEcnMarking {
    if (!this.negotiated || flags.syn || flags.rst) {
      return { flags, codepoint: EcnCodepoint.NOT_ECT };
    }
    const wire: TcpFlags = { ...flags, ece: this.echoing, cwr: false };
    if (emission !== 'new' || payloadBytes === 0) {
      return { flags: wire, codepoint: EcnCodepoint.NOT_ECT };
    }
    wire.cwr = this.cwrPending;
    this.cwrPending = false;
    return { flags: wire, codepoint: EcnCodepoint.ECT_0 };
  }

  reacts(flags: TcpFlags, sendUnacked: number): boolean {
    if (!this.negotiated || !flags.ece || flags.syn) return false;
    return this.reductionEnd === null || seqLt(this.reductionEnd, sendUnacked);
  }

  windowReduced(sendNext: number): void {
    if (!this.negotiated) return;
    this.reductionEnd = sendNext;
    this.cwrPending = true;
  }
}
