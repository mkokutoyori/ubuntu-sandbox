import type { IEventBus } from '@/events/EventBus';
import { getDefaultScheduler, type IScheduler, type TimerHandle } from '@/events/Scheduler';
import { ReactiveAgentBase } from '../core/ReactiveAgentBase';
import {
  type BridgeId, type StpBpdu, type StpConfig, type StpPortInfo, type StpPortRole,
  type StpPortGuards, type MstRegion,
  createDefaultStpConfig, compareBridge, bridgeEquals, defaultPathCost, defaultPathCostLong,
  defaultPortGuards, createDefaultMstRegion, parseStpVlanList,
  ETHERTYPE_STP, STP_BRIDGE_MAC, PVST_PLUS_MAC, UPLINKFAST_DEFAULT_RATE,
} from './types';
import { StpVlanInstance, type StpInstanceAgent, type StpForwardState } from './StpVlanInstance';
import { mstConfigIdentifier, sameMstRegion, type MstConfigIdentifier } from './MstConfigId';
import { MACAddress, type EthernetFrame } from '../core/types';
import type { LinkSendRequest } from '../layers/link/LinkLayer';
import { Logger } from '../core/Logger';

export type { StpForwardState } from './StpVlanInstance';

export interface StpHost {
  readonly id: string;
  readonly name: string;
  getHostname(): string;
  getPort(name: string): import('../hardware/Port').Port | undefined;
  getPorts(): import('../hardware/Port').Port[];
  sendOnLink(request: LinkSendRequest): boolean;
  onForwardStateChanged(portName: string, state: StpForwardState, vlan: number): void;
  onStpBpduGuardErrDisable?(portName: string, senderMac: string): void;
  onTopologyChangeAging?(agingSec: number | null): void;
  getStpPortVlans?(portName: string): number[];
  /** Only real 802.1Q trunk ports get Cisco's PVST+ per-VLAN wire dressing (see `PVST_PLUS_MAC`); absent entirely on non-Cisco hosts. */
  isStpTrunkPort?(portName: string): boolean;
  getStpNativeVlan?(portName: string): number;
  /**
   * The LACP bundle a port belongs to, when it is currently bundled. STP
   * runs on the aggregate, not on its members: a Port-channel is one
   * logical link, and blocking half of it would be a bug, not a loop fix.
   */
  getStpBundleGroup?(portName: string): { groupKey: string; members: string[] } | undefined;
}

export class StpAgent extends ReactiveAgentBase implements StpInstanceAgent {
  private config: StpConfig;
  private readonly mstRegion: MstRegion = createDefaultMstRegion();
  private readonly mstInstancePriority = new Map<number, number>();
  private readonly rootRole = new Map<number, 'primary' | 'secondary'>();
  private readonly vlanPriority = new Map<number, number>();
  private readonly vlanHello = new Map<number, number>();
  private readonly vlanMaxAge = new Map<number, number>();
  private readonly vlanForwardDelay = new Map<number, number>();
  private pathcostMethod: 'short' | 'long' = 'short';
  private readonly guards = new Map<string, StpPortGuards>();
  private readonly rootInconsistent = new Set<string>();
  private readonly loopInconsistent = new Set<string>();
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
  private readonly bpduSentCounts = new Map<string, number>();
  private readonly bpduReceivedCounts = new Map<string, number>();
  private readonly forwardingTransitionCounts = new Map<string, number>();

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
  /**
   * The name STP knows a port by: its bundle key when the port is
   * currently aggregated, its own name otherwise. Every map in the agent
   * and in the instances is keyed by this, so an aggregate elects, blocks
   * and forwards as the single link it physically is.
   */
  stpKey(portName: string): string {
    return this.host.getStpBundleGroup?.(portName)?.groupKey ?? portName;
  }

  /**
   * LACP has just bundled or unbundled this port, so the name STP knows it
   * by has changed. Whatever was learned under the old name describes a
   * link that no longer exists at that granularity — left in place it wins
   * the root-port election over the aggregate, and the members keep the
   * roles they held as standalone ports. Drop both names and re-elect.
   */
  onBundleChanged(portName: string, groupKey: string, bundled: boolean): void {
    const [stale, target] = bundled ? [portName, groupKey] : [groupKey, portName];
    for (const inst of this.instances.values()) {
      // The BPDU heard under the old name was heard on this same physical
      // link, so it moves across rather than being thrown away — dropping
      // it would put the bridge back to believing it is root until the
      // next Hello, and blocking would be recomputed from nothing.
      const carried = inst.portInfo.get(stale);
      inst.forgetPort(stale);
      const own = this.ownBridgeId(inst.vlanId);
      if (carried && !bridgeEquals(carried.designatedBridge, own)) {
        inst.setPortInfo(target, { ...carried });
      }
    }
    this.recomputeOnTopologyChange();
    // The members' data-plane state is only refreshed when the aggregate's
    // own state *changes*. The second member to join finds it unchanged, so
    // it would keep the blocking it was given as a standalone port — the
    // aggregate has to be re-asserted to every member, not just the first.
    for (const inst of this.instances.values()) {
      const state = inst.getForwardState(target);
      if (state === 'disabled') continue;
      for (const vlan of this.vlansForInstanceKey(inst.vlanId)) {
        for (const member of this.stpMembers(target)) {
          this.host.onForwardStateChanged(member, state, vlan);
        }
      }
    }
  }

