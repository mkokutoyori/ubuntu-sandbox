/**
 * CdpAgent — Cisco Discovery Protocol engine (per device).
 *
 * Drives the three CDP duties:
 *   1. Advertise — on every CDP-enabled port that is link-up, emit a
 *      CDP frame periodically (timerSec, default 60 s), on link-up,
 *      and on relevant configuration changes.
 *   2. Receive — fold incoming advertisements into the neighbour table
 *      (insert / refresh / expiry timer reset).
 *   3. Expire — drop neighbours that have not refreshed within their
 *      hold-time and publish `cdp.neighbor.expired`.
 *
 * Reactive integration with the project's event bus:
 *   - subscribes to `port.link.up`   → immediate advertisement
 *   - subscribes to `port.link.down` → flushes neighbours learnt via
 *     that port and publishes their expiry
 *
 * The agent owns no policy of its own — every knob lives in `CdpConfig`
 * which the host device persists in its running-config (NVRAM
 * coherence). `setEnabled / setTimer / setHoldtime / setPortEnabled`
 * are the only mutation points and each one publishes
 * `cdp.config.changed`.
 */
import type { IEventBus } from '@/events/EventBus';
import {
  getDefaultScheduler, type IScheduler, type TimerHandle,
} from '@/events/Scheduler';
import {
  type CdpConfig, type CdpFrame, type CdpNeighborEntry, type CdpCapability,
  createDefaultCdpConfig, neighborKey, ETHERTYPE_CDP, CDP_MULTICAST_MAC,
} from './types';
import {
  MACAddress, type EthernetFrame, type DeviceType,
} from '../core/types';
import { Logger } from '../core/Logger';

export interface CdpHost {
  readonly id: string;
  readonly name: string;
  getHostname(): string;
  getType(): DeviceType;
  getPort(name: string): import('../hardware/Port').Port | undefined;
  getPorts(): import('../hardware/Port').Port[];
  sendFrame(portName: string, frame: EthernetFrame): void;
  /** Optional native VLAN for a port (switches only). */
  getNativeVlan?(portName: string): number | undefined;
}

/** Read-only view of a learned CDP neighbour (used by `show cdp`). */
export type CdpNeighbor = Readonly<CdpNeighborEntry>;

export class CdpAgent {
  private config: CdpConfig = createDefaultCdpConfig();
  private readonly neighbors = new Map<string, CdpNeighborEntry>();
  /** Re-entrance guard so a peer's synchronous reply doesn't bounce
   *  back through us mid-advertisement (Cable.transmit is sync). */
  private readonly advertising = new Set<string>();
  private adTimer: TimerHandle | null = null;
  private expiryTimer: TimerHandle | null = null;
  private scheduler: IScheduler | null = null;
  private unsubscribers: Array<() => void> = [];
  private running = false;

  constructor(
    private readonly host: CdpHost,
    private readonly getBus: () => IEventBus,
    private readonly getScheduler: () => IScheduler = () => getDefaultScheduler(),
  ) {}

  // ── lifecycle ──────────────────────────────────────────────────────

  start(): void {
    if (this.running) return;
    this.running = true;
    this.installSubscribers();
    if (this.config.enabled) this.startTimers();
  }

