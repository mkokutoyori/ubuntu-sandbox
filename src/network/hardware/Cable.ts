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
  stats: CableStats;
}

export class Cable {
  private readonly id: string;
  private portA: Port | null = null;
  private portB: Port | null = null;
  private isUp: boolean = true;
  private readonly cableType: CableType;
  private readonly lengthMeters: number;
  private readonly spec: CableSpec;
  private packetLossRate: number = 0;
  private stats: CableStats = { framesTransmitted: 0, framesLost: 0 };

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

  // ─── Port Connections ──────────────────────────────────────────

  getPortA(): Port | null { return this.portA; }
  getPortB(): Port | null { return this.portB; }

  /**
   * Connect two ports via this cable.
   * Automatically sets the cable reference on both ports and triggers auto-negotiation.
   */
  connect(portA: Port, portB: Port): void {
    this.portA = portA;
    this.portB = portB;
    portA.connectCable(this);
    portB.connectCable(this);

    // Trigger auto-negotiation between ports through this cable
    this.negotiateLink();

    Logger.info(this.id, 'cable:connect',
      `Cable connected: ${portA.getEquipmentId()}.${portA.getName()} ↔ ${portB.getEquipmentId()}.${portB.getName()}`);
  }

  /**
   * Disconnect the cable from both ports.
   * Notifies ports of link-down via disconnectCable().
   */
  disconnect(): void {
    if (this.portA) this.portA.disconnectCable();
    if (this.portB) this.portB.disconnectCable();
    Logger.info(this.id, 'cable:disconnect', `Cable ${this.id} disconnected`);
    this.portA = null;
    this.portB = null;
  }

  // ─── Auto-negotiation ─────────────────────────────────────────

  /**
   * Perform auto-negotiation between both ports.
   * Each port negotiates speed/duplex based on peer capabilities and cable max speed.
   */
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

  getStats(): Readonly<CableStats> { return { ...this.stats }; }

  resetStats(): void {
    this.stats = { framesTransmitted: 0, framesLost: 0 };
  }

  // ─── Link State ────────────────────────────────────────────────

  isConnected(): boolean { return this.portA !== null && this.portB !== null; }

  getIsUp(): boolean { return this.isUp; }

  setUp(up: boolean): void {
    this.isUp = up;
    Logger.info(this.id, 'cable:state', `Cable ${this.id}: ${up ? 'up' : 'down'}`);
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
      Logger.warn(this.id, 'cable:blocked', `Cable ${this.id} is down, frame dropped`);
      return false;
    }

    if (!this.portA || !this.portB) {
      Logger.warn(this.id, 'cable:blocked', `Cable ${this.id} not fully connected, frame dropped`);
      return false;
    }

    // Simulate packet loss
    if (this.packetLossRate > 0 && Math.random() < this.packetLossRate) {
      this.stats.framesLost++;
      Logger.debug(this.id, 'cable:loss', `Cable ${this.id}: frame lost (simulated)`);
      return false;
    }

    const targetPort = (fromPort === this.portA) ? this.portB : this.portA;

    Logger.debug(this.id, 'cable:transmit',
      `${fromPort.getEquipmentId()}.${fromPort.getName()} → ${targetPort.getEquipmentId()}.${targetPort.getName()}`,
      { srcMAC: frame.srcMAC.toString(), dstMAC: frame.dstMAC.toString() });

    targetPort.receiveFrame(frame);
    this.stats.framesTransmitted++;
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
      stats: { ...this.stats },
    };
  }
}
