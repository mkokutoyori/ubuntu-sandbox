import type { IScheduler, TimerHandle } from '@/events/Scheduler';
import type { IEventBus } from '@/events/EventBus';
import type { Port } from '../hardware/Port';
import {
  type BridgeId, type StpPortInfo, type StpPortRole, type StpProtocolMode,
  compareBridge, bridgeEquals,
} from './types';
import { Logger } from '../core/Logger';

export type StpForwardState =
  | 'blocking' | 'listening' | 'learning' | 'forwarding' | 'disabled';

export interface StpInstanceAgent {
  readonly deviceId: string;
  readonly deviceName: string;
  getHostname(): string;
  bus(): IEventBus;
  scheduler(): IScheduler;
  getPort(name: string): Port | undefined;
  getPorts(): Port[];
  stpLogicalPorts(): Array<{ key: string; port: Port }>;
  getMode(): StpProtocolMode;
  isEnabledStp(): boolean;
  forwardDelaySec(vlan: number): number;
  maxAgeSec(vlan: number): number;
  ownBridgeId(vlan: number): BridgeId;
  costForPort(port: Port | undefined, vlan?: number): number;
  portIdFor(portName: string, vlan?: number): number;
  isRootInconsistent(portName: string): boolean;
  clearRootInconsistent(portName: string): void;
  getVlanHelloSec(vlan: number): number;
  isLoopGuardActive(portName: string): boolean;
  isLoopInconsistent(portName: string): boolean;
  setLoopInconsistent(portName: string, on: boolean): void;
  isPortFastOperational(portName: string): boolean;
  isPointToPoint(portName: string): boolean;
  portCarriesVlan(portName: string, vlan: number): boolean;
  onInstanceForwardState(vlan: number, portName: string, state: StpForwardState): void;
  onInstanceTopologyChange(vlan: number): void;
  sendProposal(vlan: number, portName: string): void;
}

export class StpVlanInstance {
  readonly portInfo = new Map<string, StpPortInfo>();
  private readonly forwardStates = new Map<string, StpForwardState>();
  private readonly transitionTimers = new Map<string, TimerHandle>();
  private rootBridge: BridgeId;
  private rootPort: string | null = null;
  private rootPathCost = 0;
  private scheduler: IScheduler | null = null;

  constructor(
    readonly vlanId: number,
    private readonly agent: StpInstanceAgent,
  ) {
    this.rootBridge = agent.ownBridgeId(vlanId);
  }

  getRootBridge(): BridgeId { return { ...this.rootBridge }; }
  getRootPort(): string | null { return this.rootPort; }
  getRootPathCost(): number { return this.rootPathCost; }
  isRoot(): boolean { return bridgeEquals(this.rootBridge, this.agent.ownBridgeId(this.vlanId)); }
  getPortRole(portName: string): StpPortRole {
    return this.portInfo.get(portName)?.role ?? 'disabled';
  }
  getForwardState(portName: string): StpForwardState {
    return this.forwardStates.get(portName) ?? 'disabled';
  }
  hasPort(portName: string): boolean { return this.portInfo.has(portName); }
  setPortInfo(portName: string, info: StpPortInfo): void { this.portInfo.set(portName, info); }

  forgetPort(portName: string): { wasActive: boolean } {
    const fs = this.forwardStates.get(portName);
    const wasActive = fs === 'forwarding' || fs === 'learning';
    this.portInfo.delete(portName);
    this.cancelTransition(portName);
    this.forwardStates.delete(portName);
    return { wasActive };
  }

  cancelAllTransitions(): void {
    for (const portName of [...this.transitionTimers.keys()]) this.cancelTransition(portName);
  }

