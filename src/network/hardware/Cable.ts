/**
 * Cable - Physical link between two Ports
 *
 * A cable connects exactly two ports. When a frame is sent from one port,
 * the cable delivers it to the other port.
 *
 * Realistic features:
 * - Cable type (Cat5e, Cat6, Cat6a, fiber, crossover, serial)
 * - Max speed per cable type (IEEE 802.3)
 * - Cable length and propagation delay (~5ns/m copper, ~3.3ns/m fiber)
 * - Max length per cable type (100m for copper, 80km for SMF)
 * - Auto-negotiation trigger on connect
 * - Duplex mismatch detection
 *
 * Frame flow:
 *   Port A → Cable.transmit(frame, portA) → Port B.receiveFrame(frame)
 */

import { EthernetFrame } from '../core/types';
import { Logger } from '../core/Logger';
import { Port } from './Port';
import { getDefaultEventBus, type IEventBus } from '@/events/EventBus';

export type CableType = 'cat5e' | 'cat6' | 'cat6a' | 'fiber-single' | 'fiber-multi' | 'crossover' | 'serial';

/** Cable specifications per type */
interface CableSpec {
  maxSpeed: number;      // Mbps
  maxLength: number;     // meters
  propagationNsPerM: number; // nanoseconds per meter
}

const CABLE_SPECS: Record<CableType, CableSpec> = {
  'cat5e':        { maxSpeed: 1000,   maxLength: 100,   propagationNsPerM: 5.0 },
  'cat6':         { maxSpeed: 10000,  maxLength: 100,   propagationNsPerM: 5.0 },
  'cat6a':        { maxSpeed: 10000,  maxLength: 100,   propagationNsPerM: 5.0 },
  'fiber-single': { maxSpeed: 100000, maxLength: 80000, propagationNsPerM: 3.3 },
  'fiber-multi':  { maxSpeed: 10000,  maxLength: 2000,  propagationNsPerM: 3.3 },
  'crossover':    { maxSpeed: 1000,   maxLength: 100,   propagationNsPerM: 5.0 },
  'serial':       { maxSpeed: 10,     maxLength: 15,    propagationNsPerM: 5.0 },
};

export interface CableOptions {
  cableType?: CableType;
  lengthMeters?: number;
}

export interface CableStats {
  framesTransmitted: number;
  framesLost: number;
  framesCorrupted: number;
}

export interface CableInfo {
  id: string;
  cableType: CableType;
  lengthMeters: number;
  maxSpeed: number;
  propagationDelayMs: number;
  isUp: boolean;
  isConnected: boolean;
  packetLossRate: number;
  corruptionRate: number;
  stats: CableStats;
}

export class Cable {
  /**
   * Loop guard for the synchronous delivery chain. Delivery recurses
   * through the whole topology in one call stack (transmit →
   * receiveFrame → handleFrame → sendFrame → transmit …), so a physical
   * L2 loop on switches with no STP agent used to recurse until
   * `RangeError: Maximum call stack size exceeded`. Two static budgets
   * bound one top-level send (a "cascade"):
   *  - depth caps nested deliveries, which is what actually protects
   *    the stack;
   *  - cascade frames caps total deliveries, which is what stops a
   *    mesh loop whose egress paths clone frames (depth alone would
   *    explore an exponential number of paths).
   * Both are far above anything a legitimate canvas topology produces;
   * excess frames are dropped as `l2-loop-suppressed`.
   */
  private static deliveryDepth = 0;
  private static cascadeFrames = 0;
  static readonly MAX_SYNC_DELIVERY_DEPTH = 256;
  static readonly MAX_CASCADE_FRAMES = 20_000;

  private readonly id: string;
  private portA: Port | null = null;
  private portB: Port | null = null;
  private isUp: boolean = true;
  private readonly cableType: CableType;
  private readonly lengthMeters: number;
  private readonly spec: CableSpec;
  private packetLossRate: number = 0;
  private corruptionRate: number = 0;
  /** `tc qdisc ... netem delay <ms>` — added to `getPropagationDelay()`'s
   *  physical-distance figure. Like that figure, this is exposed as
   *  metadata for RTT reporting (ping) rather than an actual async delay
   *  injected into frame delivery — `Cable.transmit()` stays synchronous
   *  on the hot data-plane path; only the one consumer that reports a
   *  wall-clock-shaped number to the user (ping's RTT) adds it in. */
  private artificialDelayMs: number = 0;
  private stats: CableStats = { framesTransmitted: 0, framesLost: 0, framesCorrupted: 0 };

