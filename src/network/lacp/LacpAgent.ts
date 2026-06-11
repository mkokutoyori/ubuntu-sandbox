import type { IEventBus } from '@/events/EventBus';
import { getDefaultScheduler, type IScheduler } from '@/events/Scheduler';
import { ReactiveAgentBase } from '../core/ReactiveAgentBase';
import {
  type LacpAdminMode, type LacpConfig, type LacpFrame, type LacpPortInfo,
  type LacpPortState, type LacpActorInfo,
  createDefaultLacpConfig, buildActorState, compareSystemId,
  ETHERTYPE_LACP, LACP_SLOW_MAC,
  LACP_FLAG_SYNC, LACP_FLAG_COLLECTING, LACP_FLAG_DISTRIBUTING,
} from './types';
import { MACAddress, type EthernetFrame } from '../core/types';
import { Logger } from '../core/Logger';

export interface LacpHost {
  readonly id: string;
  readonly name: string;
  getHostname(): string;
  getPort(name: string): import('../hardware/Port').Port | undefined;
  getPorts(): import('../hardware/Port').Port[];
  sendFrame(portName: string, frame: EthernetFrame): void;
}

export class LacpAgent extends ReactiveAgentBase {
  private config: LacpConfig;
  private readonly advertising = new Set<string>();

  constructor(
    private readonly host: LacpHost,
    getBus: () => IEventBus,
    systemId: string,
    getScheduler: () => IScheduler = () => getDefaultScheduler(),
  ) {
    super(host, getBus, getScheduler);
    this.config = createDefaultLacpConfig(systemId);
  }

  getConfig(): Readonly<LacpConfig> { return this.config; }

  setSystemPriority(priority: number): void {
    if (priority < 0 || priority > 65535) return;
    this.config.systemPriority = priority;
    this.recompute();
  }

  setFastRate(on: boolean): void {
    this.config.fastRate = on;
    if (this.config.enabled) {
      this.stopTimers();
      this.armTimers();
    }
  }

  ensureGroup(groupId: number, name?: string, loadBalance?: string): void {
    let g = this.config.groups.get(groupId);
    if (!g) {
      g = { name: name ?? `Port-channel${groupId}`, loadBalance: loadBalance ?? 'src-dst-mac' };
      this.config.groups.set(groupId, g);
    } else {
      if (name) g.name = name;
      if (loadBalance) g.loadBalance = loadBalance;
    }
  }

  addPortToGroup(portName: string, groupId: number, mode: LacpAdminMode): void {
    this.ensureGroup(groupId);
    let p = this.config.ports.get(portName);
    if (!p) {
      p = {
        portName, groupId, mode,
        state: 'standalone', partner: null,
        selected: false, bundled: false, lastRxMs: 0,
      };
      this.config.ports.set(portName, p);
    } else {
      p.groupId = groupId;
      p.mode = mode;
    }
    this.recompute();
    if (this.config.enabled && mode === 'active') this.advertise(portName);
  }

  removePort(portName: string): void {
    const p = this.config.ports.get(portName);
    if (!p) return;
    if (p.bundled) {
      this.getBus().publish({
        topic: 'lacp.port.unbundled',
        payload: {
          deviceId: this.host.id, hostname: this.host.getHostname(),
          port: portName, groupId: p.groupId, cause: 'admin-change',
        },
      });
    }
    this.config.ports.delete(portName);
  }

  getPortInfo(portName: string): LacpPortInfo | undefined {
    return this.config.ports.get(portName);
  }

  getGroupMembers(groupId: number): LacpPortInfo[] {
    return Array.from(this.config.ports.values()).filter(p => p.groupId === groupId);
  }

  getAllGroups(): Array<{ id: number; name: string; loadBalance: string; members: LacpPortInfo[] }> {
    return Array.from(this.config.groups.entries()).map(([id, g]) => ({
      id, name: g.name, loadBalance: g.loadBalance,
      members: this.getGroupMembers(id),
    }));
  }

  runningConfigInterfaceLines(portName: string): string[] {
    const p = this.config.ports.get(portName);
    if (!p) return [];
    return [`channel-group ${p.groupId} mode ${p.mode}`];
  }