  expireStaleBpduInfo(nowMs: number): boolean {
    const own = this.agent.ownBridgeId(this.vlanId);
    let expired = false;
    for (const [portName, info] of this.portInfo) {
      if (bridgeEquals(info.designatedBridge, own)) continue;
      // Root Guard lifts itself once the superior BPDUs stop, well before
      // the info ages out: IOS gives the port back after roughly two Hello
      // times of silence. Without this the block is permanent and a lab
      // can never show the recovery half of the scenario.
      if (this.agent.isRootInconsistent(portName)
          && nowMs - info.ageMs > this.agent.getVlanHelloSec(this.vlanId) * 2000) {
        this.agent.clearRootInconsistent(portName);
      }
      if (nowMs - info.ageMs <= this.agent.maxAgeSec(this.vlanId) * 1000) continue;
      if (info.role !== 'designated' && this.agent.isLoopGuardActive(portName)) {
        // Real IOS: without Loop Guard, a non-designated port that stops
        // hearing BPDUs (the classic unidirectional-link failure) ages out
        // and re-elects itself designated/forwarding — creating the loop
        // the guard exists to prevent. Keep it blocked (loop-inconsistent)
        // instead, and leave the stale info in place so this keeps firing
        // (idempotently) until a fresh BPDU clears it in StpAgent.handleFrame.
        if (!this.agent.isLoopInconsistent(portName)) {
          this.agent.setLoopInconsistent(portName, true);
          expired = true;
        }
        continue;
      }
      this.portInfo.delete(portName);
      expired = true;
      this.agent.bus().publish({
        topic: 'stp.bpdu-info.expired',
        payload: {
          deviceId: this.agent.deviceId, hostname: this.agent.getHostname(),
          port: portName, vlan: this.vlanId,
          designatedBridge: `${info.designatedBridge.priority}/${info.designatedBridge.mac}`,
        },
      });
      Logger.info(this.agent.deviceId, 'stp:info-age',
        `${this.agent.deviceName}: BPDU info on ${portName} (VLAN ${this.vlanId}) aged out (max age ${this.agent.maxAgeSec(this.vlanId)}s)`);
    }
    if (expired) this.runElection();
    return expired;
  }

