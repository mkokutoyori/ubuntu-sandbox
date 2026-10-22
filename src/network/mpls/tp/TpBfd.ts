import { simulationNowMs } from '@/network/core/SystemClock';
import { getDefaultScheduler, type IScheduler, type TimerHandle } from '@/events/Scheduler';
import {
  bfdNextState, nextDiscriminator, type BfdDiagnostic, type BfdPacket, type BfdState,
} from '@/network/bfd/types';
import type { GachDelivery } from '../MplsEngine';
import { ChannelType } from './GachPacket';
import type { MplsTpEngine } from './MplsTpEngine';

export const TP_BFD_DETECT_MULTIPLIER = 3;
export const TP_BFD_CV_INTERVAL_MS = 1000;
export const TP_BFD_INITIAL_INTERVAL_MS = 1000;
const TIMER_TICK_MS = 100;

export interface LspMepId {
  readonly globalId: number;
  readonly nodeId: number;
  readonly tunnelNum: number;
  readonly lspNum: number;
}

export interface ConnectivityVerificationMessage {
  readonly bfd: BfdPacket;
  readonly sourceMep: LspMepId;
}

export interface TpBfdConfig {
  readonly name: string;
  readonly outLsp: string;
  readonly inLsp: string;
  readonly localMep: LspMepId;
  readonly expectedRemoteMep: LspMepId;
  readonly intervalMs?: number;
}

export interface TpBfdSessionView {
  readonly name: string;
  readonly state: BfdState;
  readonly diagnostic: BfdDiagnostic;
  readonly remoteDiagnostic: BfdDiagnostic;
  readonly remoteIndicatesDefect: boolean;
  readonly misconnectivity: boolean;
  readonly sent: { readonly cc: number; readonly cv: number };
  readonly received: { readonly cc: number; readonly cv: number };
}

interface Session {
  readonly config: TpBfdConfig;
  readonly intervalMs: number;
  readonly localDiscriminator: number;
  remoteDiscriminator: number;
  state: BfdState;
  remoteState: BfdState;
  diagnostic: BfdDiagnostic;
  remoteDiagnostic: BfdDiagnostic;
  adminUp: boolean;
  misconnectivity: boolean;
  lastHeardMs: number;
  lastSentMs: number;
  lastCvMs: number;
  sent: { cc: number; cv: number };
  received: { cc: number; cv: number };
}

function sameMep(a: LspMepId, b: LspMepId): boolean {
  return a.globalId === b.globalId && a.nodeId === b.nodeId && a.tunnelNum === b.tunnelNum && a.lspNum === b.lspNum;
}

export function isConnectivityVerification(message: unknown): message is ConnectivityVerificationMessage {
  return typeof message === 'object' && message !== null && 'sourceMep' in message && 'bfd' in message;
}

export class TpBfdEngine {
  private readonly sessions = new Map<string, Session>();
  private timer: TimerHandle | null = null;
  private scheduler: IScheduler | null = null;

  constructor(
    private readonly tp: MplsTpEngine,
    private readonly getScheduler: () => IScheduler = () => getDefaultScheduler(),
  ) {
    tp.registerChannel(ChannelType.BfdContinuityCheck, delivery => this.receive(delivery, false));
    tp.registerChannel(ChannelType.BfdConnectivityVerification, delivery => this.receive(delivery, true));
  }

  enable(config: TpBfdConfig): void {
    const session: Session = {
      config, intervalMs: config.intervalMs ?? TP_BFD_INITIAL_INTERVAL_MS, localDiscriminator: nextDiscriminator(),
      remoteDiscriminator: 0, state: 'down', remoteState: 'down', diagnostic: 'none', remoteDiagnostic: 'none',
      adminUp: true, misconnectivity: false, lastHeardMs: 0, lastSentMs: 0, lastCvMs: 0,
      sent: { cc: 0, cv: 0 }, received: { cc: 0, cv: 0 },
    };
    this.sessions.set(config.name, session);
    this.start();
    this.transmit(session);
  }

  disable(name: string): void {
    const session = this.sessions.get(name);
    if (session === undefined) return;
    session.adminUp = false;
    session.state = 'admin-down';
    session.diagnostic = 'admin-down';
    this.transmit(session);
    this.sessions.delete(name);
    if (this.sessions.size === 0) this.stop();
  }