  /** Reactive bus override (Phase 3 — defaults to singleton). */
  private busOverride: IEventBus | null = null;

  /** Random source — injectable so tests can seed deterministic loss. */
  private rng: () => number = Math.random;

  setEventBus(bus: IEventBus | null): void { this.busOverride = bus; }
  setRng(rng: () => number): void { this.rng = rng; }
  private getBus(): IEventBus { return this.busOverride ?? getDefaultEventBus(); }

  private portRefOf(port: Port) {
    return { deviceId: port.getEquipmentId(), portName: port.getName() };
  }

  constructor(id: string, options?: CableOptions) {
    this.id = id;
    this.cableType = options?.cableType ?? 'cat5e';
    this.spec = CABLE_SPECS[this.cableType];

    const length = options?.lengthMeters ?? 1;
    if (length <= 0) {
      throw new Error(`Invalid cable length: ${length}m. Must be > 0.`);
    }
    if (length > this.spec.maxLength) {
      throw new Error(
        `Cable length ${length}m exceeds max for ${this.cableType} (${this.spec.maxLength}m).`
      );
    }
    this.lengthMeters = length;
  }

  getId(): string { return this.id; }

  // ─── Cable Properties ───────────────────────────────────────────

  getCableType(): CableType { return this.cableType; }
  getLength(): number { return this.lengthMeters; }
  getMaxSpeed(): number { return this.spec.maxSpeed; }
  getMaxLength(): number { return this.spec.maxLength; }

  /** Propagation delay in milliseconds */
  getPropagationDelay(): number {
    return (this.lengthMeters * this.spec.propagationNsPerM) / 1_000_000;
  }

  /** `tc qdisc ... netem delay` — see the field's own doc comment. */
  getArtificialDelayMs(): number { return this.artificialDelayMs; }
  setArtificialDelayMs(ms: number): void { this.artificialDelayMs = Math.max(0, ms); }

  // ─── Port Connections ──────────────────────────────────────────

  getPortA(): Port | null { return this.portA; }
  getPortB(): Port | null { return this.portB; }

  /**
   * Connect two ports via this cable.
   * Automatically sets the cable reference on both ports and triggers auto-negotiation.
   */
  connect(portA: Port, portB: Port): boolean {
    if (!portA.acceptsCable() || !portB.acceptsCable()) return false;
    this.portA = portA;
    this.portB = portB;
    // Set cable references on BOTH ports before triggering any link-change
    // notifications. This ensures that when _ospfAutoConverge fires for portA,
    // portB's cable is already set so reverse packet delivery works correctly.
    portA._setCableNoNotify(this);
    portB._setCableNoNotify(this);
    portA._notifyLinkUp();
    portB._notifyLinkUp();

    // Trigger auto-negotiation between ports through this cable
    this.negotiateLink();

    Logger.info(this.id, 'cable:connect',
      `Cable connected: ${portA.getEquipmentId()}.${portA.getName()} ↔ ${portB.getEquipmentId()}.${portB.getName()}`);

    const bus = this.getBus();
    bus.publish({
      topic: 'cable.connected',
      payload: {
        cableId: this.id,
        portA: this.portRefOf(portA),
        portB: this.portRefOf(portB),
        cableType: this.cableType,
      },
    });
    bus.publish({
      topic: 'cable.negotiated',
      payload: {
        cableId: this.id,
        speed: portA.getNegotiatedSpeed(),
        duplex: portA.getNegotiatedDuplex(),
      },
    });
    if (this.hasDuplexMismatch()) {
      bus.publish({
        topic: 'cable.duplex-mismatch',
        payload: {
          cableId: this.id,
          portA: this.portRefOf(portA),
          portB: this.portRefOf(portB),
        },
      });
    }
    return true;
  }

  /**
   * Disconnect the cable from both ports.
   * Notifies ports of link-down via disconnectCable().
   */
  disconnect(): void {
    const a = this.portA;
    const b = this.portB;
    this.portA = null;
    this.portB = null;
    if (a) a.disconnectCable();
    if (b) b.disconnectCable();
    Logger.info(this.id, 'cable:disconnect', `Cable ${this.id} disconnected`);
    this.getBus().publish({
      topic: 'cable.disconnected',
      payload: { cableId: this.id },
    });
  }