  handleFrame(portName: string, frame: EthernetFrame): void {
    // A stopped agent neither speaks nor processes — otherwise it
    // keeps answering partner LACPDUs and looks alive forever.
    if (!this.isRunning() || !this.config.enabled) return;
    const payload = frame.payload as LacpFrame | undefined;
    if (!payload || payload.type !== 'lacp') return;
    const p = this.config.ports.get(portName);
    if (!p) return;
    if (p.mode === 'on') return;
    p.partner = { ...payload.actor };
    p.lastRxMs = Date.now();
    // A fresh LACPDU revives an expired port (802.3ad receive machine:
    // EXPIRED → CURRENT); selection below re-bundles it.
    if (p.state === 'expired') p.state = 'standalone';
    this.getBus().publish({
      topic: 'lacp.frame.received',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        port: portName,
        partnerSystemId: payload.actor.systemId,
        partnerKey: payload.actor.key,
      },
    });
    this.recompute();
    this.maybeAdvertiseBack(portName);
  }

  advertise(portName: string): void {
    if (!this.config.enabled) return;
    const port = this.host.getPort(portName);
    if (!port || !port.getIsUp() || !port.isConnected()) return;
    const p = this.config.ports.get(portName);
    if (!p || p.mode === 'on') return;
    const actor: LacpActorInfo = {
      systemPriority: this.config.systemPriority,
      systemId: this.config.systemId,
      key: p.groupId,
      portPriority: 32768,
      portNumber: this.portNumberFor(portName),
      state: buildActorState(p.mode, p),
    };
    const partner: LacpActorInfo = p.partner ?? {
      systemPriority: 0, systemId: '00:00:00:00:00:00',
      key: 0, portPriority: 0, portNumber: 0, state: 0,
    };
    const payload: LacpFrame = {
      type: 'lacp', subtype: 0x01, version: 0x01,
      actor, partner, collectorMaxDelay: 0,
    };
    const eth: EthernetFrame = {
      srcMAC: port.getMAC(),
      dstMAC: new MACAddress(LACP_SLOW_MAC),
      etherType: ETHERTYPE_LACP,
      payload,
    };
    if (this.advertising.has(portName)) return;
    this.advertising.add(portName);
    try { this.host.sendFrame(portName, eth); }
    finally { this.advertising.delete(portName); }
    this.getBus().publish({
      topic: 'lacp.frame.sent',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        port: portName, groupId: p.groupId, mode: p.mode,
      },
    });
  }

  private maybeAdvertiseBack(portName: string): void {
    if (this.advertising.has(portName)) return;
    this.advertise(portName);
  }

  private portNumberFor(portName: string): number {
    const idx = this.host.getPorts().findIndex(p => p.getName() === portName);
    return idx + 1;
  }

  protected isEnabled(): boolean { return this.config.enabled; }

  protected armTimers(): void {
    this.scheduleInterval('slow', () => this.tick('slow'), 30_000);
    if (this.config.fastRate) {
      this.scheduleInterval('fast', () => this.tick('fast'), 1_000);
    }
    this.scheduleInterval('expiry', () => this.expireDue(), 1_000);
  }

  /** current_while (802.3ad §43.4.12): 3 × the interval we requested. */
  private rxTimeoutMs(): number {
    return this.config.fastRate ? 3_000 : 90_000;
  }

  /** EXPIRED keeps partner info one short interval before defaulting. */
  private static readonly EXPIRED_GRACE_MS = 3_000;

  /**
   * Receive machine timeouts. Previously a silent partner kept its
   * port bundled forever — a unidirectional failure (peer hung, agent
   * stopped) was never detected as long as the link stayed up.
   */
  private expireDue(): void {
    const now = Date.now();
    for (const p of this.config.ports.values()) {
      if (p.mode === 'on' || !p.partner || p.lastRxMs === 0) continue;
      const port = this.host.getPort(p.portName);
      if (!port || !port.getIsUp() || !port.isConnected()) continue;
      const elapsed = now - p.lastRxMs;
      if (p.state !== 'expired' && elapsed > this.rxTimeoutMs()) {
        const oldState = p.state;
        const oldBundled = p.bundled;
        p.state = 'expired';
        p.selected = false;
        p.bundled = false;
        this.maybeEmitStateChange(p, oldState, oldBundled, 'partner-timeout');
      } else if (p.state === 'expired'
        && elapsed > this.rxTimeoutMs() + LacpAgent.EXPIRED_GRACE_MS) {
        // DEFAULTED: forget the partner entirely.
        const oldState = p.state;
        p.partner = null;
        p.lastRxMs = 0;
        p.state = 'standalone';
        this.maybeEmitStateChange(p, oldState, p.bundled);
        this.recompute();
      }
    }
  }

  private tick(rate: 'slow' | 'fast'): void {
    for (const p of this.config.ports.values()) {
      const port = this.host.getPort(p.portName);
      if (!port || !port.getIsUp() || !port.isConnected()) continue;
      if (p.mode !== 'active') continue;
      if (rate === 'slow' && this.config.fastRate) continue;
      this.advertise(p.portName);
    }
  }

  protected override onPortLinkUp(portName: string): void {
    const p = this.config.ports.get(portName);
    if (!p) return;
    if (p.mode === 'active') this.advertise(portName);
    this.recompute();
  }

  protected override onPortLinkDown(portName: string): void {
    const p = this.config.ports.get(portName);
    if (!p) return;
    const wasBundled = p.bundled;
    p.partner = null;
    p.selected = false;
    if (wasBundled) {
      this.getBus().publish({
        topic: 'lacp.port.unbundled',
        payload: {
          deviceId: this.host.id, hostname: this.host.getHostname(),
          port: portName, groupId: p.groupId, cause: 'link-down',
        },
      });
    }
    this.recompute();
  }

  private recompute(): void {
    const byGroup = new Map<number, LacpPortInfo[]>();
    for (const p of this.config.ports.values()) {
      const arr = byGroup.get(p.groupId) ?? [];
      arr.push(p);
      byGroup.set(p.groupId, arr);
    }
    for (const [, members] of byGroup) {
      this.runSelection(members);
    }
  }

  private runSelection(members: LacpPortInfo[]): void {
    for (const p of members) {
      const oldState = p.state;
      const oldBundled = p.bundled;
      const port = this.host.getPort(p.portName);
      const linkUp = !!port && port.getIsUp() && port.isConnected();
      if (!linkUp) {
        p.state = 'standalone'; p.selected = false; p.bundled = false;
      } else if (p.mode === 'on') {
        p.state = 'bundled'; p.selected = true; p.bundled = true;
      } else if (p.state === 'expired') {
        // Stays out of the aggregate until a fresh LACPDU arrives
        // (handleFrame clears the state) or the partner is defaulted.
        p.selected = false; p.bundled = false;
      } else if (p.partner && p.partner.key === p.groupId) {
        const sameSystem = compareSystemId(
          { priority: this.config.systemPriority, id: this.config.systemId },
          { priority: p.partner.systemPriority, id: p.partner.systemId },
        ) === 0;
        if (sameSystem) {
          p.state = 'standalone'; p.selected = false; p.bundled = false;
        } else {
          p.state = 'bundled'; p.selected = true; p.bundled = true;
        }
      } else {
        p.state = 'standalone'; p.selected = false; p.bundled = false;
      }
      this.maybeEmitStateChange(p, oldState, oldBundled);
    }
  }

  private maybeEmitStateChange(
    p: LacpPortInfo, oldState: LacpPortState, oldBundled: boolean,
    unbundleCause = 'partner-loss',
  ): void {
    if (oldState !== p.state) {
      this.getBus().publish({
        topic: 'lacp.port.state-changed',
        payload: {
          deviceId: this.host.id, hostname: this.host.getHostname(),
          port: p.portName, groupId: p.groupId,
          oldState, newState: p.state,
        },
      });
      Logger.info(this.host.id, 'lacp:state',
        `${this.host.name}: ${p.portName} ${oldState} → ${p.state}`);
    }
    if (!oldBundled && p.bundled) {
      this.getBus().publish({
        topic: 'lacp.port.bundled',
        payload: {
          deviceId: this.host.id, hostname: this.host.getHostname(),
          port: p.portName, groupId: p.groupId,
          partnerSystemId: p.partner?.systemId ?? '00:00:00:00:00:00',
        },
      });
    } else if (oldBundled && !p.bundled) {
      this.getBus().publish({
        topic: 'lacp.port.unbundled',
        payload: {
          deviceId: this.host.id, hostname: this.host.getHostname(),
          port: p.portName, groupId: p.groupId, cause: unbundleCause,
        },
      });
    }
  }
}
