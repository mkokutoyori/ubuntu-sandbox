import type { IEventBus } from '@/events/EventBus';
import { getDefaultScheduler, type IScheduler } from '@/events/Scheduler';
import { ReactiveAgentBase } from '../core/ReactiveAgentBase';
import {
  type BridgeId, type StpBpdu, type StpConfig, type StpPortInfo, type StpPortRole,
  type StpPortGuards, type MstRegion,
  createDefaultStpConfig, compareBridge, bridgeEquals, defaultPathCost, defaultPathCostLong,
  defaultPortGuards, createDefaultMstRegion,
  ETHERTYPE_STP, STP_BRIDGE_MAC,
} from './types';
import { MACAddress, type EthernetFrame } from '../core/types';
import { Logger } from '../core/Logger';

export type StpForwardState = 'blocking' | 'listening' | 'learning' | 'forwarding' | 'disabled';

export interface StpHost {
  readonly id: string;
  readonly name: string;
  getHostname(): string;
  getPort(name: string): import('../hardware/Port').Port | undefined;
  getPorts(): import('../hardware/Port').Port[];
  sendFrame(portName: string, frame: EthernetFrame): void;
  onForwardStateChanged(portName: string, state: StpForwardState): void;
  onStpBpduGuardErrDisable?(portName: string, senderMac: string): void;
  /**
   * Topology-change fast aging (802.1D-1998 §8.3.5): while the TC flag
   * circulates, dynamic MAC entries age with `agingSec` (forward delay)
   * instead of the configured default; null restores the default.
   */
  onTopologyChangeAging?(agingSec: number | null): void;
}

export class StpAgent extends ReactiveAgentBase {
  private config: StpConfig;
  private readonly mstRegion: MstRegion = createDefaultMstRegion();
  private readonly mstInstancePriority = new Map<number, number>();
  private pathcostMethod: 'short' | 'long' = 'short';
  private readonly portInfo = new Map<string, StpPortInfo>();
  private readonly guards = new Map<string, StpPortGuards>();
  private readonly rootInconsistent = new Set<string>();
  private readonly portFastLost = new Set<string>();
  private readonly advertising = new Set<string>();
  private readonly forwardStates = new Map<string, StpForwardState>();
  private readonly transitionTimers = new Map<string, TimerHandle>();
  private rootBridge: BridgeId;
  private rootPort: string | null = null;
  private rootPathCost = 0;
  /** Scheduler that armed one-shot timers (clear() must land on it). */
  private scheduler: IScheduler | null = null;

  // ── Topology change machinery (802.1D-1998 §8.6.14) ──────────────
  /** TCNs owed toward the root until the designated bridge acks. */
  private tcnPending = false;
  /** TC flag carried in our config BPDUs (root: during tcWhile; else mirrored from the root port). */
  private tcFlagActive = false;
  /** Ports owed a one-shot Topology Change Ack on their next config BPDU. */
  private readonly pendingTcAck = new Set<string>();
  private readonly pendingAgreement = new Set<string>();
  private tcWhileTimer: TimerHandle | null = null;
  private fastAgingActive = false;

  constructor(
    private readonly host: StpHost,
    getBus: () => IEventBus,
    baseMac: string,
    getScheduler: () => IScheduler = () => getDefaultScheduler(),
  ) {
    super(host, getBus, getScheduler);
    this.config = createDefaultStpConfig(baseMac);
    this.rootBridge = this.ownBridgeId();
  }

  override start(): void {
    if (this.isRunning()) return;
    super.start();
    this.recomputeOnTopologyChange();
  }

  override stop(): void {
    if (!this.isRunning()) return;
    super.stop(); // also clears the named 'tcn' interval
    // Cancel pending 802.1D listening/learning transitions — a stopped
    // agent must not flip port states later.
    for (const portName of [...this.transitionTimers.keys()]) {
      this.cancelTransition(portName);
    }
    if (this.tcWhileTimer !== null) {
      (this.scheduler ?? this.getScheduler()).clear(this.tcWhileTimer);
      this.tcWhileTimer = null;
    }
    this.tcnPending = false;
    this.tcFlagActive = false;
    this.pendingTcAck.clear();
    this.pendingAgreement.clear();
    this.setFastAging(false);
  }