  // ─── Auto-negotiation ─────────────────────────────────────────

  /**
   * Perform auto-negotiation between both ports.
   * Each port negotiates speed/duplex based on peer capabilities and cable max speed.
   */
  /**
   * Re-run negotiation because one end's speed, duplex or negotiation
   * mode changed. On real hardware that bounces the link; here it is
   * what makes a forced `speed`/`duplex` reach the negotiated values
   * the views read — without it they kept reporting what the link had
   * agreed on before the operator forced anything.
   */
  renegotiate(): void { this.negotiateLink(); }

  private negotiateLink(): void {
    if (!this.portA || !this.portB) return;

    const cableMaxSpeed = this.spec.maxSpeed;

    this.portA.negotiate(
      this.portB.getSpeed(),
      this.portB.getDuplex(),
      cableMaxSpeed as typeof this.portA extends Port ? Parameters<Port['negotiate']>[2] : never,
    );
    this.portB.negotiate(
      this.portA.getSpeed(),
      this.portA.getDuplex(),
      cableMaxSpeed as typeof this.portB extends Port ? Parameters<Port['negotiate']>[2] : never,
    );

    if (this.hasDuplexMismatch()) {
      Logger.warn(this.id, 'cable:duplex-mismatch',
        `Duplex mismatch detected on cable ${this.id}: ` +
        `${this.portA.getName()}=${this.portA.getNegotiatedDuplex()} ↔ ` +
        `${this.portB.getName()}=${this.portB.getNegotiatedDuplex()}`);
    }
  }

  /**
   * Detect duplex mismatch between the two ports.
   * A mismatch occurs when both ports have auto-negotiation OFF and different duplex settings.
   * When auto-negotiation is ON, it resolves duplex to lowest common, so no mismatch.
   */
  hasDuplexMismatch(): boolean {
    if (!this.portA || !this.portB) return false;
    return this.portA.getNegotiatedDuplex() !== this.portB.getNegotiatedDuplex();
  }

  // ─── Error Simulation ──────────────────────────────────────────

  getPacketLossRate(): number { return this.packetLossRate; }

  setPacketLossRate(rate: number): void {
    if (rate < 0 || rate > 1) {
      throw new Error(`Invalid packet loss rate: ${rate}. Must be between 0 and 1.`);
    }
    this.packetLossRate = rate;
    Logger.info(this.id, 'cable:loss-rate', `Cable ${this.id}: packet loss rate set to ${(rate * 100).toFixed(1)}%`);
  }

  getCorruptionRate(): number { return this.corruptionRate; }

  /**
   * Simulated FCS/CRC failure rate — no byte-level frame encoding exists to
   * corrupt, so this models the receiver-side effect directly: the frame
   * silently fails to arrive (like a real NIC discarding a bad-FCS frame
   * before it ever reaches the driver) and the receiving port's `errorsIn`
   * counter increments, distinct from a generic simulated loss.
   */
  setCorruptionRate(rate: number): void {
    if (rate < 0 || rate > 1) {
      throw new Error(`Invalid corruption rate: ${rate}. Must be between 0 and 1.`);
    }
    this.corruptionRate = rate;
    Logger.info(this.id, 'cable:corruption-rate', `Cable ${this.id}: corruption rate set to ${(rate * 100).toFixed(1)}%`);
  }

  getStats(): Readonly<CableStats> { return { ...this.stats }; }

  resetStats(): void {
    this.stats = { framesTransmitted: 0, framesLost: 0, framesCorrupted: 0 };
  }

  // ─── Link State ────────────────────────────────────────────────

  isConnected(): boolean { return this.portA !== null && this.portB !== null; }

  getIsUp(): boolean { return this.isUp; }

  setUp(up: boolean): void {
    if (this.isUp === up) return;
    this.isUp = up;
    Logger.info(this.id, 'cable:state', `Cable ${this.id}: ${up ? 'up' : 'down'}`);
    const state = up ? 'up' : 'down';
    this.portA?._notifyCarrierChange(state);
    this.portB?._notifyCarrierChange(state);
  }

  // ─── Frame Transmission ────────────────────────────────────────

