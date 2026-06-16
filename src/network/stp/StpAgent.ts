import type { IEventBus } from '@/events/EventBus';
import { getDefaultScheduler, type IScheduler, type TimerHandle } from '@/events/Scheduler';
import { ReactiveAgentBase } from '../core/ReactiveAgentBase';
import {
  type BridgeId, type StpBpdu, type StpConfig, type StpPortInfo, type StpPortRole,
  type StpPortGuards, type MstRegion,
  createDefaultStpConfig, compareBridge, defaultPathCost, defaultPathCostLong,
  defaultPortGuards, createDefaultMstRegion,
  ETHERTYPE_STP, STP_BRIDGE_MAC,
} from './types';
import { StpVlanInstance, type StpInstanceAgent, type StpForwardState } from './StpVlanInstance';
import { MACAddress, type EthernetFrame } from '../core/types';
import { Logger } from '../core/Logger';

export type { StpForwardState } from './StpVlanInstance';

export interface StpHost {
  readonly id: string;
  readonly name: string;
  getHostname(): string;
  getPort(name: string): import('../hardware/Port').Port | undefined;
  getPorts(): import('../hardware/Port').Port[];
  sendFrame(portName: string, frame: EthernetFrame): void;
  onForwardStateChanged(portName: string, state: StpForwardState, vlan: number): void;
  onStpBpduGuardErrDisable?(portName: string, senderMac: string): void;
  onTopologyChangeAging?(agingSec: number | null): void;
  getStpPortVlans?(portName: string): number[];
}

export class StpAgent extends ReactiveAgentBase implements StpInstanceAgent {
  private config: StpConfig;
  private readonly mstRegion: MstRegion = createDefaultMstRegion();
  private readonly mstInstancePriority = new Map<number, number>();
  private readonly vlanPriority = new Map<number, number>();
  private readonly vlanHello = new Map<number, number>();
  private readonly vlanMaxAge = new Map<number, number>();
  private readonly vlanForwardDelay = new Map<number, number>();
  private pathcostMethod: 'short' | 'long' = 'short';
  private readonly guards = new Map<string, StpPortGuards>();
  private readonly rootInconsistent = new Set<string>();
  private readonly portFastLost = new Set<string>();
  private readonly advertising = new Set<string>();
  private readonly instances = new Map<number, StpVlanInstance>();
  private armedScheduler: IScheduler | null = null;