  getConfig(): Readonly<StpConfig> { return this.config; }
  getRootBridge(): BridgeId { return { ...this.rootBridge }; }
  getRootPort(): string | null { return this.rootPort; }
  getRootPathCost(): number { return this.rootPathCost; }
  isRoot(): boolean { return bridgeEquals(this.rootBridge, this.ownBridgeId()); }
  ownBridgeId(): BridgeId {
    return { priority: this.config.bridgePriority, mac: this.config.baseMac };
  }

  getPortRole(portName: string): StpPortRole {
    return this.portInfo.get(portName)?.role ?? 'disabled';
  }

  /**
   * Path cost of a port (IEEE 802.1D-2004 Table 17-3), derived from the
   * live link speed. Used by `show spanning-tree` so the displayed cost
   * tracks the real interface speed instead of a hard-coded constant.
   */
  getPortCost(portName: string): number {
    const known = this.portInfo.get(portName)?.cost;
    if (known !== undefined) return known;
    return this.costForPort(this.host.getPort(portName));
  }

  /**
   * Speed-derived path cost (IEEE 802.1D-2004 Table 17-3). `Port.getSpeed()`
   * is in Mbps; {@link defaultPathCost} works in kbps, so convert here — the
   * single conversion point keeps every STP cost consistent (a Gigabit link
   * is 4, FastEthernet 19, 10 GbE 2, not the 200 a raw Mbps value yields).
   */
  private costForPort(port: import('../hardware/Port').Port | undefined): number {
    const kbps = (port?.getSpeed() ?? 0) * 1000;
    return this.pathcostMethod === 'long' ? defaultPathCostLong(kbps) : defaultPathCost(kbps);
  }

  getPathcostMethod(): 'short' | 'long' { return this.pathcostMethod; }
  setPathcostMethod(method: 'short' | 'long'): void { this.pathcostMethod = method; }

  getMstInstancePriority(instanceId: number): number {
    return this.mstInstancePriority.get(instanceId) ?? 32768;
  }
  setMstInstancePriority(instanceId: number, priority: number): void {
    this.mstInstancePriority.set(instanceId, priority);
  }

  /**
   * RSTP operPointToPoint (IEEE 802.1D-2004 §6.4.3), inferred from the
   * operational duplex: a full-duplex link is point-to-point (eligible for
   * the rapid proposal/agreement transition), a half-duplex link is shared
   * (a hub segment) and must fall back to the timed listening/learning walk.
   */
  getPortLinkType(portName: string): 'p2p' | 'shared' {
    return this.host.getPort(portName)?.getDuplex() === 'half'
      ? 'shared' : 'p2p';
  }

  private isPointToPoint(portName: string): boolean {
    return this.getPortLinkType(portName) === 'p2p';
  }

  getMstRegion(): MstRegion { return this.mstRegion; }
  setMstName(name: string): void { this.mstRegion.name = name; }
  setMstRevision(rev: number): void { this.mstRegion.revision = rev; }
  mapMstInstance(instanceId: number, vlans: string): void {
    this.mstRegion.instances.set(instanceId, vlans);
  }
  unmapMstInstance(instanceId: number): void {
    this.mstRegion.instances.delete(instanceId);
  }

  /** TC flag currently carried in our config BPDUs (root tcWhile or mirrored). */
  isTopologyChangeActive(): boolean { return this.tcFlagActive; }

  /** Fast MAC aging in effect (802.1D-1998 §8.3.5). */
  isFastAgingActive(): boolean { return this.fastAgingActive; }

  getForwardState(portName: string): StpForwardState {
    return this.forwardStates.get(portName) ?? 'disabled';
  }

  setBridgePriority(priority: number): void {
    if (priority < 0 || priority > 65535) return;
    const stepped = Math.floor(priority / 4096) * 4096;
    if (stepped === this.config.bridgePriority) return;
    this.config.bridgePriority = stepped;
    this.recomputeOnTopologyChange();
    this.publishConfigChange();
  }

  setHelloSec(sec: number): void {
    if (sec < 1 || sec > 10) return;
    this.config.helloSec = sec;
    if (this.config.enabled) {
      this.stopTimers();
      this.armTimers();
    }
  }

  setMode(mode: import('./types').StpProtocolMode): void {
    if (this.config.mode === mode) return;
    this.config.mode = mode;
    this.recomputeOnTopologyChange();
  }

