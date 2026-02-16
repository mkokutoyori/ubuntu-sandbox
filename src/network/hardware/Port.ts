/**
 * Port - Physical network port on equipment
 *
 * A port is a physical interface on a device. It has a MAC address,
 * optional IP configuration, speed/duplex settings, error counters,
 * and can be connected to a Cable.
 *
 * Realistic features:
 * - Speed: 10/100/1000/10000 Mbps (IEEE 802.3)
 * - Duplex: full/half
 * - Auto-negotiation (IEEE 802.3u)
 * - Error counters (RFC 2863 ifTable)
 * - Link state change events
 *
 * Frame flow:
 *   Equipment.send(frame, portName) → Port.sendFrame(frame) → Cable.transmit(frame, this)
 *   Cable.transmit(frame, fromPort) → otherPort.receiveFrame(frame) → Equipment.handleFrame(portName, frame)
 */

import {
  MACAddress, IPAddress, SubnetMask, EthernetFrame, PortInfo, ConnectionType, IPv6Address,
  PortDuplex, PortSpeed, PortCounters, VALID_PORT_SPEEDS, PortViolationMode,
} from '../core/types';
import { Logger } from '../core/Logger';
import type { Cable } from './Cable';

export type FrameHandler = (portName: string, frame: EthernetFrame) => void;
export type LinkChangeHandler = (state: 'up' | 'down') => void;

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

  // ─── Physical layer properties ──────────────────────────────────
  private speed: PortSpeed = 1000;
  private duplex: PortDuplex = 'full';
  private autoNegotiation: boolean = true;
  private negotiatedSpeed: PortSpeed | null = null;
  private negotiatedDuplex: PortDuplex | null = null;

  // ─── MTU ───────────────────────────────────────────────────────────
  private mtu: number = 1500;

  // ─── Port Security (Cisco-style) ──────────────────────────────────
  private portSecurityEnabled: boolean = false;
  private maxMACAddresses: number = 1;
  private secureMACAddresses: MACAddress[] = [];
  private violationMode: PortViolationMode = 'shutdown';
  private securityViolationCount: number = 0;

  // ─── Error counters (RFC 2863 ifTable) ──────────────────────────
  private counters: PortCounters = {
    framesIn: 0, framesOut: 0,
    bytesIn: 0, bytesOut: 0,
    errorsIn: 0, errorsOut: 0,
    dropsIn: 0, dropsOut: 0,
  };

  // ─── Link state observers ───────────────────────────────────────
  private linkChangeHandlers: LinkChangeHandler[] = [];

  constructor(name: string, type: ConnectionType = 'ethernet', mac?: MACAddress) {
    this.name = name;
    this.type = type;
    this.mac = mac || MACAddress.generate();
  }

  // ─── Identity ───────────────────────────────────────────────────

  getName(): string { return this.name; }
  getMAC(): MACAddress { return this.mac; }
  setMAC(mac: MACAddress): void { (this as { mac: MACAddress }).mac = mac; }
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

  enableIPv6(): void {
    if (this.ipv6Enabled) return;
    this.ipv6Enabled = true;

    const linkLocal = IPv6Address.fromMAC(this.mac);
    this.ipv6Addresses.push({
      address: linkLocal.withScopeId(this.name),
      prefixLength: 64,
      origin: 'link-local',
    });

    Logger.info(this.equipmentId, 'port:ipv6-enabled',
      `${this.name}: IPv6 enabled, link-local ${linkLocal}`);
  }

  disableIPv6(): void {
    this.ipv6Enabled = false;
    this.ipv6Addresses = [];
    Logger.info(this.equipmentId, 'port:ipv6-disabled', `${this.name}: IPv6 disabled`);
  }

  isIPv6Enabled(): boolean {
    return this.ipv6Enabled;
  }

  configureIPv6(address: IPv6Address, prefixLength: number): void {
    if (!this.ipv6Enabled) {
      this.enableIPv6();
    }

    const exists = this.ipv6Addresses.some(e =>
      e.address.equals(address) && e.prefixLength === prefixLength
    );
    if (exists) return;

    const addrWithScope = address.isLinkLocal() ? address.withScopeId(this.name) : address;

    this.ipv6Addresses.push({
      address: addrWithScope,
      prefixLength,
      origin: 'static',
    });

    Logger.info(this.equipmentId, 'port:ipv6-config',
      `${this.name}: IPv6 address ${address}/${prefixLength} configured`);
  }

  addSLAACAddress(prefix: IPv6Address, prefixLength: number): IPv6Address {
    if (!this.ipv6Enabled) {
      this.enableIPv6();
    }

    const linkLocal = IPv6Address.fromMAC(this.mac);
    const linkLocalHextets = linkLocal.getHextets();
    const prefixHextets = prefix.getNetworkPrefix(prefixLength).getHextets();

    const fullAddr = new IPv6Address([
      prefixHextets[0], prefixHextets[1], prefixHextets[2], prefixHextets[3],
      linkLocalHextets[4], linkLocalHextets[5], linkLocalHextets[6], linkLocalHextets[7],
    ]);

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

  removeIPv6Address(address: IPv6Address): boolean {
    const before = this.ipv6Addresses.length;
    this.ipv6Addresses = this.ipv6Addresses.filter(e => !e.address.equals(address));
    return this.ipv6Addresses.length < before;
  }

  getIPv6Addresses(): IPv6AddressEntry[] {
    return [...this.ipv6Addresses];
  }

  getLinkLocalIPv6(): IPv6Address | null {
    const entry = this.ipv6Addresses.find(e => e.origin === 'link-local');
    return entry?.address ?? null;
  }

  getGlobalIPv6(): IPv6Address | null {
    const entry = this.ipv6Addresses.find(e =>
      e.origin !== 'link-local' && e.address.isGlobalUnicast()
    );
    return entry?.address ?? null;
  }

  hasIPv6Address(address: IPv6Address): boolean {
    return this.ipv6Addresses.some(e => e.address.equals(address));
  }

  clearIPv6Addresses(): void {
    this.ipv6Addresses = this.ipv6Addresses.filter(e => e.origin === 'link-local');
  }

  // ─── Speed & Duplex (IEEE 802.3) ─────────────────────────────────

  getSpeed(): PortSpeed { return this.speed; }

  setSpeed(speed: number): void {
    if (!(VALID_PORT_SPEEDS as readonly number[]).includes(speed)) {
      throw new Error(
        `Invalid port speed: ${speed} Mbps. Valid speeds: ${VALID_PORT_SPEEDS.join(', ')}`
      );
    }
    this.speed = speed as PortSpeed;
    Logger.info(this.equipmentId, 'port:speed', `${this.name}: speed set to ${speed} Mbps`);
  }

  getDuplex(): PortDuplex { return this.duplex; }

  setDuplex(duplex: PortDuplex): void {
    this.duplex = duplex;
    Logger.info(this.equipmentId, 'port:duplex', `${this.name}: duplex set to ${duplex}`);
  }

  // ─── Auto-negotiation (IEEE 802.3u) ──────────────────────────────

  isAutoNegotiation(): boolean { return this.autoNegotiation; }

  setAutoNegotiation(enabled: boolean): void {
    this.autoNegotiation = enabled;
    Logger.info(this.equipmentId, 'port:autoneg',
      `${this.name}: auto-negotiation ${enabled ? 'enabled' : 'disabled'}`);
  }

  getNegotiatedSpeed(): PortSpeed {
    // When autoneg is off and no cable negotiation happened, use configured speed
    if (!this.autoNegotiation && this.negotiatedSpeed === null) {
      return this.speed;
    }
    return this.negotiatedSpeed ?? this.speed;
  }

  getNegotiatedDuplex(): PortDuplex {
    if (!this.autoNegotiation && this.negotiatedDuplex === null) {
      return this.duplex;
    }
    return this.negotiatedDuplex ?? this.duplex;
  }

  /**
   * Called by Cable during connect to perform auto-negotiation.
   * Determines the lowest common speed and best common duplex.
   */
  negotiate(peerSpeed: PortSpeed, peerDuplex: PortDuplex, cableMaxSpeed: PortSpeed): void {
    if (this.autoNegotiation) {
      this.negotiatedSpeed = Math.min(this.speed, peerSpeed, cableMaxSpeed) as PortSpeed;
      // Half duplex if either side is half
      this.negotiatedDuplex = (this.duplex === 'half' || peerDuplex === 'half') ? 'half' : 'full';
    } else {
      this.negotiatedSpeed = Math.min(this.speed, cableMaxSpeed) as PortSpeed;
      this.negotiatedDuplex = this.duplex;
    }
  }

  // ─── MTU ───────────────────────────────────────────────────────────

  getMTU(): number { return this.mtu; }

  setMTU(mtu: number): void {
    if (mtu < 68) {
      throw new Error(`Invalid MTU: ${mtu}. Minimum is 68 (IPv4 minimum).`);
    }
    if (mtu > 9216) {
      throw new Error(`Invalid MTU: ${mtu}. Maximum is 9216 (jumbo frame).`);
    }
    this.mtu = mtu;
    Logger.info(this.equipmentId, 'port:mtu', `${this.name}: MTU set to ${mtu}`);
  }

  // ─── Port Security (Cisco-style) ──────────────────────────────────

  isPortSecurityEnabled(): boolean { return this.portSecurityEnabled; }

  enablePortSecurity(): void {
    this.portSecurityEnabled = true;
    Logger.info(this.equipmentId, 'port:security', `${this.name}: port security enabled`);
  }

  disablePortSecurity(): void {
    this.portSecurityEnabled = false;
    this.secureMACAddresses = [];
    this.securityViolationCount = 0;
    Logger.info(this.equipmentId, 'port:security', `${this.name}: port security disabled`);
  }

  getMaxMACAddresses(): number { return this.maxMACAddresses; }

  setMaxMACAddresses(max: number): void {
    if (max < 1) throw new Error('Max MAC addresses must be at least 1');
    this.maxMACAddresses = max;
  }

  getSecureMACAddresses(): MACAddress[] { return [...this.secureMACAddresses]; }

  addStaticMACAddress(mac: MACAddress): void {
    if (!this.secureMACAddresses.some(m => m.equals(mac))) {
      this.secureMACAddresses.push(mac);
    }
  }

  getViolationMode(): PortViolationMode { return this.violationMode; }

  setViolationMode(mode: PortViolationMode): void {
    this.violationMode = mode;
  }

  getSecurityViolationCount(): number { return this.securityViolationCount; }

  /**
   * Check if a source MAC passes port security.
   * Returns true if frame should be accepted, false if it should be dropped.
   */
  private checkPortSecurity(srcMAC: MACAddress): boolean {
    if (!this.portSecurityEnabled) return true;

    // Check if MAC is already learned
    if (this.secureMACAddresses.some(m => m.equals(srcMAC))) {
      return true;
    }

    // Room to learn a new MAC?
    if (this.secureMACAddresses.length < this.maxMACAddresses) {
      this.secureMACAddresses.push(srcMAC);
      Logger.debug(this.equipmentId, 'port:security-learn',
        `${this.name}: learned MAC ${srcMAC}`);
      return true;
    }

    // Violation!
    this.securityViolationCount++;
    Logger.warn(this.equipmentId, 'port:security-violation',
      `${this.name}: security violation from ${srcMAC} (mode: ${this.violationMode})`);

    switch (this.violationMode) {
      case 'shutdown':
        this.isUp = false;
        this.notifyLinkChange('down');
        Logger.warn(this.equipmentId, 'port:security-shutdown',
          `${this.name}: port shut down due to security violation`);
        break;
      case 'restrict':
        // Drop + increment counter (counter already incremented above)
        break;
      case 'protect':
        // Just silently drop
        break;
    }

    return false;
  }

  // ─── Error Counters (RFC 2863) ───────────────────────────────────

  getCounters(): Readonly<PortCounters> {
    return { ...this.counters };
  }

  resetCounters(): void {
    this.counters = {
      framesIn: 0, framesOut: 0,
      bytesIn: 0, bytesOut: 0,
      errorsIn: 0, errorsOut: 0,
      dropsIn: 0, dropsOut: 0,
    };
  }

  incrementErrorsIn(): void { this.counters.errorsIn++; }
  incrementErrorsOut(): void { this.counters.errorsOut++; }

  // ─── Link State ────────────────────────────────────────────────

  getIsUp(): boolean { return this.isUp; }

  setUp(up: boolean): void {
    if (this.isUp === up) return; // No change — don't notify
    this.isUp = up;
    Logger.info(this.equipmentId, 'port:state', `${this.name}: ${up ? 'up' : 'down'}`);
    this.notifyLinkChange(up ? 'up' : 'down');
  }

  onLinkChange(handler: LinkChangeHandler): void {
    this.linkChangeHandlers.push(handler);
  }

  private notifyLinkChange(state: 'up' | 'down'): void {
    for (const handler of this.linkChangeHandlers) {
      handler(state);
    }
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
    this.negotiatedSpeed = null;
    this.negotiatedDuplex = null;
    Logger.debug(this.equipmentId, 'port:cable-disconnect', `${this.name}: cable disconnected`);
    this.notifyLinkChange('down');
  }

  // ─── Frame Handler (set by owning Equipment) ───────────────────

  onFrame(handler: FrameHandler): void {
    this.frameHandler = handler;
  }

  // ─── Frame Transmission ────────────────────────────────────────

  sendFrame(frame: EthernetFrame): boolean {
    if (!this.isUp) {
      this.counters.dropsOut++;
      Logger.warn(this.equipmentId, 'port:send-blocked', `${this.name}: port is down, frame dropped`);
      return false;
    }

    if (!this.cable) {
      this.counters.dropsOut++;
      Logger.warn(this.equipmentId, 'port:send-blocked', `${this.name}: no cable connected, frame dropped`);
      return false;
    }

    this.counters.framesOut++;
    Logger.debug(this.equipmentId, 'port:send',
      `${this.name}: sending frame ${frame.srcMAC} → ${frame.dstMAC}`,
      { etherType: frame.etherType });

    return this.cable.transmit(frame, this);
  }

  receiveFrame(frame: EthernetFrame): void {
    if (!this.isUp) {
      this.counters.dropsIn++;
      Logger.warn(this.equipmentId, 'port:recv-blocked', `${this.name}: port is down, frame dropped`);
      return;
    }

    // Port security check
    if (!this.checkPortSecurity(frame.srcMAC)) {
      this.counters.dropsIn++;
      return;
    }

    this.counters.framesIn++;
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
      speed: this.speed,
      duplex: this.duplex,
      mtu: this.mtu,
      counters: { ...this.counters },
    };
  }
}