  /**
   * Transmit a frame from one port to the other.
   * Frame is delivered synchronously — propagation delay is exposed as metadata
   * for RTT calculation but doesn't introduce actual async delay (preserves
   * simulation determinism).
   */
  transmit(frame: EthernetFrame, fromPort: Port): boolean {
    if (!this.isUp) {
      this.getBus().publish({
        topic: 'cable.frame.lost',
        payload: { cableId: this.id, reason: 'cable-down' },
      });
      return false;
    }

    if (!this.portA || !this.portB) {
      this.getBus().publish({
        topic: 'cable.frame.lost',
        payload: { cableId: this.id, reason: 'no-peer' },
      });
      return false;
    }

    // Simulate packet loss
    if (this.packetLossRate > 0 && this.rng() < this.packetLossRate) {
      this.stats.framesLost++;
      Logger.debug(this.id, 'cable:loss', `Cable ${this.id}: frame lost (simulated)`);
      this.getBus().publish({
        topic: 'cable.frame.lost',
        payload: { cableId: this.id, reason: 'simulated-loss' },
      });
      return false;
    }

    const targetPort = (fromPort === this.portA) ? this.portB : this.portA;

    // Simulate FCS/CRC failure — the frame never reaches the receiver's
    // handleFrame(), same as a real NIC discarding a bad-FCS frame before
    // the driver ever sees it, but tracked distinctly from generic loss.
    if (this.corruptionRate > 0 && this.rng() < this.corruptionRate) {
      this.stats.framesCorrupted++;
      targetPort.incrementCrcErrorsIn();
      Logger.debug(this.id, 'cable:corrupted', `Cable ${this.id}: frame corrupted (simulated FCS failure)`);
      this.getBus().publish({
        topic: 'cable.frame.lost',
        payload: { cableId: this.id, reason: 'fcs-corrupted' },
      });
      return false;
    }

    // A send arriving at depth 0 opens a fresh cascade.
    if (Cable.deliveryDepth === 0) Cable.cascadeFrames = 0;
    if (Cable.deliveryDepth >= Cable.MAX_SYNC_DELIVERY_DEPTH
        || Cable.cascadeFrames >= Cable.MAX_CASCADE_FRAMES) {
      this.stats.framesLost++;
      Logger.warn(this.id, 'cable:loop-guard',
        `Cable ${this.id}: frame suppressed (L2 loop suspected — ` +
        `${Cable.deliveryDepth >= Cable.MAX_SYNC_DELIVERY_DEPTH ? 'delivery depth' : 'cascade frame budget'} exhausted). ` +
        `Check the topology for a switching loop without STP.`);
      this.getBus().publish({
        topic: 'cable.frame.lost',
        payload: { cableId: this.id, reason: 'l2-loop-suppressed' },
      });
      return false;
    }

    Logger.debug(this.id, 'cable:transmit',
      `${fromPort.getEquipmentId()}.${fromPort.getName()} → ${targetPort.getEquipmentId()}.${targetPort.getName()}`,
      { srcMAC: frame.srcMAC.toString(), dstMAC: frame.dstMAC.toString() });

    const bus = this.getBus();
    const propagationMs = this.getPropagationDelay();
    const fromRef = this.portRefOf(fromPort);
    const toRef = this.portRefOf(targetPort);

    bus.publish({
      topic: 'cable.frame.dispatched',
      payload: {
        cableId: this.id,
        from: fromRef,
        to: toRef,
        frame,
        propagationMs,
      },
    });

    // Phase 3: delivery stays synchronous to preserve current call-stack
    // semantics for tests. Phase 6 will migrate to scheduler-driven async
    // delivery (`scheduler.setTimeout(deliver, propagationMs)`).
    Cable.deliveryDepth++;
    Cable.cascadeFrames++;
    try {
      targetPort.receiveFrame(frame);
    } finally {
      Cable.deliveryDepth--;
    }
    this.stats.framesTransmitted++;

    bus.publish({
      topic: 'cable.frame.delivered',
      payload: { cableId: this.id, from: fromRef, to: toRef, frame },
    });
    return true;
  }

  // ─── Info ──────────────────────────────────────────────────────

  getInfo(): CableInfo {
    return {
      id: this.id,
      cableType: this.cableType,
      lengthMeters: this.lengthMeters,
      maxSpeed: this.spec.maxSpeed,
      propagationDelayMs: this.getPropagationDelay(),
      isUp: this.isUp,
      isConnected: this.isConnected(),
      packetLossRate: this.packetLossRate,
      corruptionRate: this.corruptionRate,
      stats: { ...this.stats },
    };
  }
}