  getMode(): import('./types').StpProtocolMode { return this.config.mode; }

  setMaxAgeSec(sec: number): void {
    if (sec < 6 || sec > 40) return;
    this.config.maxAgeSec = sec;
  }

  setForwardDelaySec(sec: number): void {
    if (sec < 4 || sec > 30) return;
    this.config.forwardDelaySec = sec;
  }

  getPortGuards(portName: string): StpPortGuards {
    let g = this.guards.get(portName);
    if (!g) { g = defaultPortGuards(); this.guards.set(portName, g); }
    return g;
  }

  setPortFast(portName: string, on: boolean): void {
    this.getPortGuards(portName).portFast = on;
    if (!on) this.portFastLost.delete(portName);
  }

  isPortFastOperational(portName: string): boolean {
    return this.guards.get(portName)?.portFast === true
      && !this.portFastLost.has(portName);
  }

  setPortBpduGuard(portName: string, on: boolean): void {
    this.getPortGuards(portName).bpduGuard = on;
  }

  setPortRootGuard(portName: string, on: boolean): void {
    this.getPortGuards(portName).rootGuard = on;
  }

  setBpduGuardGlobal(on: boolean): void {
    this.config.bpduGuardGlobal = on;
  }

  clearRootInconsistent(portName: string): void {
    if (!this.rootInconsistent.delete(portName)) return;
    this.getBus().publish({
      topic: 'stp.root-guard.changed',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        port: portName, state: 'consistent',
      },
    });
    this.runElection();
  }

  isRootInconsistent(portName: string): boolean {
    return this.rootInconsistent.has(portName);
  }

  setEnabled(on: boolean): void {
    if (this.config.enabled === on) return;
    this.config.enabled = on;
    if (on) {
      this.recomputeOnTopologyChange();
      this.armTimers();
    } else {
      this.stopTimers();
      for (const port of this.host.getPorts()) {
        this.applyForwardState(port.getName(), 'forwarding');
      }
    }
  }

  runningConfigGlobalLines(): string[] {
    const out: string[] = [];
    if (!this.config.enabled) out.push('no spanning-tree vlan 1');
    if (this.config.bridgePriority !== 32768) {
      out.push(`spanning-tree vlan 1 priority ${this.config.bridgePriority}`);
    }
    if (this.config.helloSec !== 2) {
      out.push(`spanning-tree vlan 1 hello-time ${this.config.helloSec}`);
    }
    if (this.config.maxAgeSec !== 20) {
      out.push(`spanning-tree vlan 1 max-age ${this.config.maxAgeSec}`);
    }
    if (this.config.forwardDelaySec !== 15) {
      out.push(`spanning-tree vlan 1 forward-time ${this.config.forwardDelaySec}`);
    }
    return out;
  }

  handleFrame(portName: string, frame: EthernetFrame): void {
    if (!this.config.enabled) return;
    const payload = frame.payload as StpBpdu | undefined;
    if (!payload || payload.type !== 'stp') return;
    const port = this.host.getPort(portName);
    if (!port || !port.getIsUp() || !port.isConnected()) return;

    // BPDU Guard fires on ANY BPDU type (config or TCN), like real IOS.
    const g = this.getPortGuards(portName);
    const bpduGuard = g.bpduGuard || (g.portFast && this.config.bpduGuardGlobal);
    if (bpduGuard) {
      this.getBus().publish({
        topic: 'stp.bpdu-guard.violation',
        payload: {
          deviceId: this.host.id, hostname: this.host.getHostname(),
          port: portName, senderMac: payload.senderBridge.mac,
        },
      });
      Logger.warn(this.host.id, 'stp:bpdu-guard',
        `${this.host.name}: BPDU Guard triggered on ${portName} — err-disabling`);
      this.host.onStpBpduGuardErrDisable?.(portName, payload.senderBridge.mac);
      return;
    }

    if (g.portFast && !this.portFastLost.has(portName)) {
      this.portFastLost.add(portName);
      this.getBus().publish({
        topic: 'stp.portfast.lost',
        payload: {
          deviceId: this.host.id, hostname: this.host.getHostname(),
          port: portName, senderMac: payload.senderBridge.mac,
        },
      });
      Logger.warn(this.host.id, 'stp:portfast-lost',
        `${this.host.name}: ${portName} received a BPDU — PortFast operational status lost`);
    }

    if (payload.bpduType === 'tcn') {
      this.handleTcnBpdu(portName);
      return;
    }
    if (payload.bpduType !== 'config') return;

    this.getBus().publish({
      topic: 'stp.bpdu.received',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        port: portName,
        senderMac: payload.senderBridge.mac,
        rootMac: payload.rootBridge.mac,
      },
    });
    const cost = this.costForPort(port);
    const info: StpPortInfo = {
      role: 'disabled',
      cost,
      designatedRoot: { ...payload.rootBridge },
      designatedBridge: { ...payload.senderBridge },
      designatedCost: payload.rootPathCost,
      designatedPort: payload.portId,
      ageMs: Date.now(),
    };
    this.portInfo.set(portName, info);

    if (g.rootGuard) {
      const myRoot = this.rootBridge;
      const advertised = payload.rootBridge;
      if (compareBridge(advertised, myRoot) < 0) {
        if (!this.rootInconsistent.has(portName)) {
          this.rootInconsistent.add(portName);
          this.getBus().publish({
            topic: 'stp.root-guard.changed',
            payload: {
              deviceId: this.host.id, hostname: this.host.getHostname(),
              port: portName, state: 'inconsistent',
            },
          });
          Logger.warn(this.host.id, 'stp:root-guard',
            `${this.host.name}: Root Guard blocked ${portName} (superior BPDU from ${advertised.priority}/${advertised.mac})`);
        }
      } else if (this.rootInconsistent.has(portName)) {
        this.rootInconsistent.delete(portName);
        this.getBus().publish({
          topic: 'stp.root-guard.changed',
          payload: {
            deviceId: this.host.id, hostname: this.host.getHostname(),
            port: portName, state: 'consistent',
          },
        });
      }
    }

    this.runElection();

    // ── Topology change processing (802.1D-1998 §8.6.14) ──────────
    // The designated bridge acked our TCNs: stop retransmitting.
    if (this.config.mode === 'rstp' && payload.version === 2) {
      if (payload.proposal && portName === this.rootPort) {
        this.pendingAgreement.add(portName);
        this.cancelTransition(portName);
        this.applyForwardState(portName, 'forwarding');
        this.sendBpdu(portName);
      }
      if (payload.agreement && this.portInfo.get(portName)?.role === 'designated') {
        this.cancelTransition(portName);
        this.applyForwardState(portName, 'forwarding');
      }
      if (payload.topologyChange && !this.tcFlagActive) {
        this.startTcWhile();
      }
      if (!payload.topologyChange && portName === this.rootPort) {
        this.setFastAging(false);
      }
      return;
    }
    if (payload.topologyChangeAck && portName === this.rootPort) {
      this.stopTcnRetransmission();
    }
    // Mirror the TC flag heard on the root port: propagate it on our
    // designated ports and run fast aging while it is set (§8.3.5).
    if (portName === this.rootPort && !this.isRoot()) {
      if (this.tcFlagActive !== payload.topologyChange) {
        this.tcFlagActive = payload.topologyChange;
        if (payload.topologyChange) this.emitBpduOnAllPorts();
      }
      this.setFastAging(payload.topologyChange);
    }
  }

  // ── Topology Change Notification machinery ────────────────────────

  /**
   * TCN received (802.1D-1998 §8.6.13): only meaningful on a port where
   * we are the designated bridge. Ack it on the next config BPDU out
   * that port and pass the notification toward the root.
   */
  private handleTcnBpdu(portName: string): void {
    if (this.portInfo.get(portName)?.role !== 'designated' && !this.isRoot()) return;
    this.getBus().publish({
      topic: 'stp.tcn.received',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        port: portName,
      },
    });
    this.pendingTcAck.add(portName);
    this.sendBpdu(portName); // immediate ack, like real bridges
    this.notifyTopologyChange();
  }

  /**
   * A topology change was detected locally or relayed from downstream:
   * the root starts the tcWhile period (TC flag + fast aging for
   * max age + forward delay, §8.5.3.12); any other bridge sends TCNs
   * out its root port every hello time until acked.
   */
  private notifyTopologyChange(): void {
    if (!this.config.enabled) return;
    this.getBus().publish({
      topic: 'stp.topology-change.detected',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        isRoot: this.isRoot(),
      },
    });
    if (this.config.mode === 'rstp' || this.isRoot()) {
      this.startTcWhile();
    } else {
      this.startTcnRetransmission();
    }
  }

  private startTcWhile(): void {
    this.tcFlagActive = true;
    this.setFastAging(true);
    const s = this.getScheduler();
    this.scheduler = s;
    if (this.tcWhileTimer !== null) s.clear(this.tcWhileTimer);
    this.tcWhileTimer = s.setTimeout(() => {
      this.tcWhileTimer = null;
      this.tcFlagActive = false;
      this.setFastAging(false);
    }, (this.config.maxAgeSec + this.config.forwardDelaySec) * 1000);
    // Spread the news immediately instead of waiting for the next hello.
    this.emitBpduOnAllPorts();
  }

  private startTcnRetransmission(): void {
    if (!this.rootPort) return;
    this.tcnPending = true;
    this.sendTcn();
    this.scheduleInterval('tcn', () => {
      if (this.tcnPending && this.rootPort) this.sendTcn();
    }, this.config.helloSec * 1000);
  }

  private stopTcnRetransmission(): void {
    if (!this.tcnPending) return;
    this.tcnPending = false;
    this.clearInterval('tcn');
  }

  private sendTcn(): void {
    const portName = this.rootPort;
    if (!portName) return;
    const port = this.host.getPort(portName);
    if (!port || !port.getIsUp() || !port.isConnected()) return;
    const bpdu: StpBpdu = {
      type: 'stp', bpduType: 'tcn',
      protocolId: 0x0000, version: 0, flags: 0,
      rootBridge: { ...this.rootBridge },
      rootPathCost: this.rootPathCost,
      senderBridge: this.ownBridgeId(),
      portId: this.portIdFor(portName),
      messageAgeSec: 0,
      maxAgeSec: this.config.maxAgeSec,
      helloSec: this.config.helloSec,
      forwardDelaySec: this.config.forwardDelaySec,
      topologyChange: false,
      topologyChangeAck: false,
    };
    this.host.sendFrame(portName, {
      srcMAC: port.getMAC(),
      dstMAC: new MACAddress(STP_BRIDGE_MAC),
      etherType: ETHERTYPE_STP,
      payload: bpdu,
    });
    this.getBus().publish({
      topic: 'stp.tcn.sent',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        port: portName,
      },
    });
  }

  private setFastAging(on: boolean): void {
    if (this.fastAgingActive === on) return;
    this.fastAgingActive = on;
    this.host.onTopologyChangeAging?.(on ? this.config.forwardDelaySec : null);
    Logger.info(this.host.id, 'stp:fast-aging',
      `${this.host.name}: MAC fast aging ${on ? `ON (${this.config.forwardDelaySec}s)` : 'off'}`);
  }

  emitBpduOnAllPorts(): void {
    if (!this.config.enabled) return;
    for (const port of this.host.getPorts()) {
      const name = port.getName();
      if (!port.getIsUp() || !port.isConnected()) continue;
      const role = this.portInfo.get(name)?.role;
      if (role !== 'designated' && !this.isRoot()) {
        if (name === this.rootPort) {
          if (!(this.config.mode === 'rstp' && this.tcFlagActive)) continue;
        } else if (role === 'alternate') continue;
      }
      this.sendBpdu(name);
    }
  }

  private sendBpdu(portName: string): void {
    const port = this.host.getPort(portName);
    if (!port) return;
    if (this.advertising.has(portName)) return;
    const bpdu: StpBpdu = {
      type: 'stp', bpduType: 'config',
      protocolId: 0x0000,
      version: this.config.mode === 'rstp' ? 2 : 0,
      flags: 0,
      proposal: this.config.mode === 'rstp'
        && this.isPointToPoint(portName)
        && this.portInfo.get(portName)?.role === 'designated'
        && this.forwardStates.get(portName) !== 'forwarding',
      agreement: this.pendingAgreement.delete(portName),
      rootBridge: { ...this.rootBridge },
      rootPathCost: this.rootPathCost,
      senderBridge: this.ownBridgeId(),
      portId: this.portIdFor(portName),
      messageAgeSec: 0,
      maxAgeSec: this.config.maxAgeSec,
      helloSec: this.config.helloSec,
      forwardDelaySec: this.config.forwardDelaySec,
      topologyChange: this.tcFlagActive,
      // One-shot ack toward the bridge whose TCN we owe (§8.6.14).
      topologyChangeAck: this.pendingTcAck.delete(portName),
    };
    const frame: EthernetFrame = {
      srcMAC: port.getMAC(),
      dstMAC: new MACAddress(STP_BRIDGE_MAC),
      etherType: ETHERTYPE_STP,
      payload: bpdu,
    };
    this.advertising.add(portName);
    try { this.host.sendFrame(portName, frame); }
    finally { this.advertising.delete(portName); }
    this.getBus().publish({
      topic: 'stp.bpdu.sent',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        port: portName,
        rootMac: this.rootBridge.mac, rootPriority: this.rootBridge.priority,
        pathCost: this.rootPathCost,
      },
    });
  }

  private portIdFor(portName: string): number {
    const idx = this.host.getPorts().findIndex(p => p.getName() === portName);
    return (0x80 << 8) | (idx & 0xff);
  }

  protected isEnabled(): boolean { return this.config.enabled; }

  protected armTimers(): void {
    this.scheduleInterval('hello', () => this.emitBpduOnAllPorts(),
      this.config.helloSec * 1000);
    this.scheduleInterval('info-age', () => this.expireStaleBpduInfo(), 1_000);
  }

  private expireStaleBpduInfo(): void {
    if (!this.config.enabled) return;
    const now = Date.now();
    const own = this.ownBridgeId();
    let expired = false;
    for (const [portName, info] of this.portInfo) {
      if (bridgeEquals(info.designatedBridge, own)) continue;
      if (now - info.ageMs <= this.config.maxAgeSec * 1000) continue;
      this.portInfo.delete(portName);
      expired = true;
      this.getBus().publish({
        topic: 'stp.bpdu-info.expired',
        payload: {
          deviceId: this.host.id, hostname: this.host.getHostname(),
          port: portName,
          designatedBridge: `${info.designatedBridge.priority}/${info.designatedBridge.mac}`,
        },
      });
      Logger.info(this.host.id, 'stp:info-age',
        `${this.host.name}: BPDU info on ${portName} aged out (max age ${this.config.maxAgeSec}s)`);
    }
    if (expired) this.runElection();
  }

  protected override onPortLinkUp(_portName: string): void {
    this.recomputeOnTopologyChange();
  }

  protected override onPortLinkDown(portName: string): void {
    // Losing an active (non-edge) port is a topology change
    // (802.1D-1998 §8.5.3.12) — capture the state before forgetting it.
    const wasActive = this.forwardStates.get(portName) === 'forwarding'
      || this.forwardStates.get(portName) === 'learning';
    const portFast = this.isPortFastOperational(portName);
    this.portFastLost.delete(portName);
    this.portInfo.delete(portName);
    // Forget the applied forward state so a re-connected link is treated as a
    // fresh edge port (rapid transition), matching the link-up fast path in
    // the Switch base class.
    this.cancelTransition(portName);
    this.forwardStates.delete(portName);
    this.runElection();
    if (wasActive && !portFast && this.config.enabled) {
      this.notifyTopologyChange();
    }
  }

  private recomputeOnTopologyChange(): void {
    this.runElection();
    this.emitBpduOnAllPorts();
  }

  private runElection(): void {
    const own = this.ownBridgeId();
    let bestRoot: BridgeId = own;
    let bestCost = 0;
    let bestPort: string | null = null;
    let bestInfo: StpPortInfo | null = null;

    for (const [portName, info] of this.portInfo) {
      const port = this.host.getPort(portName);
      if (!port || !port.getIsUp() || !port.isConnected()) continue;
      if (this.rootInconsistent.has(portName)) continue;
      const r = info.designatedRoot;
      const candidateCost = info.designatedCost + info.cost;
      if (compareBridge(r, bestRoot) < 0) {
        bestRoot = r;
        bestCost = candidateCost;
        bestPort = portName;
        bestInfo = info;
      } else if (bridgeEquals(r, bestRoot)) {
        if (bestPort === null || bestInfo === null
            || this.rootPathPreference(info, candidateCost, portName, bestInfo, bestCost, bestPort) < 0) {
          bestCost = candidateCost;
          bestPort = portName;
          bestInfo = info;
        }
      }
    }

    const rootChanged = !bridgeEquals(bestRoot, this.rootBridge);
    const oldRootMac = rootChanged ? this.rootBridge.mac : null;
    this.rootBridge = bestRoot;
    this.rootPathCost = bridgeEquals(bestRoot, own) ? 0 : bestCost;
    this.rootPort = bridgeEquals(bestRoot, own) ? null : bestPort;

    for (const port of this.host.getPorts()) {
      const name = port.getName();
      if (!port.getIsUp() || !port.isConnected()) {
        continue;
      }
      if (this.rootInconsistent.has(name)) {
        this.applyRole(name, 'alternate');
        continue;
      }
      const guards = this.guards.get(name);
      if (this.isPortFastOperational(name) && name !== this.rootPort) {
        this.applyRole(name, 'designated');
        continue;
      }
      if (name === this.rootPort) { this.applyRole(name, 'root'); continue; }
      const info = this.portInfo.get(name);
      if (!info) { this.applyRole(name, 'designated'); continue; }
      const myAdvertised: { root: BridgeId; cost: number; bridge: BridgeId; port: number } = {
        root: this.rootBridge,
        cost: this.rootPathCost,
        bridge: own,
        port: this.portIdFor(name),
      };
      const theirs = {
        root: info.designatedRoot, cost: info.designatedCost,
        bridge: info.designatedBridge, port: info.designatedPort,
      };
      const mine = this.bpduSuperiority(myAdvertised, theirs);
      if (mine <= 0) { this.applyRole(name, 'designated'); continue; }
      // Non-designated, non-root: distinguish Alternate from Backup
      // (802.1D-2004 §17.7). A superior BPDU sourced by our OWN bridge —
      // only possible on a shared segment carrying another of our
      // designated ports — makes this a Backup port; a superior BPDU from
      // any other bridge makes it an Alternate (alternate path to root).
      const fromSelf = bridgeEquals(info.designatedBridge, own);
      this.applyRole(name, fromSelf ? 'backup' : 'alternate');
    }

    if (rootChanged) {
      this.getBus().publish({
        topic: 'stp.root.changed',
        payload: {
          deviceId: this.host.id, hostname: this.host.getHostname(),
          oldRootMac, newRootMac: this.rootBridge.mac,
          newRootPriority: this.rootBridge.priority,
          rootPort: this.rootPort,
        },
      });
      Logger.info(this.host.id, 'stp:root-change',
        `${this.host.name}: STP root → ${this.rootBridge.priority}/${this.rootBridge.mac}`);
    }
  }

  /**
   * Root-port tie-break, IEEE 802.1D-1998 §8.6.8: when two ports reach the
   * same root at the same path cost, prefer the lowest sender bridge ID,
   * then the lowest sender port ID, then the lowest local port ID.
   * Returns < 0 when candidate `a` beats the current best `b`.
   */
  private rootPathPreference(
    a: StpPortInfo, aCost: number, aPort: string,
    b: StpPortInfo, bCost: number, bPort: string,
  ): number {
    if (aCost !== bCost) return aCost - bCost;
    const sender = compareBridge(a.designatedBridge, b.designatedBridge);
    if (sender !== 0) return sender;
    if (a.designatedPort !== b.designatedPort) return a.designatedPort - b.designatedPort;
    return this.portIdFor(aPort) - this.portIdFor(bPort);
  }

  private bpduSuperiority(
    a: { root: BridgeId; cost: number; bridge: BridgeId; port: number },
    b: { root: BridgeId; cost: number; bridge: BridgeId; port: number },
  ): number {
    const r = compareBridge(a.root, b.root);
    if (r !== 0) return r;
    if (a.cost !== b.cost) return a.cost - b.cost;
    const br = compareBridge(a.bridge, b.bridge);
    if (br !== 0) return br;
    return a.port - b.port;
  }

  private applyRole(portName: string, role: StpPortRole): void {
    let info = this.portInfo.get(portName);
    if (!info) {
      const port = this.host.getPort(portName);
      const cost = this.costForPort(port);
      info = {
        role: 'disabled', cost,
        designatedRoot: this.ownBridgeId(),
        designatedBridge: this.ownBridgeId(),
        designatedCost: 0,
        designatedPort: this.portIdFor(portName),
        ageMs: Date.now(),
      };
      this.portInfo.set(portName, info);
    }
    const oldRole = info.role;
    if (oldRole !== role) {
      info.role = role;
      this.getBus().publish({
        topic: 'stp.role.changed',
        payload: {
          deviceId: this.host.id, hostname: this.host.getHostname(),
          port: portName, oldRole, newRole: role,
        },
      });
    }
    if (role === 'disabled') {
      this.applyForwardState(portName, 'disabled');
    } else if (role === 'alternate' || role === 'backup') {
      this.applyForwardState(portName, 'blocking');
    } else {
      this.requestForwarding(portName);
    }
  }

  /**
   * Move a root/designated port toward forwarding.
   *
   * IEEE 802.1D-1998 §8.4: a port leaving the blocking state must spend
   * `forwardDelaySec` in Listening (no learning, no forwarding) and another
   * `forwardDelaySec` in Learning (MAC learning only) before it forwards.
   * Two fast paths skip the transitional states:
   *  - PortFast (edge port, 802.1D-2004 §17.13.1 operEdge),
   *  - a port this agent has never managed yet — initial bring-up is treated
   *    as an RSTP-style rapid transition, mirroring the link-up fast path in
   *    the Switch base class so freshly cabled topologies stay usable.
   */
  private requestForwarding(portName: string): void {
    const current = this.forwardStates.get(portName);
    if (current === 'forwarding' || current === 'listening' || current === 'learning') return;
    const portFast = this.isPortFastOperational(portName);
    if (portFast || current === undefined) {
      this.applyForwardState(portName, 'forwarding');
      return;
    }
    // RSTP rapid root-port transition is only safe on a point-to-point
    // link; on a shared segment the root port walks the timers (§17.10).
    if (this.config.mode === 'rstp' && portName === this.rootPort
      && this.isPointToPoint(portName)) {
      this.applyForwardState(portName, 'forwarding');
      return;
    }
    this.applyForwardState(portName, 'listening');
    this.scheduleTransition(portName, 'learning');
    // A designated port proposes only on point-to-point links (the
    // proposal flag in sendBpdu is gated the same way).
    if (this.config.mode === 'rstp' && this.isPointToPoint(portName)) {
      this.sendBpdu(portName);
    }
  }

  private scheduleTransition(portName: string, next: 'learning' | 'forwarding'): void {
    this.cancelTransition(portName);
    const s = this.getScheduler();
    this.scheduler = s;
    const handle = s.setTimeout(() => {
      this.transitionTimers.delete(portName);
      this.applyForwardState(portName, next);
      if (next === 'learning') this.scheduleTransition(portName, 'forwarding');
    }, this.config.forwardDelaySec * 1000);
    this.transitionTimers.set(portName, handle);
  }

  private cancelTransition(portName: string): void {
    const handle = this.transitionTimers.get(portName);
    if (handle === undefined) return;
    (this.scheduler ?? this.getScheduler()).clear(handle);
    this.transitionTimers.delete(portName);
  }

  private applyForwardState(portName: string, state: StpForwardState): void {
    if (state !== 'listening' && state !== 'learning') this.cancelTransition(portName);
    const previous = this.forwardStates.get(portName);
    if (previous === state) return;
    this.forwardStates.set(portName, state);
    this.host.onForwardStateChanged(portName, state);
    this.getBus().publish({
      topic: 'stp.port-state.changed',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        port: portName, oldState: previous ?? null, newState: state,
      },
    });
    // A non-edge port reaching forwarding is a topology change
    // (802.1D-1998 §8.5.3.12). Initial bring-up (previous === undefined)
    // follows the RSTP-style rapid path and stays silent, consistent
    // with requestForwarding(); PortFast ports never notify.
    if (state === 'forwarding' && previous !== undefined
      && !this.isPortFastOperational(portName) && this.config.enabled) {
      this.notifyTopologyChange();
    }
  }

  private publishConfigChange(): void {
    this.getBus().publish({
      topic: 'stp.root.changed',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        oldRootMac: null, newRootMac: this.rootBridge.mac,
        newRootPriority: this.rootBridge.priority,
        rootPort: this.rootPort,
      },
    });
  }
}
