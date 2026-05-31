import type { IEventBus } from '@/events/EventBus';
import { getDefaultScheduler, type IScheduler, type TimerHandle } from '@/events/Scheduler';
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

export class LacpAgent {
  private config: LacpConfig;
  private readonly advertising = new Set<string>();
  private slowTimer: TimerHandle | null = null;
  private fastTimer: TimerHandle | null = null;
  private scheduler: IScheduler | null = null;
  private unsubscribers: Array<() => void> = [];
  private running = false;

  constructor(
    private readonly host: LacpHost,
    private readonly getBus: () => IEventBus,
    systemId: string,
    private readonly getScheduler: () => IScheduler = () => getDefaultScheduler(),
  ) {
    this.config = createDefaultLacpConfig(systemId);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.installSubscribers();
    if (this.config.enabled) this.startTimers();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    for (const u of this.unsubscribers) u();
    this.unsubscribers = [];
    this.stopTimers();
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
      this.startTimers();
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
    if (!this.config.enabled) return;
    const payload = frame.payload as LacpFrame | undefined;
    if (!payload || payload.type !== 'lacp') return;
    const p = this.config.ports.get(portName);
    if (!p) return;
    if (p.mode === 'on') return;
    p.partner = { ...payload.actor };
    p.lastRxMs = Date.now();
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

  private startTimers(): void {
    const s = this.getScheduler();
    this.scheduler = s;
    if (this.slowTimer === null) {
      this.slowTimer = s.setInterval(() => this.tick('slow'), 30_000);
    }
    if (this.config.fastRate && this.fastTimer === null) {
      this.fastTimer = s.setInterval(() => this.tick('fast'), 1_000);
    }
  }

  private stopTimers(): void {
    const s = this.scheduler ?? this.getScheduler();
    if (this.slowTimer !== null) { s.clear(this.slowTimer); this.slowTimer = null; }
    if (this.fastTimer !== null) { s.clear(this.fastTimer); this.fastTimer = null; }
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

  private installSubscribers(): void {
    const bus = this.getBus();
    this.unsubscribers.push(bus.subscribeWhere(
      'port.link.up',
      (p) => p.deviceId === this.host.id,
      (e) => this.onLinkUp(e.payload.portName),
    ));
    this.unsubscribers.push(bus.subscribeWhere(
      'port.link.down',
      (p) => p.deviceId === this.host.id,
      (e) => this.onLinkDown(e.payload.portName),
    ));
  }

  private onLinkUp(portName: string): void {
    const p = this.config.ports.get(portName);
    if (!p) return;
    if (p.mode === 'active') this.advertise(portName);
    this.recompute();
  }

  private onLinkDown(portName: string): void {
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

  private maybeEmitStateChange(p: LacpPortInfo, oldState: LacpPortState, oldBundled: boolean): void {
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
          port: p.portName, groupId: p.groupId, cause: 'partner-loss',
        },
      });
    }
  }
}