  runElection(): void {
    const own = this.agent.ownBridgeId(this.vlanId);
    let bestRoot: BridgeId = own;
    let bestCost = 0;
    let bestPort: string | null = null;
    let bestInfo: StpPortInfo | null = null;

    for (const [portName, info] of this.portInfo) {
      const port = this.agent.getPort(portName);
      if (!port || !port.getIsUp() || !port.isConnected()) continue;
      if (this.agent.isRootInconsistent(portName)) continue;
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

    for (const { key: name, port } of this.agent.stpLogicalPorts()) {
      if (!port.getIsUp() || !port.isConnected()) continue;
      if (!this.agent.portCarriesVlan(name, this.vlanId)) continue;
      if (this.agent.isRootInconsistent(name)) { this.applyRole(name, 'alternate'); continue; }
      if (this.agent.isLoopInconsistent(name)) { this.applyRole(name, 'alternate'); continue; }
      if (this.agent.isPortFastOperational(name) && name !== this.rootPort) {
        this.applyRole(name, 'designated');
        continue;
      }
      if (name === this.rootPort) { this.applyRole(name, 'root'); continue; }
      const info = this.portInfo.get(name);
      if (!info) { this.applyRole(name, 'designated'); continue; }
      const myAdvertised = {
        root: this.rootBridge, cost: this.rootPathCost,
        bridge: own, port: this.agent.portIdFor(name, this.vlanId),
      };
      const theirs = {
        root: info.designatedRoot, cost: info.designatedCost,
        bridge: info.designatedBridge, port: info.designatedPort,
      };
      const mine = this.bpduSuperiority(myAdvertised, theirs);
      if (mine <= 0) { this.applyRole(name, 'designated'); continue; }
      const fromSelf = bridgeEquals(info.designatedBridge, own);
      this.applyRole(name, fromSelf ? 'backup' : 'alternate');
    }

    if (rootChanged) {
      this.agent.bus().publish({
        topic: 'stp.root.changed',
        payload: {
          deviceId: this.agent.deviceId, hostname: this.agent.getHostname(),
          vlan: this.vlanId,
          oldRootMac, newRootMac: this.rootBridge.mac,
          newRootPriority: this.rootBridge.priority,
          rootPort: this.rootPort,
        },
      });
      Logger.info(this.agent.deviceId, 'stp:root-change',
        `${this.agent.deviceName}: STP root (VLAN ${this.vlanId}) → ${this.rootBridge.priority}/${this.rootBridge.mac}`);
    }
  }

  private rootPathPreference(
    a: StpPortInfo, aCost: number, aPort: string,
    b: StpPortInfo, bCost: number, bPort: string,
  ): number {
    if (aCost !== bCost) return aCost - bCost;
    const sender = compareBridge(a.designatedBridge, b.designatedBridge);
    if (sender !== 0) return sender;
    if (a.designatedPort !== b.designatedPort) return a.designatedPort - b.designatedPort;
    return this.agent.portIdFor(aPort, this.vlanId) - this.agent.portIdFor(bPort, this.vlanId);
  }

  receivedIsInferiorOnDesignated(
    portName: string,
    received: { root: BridgeId; cost: number; bridge: BridgeId; port: number },
  ): boolean {
    if (this.getPortRole(portName) !== 'designated') return false;
    return this.bpduSuperiority(received, {
      root: this.getRootBridge(),
      cost: this.getRootPathCost(),
      bridge: this.agent.ownBridgeId(this.vlanId),
      port: this.agent.portIdFor(portName, this.vlanId),
    }) > 0;
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
      const port = this.agent.getPort(portName);
      info = {
        role: 'disabled', cost: this.agent.costForPort(port, this.vlanId),
        designatedRoot: this.agent.ownBridgeId(this.vlanId),
        designatedBridge: this.agent.ownBridgeId(this.vlanId),
        designatedCost: 0,
        designatedPort: this.agent.portIdFor(portName, this.vlanId),
        ageMs: Date.now(),
      };
      this.portInfo.set(portName, info);
    }
    const oldRole = info.role;
    if (oldRole !== role) {
      info.role = role;
      this.agent.bus().publish({
        topic: 'stp.role.changed',
        payload: {
          deviceId: this.agent.deviceId, hostname: this.agent.getHostname(),
          port: portName, vlan: this.vlanId, oldRole, newRole: role,
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

  requestForwarding(portName: string): void {
    const current = this.forwardStates.get(portName);
    if (current === 'forwarding' || current === 'listening' || current === 'learning') return;
    if (this.agent.isPortFastOperational(portName) || current === undefined) {
      this.applyForwardState(portName, 'forwarding');
      return;
    }
    const rapid = this.agent.getMode() !== 'stp';
    if (rapid && portName === this.rootPort
      && this.agent.isPointToPoint(portName)) {
      this.applyForwardState(portName, 'forwarding');
      return;
    }
    this.applyForwardState(portName, 'listening');
    this.scheduleTransition(portName, 'learning');
    if (rapid && this.agent.isPointToPoint(portName)) {
      this.agent.sendProposal(this.vlanId, portName);
    }
  }

  jumpToForwarding(portName: string): void {
    this.cancelTransition(portName);
    this.applyForwardState(portName, 'forwarding');
  }

  private scheduleTransition(portName: string, next: 'learning' | 'forwarding'): void {
    this.cancelTransition(portName);
    const s = this.agent.scheduler();
    this.scheduler = s;
    const handle = s.setTimeout(() => {
      this.transitionTimers.delete(portName);
      this.applyForwardState(portName, next);
      if (next === 'learning') this.scheduleTransition(portName, 'forwarding');
    }, this.agent.forwardDelaySec(this.vlanId) * 1000);
    this.transitionTimers.set(portName, handle);
  }

  private cancelTransition(portName: string): void {
    const handle = this.transitionTimers.get(portName);
    if (handle === undefined) return;
    (this.scheduler ?? this.agent.scheduler()).clear(handle);
    this.transitionTimers.delete(portName);
  }

  private applyForwardState(portName: string, state: StpForwardState): void {
    if (state !== 'listening' && state !== 'learning') this.cancelTransition(portName);
    const previous = this.forwardStates.get(portName);
    if (previous === state) return;
    this.forwardStates.set(portName, state);
    this.agent.onInstanceForwardState(this.vlanId, portName, state);
    this.agent.bus().publish({
      topic: 'stp.port-state.changed',
      payload: {
        deviceId: this.agent.deviceId, hostname: this.agent.getHostname(),
        port: portName, vlan: this.vlanId, oldState: previous ?? null, newState: state,
      },
    });
    if (state === 'forwarding' && previous !== undefined
      && !this.agent.isPortFastOperational(portName) && this.agent.isEnabledStp()) {
      this.agent.onInstanceTopologyChange(this.vlanId);
    }
  }

  forceAll(state: StpForwardState): void {
    for (const { key } of this.agent.stpLogicalPorts()) {
      if (!this.agent.portCarriesVlan(key, this.vlanId)) continue;
      this.applyForwardState(key, state);
    }
  }
}
