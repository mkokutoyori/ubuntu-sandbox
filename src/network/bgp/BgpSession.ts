/**
 * BgpSession — the per-neighbour BGP Finite State Machine (RFC 4271 §8),
 * driven over a real transport (a TCP/179 socket in production, a paired
 * fake in tests). One session owns one connection and walks the peering
 * up: TCP up → OPEN exchange → KEEPALIVE → Established, then carries
 * UPDATE/KEEPALIVE traffic and tears down on error or close.
 *
 * The simulator's cable delivery is synchronous (a sent message re-enters
 * the peer's stack before `send()` returns), so the FSM follows a strict
 * **transition-before-send** discipline: it moves to the post-send state
 * *before* putting a message on the wire, so a re-entrant reply always
 * observes the correct state. Without it, a synchronous KEEPALIVE could
 * arrive while we are still nominally in OpenSent and be dropped, leaving
 * the peering stuck in OpenConfirm.
 *
 * SRP: session/peering logic only. It knows nothing about the RIB,
 * best-path or topology — the engine wires those through callbacks.
 */
import { getDefaultScheduler, type IScheduler } from '@/events/Scheduler';
import { TimerSet } from '@/events/TimerSet';
import {
  type BgpMessage, type BgpOpenMessage, type BgpUpdateMessage,
  keepalive,
  BGP_VERSION, BGP_DEFAULT_HOLD_SEC, BGP_DEFAULT_KEEPALIVE_SEC,
  BGP_ERROR, BGP_OPEN_ERROR,
} from './messages';

/** RFC 4271 §8.2.2 BGP FSM states. */
export type BgpFsmState =
  | 'Idle' | 'Connect' | 'Active'
  | 'OpenSent' | 'OpenConfirm' | 'Established';

/**
 * Duplex BGP message channel. Production wraps a {@link TcpSocket}; tests
 * pair two of these so one's `send` is the other's inbound message.
 */
export interface BgpTransport {
  send(msg: BgpMessage): void;
  close(): void;
  onMessage(handler: (msg: BgpMessage) => void): void;
  onClose(handler: () => void): void;
}

export interface BgpSessionConfig {
  readonly localAsn: number;
  readonly localRouterId: string;
  readonly holdTimeSec?: number;
  /** Expected peer AS (`neighbor <ip> remote-as`); a mismatch is rejected. */
  readonly expectedPeerAsn?: number;
}

export interface BgpSessionCallbacks {
  onStateChange?(oldState: BgpFsmState, newState: BgpFsmState): void;
  onEstablished?(peerAsn: number, peerRouterId: string): void;
  onUpdate?(update: BgpUpdateMessage): void;
  onClose?(): void;
}

export class BgpSession {
  private _state: BgpFsmState = 'Idle';
  private peerAsn: number | null = null;
  private peerRouterId: string | null = null;
  private sentOpen = false;
  private negotiatedHoldSec: number;
  private readonly timers: TimerSet;
  private holdTimer: symbol | null = null;
  private keepaliveTimer: symbol | null = null;
  /**
   * UPDATEs that arrived in OpenConfirm — delivered once Established.
   * Cable delivery is synchronous, so a peer that finishes the handshake
   * first can push its initial routes before this side has processed the
   * final KEEPALIVE; buffering replays them instead of dropping them.
   */
  private pendingUpdates: BgpUpdateMessage[] = [];

  constructor(
    private readonly transport: BgpTransport,
    private readonly cfg: BgpSessionConfig,
    private readonly cb: BgpSessionCallbacks = {},
    getScheduler: () => IScheduler = () => getDefaultScheduler(),
  ) {
    this.negotiatedHoldSec = cfg.holdTimeSec ?? BGP_DEFAULT_HOLD_SEC;
    this.timers = new TimerSet(getScheduler);
    transport.onMessage((m) => this.receive(m));
    transport.onClose(() => this.onTransportClosed());
  }

  get state(): BgpFsmState { return this._state; }
  get remoteAsn(): number | null { return this.peerAsn; }
  get remoteRouterId(): string | null { return this.peerRouterId; }
  isEstablished(): boolean { return this._state === 'Established'; }

  /**
   * The TCP connection is up (RFC 4271 §8.2.2, event 17): send our OPEN
   * and move to OpenSent. Idempotent — a peer that already sent OPEN in
   * response to ours simply stays its course.
   */
  tcpEstablished(): void {
    if (this._state !== 'Idle' && this._state !== 'Connect'
      && this._state !== 'Active') return;
    this.transition('OpenSent');   // before send (synchronous re-entrancy)
    this.emitOpen();
  }

  /** Advertise/withdraw routes to the peer (only meaningful when up). */
  sendUpdate(update: BgpUpdateMessage): void {
    if (this._state !== 'Established') return;
    this.transport.send(update);
  }

  /** Administrative shutdown (RFC 4271 §6.7 Cease). */
  close(): void {
    if (this._state === 'Idle') return;
    this.transport.send({
      type: 'bgp', message: 'notification',
      errorCode: BGP_ERROR.CEASE, errorSubcode: 0,
    });
    this.teardown();
  }