  /**
   * Detach subscribers + stop timers — used to rebind the agent onto a
   * fresh bus. The neighbour table is preserved so a transient restart
   * (e.g. `setEventBus`) does not erase observable protocol state.
   * Use `setEnabled(false)` to flush the table.
   */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    for (const u of this.unsubscribers) u();
    this.unsubscribers = [];
    this.stopTimers();
  }

  // ── configuration ──────────────────────────────────────────────────

  getConfig(): Readonly<CdpConfig> { return this.config; }

  private _advertiseV2: boolean = true;
  setAdvertiseV2(on: boolean): void { this._advertiseV2 = on; }
  isAdvertiseV2(): boolean { return this._advertiseV2; }

  asRunningConfigLines(): string[] {
    const lines: string[] = [];
    if (!this.config.enabled) lines.push('no cdp run');
    if (this.config.timerSec !== 60) lines.push(`cdp timer ${this.config.timerSec}`);
    if (this.config.holdtimeSec !== 180) lines.push(`cdp holdtime ${this.config.holdtimeSec}`);
    if (!this._advertiseV2) lines.push('no cdp advertise-v2');
    return lines;
  }

  asRunningConfigForInterface(ifName: string): string[] {
    if (this.config.disabledPorts.has(ifName)) return [' no cdp enable'];
    return [];
  }

  setEnabled(on: boolean): void {
    if (this.config.enabled === on) return;
    this.config.enabled = on;
    if (on) {
      this.startTimers();
      this.advertiseAll('config-change');
    } else {
      this.stopTimers();
      this.flushAll('admin-disabled');
    }
    this.publishConfigChange();
  }

  setTimerSec(sec: number): void {
    if (sec <= 0) return;
    this.config.timerSec = sec;
    this.config.holdtimeSec = Math.max(this.config.holdtimeSec, sec);
    if (this.config.enabled) {
      this.stopTimers();
      this.startTimers();
    }
    this.publishConfigChange();
  }

  setHoldtimeSec(sec: number): void {
    if (sec <= 0) return;
    this.config.holdtimeSec = sec;
    this.publishConfigChange();
  }

  setPortEnabled(portName: string, on: boolean): void {
    if (on) {
      if (!this.config.disabledPorts.delete(portName)) return;
      if (this.config.enabled) this.advertise(portName, 'config-change');
    } else {
      if (this.config.disabledPorts.has(portName)) return;
      this.config.disabledPorts.add(portName);
      this.flushPort(portName, 'admin-disabled');
    }
  }

  isPortEnabled(portName: string): boolean {
    return this.config.enabled && !this.config.disabledPorts.has(portName);
  }

  // ── public reads ────────────────────────────────────────────────────

  getNeighbors(): CdpNeighbor[] {
    return Array.from(this.neighbors.values());
  }

  getNeighborsOnPort(portName: string): CdpNeighbor[] {
    return Array.from(this.neighbors.values()).filter(n => n.localPort === portName);
  }

  /**
   * Lines to emit in `show running-config` for non-default CDP knobs.
   * The `cdp run` enable/disable line is owned by `CiscoConfigState`.
   */
  runningConfigGlobalLines(): string[] {
    const out: string[] = [];
    if (this.config.timerSec !== 60) out.push(`cdp timer ${this.config.timerSec}`);
    if (this.config.holdtimeSec !== 180) out.push(`cdp holdtime ${this.config.holdtimeSec}`);
    return out;
  }

  /** Returns `['no cdp enable']` if this port had CDP turned off. */
  runningConfigInterfaceLines(portName: string): string[] {
    return this.config.disabledPorts.has(portName) ? ['no cdp enable'] : [];
  }

  // ── inbound ────────────────────────────────────────────────────────

  /** Called by the hosting device's `handleFrame` when a CDP frame arrives. */
  handleFrame(portName: string, frame: EthernetFrame): void {
    if (!this.config.enabled) return;
    if (this.config.disabledPorts.has(portName)) return;
    const payload = frame.payload as CdpFrame | undefined;
    if (!payload || payload.type !== 'cdp') return;

    const key = neighborKey(portName, payload.deviceId);
    const now = Date.now();
    const expiresAtMs = now + payload.holdtimeSec * 1000;
    const existing = this.neighbors.get(key);
    const entry: CdpNeighborEntry = {
      localPort: portName,
      remoteHost: payload.deviceId,
      remotePort: payload.portId,
      remoteType: this.capabilityToType(payload.capabilities[0]),
      remotePlatform: payload.platform,
      remoteCapability: payload.capabilities[0] ?? 'Host',
      remoteAddresses: [...payload.addresses],
      remoteSoftwareVersion: payload.softwareVersion,
      learnedAtMs: now,
      holdtimeSec: payload.holdtimeSec,
      expiresAtMs,
      nativeVlan: payload.nativeVlan,
      duplex: payload.duplex,
    };
    this.neighbors.set(key, entry);
    const bus = this.getBus();
    bus.publish({
      topic: 'cdp.frame.received',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        port: portName, remoteHost: payload.deviceId, remotePort: payload.portId,
      },
    });
    if (!existing) {
      bus.publish({
        topic: 'cdp.neighbor.discovered',
        payload: {
          deviceId: this.host.id, hostname: this.host.getHostname(),
          localPort: portName, remoteHost: payload.deviceId, remotePort: payload.portId,
          remoteCapability: entry.remoteCapability, holdtimeSec: payload.holdtimeSec,
        },
      });
      Logger.info(this.host.id, 'cdp:neighbor-up',
        `${this.host.name}: CDP neighbour ${payload.deviceId} (${payload.portId}) on ${portName}`);
    } else {
      bus.publish({
        topic: 'cdp.neighbor.refreshed',
        payload: {
          deviceId: this.host.id, hostname: this.host.getHostname(),
          localPort: portName, remoteHost: payload.deviceId,
        },
      });
    }
    // Reply if we haven't transmitted on this port for a while —
    // bounds the cascade (the peer's own guard halts the next round)
    // while ensuring fresh bring-up doesn't have to wait for the 60 s
    // periodic tick.
    this.maybeAdvertiseBack(portName);
  }

  // ── advertisement ──────────────────────────────────────────────────

  /** Emit an advertisement on every CDP-eligible up-link port. */
  advertiseAll(reason: 'link-up' | 'periodic' | 'config-change'): void {
    if (!this.config.enabled) return;
    for (const port of this.host.getPorts()) {
      const name = port.getName();
      if (this.config.disabledPorts.has(name)) continue;
      if (!port.getIsUp() || !port.isConnected()) continue;
      this.advertise(name, reason);
    }
  }

  advertise(portName: string, reason: 'link-up' | 'periodic' | 'config-change'): void {
    if (!this.config.enabled) return;
    if (this.config.disabledPorts.has(portName)) return;
    const port = this.host.getPort(portName);
    if (!port || !port.getIsUp() || !port.isConnected()) return;

    const payload: CdpFrame = {
      type: 'cdp', version: 2,
      holdtimeSec: this.config.holdtimeSec,
      deviceId: this.host.getHostname(),
      portId: portName,
      capabilities: [this.deviceCapability()],
      softwareVersion: this.softwareVersion(),
      platform: this.devicePlatform(),
      addresses: this.collectAddresses(),
      nativeVlan: this.host.getNativeVlan?.(portName),
      duplex: this.portDuplex(port),
    };
    const frame: EthernetFrame = {
      srcMAC: port.getMAC(),
      dstMAC: new MACAddress(CDP_MULTICAST_MAC),
      etherType: ETHERTYPE_CDP,
      payload,
    };
    if (this.advertising.has(portName)) return;
    this.advertising.add(portName);
    try {
      this.host.sendFrame(portName, frame);
    } finally {
      this.advertising.delete(portName);
    }
    this.getBus().publish({
      topic: 'cdp.frame.sent',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        port: portName, reason,
      },
    });
  }

  /**
   * Send an ad back when we just received one on this port. The
   * `advertising` set is the cascade-stopper: if we're already mid-
   * advertisement on this port, the peer's reply lands in handleFrame
   * but the back-reply is skipped — preventing infinite recursion.
   */
  private maybeAdvertiseBack(portName: string): void {
    if (this.advertising.has(portName)) return;
    this.advertise(portName, 'link-up');
  }

  // ── timers ────────────────────────────────────────────────────────

  private startTimers(): void {
    const s = this.getScheduler();
    this.scheduler = s;
    if (this.adTimer === null) {
      this.adTimer = s.setInterval(() => this.advertiseAll('periodic'),
        this.config.timerSec * 1000);
    }
    if (this.expiryTimer === null) {
      this.expiryTimer = s.setInterval(() => this.expireDue(), 1000);
    }
  }

  private stopTimers(): void {
    const s = this.scheduler ?? this.getScheduler();
    if (this.adTimer !== null) { s.clear(this.adTimer); this.adTimer = null; }
    if (this.expiryTimer !== null) { s.clear(this.expiryTimer); this.expiryTimer = null; }
  }

  private expireDue(): void {
    const now = Date.now();
    for (const [key, n] of this.neighbors) {
      if (n.expiresAtMs <= now) {
        this.neighbors.delete(key);
        this.publishExpiry(n, 'holdtime');
      }
    }
  }

  private installSubscribers(): void {
    const bus = this.getBus();
    this.unsubscribers.push(bus.subscribeWhere(
      'port.link.up',
      (p) => p.deviceId === this.host.id,
      (e) => this.advertise(e.payload.portName, 'link-up'),
    ));
    this.unsubscribers.push(bus.subscribeWhere(
      'port.link.down',
      (p) => p.deviceId === this.host.id,
      (e) => this.flushPort(e.payload.portName, 'link-down'),
    ));
  }

  private flushPort(portName: string, cause: 'link-down' | 'admin-disabled'): void {
    for (const [key, n] of this.neighbors) {
      if (n.localPort !== portName) continue;
      this.neighbors.delete(key);
      this.publishExpiry(n, cause);
    }
  }

  private flushAll(cause: 'admin-disabled'): void {
    for (const [key, n] of this.neighbors) {
      this.neighbors.delete(key);
      this.publishExpiry(n, cause);
    }
  }

  private publishExpiry(n: CdpNeighborEntry, cause: 'holdtime' | 'link-down' | 'admin-disabled'): void {
    this.getBus().publish({
      topic: 'cdp.neighbor.expired',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        localPort: n.localPort, remoteHost: n.remoteHost, cause,
      },
    });
    Logger.info(this.host.id, 'cdp:neighbor-down',
      `${this.host.name}: CDP neighbour ${n.remoteHost} on ${n.localPort} expired (${cause})`);
  }

  private publishConfigChange(): void {
    this.getBus().publish({
      topic: 'cdp.config.changed',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        enabled: this.config.enabled,
        timerSec: this.config.timerSec, holdtimeSec: this.config.holdtimeSec,
      },
    });
  }

  // ── derivation helpers ─────────────────────────────────────────────

  private deviceCapability(): CdpCapability {
    const t = this.host.getType();
    if (t.startsWith('router')) return 'Router';
    if (t.startsWith('switch')) return 'Switch';
    return 'Host';
  }

  private capabilityToType(c?: CdpCapability): DeviceType {
    if (c === 'Router') return 'router-cisco';
    if (c === 'Switch') return 'switch-cisco';
    return 'linux-pc';
  }

  private devicePlatform(): string {
    const t = this.host.getType();
    switch (t) {
      case 'router-cisco':  return 'Cisco 2911';
      case 'switch-cisco':  return 'Cisco Catalyst 2960';
      case 'router-huawei': return 'Huawei AR2220';
      case 'switch-huawei': return 'Huawei S5720';
      default: return t;
    }
  }

  private softwareVersion(): string {
    const t = this.host.getType();
    if (t.startsWith('switch')) {
      return 'Cisco IOS Software, C2960 Software (C2960-LANBASEK9-M), Version 15.2(7)E2';
    }
    if (t.startsWith('router')) {
      return 'Cisco IOS Software, c2900 Software (C2900-UNIVERSALK9-M), Version 15.4(3)M';
    }
    return '';
  }

  private collectAddresses(): string[] {
    const out: string[] = [];
    for (const p of this.host.getPorts()) {
      const ip = p.getIPAddress();
      if (ip) out.push(ip.toString());
    }
    return out;
  }

  private portDuplex(p: import('../hardware/Port').Port): 'half' | 'full' | 'auto' {
    const d = p.getDuplex();
    if (d === 'half' || d === 'full') return d;
    return 'auto';
  }
}
