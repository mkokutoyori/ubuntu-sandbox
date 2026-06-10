import type { IEventBus } from '@/events/EventBus';
import { getDefaultScheduler, type IScheduler } from '@/events/Scheduler';
import { ReactiveAgentBase } from '../core/ReactiveAgentBase';
import {
  type BridgeId, type StpBpdu, type StpConfig, type StpPortInfo, type StpPortRole,
  type StpPortGuards,
  createDefaultStpConfig, compareBridge, bridgeEquals, defaultPathCost,
  defaultPortGuards,
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
}

export class StpAgent extends ReactiveAgentBase {
  private config: StpConfig;
  private readonly portInfo = new Map<string, StpPortInfo>();
  private readonly guards = new Map<string, StpPortGuards>();
  private readonly rootInconsistent = new Set<string>();
  private readonly advertising = new Set<string>();
  private readonly forwardStates = new Map<string, StpForwardState>();
  private readonly transitionTimers = new Map<string, TimerHandle>();
  private rootBridge: BridgeId;
  private rootPort: string | null = null;
  private rootPathCost = 0;

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
    super.stop();
    // Cancel pending 802.1D listening/learning transitions — a stopped
    // agent must not flip port states later.
    for (const portName of [...this.transitionTimers.keys()]) {
      this.cancelTransition(portName);
    }
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
    if (payload.bpduType !== 'config') return;
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

    this.getBus().publish({
      topic: 'stp.bpdu.received',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        port: portName,
        senderMac: payload.senderBridge.mac,
        rootMac: payload.rootBridge.mac,
      },
    });
    const cost = defaultPathCost(port.getSpeed());
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
  }

  emitBpduOnAllPorts(): void {
    if (!this.config.enabled) return;
    for (const port of this.host.getPorts()) {
      const name = port.getName();
      if (!port.getIsUp() || !port.isConnected()) continue;
      const role = this.portInfo.get(name)?.role;
      if (role !== 'designated' && !this.isRoot()) {
        if (name === this.rootPort) continue;
        if (role === 'alternate') continue;
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
      protocolId: 0x0000, version: 0,
      flags: 0,
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
  }

  protected override onPortLinkUp(_portName: string): void {
    this.recomputeOnTopologyChange();
  }

  protected override onPortLinkDown(portName: string): void {
    this.portInfo.delete(portName);
    // Forget the applied forward state so a re-connected link is treated as a
    // fresh edge port (rapid transition), matching the link-up fast path in
    // the Switch base class.
    this.cancelTransition(portName);
    this.forwardStates.delete(portName);
    this.runElection();
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
      if (guards?.portFast && name !== this.rootPort) {
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
      if (mine <= 0) this.applyRole(name, 'designated');
      else this.applyRole(name, 'alternate');
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
      const cost = port ? defaultPathCost(port.getSpeed()) : 19;
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
    } else if (role === 'alternate') {
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
    const portFast = this.guards.get(portName)?.portFast === true;
    if (portFast || current === undefined) {
      this.applyForwardState(portName, 'forwarding');
      return;
    }
    this.applyForwardState(portName, 'listening');
    this.scheduleTransition(portName, 'learning');
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
