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

import { MACAddress, IPAddress, SubnetMask, EthernetFrame, PortInfo, ConnectionType, IPv6Address } from '../core/types';
import { Logger } from '../core/Logger';
import type { Cable } from './Cable';

export type FrameHandler = (portName: string, frame: EthernetFrame) => void;

/** IPv6 address entry with prefix length */
export interface IPv6AddressEntry {
  address: IPv6Address;
  prefixLength: number;
  /** Origin of the address */
  origin: 'link-local' | 'static' | 'slaac' | 'dhcpv6';
}

export class Port {
  private readonly name: string;
  private readonly mac: MACAddress;
  private readonly type: ConnectionType;
  private cable: Cable | null = null;
  // IPv4 configuration
  private ipAddress: IPAddress | null = null;
  private subnetMask: SubnetMask | null = null;
  // IPv6 configuration (multiple addresses per interface)
  private ipv6Addresses: IPv6AddressEntry[] = [];
  private ipv6Enabled: boolean = false;
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

  // ─── IPv6 Configuration ────────────────────────────────────────

  /**
   * Enable IPv6 on this interface.
   * Automatically generates a link-local address from the MAC (EUI-64).
   */
  enableIPv6(): void {
    if (this.ipv6Enabled) return;
    this.ipv6Enabled = true;

    // Generate link-local address from MAC using EUI-64
    const linkLocal = IPv6Address.fromMAC(this.mac);
    this.ipv6Addresses.push({
      address: linkLocal.withScopeId(this.name), // Add scope ID for link-local
      prefixLength: 64,
      origin: 'link-local',
    });

    Logger.info(this.equipmentId, 'port:ipv6-enabled',
      `${this.name}: IPv6 enabled, link-local ${linkLocal}`);
  }

  /**
   * Disable IPv6 on this interface.
   * Removes all IPv6 addresses.
   */
  disableIPv6(): void {
    this.ipv6Enabled = false;
    this.ipv6Addresses = [];
    Logger.info(this.equipmentId, 'port:ipv6-disabled', `${this.name}: IPv6 disabled`);
  }

  isIPv6Enabled(): boolean {
    return this.ipv6Enabled;
  }

  /**
   * Configure a static IPv6 address on this interface.
   * Automatically enables IPv6 if not already enabled.
   */
  configureIPv6(address: IPv6Address, prefixLength: number): void {
    if (!this.ipv6Enabled) {
      this.enableIPv6();
    }

    // Check if this exact address already exists
    const exists = this.ipv6Addresses.some(e =>
      e.address.equals(address) && e.prefixLength === prefixLength
    );
    if (exists) return;

    // For link-local, use scope ID; for global, no scope
    const addrWithScope = address.isLinkLocal() ? address.withScopeId(this.name) : address;

    this.ipv6Addresses.push({
      address: addrWithScope,
      prefixLength,
      origin: 'static',
    });

    Logger.info(this.equipmentId, 'port:ipv6-config',
      `${this.name}: IPv6 address ${address}/${prefixLength} configured`);
  }

  /**
   * Add an IPv6 address via SLAAC (Stateless Address Autoconfiguration).
   */
  addSLAACAddress(prefix: IPv6Address, prefixLength: number): IPv6Address {
    if (!this.ipv6Enabled) {
      this.enableIPv6();
    }

    // Generate interface ID from MAC (EUI-64)
    const linkLocal = IPv6Address.fromMAC(this.mac);
    const linkLocalHextets = linkLocal.getHextets();
    const prefixHextets = prefix.getNetworkPrefix(prefixLength).getHextets();

    // Combine prefix with interface ID (assumes /64 prefix)
    const fullAddr = new IPv6Address([
      prefixHextets[0], prefixHextets[1], prefixHextets[2], prefixHextets[3],
      linkLocalHextets[4], linkLocalHextets[5], linkLocalHextets[6], linkLocalHextets[7],
    ]);

    // Check if already exists
    const exists = this.ipv6Addresses.some(e => e.address.equals(fullAddr));
    if (!exists) {
      this.ipv6Addresses.push({
        address: fullAddr,
        prefixLength,
        origin: 'slaac',
      });
      Logger.info(this.equipmentId, 'port:slaac',
        `${this.name}: SLAAC address ${fullAddr}/${prefixLength} configured`);
    }

    return fullAddr;
  }

  /**
   * Remove an IPv6 address from this interface.
   */
  removeIPv6Address(address: IPv6Address): boolean {
    const before = this.ipv6Addresses.length;
    this.ipv6Addresses = this.ipv6Addresses.filter(e => !e.address.equals(address));
    return this.ipv6Addresses.length < before;
  }

  /**
   * Get all IPv6 addresses configured on this interface.
   */
  getIPv6Addresses(): IPv6AddressEntry[] {
    return [...this.ipv6Addresses];
  }

  /**
   * Get the link-local IPv6 address (if IPv6 is enabled).
   */
  getLinkLocalIPv6(): IPv6Address | null {
    const entry = this.ipv6Addresses.find(e => e.origin === 'link-local');
    return entry?.address ?? null;
  }

  /**
   * Get the first global unicast IPv6 address (for outgoing packets).
   */
  getGlobalIPv6(): IPv6Address | null {
    const entry = this.ipv6Addresses.find(e =>
      e.origin !== 'link-local' && e.address.isGlobalUnicast()
    );
    return entry?.address ?? null;
  }

  /**
   * Check if this interface has a specific IPv6 address.
   */
  hasIPv6Address(address: IPv6Address): boolean {
    return this.ipv6Addresses.some(e => e.address.equals(address));
  }

  /**
   * Clear all IPv6 addresses except link-local.
   */
  clearIPv6Addresses(): void {
    this.ipv6Addresses = this.ipv6Addresses.filter(e => e.origin === 'link-local');
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
      ipv6Enabled: this.ipv6Enabled || undefined,
      ipv6Addresses: this.ipv6Addresses.length > 0 ? this.ipv6Addresses.map(e => ({
        address: e.address,
        prefixLength: e.prefixLength,
        origin: e.origin,
      })) : undefined,
      isUp: this.isUp,
    };
  }
}
