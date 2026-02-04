/**
 * Port - Physical network port on equipment
 *
 * A port is a physical interface on a device. It has a MAC address,
 * optional IP configuration, and can be connected to a Cable.
 *
 * Frame flow:
 *   Equipment.send(frame, portName) → Port.sendFrame(frame) → Cable.transmit(frame, this)
 *   Cable.transmit(frame, fromPort) → otherPort.receiveFrame(frame) → Equipment.handleFrame(portName, frame)
 */

import { MACAddress, IPAddress, SubnetMask, EthernetFrame, PortInfo, ConnectionType } from '../core/types';
import { Logger } from '../core/Logger';
import type { Cable } from './Cable';

export type FrameHandler = (portName: string, frame: EthernetFrame) => void;

export class Port {
  private readonly name: string;
  private readonly mac: MACAddress;
  private readonly type: ConnectionType;
  private cable: Cable | null = null;
  private ipAddress: IPAddress | null = null;
  private subnetMask: SubnetMask | null = null;
  private isUp: boolean = true;
  private equipmentId: string = '';
  private frameHandler: FrameHandler | null = null;

  constructor(name: string, type: ConnectionType = 'ethernet', mac?: MACAddress) {
    this.name = name;
    this.type = type;
    this.mac = mac || MACAddress.generate();
  }

  // ─── Identity ───────────────────────────────────────────────────

  getName(): string { return this.name; }
  getMAC(): MACAddress { return this.mac; }
  getType(): ConnectionType { return this.type; }
  getEquipmentId(): string { return this.equipmentId; }

  setEquipmentId(id: string): void {
    this.equipmentId = id;
  }

  // ─── IP Configuration ──────────────────────────────────────────

  getIPAddress(): IPAddress | null { return this.ipAddress; }
  getSubnetMask(): SubnetMask | null { return this.subnetMask; }

  configureIP(ip: IPAddress, mask: SubnetMask): void {
    this.ipAddress = ip;
    this.subnetMask = mask;
    Logger.info(this.equipmentId, 'port:ip-config', `${this.name}: IP set to ${ip}/${mask.toCIDR()}`);
  }

  clearIP(): void {
    this.ipAddress = null;
    this.subnetMask = null;
  }

  // ─── Link State ────────────────────────────────────────────────

  getIsUp(): boolean { return this.isUp; }

  setUp(up: boolean): void {
    this.isUp = up;
    Logger.info(this.equipmentId, 'port:state', `${this.name}: ${up ? 'up' : 'down'}`);
  }

  // ─── Cable Connection ──────────────────────────────────────────

  getCable(): Cable | null { return this.cable; }

  isConnected(): boolean {
    return this.cable !== null;
  }

  connectCable(cable: Cable): void {
    this.cable = cable;
    Logger.debug(this.equipmentId, 'port:cable-connect', `${this.name}: cable connected`);
  }

  disconnectCable(): void {
    this.cable = null;
    Logger.debug(this.equipmentId, 'port:cable-disconnect', `${this.name}: cable disconnected`);
  }

  // ─── Frame Handler (set by owning Equipment) ───────────────────

  onFrame(handler: FrameHandler): void {
    this.frameHandler = handler;
  }

  // ─── Frame Transmission ────────────────────────────────────────

  /**
   * Send a frame out through this port via the cable
   */
  sendFrame(frame: EthernetFrame): boolean {
    if (!this.isUp) {
      Logger.warn(this.equipmentId, 'port:send-blocked', `${this.name}: port is down, frame dropped`);
      return false;
    }

    if (!this.cable) {
      Logger.warn(this.equipmentId, 'port:send-blocked', `${this.name}: no cable connected, frame dropped`);
      return false;
    }

    Logger.debug(this.equipmentId, 'port:send',
      `${this.name}: sending frame ${frame.srcMAC} → ${frame.dstMAC}`,
      { etherType: frame.etherType });

    return this.cable.transmit(frame, this);
  }

  /**
   * Receive a frame from the cable (called by Cable)
   */
  receiveFrame(frame: EthernetFrame): void {
    if (!this.isUp) {
      Logger.warn(this.equipmentId, 'port:recv-blocked', `${this.name}: port is down, frame dropped`);
      return;
    }

    Logger.debug(this.equipmentId, 'port:recv',
      `${this.name}: received frame ${frame.srcMAC} → ${frame.dstMAC}`,
      { etherType: frame.etherType });

    if (this.frameHandler) {
      this.frameHandler(this.name, frame);
    }
  }

  // ─── Info ──────────────────────────────────────────────────────

  getInfo(): PortInfo {
    return {
      name: this.name,
      type: this.type,
      mac: this.mac,
      ipAddress: this.ipAddress ?? undefined,
      subnetMask: this.subnetMask ?? undefined,
      isUp: this.isUp,
    };
  }
}