  /**
   * The physical port to ask the host about. Switchport config, guards and
   * link type are all held per physical interface, so a bundle key has to
   * be resolved to a member before any of them is looked up — otherwise the
   * aggregate reads as an unknown port carrying no VLAN, and stops sending
   * BPDUs entirely.
   */
  private hostPortName(name: string): string {
    if (this.host.getPort(name)) return name;
    return this.stpMembers(name)[0] ?? name;
  }

  /** The physical ports behind an STP-level name. */
  stpMembers(key: string): string[] {
    for (const port of this.host.getPorts()) {
      const group = this.host.getStpBundleGroup?.(port.getName());
      if (group?.groupKey === key) return group.members;
    }
    return [key];
  }

  /**
   * The member a bundle actually transmits through: the first one still up
   * and cabled. A logical name is never handed to the link layer — only real
   * ports carry frames.
   */
  private txMemberFor(key: string): string {
    if (this.host.getPort(key)) return key;
    const members = this.stpMembers(key);
    const live = members.find(m => {
      const p = this.host.getPort(m);
      return !!p && p.getIsUp() && p.isConnected();
    });
    return live ?? members[0] ?? key;
  }

  /** One representative port per STP-level name, in physical port order. */
  stpLogicalPorts(): Array<{ key: string; port: import('../hardware/Port').Port }> {
    const seen = new Set<string>();
    const out: Array<{ key: string; port: import('../hardware/Port').Port }> = [];
    for (const port of this.host.getPorts()) {
      const key = this.stpKey(port.getName());
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ key, port });
    }
    return out;
  }

  /**
   * Resolves an STP-level name to a real port — a bundle key resolves to
   * its first member, which is what keeps every name-keyed lookup in the
   * instances working unchanged.
   */
  getPort(name: string): import('../hardware/Port').Port | undefined {
    const direct = this.host.getPort(name);
    if (direct) return direct;
    const members = this.stpMembers(name);
    return members[0] === name ? undefined : this.host.getPort(members[0]);
  }
  getPorts(): import('../hardware/Port').Port[] { return this.host.getPorts(); }
  isEnabledStp(): boolean { return this.config.enabled; }
  /**
   * 802.1D: only the root's timers are in force. A bridge that is not the
   * root runs on the values it heard on its root port, falling back to its
   * own configuration when it is the root or has heard nothing yet.
   */
  private rootPortTimers(key: number): StpPortInfo | null {
    const inst = this.instances.get(key);
    if (!inst || inst.isRoot()) return null;
    const rootPort = inst.getRootPort();
    return rootPort ? inst.portInfo.get(rootPort) ?? null : null;
  }

  forwardDelaySec(vlan: number): number {
    return this.rootPortTimers(vlan)?.forwardDelaySec ?? this.getVlanForwardDelaySec(vlan);
  }
  maxAgeSec(vlan: number): number {
    return this.rootPortTimers(vlan)?.maxAgeSec ?? this.getVlanMaxAgeSec(vlan);
  }
  isRootInconsistent(portName: string): boolean { return this.rootInconsistent.has(portName); }
  isLoopInconsistent(portName: string): boolean { return this.loopInconsistent.has(portName); }

  setLoopInconsistent(portName: string, on: boolean): void {
    const changed = on ? !this.loopInconsistent.has(portName) : this.loopInconsistent.delete(portName);
    if (on) this.loopInconsistent.add(portName);
    if (!changed) return;
    this.getBus().publish({
      topic: 'stp.loop-guard.changed',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        port: portName, state: on ? 'inconsistent' : 'consistent',
      },
    });
    if (on) {
      Logger.warn(this.host.id, 'stp:loop-guard',
        `${this.host.name}: Loop Guard blocking ${portName} (BPDUs stopped arriving on a non-designated port)`);
    }
  }

  /** Real IOS: Loop Guard only ever operates on point-to-point, non-edge ports. */
  isLoopGuardActive(portName: string): boolean {
    const g = this.getPortGuards(portName);
    if (g.loopGuard) return true;
    if (!this.config.loopGuardGlobal) return false;
    if (g.rootGuard) return false;
    if (this.isPortFastOperational(portName)) return false;
    return this.isPointToPoint(portName);
  }
  onInstanceForwardState(key: number, portName: string, state: StpForwardState): void {
    if (state === 'forwarding') {
      this.forwardingTransitionCounts.set(portName, (this.forwardingTransitionCounts.get(portName) ?? 0) + 1);
    }
    // Fan out to every real VLAN this instance carries — the data plane
    // gates forwarding per actual 802.1Q VLAN, not per (simulator-internal)
    // instance key, and several VLANs can share one MSTI's fate.
    // The data plane is still per physical port: a bundle's STP verdict
    // has to reach every member, or half the aggregate stays blocked.
    for (const vlan of this.vlansForInstanceKey(key)) {
      for (const member of this.stpMembers(portName)) {
        this.host.onForwardStateChanged(member, state, vlan);
      }
    }
  }
  onInstanceTopologyChange(_vlan: number): void { this.notifyTopologyChange(); }
  sendProposal(vlan: number, portName: string): void { this.sendBpdu(portName, vlan); }

  /** CIST = instance 0 under real MSTP; the legacy single tree = "VLAN 1" otherwise. */
  private cstKey(): number { return this.config.mode === 'mstp' ? 0 : 1; }

  private cst(): StpVlanInstance { return this.instanceForKey(this.cstKey()); }

  private vkey(vlan: number, portName: string): string { return `${vlan}:${portName}`; }

  /**
   * Resolves a VLAN to the spanning-tree instance that actually carries it.
   * Under `stp`/`rstp` (PVST+-style) each VLAN is its own instance (identity
   * mapping). Under `mstp`, VLANs sharing an MSTI (per MstRegion) share one
   * live instance, and anything not explicitly mapped falls back to CIST (0).
   */
  private instanceKeyForVlan(vlan: number): number {
    if (this.config.mode !== 'mstp') return vlan;
    for (const [instanceId, vlanSpec] of this.mstRegion.instances) {
      if (parseStpVlanList(vlanSpec).includes(vlan)) return instanceId;
    }
    return 0;
  }

  private instanceForKey(key: number): StpVlanInstance {
    let inst = this.instances.get(key);
    if (!inst) { inst = new StpVlanInstance(key, this); this.instances.set(key, inst); }
    return inst;
  }

  private instanceForVlan(vlan: number): StpVlanInstance {
    return this.instanceForKey(this.instanceKeyForVlan(vlan));
  }

  /** All VLANs (as actually carried by some port) that resolve to the given instance key. */
  private vlansForInstanceKey(key: number): number[] {
    if (this.config.mode !== 'mstp') return [key];
    const seen = new Set<number>();
    for (const port of this.host.getPorts()) {
      for (const vlan of this.portVlans(port.getName())) seen.add(vlan);
    }
    return [...seen].filter(v => this.instanceKeyForVlan(v) === key);
  }

  private portVlans(portName: string): number[] {
    const v = this.host.getStpPortVlans?.(this.hostPortName(portName));
    // A genuinely empty array (e.g. an L2PT-tunneled port) means "no local
    // STP participation at all" — only a missing hook falls back to VLAN 1.
    return v ?? [1];
  }

  private ensurePortInstances(): void {
    for (const port of this.host.getPorts()) {
      if (!port.getIsUp() || !port.isConnected()) continue;
      for (const vlan of this.portVlans(port.getName())) this.instanceForVlan(vlan);
    }
  }

  getActiveStpVlans(): number[] {
    return [...this.instances.keys()].sort((a, b) => a - b);
  }
  getRootBridgeForInstance(key: number): BridgeId {
    return this.instanceForKey(key).getRootBridge();
  }
  getRootPortForInstance(key: number): string | null {
    return this.instanceForKey(key).getRootPort();
  }
  getRootPathCostForInstance(key: number): number {
    return this.instanceForKey(key).getRootPathCost();
  }
  getPortInfoForInstance(key: number, portName: string): StpPortInfo | null {
    return this.instanceForKey(key).portInfo.get(portName) ?? null;
  }
  isRootForInstance(key: number): boolean {
    return this.instanceForKey(key).isRoot();
  }
  getPortRoleForInstance(key: number, portName: string): StpPortRole {
    return this.instanceForKey(key).getPortRole(portName);
  }
  getForwardStateForInstance(key: number, portName: string): StpForwardState {
    return this.instanceForKey(key).getForwardState(portName);
  }
  getPortCostForInstance(key: number, portName: string): number {
    const known = this.instanceForKey(key).portInfo.get(portName)?.cost;
    if (known !== undefined) return known;
    return this.costForPort(this.host.getPort(portName));
  }

  getRootBridgeForVlan(vlan: number): BridgeId {
    return this.getRootBridgeForInstance(this.instanceKeyForVlan(vlan));
  }
  getRootPortForVlan(vlan: number): string | null {
    return this.getRootPortForInstance(this.instanceKeyForVlan(vlan));
  }
  getRootPathCostForVlan(vlan: number): number {
    return this.getRootPathCostForInstance(this.instanceKeyForVlan(vlan));
  }
  getPortInfoForVlan(vlan: number, portName: string): StpPortInfo | null {
    return this.getPortInfoForInstance(this.instanceKeyForVlan(vlan), portName);
  }
  isRootForVlan(vlan: number): boolean {
    return this.isRootForInstance(this.instanceKeyForVlan(vlan));
  }
  getPortRoleForVlan(vlan: number, portName: string): StpPortRole {
    return this.getPortRoleForInstance(this.instanceKeyForVlan(vlan), portName);
  }
  getForwardStateForVlan(vlan: number, portName: string): StpForwardState {
    return this.getForwardStateForInstance(this.instanceKeyForVlan(vlan), portName);
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
  /**
   * The Extended System ID (802.1t): the VLAN — or the MSTI — lives in the
   * low 12 bits of the priority, which is why a configured priority is
   * always a multiple of 4096. Carrying it here means the value compared by
   * the election, the value put on the wire and the value `show
   * spanning-tree` prints are one and the same.
   */
  ownBridgeId(key = this.cstKey()): BridgeId {
    const configured = this.config.mode === 'mstp'
      ? this.getMstInstancePriority(key)
      : this.getVlanPriority(key);
    return { priority: configured + this.extendedSystemId(key), mac: this.config.baseMac };
  }

  /**
   * The instance number carried in the low 12 bits of a bridge priority.
   * VRP prints the configured priority instead, so its `display stp` takes
   * this back off rather than keeping a second copy of the arithmetic.
   */
  extendedSystemId(key = this.cstKey()): number { return key & 0xfff; }

  getPortRole(portName: string): StpPortRole { return this.cst().getPortRole(portName); }

  getPortCost(portName: string): number {
    return this.getPortCostForInstance(this.cstKey(), portName);
  }

  /**
   * `spanning-tree [vlan <v>] cost <n>` / `port-priority <n>`. An operator
   * value wins over the speed-derived one; a per-VLAN value wins over the
   * port-wide one. Absent both, nothing changes from the auto behaviour.
   */
  private readonly portCostOverride = new Map<string, number>();
  private readonly portPriorityOverride = new Map<string, number>();

  private overrideOf(map: Map<string, number>, portName: string, vlan?: number): number | undefined {
    if (vlan !== undefined) {
      const perVlan = map.get(`${vlan}:${portName}`);
      if (perVlan !== undefined) return perVlan;
    }
    return map.get(portName);
  }

  setPortCost(portName: string, cost: number | null, vlan?: number): void {
    const key = vlan === undefined ? portName : `${vlan}:${portName}`;
    if (cost === null) this.portCostOverride.delete(key);
    else this.portCostOverride.set(key, cost);
    this.recomputeOnTopologyChange();
  }

  setPortPriority(portName: string, priority: number | null, vlan?: number): void {
    const key = vlan === undefined ? portName : `${vlan}:${portName}`;
    if (priority === null) this.portPriorityOverride.delete(key);
    // Real IOS rounds port-priority down to the nearest multiple of 16.
    else this.portPriorityOverride.set(key, Math.floor(priority / 16) * 16);
    this.recomputeOnTopologyChange();
  }

  getPortCostOverride(portName: string, vlan?: number): number | undefined {
    return this.overrideOf(this.portCostOverride, portName, vlan);
  }
  getPortPriorityOverride(portName: string, vlan?: number): number | undefined {
    return this.overrideOf(this.portPriorityOverride, portName, vlan);
  }

  costForPort(port: import('../hardware/Port').Port | undefined, vlan?: number): number {
    const name = port?.getName();
    if (name !== undefined) {
      const key = this.stpKey(name);
      const override = this.overrideOf(this.portCostOverride, key, vlan)
        ?? this.overrideOf(this.portCostOverride, name, vlan);
      if (override !== undefined) return override;
    }
    // A bundle's cost comes from the bandwidth it actually aggregates, so
    // adding a second member really does make the aggregate cheaper.
    const bundle = name !== undefined ? this.host.getStpBundleGroup?.(name) : undefined;
    const speed = bundle
      ? bundle.members.reduce((sum, m) => sum + (this.host.getPort(m)?.getSpeed() ?? 0), 0)
      : (port?.getSpeed() ?? 0);
    const kbps = speed * 1000;
    return this.pathcostMethod === 'long' ? defaultPathCostLong(kbps) : defaultPathCost(kbps);
  }

  getPathcostMethod(): 'short' | 'long' { return this.pathcostMethod; }
  setPathcostMethod(method: 'short' | 'long'): void { this.pathcostMethod = method; }

  getMstInstancePriority(instanceId: number): number {
    return this.mstInstancePriority.get(instanceId) ?? 32768;
  }
  setMstInstancePriority(instanceId: number, priority: number): void {
    this.mstInstancePriority.set(instanceId, Math.floor(priority / 4096) * 4096);
    if (this.config.mode !== 'mstp') return;
    this.instanceForKey(instanceId).runElection();
    this.emitBpduOnAllPorts();
  }
  getConfiguredMstInstancePriorities(): [number, number][] {
    return [...this.mstInstancePriority].sort((a, b) => a[0] - b[0]);
  }
  clearMstInstancePriority(instanceId: number): void {
    this.mstInstancePriority.delete(instanceId);
    if (this.config.mode !== 'mstp') return;
    this.instanceForKey(instanceId).runElection();
    this.emitBpduOnAllPorts();
  }

  setCistPriority(priority: number): void {
    this.setBridgePriority(priority);
    this.setMstInstancePriority(0, priority);
  }

  getRootRole(instanceId: number): 'primary' | 'secondary' | null {
    return this.rootRole.get(instanceId) ?? null;
  }
  getConfiguredRootRoles(): [number, 'primary' | 'secondary'][] {
    return [...this.rootRole].sort((a, b) => a[0] - b[0]);
  }
  setRootRole(instanceId: number, role: 'primary' | 'secondary' | null): void {
    if (role === null) this.rootRole.delete(instanceId);
    else this.rootRole.set(instanceId, role);
    const priority = role === 'primary' ? 0 : role === 'secondary' ? 4096 : 32768;
    if (instanceId !== 0) {
      if (role === null) this.clearMstInstancePriority(instanceId);
      else this.setMstInstancePriority(instanceId, priority);
      return;
    }
    this.setCistPriority(priority);
  }

  getPortLinkType(portName: string): 'p2p' | 'shared' {
    return this.getPort(portName)?.getDuplex() === 'half'
      ? 'shared' : 'p2p';
  }

  isPointToPoint(portName: string): boolean {
    return this.getPortLinkType(portName) === 'p2p';
  }

  portCarriesVlan(portName: string, key: number): boolean {
    if (this.config.mode !== 'mstp') return this.portVlans(portName).includes(key);
    return this.portVlans(portName).some(v => this.instanceKeyForVlan(v) === key);
  }

  getMstRegion(): MstRegion { return this.mstRegion; }

  getMstConfigIdentifier(): MstConfigIdentifier { return mstConfigIdentifier(this.mstRegion); }

  /**
   * IEEE 802.1Q §13.8 : hors de sa region, un pont n'echange que le CIST.
   */
  private isBoundaryBpdu(payload: StpBpdu, key: number): boolean {
    if (this.config.mode !== 'mstp') return false;
    if (key === this.cstKey()) return false;
    if (!payload.mstConfigId) return true;
    return !sameMstRegion(payload.mstConfigId, mstConfigIdentifier(this.mstRegion));
  }
  setMstName(name: string): void { this.mstRegion.name = name; }
  setMstRevision(rev: number): void { this.mstRegion.revision = rev; }
  mapMstInstance(instanceId: number, vlans: string): void {
    this.mstRegion.instances.set(instanceId, vlans);
    this.recomputeOnTopologyChange();
  }
  unmapMstInstance(instanceId: number): void {
    this.mstRegion.instances.delete(instanceId);
    this.recomputeOnTopologyChange();
  }
  applyMstRegion(name: string, revision: number, instances: [number, string][]): void {
    this.mstRegion.name = name;
    this.mstRegion.revision = revision;
    this.mstRegion.instances.clear();
    for (const [id, vlans] of instances) this.mstRegion.instances.set(id, vlans);
    this.recomputeOnTopologyChange();
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
    this.instanceForVlan(vlan).runElection();
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
    const key = this.hostPortName(portName);
    let g = this.guards.get(key);
    if (!g) { g = defaultPortGuards(); this.guards.set(key, g); }
    return g;
  }

  setPortFast(portName: string, on: boolean): void {
    this.getPortGuards(portName).portFast = on;
    if (!on) this.portFastLost.delete(portName);
  }

  isPortFastOperational(portName: string): boolean {
    const key = this.hostPortName(portName);
    return this.guards.get(key)?.portFast === true
      && !this.portFastLost.has(key);
  }

  setPortBpduGuard(portName: string, on: boolean): void {
    this.getPortGuards(portName).bpduGuard = on;
  }

  setPortRootGuard(portName: string, on: boolean): void {
    this.getPortGuards(portName).rootGuard = on;
  }

  setPortBpduFilter(portName: string, on: boolean): void {
    this.getPortGuards(portName).bpduFilter = on;
  }

  setPortLoopGuard(portName: string, on: boolean): void {
    this.getPortGuards(portName).loopGuard = on;
    if (on || !this.loopInconsistent.has(portName)) return;
    // Guard removed while the port was being held loop-inconsistent: real
    // IOS drops the condition immediately and lets the port reconverge
    // normally rather than staying blocked with no guard left to justify it.
    this.setLoopInconsistent(portName, false);
    for (const inst of this.instances.values()) inst.forgetPort(portName);
    this.recomputeOnTopologyChange();
  }

  /**
   * Real IOS: `bpdufilter enable` on an interface unconditionally suppresses
   * BPDU tx/rx on that port (dangerous if misused — no automatic recovery).
   * `portfast bpdufilter default` only filters while the port is still
   * PortFast-operational; the moment it hears a BPDU it loses that status
   * (handleFrame) and this naturally stops filtering from then on.
   */
  isBpduFilterHardEnabled(portName: string): boolean {
    return this.guards.get(portName)?.bpduFilter === true;
  }

  isBpduFilterEffective(portName: string): boolean {
    if (this.isBpduFilterHardEnabled(portName)) return true;
    return this.config.bpduFilterGlobal && this.isPortFastOperational(portName);
  }

  setBpduGuardGlobal(on: boolean): void {
    this.config.bpduGuardGlobal = on;
  }

  setPortfastDefault(on: boolean): void { this.config.portfastDefault = on; }
  setBpduFilterGlobal(on: boolean): void { this.config.bpduFilterGlobal = on; }
  setLoopGuardGlobal(on: boolean): void { this.config.loopGuardGlobal = on; }
  setUplinkFast(on: boolean, maxUpdateRate?: number): void {
    this.config.uplinkFast = on;
    this.config.uplinkFastMaxUpdateRate = on
      ? maxUpdateRate ?? this.config.uplinkFastMaxUpdateRate
      : UPLINKFAST_DEFAULT_RATE;
  }
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

  /**
   * `no spanning-tree vlan <n>` ne coupe QUE ce VLAN : son instance
   * cesse d'elire et ses ports passent en acheminement, les autres
   * arbres continuant de tourner. Le drapeau global `enabled` reste ce
   * qu'il etait, sans quoi couper un VLAN de laboratoire desarmerait la
   * protection contre les boucles de tous les autres.
   */
  setVlanStpEnabled(vlan: number, on: boolean): void {
    if (on) {
      if (!this.config.disabledVlans.delete(vlan)) return;
      this.recomputeOnTopologyChange();
      this.armTimers();
      return;
    }
    if (this.config.disabledVlans.has(vlan)) return;
    this.config.disabledVlans.add(vlan);
    this.ensurePortInstances();
    this.instances.get(vlan)?.forceAll('forwarding');
  }

  isVlanStpEnabled(vlan: number): boolean {
    return this.config.enabled && !this.config.disabledVlans.has(vlan);
  }

  runningConfigGlobalLines(): string[] {
    const out: string[] = [];
    if (!this.config.enabled) out.push('no spanning-tree vlan 1');
    for (const vlan of [...this.config.disabledVlans].sort((a, b) => a - b)) {
      out.push(`no spanning-tree vlan ${vlan}`);
    }
    /*
     * Le mode est rendu MEME quand c'est le defaut. Un Catalyst ecrit
     * `spanning-tree mode pvst` dans sa configuration d'usine — la
     * sortie `show running-config | section spanning` d'un vrai 2960 le
     * montre — et l'omettre au motif que c'est le defaut faisait
     * disparaitre la ligne que l'operateur venait de taper.
     */
    out.push(`spanning-tree mode ${
      this.config.mode === 'mstp' ? 'mst'
        : this.config.mode === 'rstp' ? 'rapid-pvst' : 'pvst'}`);
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
    if (this.config.uplinkFast) {
      out.push('spanning-tree uplinkfast'
        + (this.config.uplinkFastMaxUpdateRate === UPLINKFAST_DEFAULT_RATE
          ? '' : ` max-update-rate ${this.config.uplinkFastMaxUpdateRate}`));
    }
    if (this.config.backboneFast) out.push('spanning-tree backbonefast');
    if (this.pathcostMethod === 'long') out.push('spanning-tree pathcost method long');
    for (const vlan of this.configuredVlans()) {
      const prio = this.vlanPriority.get(vlan);
      if (prio !== undefined) out.push(`spanning-tree vlan ${vlan} priority ${prio}`);
      const hello = this.vlanHello.get(vlan);
      if (hello !== undefined) out.push(`spanning-tree vlan ${vlan} hello-time ${hello}`);
      const maxAge = this.vlanMaxAge.get(vlan);
      if (maxAge !== undefined) out.push(`spanning-tree vlan ${vlan} max-age ${maxAge}`);
      const fwd = this.vlanForwardDelay.get(vlan);
      if (fwd !== undefined) out.push(`spanning-tree vlan ${vlan} forward-time ${fwd}`);
    }
    out.push(...this.runningConfigMstLines());
    return out;
  }

  private configuredVlans(): number[] {
    const vlans = new Set<number>([
      ...this.vlanPriority.keys(), ...this.vlanHello.keys(),
      ...this.vlanMaxAge.keys(), ...this.vlanForwardDelay.keys(),
    ]);
    vlans.delete(1);
    return [...vlans].sort((a, b) => a - b);
  }

  runningConfigMstLines(): string[] {
    const r = this.mstRegion;
    if (!r.name && r.revision === 0 && r.instances.size === 0) return [];
    const out = ['spanning-tree mst configuration'];
    if (r.name) out.push(` name ${r.name}`);
    if (r.revision !== 0) out.push(` revision ${r.revision}`);
    for (const [instance, vlans] of [...r.instances].sort((a, b) => a[0] - b[0])) {
      out.push(` instance ${instance} vlan ${vlans}`);
    }
    return out;
  }

  handleFrame(physicalPort: string, frame: EthernetFrame): void {
    if (!this.config.enabled) return;
    if (!this.isRunning()) return;
    const payload = frame.payload as StpBpdu | undefined;
    if (!payload || payload.type !== 'stp') return;
    const port = this.host.getPort(physicalPort);
    if (!port || !port.getIsUp() || !port.isConnected()) return;
    // A BPDU heard on any member is a BPDU heard by the aggregate.
    const portName = this.stpKey(physicalPort);
    // Hard `bpdufilter enable`: the port drops every BPDU it receives, full
    // stop — unlike the portfast-driven "default" mode, there is no
    // automatic recovery baked into this override in real IOS either.
    if (this.isBpduFilterHardEnabled(portName)) return;
    this.bpduReceivedCounts.set(portName, (this.bpduReceivedCounts.get(portName) ?? 0) + 1);

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

    const key = payload.cist ? this.cstKey() : (payload.vlan ?? 1);
    if (this.isBoundaryBpdu(payload, key)) {
      Logger.info(this.host.id, 'stp:boundary',
        `${this.host.name}: MSTI ${key} BPDU on ${portName} ignored, sender is in another MST region`);
      return;
    }
    const inst = this.instanceForKey(key);
    // 802.1D: a BPDU whose Message Age has already reached Max Age is past
    // its useful life and is discarded rather than acted on — this is what
    // caps the network diameter a given Max Age can support.
    if (payload.messageAgeSec >= this.maxAgeSec(key)) {
      Logger.info(this.host.id, 'stp:message-age',
        `${this.host.name}: BPDU on ${portName} discarded, message age ${payload.messageAgeSec}s reached max age ${this.maxAgeSec(key)}s`);
      return;
    }
    this.getBus().publish({
      topic: 'stp.bpdu.received',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        port: portName, vlan: key,
        senderMac: payload.senderBridge.mac,
        rootMac: payload.rootBridge.mac,
      },
    });
    // BackboneFast: an inferior BPDU from the same neighbour means that
    // neighbour has lost its own path to the root — an indirect link
    // failure. Without it the port sits on stale information until Max Age
    // runs out; with it, the information is dropped now and the election
    // reruns immediately, which is the whole point of the feature.
    const previous = inst.portInfo.get(portName);
    if (this.config.backboneFast && previous
        && bridgeEquals(previous.designatedBridge, payload.senderBridge)
        && compareBridge(payload.rootBridge, previous.designatedRoot) > 0) {
      const role = previous.role;
      if (role === 'root' || role === 'alternate' || role === 'backup') {
        Logger.info(this.host.id, 'stp:backbonefast',
          `${this.host.name}: BackboneFast — inferior BPDU on ${portName}, skipping max age`);
        inst.portInfo.delete(portName);
        inst.runElection();
      }
    }

    const cost = this.costForPort(port);
    const info: StpPortInfo = {
      role: 'disabled',
      cost,
      designatedRoot: { ...payload.rootBridge },
      designatedBridge: { ...payload.senderBridge },
      designatedCost: payload.rootPathCost,
      designatedPort: payload.portId,
      ageMs: this.nowMs(),
      helloSec: payload.helloSec,
      maxAgeSec: payload.maxAgeSec,
      forwardDelaySec: payload.forwardDelaySec,
      messageAgeSec: payload.messageAgeSec,
    };
    inst.setPortInfo(portName, info);
    // A BPDU arrived on this port again — whatever kept it loop-inconsistent
    // (its neighbor's transmit path was down) is resolved.
    this.setLoopInconsistent(portName, false);

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

    const rootAvant = inst.getRootBridge();
    const coutAvant = inst.getRootPathCost();
    inst.runElection();

    this.finirBpduConfig(payload, portName, key, inst);

    if (inst.receivedIsInferiorOnDesignated(portName, {
      root: payload.rootBridge, cost: payload.rootPathCost,
      bridge: payload.senderBridge, port: payload.portId,
    })) {
      this.sendBpdu(portName, key);
    } else if (!bridgeEquals(rootAvant, inst.getRootBridge())
      || coutAvant !== inst.getRootPathCost()) {
      this.emitBpduOnAllPorts();
    }
  }

  private finirBpduConfig(
    payload: StpBpdu, portName: string, key: number, inst: StpVlanInstance,
  ): void {
    if ((this.config.mode === 'rstp' || this.config.mode === 'mstp') && payload.version === 2) {
      if (payload.proposal && portName === inst.getRootPort()) {
        this.pendingAgreement.add(this.vkey(key, portName));
        inst.jumpToForwarding(portName);
        this.sendBpdu(portName, key);
      }
      if (payload.agreement && inst.getPortRole(portName) === 'designated') {
        inst.jumpToForwarding(portName);
      }
      if (key === this.cstKey()) {
        if (payload.topologyChange && !this.tcFlagActive) {
          this.startTcWhile();
        }
        if (!payload.topologyChange && portName === inst.getRootPort()) {
          this.setFastAging(false);
        }
      }
      return;
    }
    if (key !== this.cstKey()) return;
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
    if (this.config.mode !== 'stp' || this.isRoot()) {
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
    this.host.sendOnLink({
      iface: this.txMemberFor(portName),
      destination: new MACAddress(STP_BRIDGE_MAC),
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
    // One BPDU per logical port: a bundle speaks once, through whichever
    // member is up, not once per member.
    for (const { key: name, port } of this.stpLogicalPorts()) {
      if (!port.getIsUp() || !port.isConnected()) continue;
      const keys = new Set(this.portVlans(name).map(v => this.instanceKeyForVlan(v)));
      for (const key of keys) {
        const inst = this.instanceForKey(key);
        const role = inst.getPortRole(name);
        if (role !== 'designated' && !inst.isRoot()) {
          if (name === inst.getRootPort()) {
            if (!(this.config.mode !== 'stp' && this.tcFlagActive)) continue;
          } else if (role === 'alternate') continue;
        }
        this.sendBpdu(name, key);
      }
    }
  }

  private sendBpdu(portName: string, key = 1): void {
    // Le SEUL point d'emission : gardez-le ici et les dix appelants sont
    // couverts, y compris ceux qui n'ont pas de boucle a border.
    if (!this.isVlanStpEnabled(key)) return;
    const port = this.host.getPort(portName);
    if (!port) return;
    if (this.isBpduFilterEffective(portName)) return;
    const adKey = this.vkey(key, portName);
    if (this.advertising.has(adKey)) return;
    const inst = this.instanceForKey(key);
    const rapid = this.config.mode !== 'stp';
    const bpdu: StpBpdu = {
      type: 'stp', bpduType: 'config', vlan: key, cist: key === this.cstKey(),
      mstConfigId: this.config.mode === 'mstp'
        ? mstConfigIdentifier(this.mstRegion) : undefined,
      protocolId: 0x0000,
      version: rapid ? 2 : 0,
      flags: 0,
      proposal: rapid
        && this.isPointToPoint(portName)
        && inst.getPortRole(portName) === 'designated'
        && inst.getForwardState(portName) !== 'forwarding',
      agreement: this.pendingAgreement.delete(adKey),
      rootBridge: inst.getRootBridge(),
      rootPathCost: inst.getRootPathCost(),
      senderBridge: this.ownBridgeId(key),
      portId: this.portIdFor(portName, key),
      // The root originates at 0; every bridge that relays the root's BPDU
      // adds a hop, and the timers relayed are the root's, not this
      // bridge's own configuration.
      messageAgeSec: inst.isRoot() ? 0 : (this.rootPortTimers(key)?.messageAgeSec ?? 0) + 1,
      maxAgeSec: this.maxAgeSec(key),
      helloSec: this.rootPortTimers(key)?.helloSec ?? this.getVlanHelloSec(key),
      forwardDelaySec: this.forwardDelaySec(key),
      topologyChange: this.tcFlagActive,
      topologyChangeAck: this.pendingTcAck.delete(adKey),
    };
    // Real IOS sends the CST BPDU on a trunk's native VLAN (and on any
    // access port) untagged to the IEEE bridge address, but dresses the
    // per-VLAN PVST+ hello for every OTHER VLAN on a trunk as an
    // 802.1Q-tagged frame to Cisco's proprietary SSTP MAC. VLAN demux
    // inside this engine still runs off `bpdu.vlan` (unchanged) — this
    // only fixes what a `tcpdump` capture or `show`-style inspection would
    // see on the wire, not the internal per-VLAN dispatch mechanism.
    const nativeVlan = this.host.getStpNativeVlan?.(this.hostPortName(portName)) ?? 1;
    const pvstPlus = this.config.mode !== 'mstp'
      && (this.host.isStpTrunkPort?.(this.hostPortName(portName)) ?? false)
      && key !== nativeVlan;
    this.advertising.add(adKey);
    this.bpduSentCounts.set(portName, (this.bpduSentCounts.get(portName) ?? 0) + 1);
    try {
      this.host.sendOnLink({
        iface: this.txMemberFor(portName),
        destination: new MACAddress(pvstPlus ? PVST_PLUS_MAC : STP_BRIDGE_MAC),
        etherType: ETHERTYPE_STP,
        payload: bpdu,
        ...(pvstPlus ? { dot1q: { tpid: 0x8100, pcp: 0, dei: 0, vid: key } } : {}),
      });
    } finally { this.advertising.delete(adKey); }
    this.getBus().publish({
      topic: 'stp.bpdu.sent',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        port: portName, vlan: key,
        rootMac: inst.getRootBridge().mac, rootPriority: inst.getRootBridge().priority,
        pathCost: inst.getRootPathCost(),
      },
    });
  }

  portIdFor(portName: string, vlan?: number): number {
    const member = this.stpMembers(portName)[0] ?? portName;
    const idx = this.host.getPorts().findIndex(p => p.getName() === member);
    const priority = this.overrideOf(this.portPriorityOverride, portName, vlan) ?? 0x80;
    return ((priority & 0xff) << 8) | (idx & 0xff);
  }

  portNumberFor(portName: string): number {
    return this.host.getPorts().findIndex(p => p.getName() === portName) + 1;
  }

  getBpduSentCount(portName: string): number { return this.bpduSentCounts.get(portName) ?? 0; }
  getBpduReceivedCount(portName: string): number { return this.bpduReceivedCounts.get(portName) ?? 0; }
  getForwardingTransitionCount(portName: string): number { return this.forwardingTransitionCounts.get(portName) ?? 0; }

  protected isEnabled(): boolean { return this.config.enabled; }

  protected armTimers(): void {
    this.scheduleInterval('hello', () => this.emitBpduOnAllPorts(),
      this.config.helloSec * 1000);
    this.scheduleInterval('info-age', () => this.expireStaleBpduInfo(), 1_000);
  }

  /**
   * The clock STP ages against. It has to be the scheduler's, not the wall
   * clock: the timers that drive ageing and err-disable recovery run on the
   * injected scheduler, and under a virtual one wall time never moves — so
   * a `Date.now()` stamp compared on a scheduler tick never elapses.
   */
  nowMs(): number { return this.getScheduler().now(); }

  private expireStaleBpduInfo(): void {
    if (!this.config.enabled) return;
    const now = this.nowMs();
    for (const inst of this.instances.values()) inst.expireStaleBpduInfo(now);
  }

  protected override onPortLinkUp(_portName: string): void {
    this.recomputeOnTopologyChange();
  }

  protected override onPortLinkDown(portName: string): void {
    const portFast = this.isPortFastOperational(portName);
    this.portFastLost.delete(portName);
    this.loopInconsistent.delete(portName);
    // A port that is down carries no superior BPDU any more, so Root Guard
    // has nothing left to justify it. Without this the flag outlives the
    // BPDU info the ageing loop needs, and the port stays blocked forever.
    this.clearRootInconsistent(portName);
    let wasActive = false;
    for (const [, inst] of this.instances) {
      const wasRootPort = inst.getRootPort() === portName;
      if (inst.forgetPort(portName).wasActive) wasActive = true;
      inst.runElection();
      // UplinkFast: a non-root switch whose root port just died fails over
      // to an already-known backup port immediately instead of waiting out
      // the normal listening/learning delay — real IOS's headline benefit
      // of the feature. (The CAM-flush multicast burst that also speeds up
      // upstream MAC learning is not modeled — out of scope for this pass.)
      if (this.config.uplinkFast && wasRootPort && !inst.isRoot()) {
        const newRootPort = inst.getRootPort();
        if (newRootPort) inst.jumpToForwarding(newRootPort);
      }
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
