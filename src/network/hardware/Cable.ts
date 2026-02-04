/**
 * Cable - Physical link between two Ports
 *
 * A cable connects exactly two ports. When a frame is sent from one port,
 * the cable delivers it to the other port.
 *
 * The cable checks:
 * - Both ends are connected
 * - The cable is "up" (not administratively disabled)
 * - Both ports exist
 *
 * Frame flow:
 *   Port A → Cable.transmit(frame, portA) → Port B.receiveFrame(frame)
 */

import { EthernetFrame } from '../core/types';
import { Logger } from '../core/Logger';
import { Port } from './Port';

export class Cable {
  private readonly id: string;
  private portA: Port | null = null;
  private portB: Port | null = null;
  private isUp: boolean = true;

  constructor(id: string) {
    this.id = id;
  }

  getId(): string { return this.id; }

  // ─── Port Connections ──────────────────────────────────────────

  getPortA(): Port | null { return this.portA; }
  getPortB(): Port | null { return this.portB; }

  /**
   * Connect two ports via this cable.
   * Automatically sets the cable reference on both ports.
   */
  connect(portA: Port, portB: Port): void {
    this.portA = portA;
    this.portB = portB;
    portA.connectCable(this);
    portB.connectCable(this);
    Logger.info(this.id, 'cable:connect',
      `Cable connected: ${portA.getEquipmentId()}.${portA.getName()} ↔ ${portB.getEquipmentId()}.${portB.getName()}`);
  }

  /**
   * Disconnect the cable from both ports
   */
  disconnect(): void {
    if (this.portA) this.portA.disconnectCable();
    if (this.portB) this.portB.disconnectCable();
    Logger.info(this.id, 'cable:disconnect', `Cable ${this.id} disconnected`);
    this.portA = null;
    this.portB = null;
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
   * Transmit a frame from one port to the other
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

    // Deliver to the OTHER port
    const targetPort = (fromPort === this.portA) ? this.portB : this.portA;

    Logger.debug(this.id, 'cable:transmit',
      `${fromPort.getEquipmentId()}.${fromPort.getName()} → ${targetPort.getEquipmentId()}.${targetPort.getName()}`,
      { srcMAC: frame.srcMAC.toString(), dstMAC: frame.dstMAC.toString() });

    targetPort.receiveFrame(frame);
    return true;
  }
}