  // ── inbound ────────────────────────────────────────────────────────
  private receive(msg: BgpMessage): void {
    this.armHoldTimer();   // any message resets the Hold Timer (§4.4)
    switch (msg.message) {
      case 'open': this.handleOpen(msg); break;
      case 'keepalive': this.handleKeepalive(); break;
      case 'update': this.handleUpdate(msg); break;
      case 'notification': this.teardown(); break;
    }
  }

  private handleOpen(open: BgpOpenMessage): void {
    if (this._state === 'OpenConfirm' || this._state === 'Established') return;
    if (open.version !== BGP_VERSION) {
      this.reject(BGP_ERROR.OPEN_MESSAGE, BGP_OPEN_ERROR.UNSUPPORTED_VERSION);
      return;
    }
    if (this.cfg.expectedPeerAsn !== undefined
      && open.asn !== this.cfg.expectedPeerAsn) {
      this.reject(BGP_ERROR.OPEN_MESSAGE, BGP_OPEN_ERROR.BAD_PEER_AS);
      return;
    }
    this.peerAsn = open.asn;
    this.peerRouterId = open.bgpIdentifier;
    // Negotiate the Hold Time down to the smaller of the two (§4.2).
    this.negotiatedHoldSec = Math.min(
      this.cfg.holdTimeSec ?? BGP_DEFAULT_HOLD_SEC, open.holdTimeSec);
    // Transition first so a synchronous KEEPALIVE reply lands in OpenConfirm.
    this.transition('OpenConfirm');
    if (!this.sentOpen) this.emitOpen();   // passive side answers with OPEN
    this.transport.send(keepalive());      // ack the OPEN (§8.2.2)
    this.armKeepalive();
  }

  private handleKeepalive(): void {
    if (this._state !== 'OpenConfirm') return;
    this.transition('Established');
    this.armKeepalive();
    this.cb.onEstablished?.(this.peerAsn ?? 0, this.peerRouterId ?? '0.0.0.0');
    if (this.pendingUpdates.length > 0) {
      const buffered = this.pendingUpdates;
      this.pendingUpdates = [];
      for (const u of buffered) this.cb.onUpdate?.(u);
    }
  }

  private handleUpdate(update: BgpUpdateMessage): void {
    if (this._state === 'Established') { this.cb.onUpdate?.(update); return; }
    // Arrived before our own KEEPALIVE completed the handshake — hold it.
    if (this._state === 'OpenConfirm') this.pendingUpdates.push(update);
  }

  // ── helpers ──────────────────────────────────────────────────────--
  private emitOpen(): void {
    this.sentOpen = true;
    const open: BgpOpenMessage = {
      type: 'bgp', message: 'open', version: BGP_VERSION,
      asn: this.cfg.localAsn,
      holdTimeSec: this.cfg.holdTimeSec ?? BGP_DEFAULT_HOLD_SEC,
      bgpIdentifier: this.cfg.localRouterId,
    };
    this.transport.send(open);
  }

  private reject(errorCode: number, errorSubcode: number): void {
    this.transport.send({
      type: 'bgp', message: 'notification', errorCode, errorSubcode,
    });
    this.teardown();
  }

  private onTransportClosed(): void {
    if (this._state === 'Idle') return;
    this.teardown(false);   // peer already closed; don't double-close
  }

  private teardown(closeTransport = true): void {
    this.clearTimers();
    const wasActive = this._state !== 'Idle';
    this.transition('Idle');
    this.peerAsn = null;
    this.peerRouterId = null;
    this.sentOpen = false;
    this.pendingUpdates = [];
    if (closeTransport) this.transport.close();
    if (wasActive) this.cb.onClose?.();
  }

  private transition(next: BgpFsmState): void {
    if (this._state === next) return;
    const old = this._state;
    this._state = next;
    this.cb.onStateChange?.(old, next);
  }

  private keepaliveIntervalSec(): number {
    // KEEPALIVE at a third of the negotiated Hold Time (§4.4); fall back to
    // the default when Hold Time is disabled (0).
    return this.negotiatedHoldSec > 0
      ? Math.max(1, Math.floor(this.negotiatedHoldSec / 3))
      : BGP_DEFAULT_KEEPALIVE_SEC;
  }

  private armKeepalive(): void {
    if (this.keepaliveTimer) this.timers.clear(this.keepaliveTimer);
    if (this.negotiatedHoldSec <= 0) return;   // Hold Time 0 ⇒ no keepalives
    this.keepaliveTimer = this.timers.setInterval(() => {
      if (this._state === 'OpenConfirm' || this._state === 'Established') {
        this.transport.send(keepalive());
      }
    }, this.keepaliveIntervalSec() * 1000);
  }

  private armHoldTimer(): void {
    if (this.holdTimer) this.timers.clear(this.holdTimer);
    if (this.negotiatedHoldSec <= 0) return;
    this.holdTimer = this.timers.setTimeout(() => {
      // Hold Timer expired (§6.5): notify and drop the peering.
      this.reject(BGP_ERROR.HOLD_TIMER_EXPIRED, 0);
    }, this.negotiatedHoldSec * 1000);
  }

  private clearTimers(): void {
    if (this.holdTimer) { this.timers.clear(this.holdTimer); this.holdTimer = null; }
    if (this.keepaliveTimer) { this.timers.clear(this.keepaliveTimer); this.keepaliveTimer = null; }
  }
}