  private tcnPending = false;
  private tcFlagActive = false;
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
    this.instances.set(1, new StpVlanInstance(1, this));
  }

  get deviceId(): string { return this.host.id; }
  get deviceName(): string { return this.host.name; }
  getHostname(): string { return this.host.getHostname(); }
  bus(): IEventBus { return this.getBus(); }
  scheduler(): IScheduler { return this.getScheduler(); }
  getPort(name: string): import('../hardware/Port').Port | undefined { return this.host.getPort(name); }
  getPorts(): import('../hardware/Port').Port[] { return this.host.getPorts(); }
  isEnabledStp(): boolean { return this.config.enabled; }
  forwardDelaySec(vlan: number): number { return this.getVlanForwardDelaySec(vlan); }
  maxAgeSec(vlan: number): number { return this.getVlanMaxAgeSec(vlan); }
  isRootInconsistent(portName: string): boolean { return this.rootInconsistent.has(portName); }
  onInstanceForwardState(vlan: number, portName: string, state: StpForwardState): void {
    this.host.onForwardStateChanged(portName, state, vlan);
  }
  onInstanceTopologyChange(_vlan: number): void { this.notifyTopologyChange(); }
  sendProposal(vlan: number, portName: string): void { this.sendBpdu(portName, vlan); }

  private cst(): StpVlanInstance { return this.instances.get(1)!; }

  private vkey(vlan: number, portName: string): string { return `${vlan}:${portName}`; }

  private instanceFor(vlan: number): StpVlanInstance {
    let inst = this.instances.get(vlan);
    if (!inst) { inst = new StpVlanInstance(vlan, this); this.instances.set(vlan, inst); }
    return inst;
  }

  private portVlans(portName: string): number[] {
    const v = this.host.getStpPortVlans?.(portName);
    return v && v.length ? v : [1];
  }

  private ensurePortInstances(): void {
    for (const port of this.host.getPorts()) {
      if (!port.getIsUp() || !port.isConnected()) continue;
      for (const vlan of this.portVlans(port.getName())) this.instanceFor(vlan);
    }
  }

  getActiveStpVlans(): number[] {
    return [...this.instances.keys()].sort((a, b) => a - b);
  }
  getRootBridgeForVlan(vlan: number): BridgeId {
    return (this.instances.get(vlan) ?? this.cst()).getRootBridge();
  }
  getRootPortForVlan(vlan: number): string | null {
    return (this.instances.get(vlan) ?? this.cst()).getRootPort();
  }
  getRootPathCostForVlan(vlan: number): number {
    return (this.instances.get(vlan) ?? this.cst()).getRootPathCost();
  }
  isRootForVlan(vlan: number): boolean {
    const inst = this.instances.get(vlan);
    return inst ? inst.isRoot() : true;
  }
  getPortRoleForVlan(vlan: number, portName: string): StpPortRole {
    return (this.instances.get(vlan) ?? this.cst()).getPortRole(portName);
  }
  getForwardStateForVlan(vlan: number, portName: string): StpForwardState {
    return (this.instances.get(vlan) ?? this.cst()).getForwardState(portName);
  }

  override start(): void {
    if (this.isRunning()) return;
    super.start();
    this.recomputeOnTopologyChange();
  }

  override stop(): void {
    if (!this.isRunning()) return;
    super.stop();
    for (const inst of this.instances.values()) inst.cancelAllTransitions();
    if (this.tcWhileTimer !== null) {
      (this.armedScheduler ?? this.getScheduler()).clear(this.tcWhileTimer);
      this.tcWhileTimer = null;
    }
    this.tcnPending = false;
    this.tcFlagActive = false;
    this.pendingTcAck.clear();
    this.pendingAgreement.clear();
    this.setFastAging(false);
  }

  getConfig(): Readonly<StpConfig> { return this.config; }
  getRootBridge(): BridgeId { return this.cst().getRootBridge(); }
  getRootPort(): string | null { return this.cst().getRootPort(); }
  getRootPathCost(): number { return this.cst().getRootPathCost(); }
  isRoot(): boolean { return this.cst().isRoot(); }
  ownBridgeId(vlan = 1): BridgeId {
    return { priority: this.getVlanPriority(vlan), mac: this.config.baseMac };
  }

  getPortRole(portName: string): StpPortRole { return this.cst().getPortRole(portName); }

  getPortCost(portName: string): number {
    const known = this.cst().portInfo.get(portName)?.cost;
    if (known !== undefined) return known;
    return this.costForPort(this.host.getPort(portName));
  }

  costForPort(port: import('../hardware/Port').Port | undefined): number {
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

  getPortLinkType(portName: string): 'p2p' | 'shared' {
    return this.host.getPort(portName)?.getDuplex() === 'half'
      ? 'shared' : 'p2p';
  }

  isPointToPoint(portName: string): boolean {
    return this.getPortLinkType(portName) === 'p2p';
  }

  portCarriesVlan(portName: string, vlan: number): boolean {
    return this.portVlans(portName).includes(vlan);
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

  isTopologyChangeActive(): boolean { return this.tcFlagActive; }

  isFastAgingActive(): boolean { return this.fastAgingActive; }

  getForwardState(portName: string): StpForwardState { return this.cst().getForwardState(portName); }

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

  setVlanPriority(vlan: number, priority: number): void {
    if (priority < 0 || priority > 61440) return;
    this.vlanPriority.set(vlan, Math.floor(priority / 4096) * 4096);
    if (vlan === 1) { this.setBridgePriority(priority); return; }
    this.instanceFor(vlan).runElection();
    this.emitBpduOnAllPorts();
  }
  getVlanPriority(vlan: number): number {
    return this.vlanPriority.get(vlan) ?? this.config.bridgePriority;
  }
  setVlanHelloSec(vlan: number, sec: number): void {
    this.vlanHello.set(vlan, sec);
    if (vlan === 1) this.setHelloSec(sec);
  }
  getVlanHelloSec(vlan: number): number {
    return this.vlanHello.get(vlan) ?? this.config.helloSec;
  }
  setVlanMaxAgeSec(vlan: number, sec: number): void {
    this.vlanMaxAge.set(vlan, sec);
    if (vlan === 1) this.setMaxAgeSec(sec);
  }
  getVlanMaxAgeSec(vlan: number): number {
    return this.vlanMaxAge.get(vlan) ?? this.config.maxAgeSec;
  }
  setVlanForwardDelaySec(vlan: number, sec: number): void {
    this.vlanForwardDelay.set(vlan, sec);
    if (vlan === 1) this.setForwardDelaySec(sec);
  }
  getVlanForwardDelaySec(vlan: number): number {
    return this.vlanForwardDelay.get(vlan) ?? this.config.forwardDelaySec;
  }
  getConfiguredVlans(): number[] {
    return [...this.vlanPriority.keys()].sort((a, b) => a - b);
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

  setPortfastDefault(on: boolean): void { this.config.portfastDefault = on; }
  setBpduFilterGlobal(on: boolean): void { this.config.bpduFilterGlobal = on; }
  setLoopGuardGlobal(on: boolean): void { this.config.loopGuardGlobal = on; }
  setUplinkFast(on: boolean): void { this.config.uplinkFast = on; }
  setBackboneFast(on: boolean): void { this.config.backboneFast = on; }
  getGlobalStp(): {
    portfastDefault: boolean; bpduGuardGlobal: boolean; bpduFilterGlobal: boolean;
    loopGuardGlobal: boolean; uplinkFast: boolean; backboneFast: boolean;
  } {
    return {
      portfastDefault: this.config.portfastDefault,
      bpduGuardGlobal: this.config.bpduGuardGlobal,
      bpduFilterGlobal: this.config.bpduFilterGlobal,
      loopGuardGlobal: this.config.loopGuardGlobal,
      uplinkFast: this.config.uplinkFast,
      backboneFast: this.config.backboneFast,
    };
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

  setEnabled(on: boolean): void {
    if (this.config.enabled === on) return;
    this.config.enabled = on;
    if (on) {
      this.recomputeOnTopologyChange();
      this.armTimers();
    } else {
      this.stopTimers();
      this.ensurePortInstances();
      for (const inst of this.instances.values()) inst.forceAll('forwarding');
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
    if (this.config.portfastDefault) out.push('spanning-tree portfast default');
    if (this.config.bpduGuardGlobal) out.push('spanning-tree portfast bpduguard default');
    if (this.config.bpduFilterGlobal) out.push('spanning-tree portfast bpdufilter default');
    if (this.config.loopGuardGlobal) out.push('spanning-tree loopguard default');
    if (this.config.uplinkFast) out.push('spanning-tree uplinkfast');
    if (this.config.backboneFast) out.push('spanning-tree backbonefast');
    if (this.pathcostMethod === 'long') out.push('spanning-tree pathcost method long');
    return out;
  }

  handleFrame(portName: string, frame: EthernetFrame): void {
    if (!this.config.enabled) return;
    const payload = frame.payload as StpBpdu | undefined;
    if (!payload || payload.type !== 'stp') return;
    const port = this.host.getPort(portName);
    if (!port || !port.getIsUp() || !port.isConnected()) return;

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

    const vlan = payload.vlan ?? 1;
    const inst = this.instanceFor(vlan);
    this.getBus().publish({
      topic: 'stp.bpdu.received',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        port: portName, vlan,
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
    inst.setPortInfo(portName, info);

    if (g.rootGuard) {
      const myRoot = inst.getRootBridge();
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

    inst.runElection();

    if (this.config.mode === 'rstp' && payload.version === 2) {
      if (payload.proposal && portName === inst.getRootPort()) {
        this.pendingAgreement.add(this.vkey(vlan, portName));
        inst.jumpToForwarding(portName);
        this.sendBpdu(portName, vlan);
      }
      if (payload.agreement && inst.getPortRole(portName) === 'designated') {
        inst.jumpToForwarding(portName);
      }
      if (vlan === 1) {
        if (payload.topologyChange && !this.tcFlagActive) {
          this.startTcWhile();
        }
        if (!payload.topologyChange && portName === inst.getRootPort()) {
          this.setFastAging(false);
        }
      }
      return;
    }
    if (vlan !== 1) return;
    if (payload.topologyChangeAck && portName === inst.getRootPort()) {
      this.stopTcnRetransmission();
    }
    if (portName === inst.getRootPort() && !inst.isRoot()) {
      if (this.tcFlagActive !== payload.topologyChange) {
        this.tcFlagActive = payload.topologyChange;
        if (payload.topologyChange) this.emitBpduOnAllPorts();
      }
      this.setFastAging(payload.topologyChange);
    }
  }

  private handleTcnBpdu(portName: string): void {
    if (this.cst().getPortRole(portName) !== 'designated' && !this.isRoot()) return;
    this.getBus().publish({
      topic: 'stp.tcn.received',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        port: portName,
      },
    });
    this.pendingTcAck.add(this.vkey(1, portName));
    this.sendBpdu(portName, 1);
    this.notifyTopologyChange();
  }

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
    this.armedScheduler = s;
    if (this.tcWhileTimer !== null) s.clear(this.tcWhileTimer);
    this.tcWhileTimer = s.setTimeout(() => {
      this.tcWhileTimer = null;
      this.tcFlagActive = false;
      this.setFastAging(false);
    }, (this.config.maxAgeSec + this.config.forwardDelaySec) * 1000);
    this.emitBpduOnAllPorts();
  }

  private startTcnRetransmission(): void {
    if (!this.cst().getRootPort()) return;
    this.tcnPending = true;
    this.sendTcn();
    this.scheduleInterval('tcn', () => {
      if (this.tcnPending && this.cst().getRootPort()) this.sendTcn();
    }, this.config.helloSec * 1000);
  }

  private stopTcnRetransmission(): void {
    if (!this.tcnPending) return;
    this.tcnPending = false;
    this.clearInterval('tcn');
  }

  private sendTcn(): void {
    const portName = this.cst().getRootPort();
    if (!portName) return;
    const port = this.host.getPort(portName);
    if (!port || !port.getIsUp() || !port.isConnected()) return;
    const bpdu: StpBpdu = {
      type: 'stp', bpduType: 'tcn',
      protocolId: 0x0000, version: 0, flags: 0,
      rootBridge: this.cst().getRootBridge(),
      rootPathCost: this.cst().getRootPathCost(),
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
    this.ensurePortInstances();
    for (const port of this.host.getPorts()) {
      const name = port.getName();
      if (!port.getIsUp() || !port.isConnected()) continue;
      for (const vlan of this.portVlans(name)) {
        const inst = this.instanceFor(vlan);
        const role = inst.getPortRole(name);
        if (role !== 'designated' && !inst.isRoot()) {
          if (name === inst.getRootPort()) {
            if (!(this.config.mode === 'rstp' && this.tcFlagActive)) continue;
          } else if (role === 'alternate') continue;
        }
        this.sendBpdu(name, vlan);
      }
    }
  }

  private sendBpdu(portName: string, vlan = 1): void {
    const port = this.host.getPort(portName);
    if (!port) return;
    const adKey = this.vkey(vlan, portName);
    if (this.advertising.has(adKey)) return;
    const inst = this.instanceFor(vlan);
    const bpdu: StpBpdu = {
      type: 'stp', bpduType: 'config', vlan,
      protocolId: 0x0000,
      version: this.config.mode === 'rstp' ? 2 : 0,
      flags: 0,
      proposal: this.config.mode === 'rstp'
        && this.isPointToPoint(portName)
        && inst.getPortRole(portName) === 'designated'
        && inst.getForwardState(portName) !== 'forwarding',
      agreement: this.pendingAgreement.delete(adKey),
      rootBridge: inst.getRootBridge(),
      rootPathCost: inst.getRootPathCost(),
      senderBridge: this.ownBridgeId(vlan),
      portId: this.portIdFor(portName),
      messageAgeSec: 0,
      maxAgeSec: this.config.maxAgeSec,
      helloSec: this.config.helloSec,
      forwardDelaySec: this.config.forwardDelaySec,
      topologyChange: this.tcFlagActive,
      topologyChangeAck: this.pendingTcAck.delete(adKey),
    };
    const frame: EthernetFrame = {
      srcMAC: port.getMAC(),
      dstMAC: new MACAddress(STP_BRIDGE_MAC),
      etherType: ETHERTYPE_STP,
      payload: bpdu,
    };
    this.advertising.add(adKey);
    try { this.host.sendFrame(portName, frame); }
    finally { this.advertising.delete(adKey); }
    this.getBus().publish({
      topic: 'stp.bpdu.sent',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        port: portName, vlan,
        rootMac: inst.getRootBridge().mac, rootPriority: inst.getRootBridge().priority,
        pathCost: inst.getRootPathCost(),
      },
    });
  }

  portIdFor(portName: string): number {
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
    for (const inst of this.instances.values()) inst.expireStaleBpduInfo(now);
  }

  protected override onPortLinkUp(_portName: string): void {
    this.recomputeOnTopologyChange();
  }

  protected override onPortLinkDown(portName: string): void {
    const portFast = this.isPortFastOperational(portName);
    this.portFastLost.delete(portName);
    let wasActive = false;
    for (const inst of this.instances.values()) {
      if (inst.forgetPort(portName).wasActive) wasActive = true;
      inst.runElection();
    }
    if (wasActive && !portFast && this.config.enabled) {
      this.notifyTopologyChange();
    }
  }

  private recomputeOnTopologyChange(): void {
    this.ensurePortInstances();
    for (const inst of this.instances.values()) inst.runElection();
    this.emitBpduOnAllPorts();
  }

  private runElection(): void {
    for (const inst of this.instances.values()) inst.runElection();
  }

  private publishConfigChange(): void {
    this.getBus().publish({
      topic: 'stp.root.changed',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        oldRootMac: null, newRootMac: this.cst().getRootBridge().mac,
        newRootPriority: this.cst().getRootBridge().priority,
        rootPort: this.cst().getRootPort(),
      },
    });
  }
}
