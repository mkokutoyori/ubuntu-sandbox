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
  ethernetFrameBytes,
} from '../core/types';
import { Logger } from '../core/Logger';
import { PortSecurity } from './PortSecurity';
import type { Cable } from './Cable';
import { getDefaultEventBus, type IEventBus } from '@/events/EventBus';

export type FrameHandler = (portName: string, frame: EthernetFrame) => void;
export type LinkChangeHandler = (state: 'up' | 'down') => void;

/**
 * Cisco IOS default interface delay (microseconds) for a link speed —
 * the "DLY" figure of `show interfaces`, consumed by EIGRP's composite
 * metric. Overridable per port via the `delay` interface command.
 */
export function defaultInterfaceDelayUs(speedMbps: number): number {
  if (speedMbps >= 1000) return 10;     // Gigabit and faster
  if (speedMbps >= 100) return 100;     // FastEthernet
  if (speedMbps >= 10) return 1000;     // Ethernet
  return 20_000;                        // serial-grade links
}

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
  private secondaryIPs: Array<{ ip: IPAddress; mask: SubnetMask }> = [];
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
  private bandwidthKbps: number = 0;
  /** Explicit `delay` override; null = IOS default for the link speed. */
  private delayUs: number | null = null;
  private arpTimeoutSec: number = 4 * 60 * 60;
  private keepaliveSec: number = 10;
  private keepaliveEnabled: boolean = true;
  private directedBroadcast: boolean = false;
  private negotiationAuto: boolean = true;
  private inputServicePolicy: string | null = null;
  private outputServicePolicy: string | null = null;
  private description: string = '';
  private proxyArpEnabled: boolean = true;
  private proxyArpExplicit: boolean = false;

  getBandwidthKbps(): number { return this.bandwidthKbps; }
  setBandwidthKbps(v: number): void { this.bandwidthKbps = v; }
  getDelayUs(): number {
    return this.delayUs ?? defaultInterfaceDelayUs(this.getNegotiatedSpeed());
  }
  setDelayUs(v: number): void { this.delayUs = v; }
  /** Effective bandwidth (kbps): explicit `bandwidth` or the link speed. */
  getEffectiveBandwidthKbps(): number {
    return this.bandwidthKbps > 0
      ? this.bandwidthKbps
      : this.getNegotiatedSpeed() * 1000;
  }
  getArpTimeoutSec(): number { return this.arpTimeoutSec; }
  setArpTimeoutSec(v: number): void { this.arpTimeoutSec = v; }
  getKeepaliveSec(): number { return this.keepaliveSec; }
  setKeepalive(seconds: number | null): void {
    if (seconds === null) { this.keepaliveEnabled = false; return; }
    this.keepaliveSec = seconds;
    this.keepaliveEnabled = true;
  }
  isKeepaliveEnabled(): boolean { return this.keepaliveEnabled; }
  isDirectedBroadcastEnabled(): boolean { return this.directedBroadcast; }
  setDirectedBroadcast(on: boolean): void { this.directedBroadcast = on; }
  isNegotiationAuto(): boolean { return this.negotiationAuto; }
  setNegotiationAuto(on: boolean): void { this.negotiationAuto = on; }
  getInputServicePolicy(): string | null { return this.inputServicePolicy; }
  setInputServicePolicy(name: string | null): void { this.inputServicePolicy = name; }
  getOutputServicePolicy(): string | null { return this.outputServicePolicy; }
  setOutputServicePolicy(name: string | null): void { this.outputServicePolicy = name; }
  getDescriptionText(): string { return this.description; }
  setDescriptionText(s: string): void { this.description = s; }
  isProxyArpEnabled(): boolean { return this.proxyArpEnabled; }
  setProxyArp(on: boolean, explicit = false): void {
    this.proxyArpEnabled = on;
    if (explicit) this.proxyArpExplicit = on;
  }
  isProxyArpExplicit(): boolean { return this.proxyArpExplicit; }

  // ─── Port Security (delegated to PortSecurity class) ──────────────
  private _security: PortSecurity | null = null;
  private get security(): PortSecurity {
    if (!this._security) {
      this._security = new PortSecurity(this.name, this.equipmentId);
    }
    return this._security;
  }

  // ─── Error counters (RFC 2863 ifTable) ──────────────────────────
  private counters: PortCounters = {
    framesIn: 0, framesOut: 0,
    bytesIn: 0, bytesOut: 0,
    errorsIn: 0, errorsOut: 0,
    dropsIn: 0, dropsOut: 0,
  };

  // ─── Link state observers ───────────────────────────────────────
  private linkChangeHandlers: LinkChangeHandler[] = [];

  // ─── Reactive bus (Phase 3) ─────────────────────────────────────
  /**
   * Optional bus override — defaults to the singleton bus. Events are
   * published in parallel to the legacy callbacks (`onFrame`,
   * `onLinkChange`) for the duration of the migration; phase 8 removes
   * those callbacks.
   */
  private busOverride: IEventBus | null = null;

  constructor(name: string, type: ConnectionType = 'ethernet', mac?: MACAddress) {
    this.name = name;
    this.type = type;
    this.mac = mac || MACAddress.generate();
  }

  /** Test-only / multi-topology bus injection. */
  setEventBus(bus: IEventBus | null): void {
    this.busOverride = bus;
  }

  private getBus(): IEventBus {
    return this.busOverride ?? getDefaultEventBus();
  }

  private portRef() {
    return { deviceId: this.equipmentId, portName: this.name };
  }

  // ─── Identity ───────────────────────────────────────────────────

  getName(): string { return this.name; }
  getMAC(): MACAddress { return this.mac; }
  setMAC(mac: MACAddress): void { (this as unknown as { mac: MACAddress }).mac = mac; }
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
    this.getBus().publish({
      topic: 'port.config.ip-changed',
      payload: { ...this.portRef(), ip, mask },
    });
  }

  clearIP(): void {
    if (this.ipAddress === null && this.subnetMask === null && this.secondaryIPs.length === 0) return;
    this.ipAddress = null;
    this.subnetMask = null;
    this.secondaryIPs = [];
    this.getBus().publish({
      topic: 'port.config.ip-changed',
      payload: { ...this.portRef(), ip: null, mask: null },
    });
  }

  getSecondaryIPs(): Array<{ ip: IPAddress; mask: SubnetMask }> { return this.secondaryIPs; }

  addSecondaryIP(ip: IPAddress, mask: SubnetMask): void {
    if (this.secondaryIPs.some((e) => e.ip.equals(ip))) return;
    this.secondaryIPs.push({ ip, mask });
    Logger.info(this.equipmentId, 'port:ip-config', `${this.name}: secondary IP ${ip}/${mask.toCIDR()}`);
  }

  removeSecondaryIP(ip: IPAddress): void {
    this.secondaryIPs = this.secondaryIPs.filter((e) => !e.ip.equals(ip));
  }

  ownsIPv4(ip: IPAddress): boolean {
    if (this.ipAddress?.equals(ip)) return true;
    return this.secondaryIPs.some((e) => e.ip.equals(ip));
  }

  // ─── IPv6 Configuration ────────────────────────────────────────

  enableIPv6(): void {
    if (this.ipv6Enabled) return;
    this.ipv6Enabled = true;

    const linkLocal = IPv6Address.fromMAC(this.mac);
    const scoped = linkLocal.withScopeId(this.name);
    this.ipv6Addresses.push({
      address: scoped,
      prefixLength: 64,
      origin: 'link-local',
    });

    Logger.info(this.equipmentId, 'port:ipv6-enabled',
      `${this.name}: IPv6 enabled, link-local ${linkLocal}`);
    this.getBus().publish({
      topic: 'port.config.ipv6-added',
      payload: {
        ...this.portRef(),
        address: scoped,
        prefixLength: 64,
        origin: 'link-local',
      },
    });
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
    this.getBus().publish({
      topic: 'port.config.ipv6-added',
      payload: {
        ...this.portRef(),
        address: addrWithScope,
        prefixLength,
        origin: 'static',
      },
    });
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
    const removed = this.ipv6Addresses.length < before;
    if (removed) {
      this.getBus().publish({
        topic: 'port.config.ipv6-removed',
        payload: { ...this.portRef(), address },
      });
    }
    return removed;
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

  /**
   * Release every dynamically-obtained IPv6 address (SLAAC / DHCPv6),
   * keeping link-local and manually-configured static addresses intact.
   * Mirrors `ipconfig /release6` — a real DHCP release only ever touches
   * leased addresses, never a static assignment.
   */
  releaseDynamicIPv6Addresses(): IPv6AddressEntry[] {
    const released = this.ipv6Addresses.filter(e => e.origin === 'slaac' || e.origin === 'dhcpv6');
    this.ipv6Addresses = this.ipv6Addresses.filter(e => e.origin !== 'slaac' && e.origin !== 'dhcpv6');
    return released;
  }

  // ─── Speed & Duplex (IEEE 802.3) ─────────────────────────────────

  getSpeed(): PortSpeed { return this.speed; }

  setSpeed(speed: number): void {
    if (!(VALID_PORT_SPEEDS as readonly number[]).includes(speed)) {
      throw new Error(
        `Invalid port speed: ${speed} Mbps. Valid speeds: ${VALID_PORT_SPEEDS.join(', ')}`
      );
    }
    const previous = this.speed;
    this.speed = speed as PortSpeed;
    Logger.info(this.equipmentId, 'port:speed', `${this.name}: speed set to ${speed} Mbps`);
    if (previous !== this.speed) {
      this.getBus().publish({
        topic: 'port.config.speed-changed',
        payload: { ...this.portRef(), speed: this.speed },
      });
    }
  }

  getDuplex(): PortDuplex { return this.duplex; }

  setDuplex(duplex: PortDuplex): void {
    const previous = this.duplex;
    this.duplex = duplex;
    Logger.info(this.equipmentId, 'port:duplex', `${this.name}: duplex set to ${duplex}`);
    if (previous !== duplex) {
      this.getBus().publish({
        topic: 'port.config.duplex-changed',
        payload: { ...this.portRef(), duplex },
      });
    }
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
      throw new Error(`Invalid MTU: ${mtu}. Minimum is 68 (IPv4 minimum).`);  // MTU.MIN
    }
    if (mtu > 9216) {
      throw new Error(`Invalid MTU: ${mtu}. Maximum is 9216 (jumbo frame).`);  // MTU.MAX
    }
    const previous = this.mtu;
    this.mtu = mtu;
    Logger.info(this.equipmentId, 'port:mtu', `${this.name}: MTU set to ${mtu}`);
    if (previous !== mtu) {
      this.getBus().publish({
        topic: 'port.config.mtu-changed',
        payload: { ...this.portRef(), mtu },
      });
    }
  }

  // ─── Port Security (delegated to PortSecurity) ─────────────────────

  /** Get the PortSecurity manager for direct access */
  getPortSecurity(): PortSecurity { return this.security; }

  isPortSecurityEnabled(): boolean { return this.security.isEnabled(); }

  enablePortSecurity(): void { this.security.enable(); }

  disablePortSecurity(): void { this.security.disable(); }

  getMaxMACAddresses(): number { return this.security.getMaxMACAddresses(); }

  setMaxMACAddresses(max: number): void { this.security.setMaxMACAddresses(max); }

  getSecureMACAddresses(): MACAddress[] { return this.security.getLearnedMACs(); }

  addStaticMACAddress(mac: MACAddress): void { this.security.addStaticMAC(mac); }

  getViolationMode(): PortViolationMode { return this.security.getViolationMode(); }

  setViolationMode(mode: PortViolationMode): void { this.security.setViolationMode(mode); }

  getSecurityViolationCount(): number { return this.security.getViolationCount(); }

  /**
   * Check if a source MAC passes port security.
   * Delegates to PortSecurity.evaluate() which returns explicit verdicts.
   */
  private checkPortSecurity(srcMAC: MACAddress): boolean {
    const verdict = this.security.evaluate(srcMAC);
    if (verdict.learned && verdict.learned.type === 'sticky') {
      this.getBus().publish({
        topic: 'port.security.sticky-saved',
        payload: {
          ...this.portRef(),
          mac: verdict.learned.mac,
          vlan: verdict.learned.vlan,
        },
      });
    }
    if (verdict.shouldShutdown) {
      this.isUp = false;
      this.notifyLinkChange('down');
      this.getBus().publish({
        topic: 'port.security.errdisable.set',
        payload: { ...this.portRef(), mac: srcMAC },
      });
    }
    if (!verdict.allowed) {
      const action: 'discarded' | 'shutdown' | 'restricted' = verdict.shouldShutdown
        ? 'shutdown'
        : (this.security.getViolationMode() === 'restrict' ? 'restricted' : 'discarded');
      this.getBus().publish({
        topic: 'port.security.violation',
        payload: {
          ...this.portRef(),
          mac: srcMAC,
          mode: this.security.getViolationMode(),
          action,
        },
      });
    }
    return verdict.allowed;
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
    this.getBus().publish(
      state === 'up'
        ? { topic: 'port.link.up', payload: this.portRef() }
        : { topic: 'port.link.down', payload: this.portRef() },
    );
  }

  // ─── Cable Connection ──────────────────────────────────────────

  getCable(): Cable | null { return this.cable; }

  isConnected(): boolean {
    return this.cable !== null;
  }

  connectCable(cable: Cable): void {
    this.cable = cable;
    Logger.debug(this.equipmentId, 'port:cable-connect', `${this.name}: cable connected`);
    this.notifyLinkChange('up');
  }

  /** Set cable reference without triggering link-change notifications.
   *  Used by Cable.connect to ensure both ends are wired before any
   *  _ospfAutoConverge (or similar) fires and tries to deliver packets. */
  _setCableNoNotify(cable: Cable): void {
    this.cable = cable;
    Logger.debug(this.equipmentId, 'port:cable-connect', `${this.name}: cable connected`);
  }

  /** Fire link-up handlers. Used by Cable.connect after both ends are wired. */
  _notifyLinkUp(): void {
    this.notifyLinkChange('up');
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
      this.getBus().publish({
        topic: 'port.frame.tx-blocked',
        payload: { ...this.portRef(), reason: 'link-down' },
      });
      return false;
    }

    if (!this.cable) {
      this.counters.dropsOut++;
      Logger.warn(this.equipmentId, 'port:send-blocked', `${this.name}: no cable connected, frame dropped`);
      this.getBus().publish({
        topic: 'port.frame.tx-blocked',
        payload: { ...this.portRef(), reason: 'no-cable' },
      });
      return false;
    }

    this.counters.framesOut++;
    this.counters.bytesOut += ethernetFrameBytes(frame);
    Logger.debug(this.equipmentId, 'port:send',
      `${this.name}: sending frame ${frame.srcMAC} → ${frame.dstMAC}`,
      { etherType: frame.etherType });
    this.getBus().publish({
      topic: 'port.frame.tx-requested',
      payload: { ...this.portRef(), frame },
    });

    return this.cable.transmit(frame, this);
  }

  receiveFrame(frame: EthernetFrame): void {
    if (!this.isUp) {
      this.counters.dropsIn++;
      Logger.warn(this.equipmentId, 'port:recv-blocked', `${this.name}: port is down, frame dropped`);
      this.getBus().publish({
        topic: 'port.frame.dropped',
        payload: { ...this.portRef(), reason: 'link-down', srcMac: frame.srcMAC },
      });
      return;
    }

    // Port security check
    if (!this.checkPortSecurity(frame.srcMAC)) {
      this.counters.dropsIn++;
      this.getBus().publish({
        topic: 'port.frame.dropped',
        payload: { ...this.portRef(), reason: 'security-violation', srcMac: frame.srcMAC },
      });
      return;
    }

    this.counters.framesIn++;
    this.counters.bytesIn += ethernetFrameBytes(frame);
    Logger.debug(this.equipmentId, 'port:recv',
      `${this.name}: received frame ${frame.srcMAC} → ${frame.dstMAC}`,
      { etherType: frame.etherType });
    this.getBus().publish({
      topic: 'port.frame.received',
      payload: { ...this.portRef(), frame },
    });

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