  view(name: string): TpBfdSessionView | undefined {
    const session = this.sessions.get(name);
    if (session === undefined) return undefined;
    return {
      name, state: session.state, diagnostic: session.diagnostic, remoteDiagnostic: session.remoteDiagnostic,
      remoteIndicatesDefect: session.remoteState === 'down' && session.remoteDiagnostic !== 'none',
      misconnectivity: session.misconnectivity, sent: { ...session.sent }, received: { ...session.received },
    };
  }

  private start(): void {
    if (this.timer !== null) return;
    this.scheduler = this.getScheduler();
    this.timer = this.scheduler.setInterval(() => this.tick(), TIMER_TICK_MS);
  }

  private stop(): void {
    if (this.timer === null) return;
    (this.scheduler ?? this.getScheduler()).clear(this.timer);
    this.timer = null;
  }

  private tick(): void {
    const now = simulationNowMs();
    for (const session of this.sessions.values()) {
      if (session.lastHeardMs !== 0 && (session.state === 'up' || session.state === 'init')
        && now - session.lastHeardMs > session.intervalMs * TP_BFD_DETECT_MULTIPLIER) {
        this.enterDown(session, 'control-detection-time-expired');
      }
      if (now - session.lastSentMs >= session.intervalMs) this.transmit(session);
    }
  }

  private enterDown(session: Session, diagnostic: BfdDiagnostic): void {
    session.state = 'down';
    session.diagnostic = diagnostic;
    session.remoteDiscriminator = 0;
    this.transmit(session);
  }

  private packetOf(session: Session): BfdPacket {
    return {
      type: 'bfd', version: 1, diagnostic: session.diagnostic, state: session.state, poll: false, final: false,
      controlPlaneIndependent: false, authPresent: false, demand: false, multipoint: false,
      detectMultiplier: TP_BFD_DETECT_MULTIPLIER, myDiscriminator: session.localDiscriminator,
      yourDiscriminator: session.remoteDiscriminator, desiredMinTxIntervalUs: session.intervalMs * 1000,
      requiredMinRxIntervalUs: session.intervalMs * 1000, requiredMinEchoRxIntervalUs: 0,
    };
  }

  private transmit(session: Session): void {
    const now = simulationNowMs();
    const bfd = this.packetOf(session);
    session.lastSentMs = now;
    session.sent.cc++;
    this.tp.sendOverLsp(session.config.outLsp, { type: 'gach', channelType: ChannelType.BfdContinuityCheck, message: bfd });
    if (!session.adminUp || now - session.lastCvMs < TP_BFD_CV_INTERVAL_MS) return;
    session.lastCvMs = now;
    session.sent.cv++;
    this.tp.sendOverLsp(session.config.outLsp, {
      type: 'gach', channelType: ChannelType.BfdConnectivityVerification, message: { bfd, sourceMep: session.config.localMep },
    });
  }

  private receive(delivery: GachDelivery, verification: boolean): void {
    const session = [...this.sessions.values()].find(candidate => candidate.config.inLsp === delivery.lsp);
    if (session === undefined || delivery.reason !== 'terminated') return;
    const message = delivery.payload.message;
    const bfd = verification ? (isConnectivityVerification(message) ? message.bfd : null) : (message as BfdPacket);
    if (bfd === null || bfd.type !== 'bfd') return;
    session.lastHeardMs = simulationNowMs();
    if (verification) session.received.cv++;
    else session.received.cc++;
    const defect = this.misconnectivityOf(session, bfd, verification ? (message as ConnectivityVerificationMessage).sourceMep : null);
    if (defect) {
      session.misconnectivity = true;
      if (session.state !== 'down' || session.diagnostic !== 'mis-connectivity-defect') this.enterDown(session, 'mis-connectivity-defect');
      return;
    }
    if (verification) {
      session.misconnectivity = false;
      return;
    }
    if (session.misconnectivity) return;
    session.remoteDiscriminator = bfd.myDiscriminator;
    session.remoteState = bfd.state;
    session.remoteDiagnostic = bfd.diagnostic;
    const next = bfdNextState(session.state, bfd.state, session.adminUp);
    if (next === session.state) return;
    session.state = next;
    if (next === 'down') session.diagnostic = 'neighbor-signaled-session-down';
    else if (next === 'up') session.diagnostic = 'none';
    this.transmit(session);
  }

  private misconnectivityOf(session: Session, bfd: BfdPacket, sourceMep: LspMepId | null): boolean {
    if (sourceMep !== null && !sameMep(sourceMep, session.config.expectedRemoteMep)) return true;
    return bfd.yourDiscriminator !== 0 && bfd.yourDiscriminator !== session.localDiscriminator;
  }
}
