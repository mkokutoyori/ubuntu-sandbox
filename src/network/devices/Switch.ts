/**
 * Switch - Abstract Layer 2 switching device base class
 *
 * Implements common L2 switching logic shared by all vendors:
 *   - VLAN database (802.1Q tagging)
 *   - MAC address table with configurable aging (default 300s)
 *   - Access / Trunk port modes
 *   - Native VLAN on trunk links
 *   - Trunk allowed VLAN filtering
 *   - Running-config / Startup-config (NVRAM simulation)
 *
 * Vendor-specific behavior (overridden by subclasses):
 *   - Port naming: Cisco (FastEthernet0/X) vs Huawei (GigabitEthernet0/0/X)
 *   - STP initial state: Cisco (forwarding/PortFast) vs Huawei (listening/802.1D)
 *   - VLAN deletion: Cisco (suspend ports) vs Huawei (move to default VLAN)
 *   - CLI Shell: CiscoSwitchShell vs HuaweiSwitchShell (in shells/ directory)
 *   - Boot sequence and OS type
 *
 * Concrete subclasses: CiscoSwitch, HuaweiSwitch
 *
 * Frame processing pipeline:
 *   1. Ingress: determine VLAN from port mode (access VLAN or 802.1Q tag)
 *   2. MAC learning: associate srcMAC + VLAN → ingress port
 *   3. Forward decision:
 *      a. Broadcast/unknown unicast → flood within VLAN
 *      b. Known unicast → forward to specific port (if same VLAN)
 *   4. Egress: strip or add 802.1Q tag based on egress port mode
 */

import { Equipment } from '../equipment/Equipment';
import { Port } from '../hardware/Port';
import { EthernetFrame, DeviceType, MACAddress, ETHERTYPE_ARP, ARPPacket, IPAddress, ETHERTYPE_IPV4, IPv4Packet } from '../core/types';
import { Logger } from '../core/Logger';
import {
  getDefaultScheduler,
  type IScheduler,
  type TimerHandle,
} from '@/events/Scheduler';
import {
  DHCPSnoopingConfig,
  DHCPSnoopingBinding,
  createDefaultSnoopingConfig,
} from '../dhcp/types';
import {
  type ArpAccessList,
  type ArpInspectionConfig,
  createDefaultArpInspectionConfig,
} from '../arp/types';
import { ArpInspectionPipeline } from '../arp/ArpInspectionPipeline';
import type { ISwitchShell } from './shells/ISwitchShell';
import { SwitchSecurityService } from './switch/SwitchSecurityService';

// Re-export shell classes for backward compatibility
export { CiscoSwitchShell } from './shells/CiscoSwitchShell';
export type { CLIMode } from './shells/CiscoSwitchShell';
export { HuaweiSwitchShell as HuaweiVRPSwitchShell } from './shells/HuaweiSwitchShell';

// ─── 802.1Q Tag ─────────────────────────────────────────────────────

export interface Dot1QTag {
  tpid: number;   // 0x8100
  pcp: number;    // Priority Code Point (0-7)
  dei: number;    // Drop Eligible Indicator
  vid: number;    // VLAN ID (1-4094)
}

// ─── Extended Ethernet Frame (with optional VLAN tag) ───────────────

export interface TaggedEthernetFrame extends EthernetFrame {
  dot1q?: Dot1QTag;
}

// ─── Port Configuration ─────────────────────────────────────────────

export type SwitchportMode = 'access' | 'trunk';

export interface SwitchportConfig {
  mode: SwitchportMode;
  accessVlan: number;           // VLAN for access mode (default 1)
  trunkNativeVlan: number;      // Native VLAN for trunk mode (default 1)
  trunkAllowedVlans: Set<number>; // Allowed VLANs on trunk (default: all)
}

// ─── MAC Table Entry ────────────────────────────────────────────────

export interface MACTableEntry {
  mac: string;
  vlan: number;
  port: string;
  type: 'static' | 'dynamic';
  age: number;           // seconds remaining before expiry
  timestamp: number;     // last refresh time
}

// ─── VLAN Entry ─────────────────────────────────────────────────────

export interface VLANEntry {
  id: number;
  name: string;
  ports: Set<string>;  // ports assigned to this VLAN
}

// ─── STP Port State ─────────────────────────────────────────────────

export type STPPortState = 'blocking' | 'listening' | 'learning' | 'forwarding' | 'disabled';

// ─── Switch Class (Abstract Base) ───────────────────────────────────

export abstract class Switch extends Equipment {
  private _securityService: SwitchSecurityService | null = null;
  getSecurityService(): SwitchSecurityService {
    if (!this._securityService) this._securityService = new SwitchSecurityService();
    return this._securityService;
  }

  private macTable: Map<string, MACTableEntry> = new Map(); // key: "vlan:mac"
  private macAgingTime: number = 300; // seconds
  private macAgingTimer: TimerHandle | null = null;
  private macAgingScheduler: IScheduler | null = null;
  private schedulerOverride: IScheduler | null = null;

  // ─── VLAN Database ──────────────────────────────────────────────
  protected vlans: Map<number, VLANEntry> = new Map();

  // ─── Port Configurations ────────────────────────────────────────
  private switchportConfigs: Map<string, SwitchportConfig> = new Map();

  // ─── STP Port States ────────────────────────────────────────────
  private stpStates: Map<string, STPPortState> = new Map();

  // ─── MAC Move Detection ───────────────────────────────────────
  private macMoveCount: number = 0;

  // ─── Port VLAN State (active/suspended) ────────────────────────
  protected portVlanStates: Map<string, 'active' | 'suspended'> = new Map();

  // ─── Config Persistence ─────────────────────────────────────────
  private startupConfig: string | null = null;
  protected readonly initialHostname: string;

  // ─── DHCP Snooping ────────────────────────────────────────────
  private dhcpSnooping: DHCPSnoopingConfig = createDefaultSnoopingConfig();
  private snoopingBindings: DHCPSnoopingBinding[] = [];
  private snoopingLog: string[] = [];
  private syslogServer: string | null = null;

  // ─── Interface Descriptions ──────────────────────────────────────
  private interfaceDescriptions: Map<string, string> = new Map();

  // ─── Management ARP Table ──────────────────────────────────────
  private arpTable: Map<string, { mac: MACAddress; iface: string; timestamp: number; type: 'dynamic' | 'static' }> = new Map();

  // ─── Dynamic ARP Inspection ────────────────────────────────────
  private arpInspection: ArpInspectionConfig = createDefaultArpInspectionConfig();
  private arpAccessLists: Map<string, ArpAccessList> = new Map();
  private arpErrDisabledPorts: Set<string> = new Set();
  private arpInspectionPipeline: ArpInspectionPipeline | null = null;
  private arpRecoveryTimer: TimerHandle | null = null;
  private arpRecoveryScheduler: IScheduler | null = null;
  private arpErrDisableTimestamps: Map<string, number> = new Map();
  private arpUnsubscribers: Array<() => void> = [];

  // ─── Port-Security err-disable + aging ─────────────────────────
  private psecRecoverySec: number = 0;
  private psecErrDisabledPorts: Set<string> = new Set();
  private psecErrDisableTimestamps: Map<string, number> = new Map();
  private psecRecoveryTimer: TimerHandle | null = null;
  private psecRecoveryScheduler: IScheduler | null = null;
  private psecAgingTimer: TimerHandle | null = null;
  private psecAgingScheduler: IScheduler | null = null;
  private psecUnsubscribers: Array<() => void> = [];

  // ─── CLI Shell ──────────────────────────────────────────────────
  private shell: ISwitchShell;

  constructor(type: DeviceType = 'switch-cisco', name: string = 'Switch', portCount: number = 50, x: number = 0, y: number = 0) {
    super(type, name, x, y);
    this.initialHostname = name;
    this.initPorts(portCount);
    this.initDefaultVLAN();
    this.startMACAgingProcess();
    this.shell = this.createShell();
    this.initArpInspection();
    this.initPortSecurity();
  }

  private initPortSecurity(): void {
    // React to violations on our own ports: log + auto err-disable book-keeping.
    this.psecUnsubscribers.push(this.getBus().subscribeWhere(
      'port.security.violation',
      (p) => p.deviceId === this.id,
      (e) => {
        const { portName, mac, mode, action } = e.payload;
        const ts = new Date().toISOString();
        this.snoopingLog.push(
          `*${ts}: %PORT_SECURITY-2-PSECURE_VIOLATION: Security violation occurred,` +
          ` caused by MAC address ${mac.toString().toLowerCase()} on port ${portName}` +
          ` (mode=${mode}, action=${action})`,
        );
        if (action === 'shutdown') {
          this.psecErrDisabledPorts.add(portName);
          this.psecErrDisableTimestamps.set(portName, Date.now());
          if (this.psecRecoverySec > 0) this.ensurePsecRecoveryTimer();
        }
      },
    ));

    // React to sticky-saved on our own ports: the running-config dirty
    // bit is implicit (NVRAM is rebuilt from PortSecurity on each
    // `getRunningConfig`), but we still log it so `show logging` shows
    // the trail just like real IOS does.
    this.psecUnsubscribers.push(this.getBus().subscribeWhere(
      'port.security.sticky-saved',
      (p) => p.deviceId === this.id,
      (e) => {
        const { portName, mac } = e.payload;
        const ts = new Date().toISOString();
        this.snoopingLog.push(
          `*${ts}: %PORT_SECURITY-6-STICKY_LEARN: ${portName} learned sticky MAC ${mac.toString().toLowerCase()}`,
        );
      },
    ));

    // Aging tick: every minute, walk all ports and let PortSecurity drop
    // expired entries. We don't run when no port has aging configured.
    this.startPsecAgingProcess();
  }

  private ensurePsecRecoveryTimer(): void {
    if (this.psecRecoveryTimer !== null || this.psecRecoverySec <= 0) return;
    const scheduler = this.getScheduler();
    this.psecRecoveryScheduler = scheduler;
    this.psecRecoveryTimer = scheduler.setInterval(() => this.recoverPsecErrDisabled(), 1000);
  }

  private recoverPsecErrDisabled(): void {
    if (this.psecRecoverySec <= 0 || this.psecErrDisabledPorts.size === 0) {
      this.stopPsecRecoveryTimer();
      return;
    }
    const now = Date.now();
    for (const port of [...this.psecErrDisabledPorts]) {
      const ts = this.psecErrDisableTimestamps.get(port) ?? now;
      if ((now - ts) / 1000 >= this.psecRecoverySec) {
        this.psecErrDisabledPorts.delete(port);
        this.psecErrDisableTimestamps.delete(port);
        const p = this.getPort(port);
        if (p) {
          p.getPortSecurity().resetViolationCount();
          p.setUp(true);
        }
        this.getBus().publish({
          topic: 'port.security.errdisable.cleared',
          payload: { deviceId: this.id, portName: port },
        });
      }
    }
    if (this.psecErrDisabledPorts.size === 0) this.stopPsecRecoveryTimer();
  }

  private stopPsecRecoveryTimer(): void {
    if (this.psecRecoveryTimer !== null) {
      (this.psecRecoveryScheduler ?? this.getScheduler()).clear(this.psecRecoveryTimer);
      this.psecRecoveryTimer = null;
      this.psecRecoveryScheduler = null;
    }
  }

  private startPsecAgingProcess(): void {
    if (this.psecAgingTimer !== null) return;
    const scheduler = this.getScheduler();
    this.psecAgingScheduler = scheduler;
    this.psecAgingTimer = scheduler.setInterval(() => this.tickPsecAging(), 60_000);
  }

  private stopPsecAgingProcess(): void {
    if (this.psecAgingTimer !== null) {
      (this.psecAgingScheduler ?? this.getScheduler()).clear(this.psecAgingTimer);
      this.psecAgingTimer = null;
      this.psecAgingScheduler = null;
    }
  }

  private tickPsecAging(): void {
    const now = Date.now();
    for (const [portName, port] of this.ports) {
      const sec = port.getPortSecurity();
      if (!sec.isEnabled() || sec.getAgingTimeMin() <= 0) continue;
      const aged = sec.ageOut(now);
      for (const entry of aged) {
        this.getBus().publish({
          topic: 'port.security.mac-aged',
          payload: {
            deviceId: this.id, portName,
            mac: entry.mac, vlan: entry.vlan, type: entry.type,
          },
        });
      }
    }
  }

  private initArpInspection(): void {
    this.arpInspectionPipeline = new ArpInspectionPipeline(
      {
        id: this.id,
        name: this.name,
        _getArpInspectionConfig: () => this.arpInspection,
        _getArpAccessLists: () => this.arpAccessLists,
        _getSnoopingBindings: () => this.snoopingBindings,
        _addSnoopingLog: (msg) => this.snoopingLog.push(msg),
        _arpErrDisable: (port) => this.arpErrDisablePort(port),
        _isArpErrDisabled: (port) => this.arpErrDisabledPorts.has(port),
      },
      () => this.getBus(),
    );

    // React: link going down → drop rate-limit accounting for the port.
    // Counters are kept across flaps to match Cisco's `show ip arp inspection
    // statistics` semantics (only `clear ip arp inspection statistics` zeroes
    // them out).
    this.arpUnsubscribers.push(this.getBus().subscribeWhere(
      'port.link.down',
      (p) => p.deviceId === this.id,
      (e) => this.arpInspectionPipeline?.resetPort(e.payload.portName),
    ));
  }

  private arpErrDisablePort(port: string): void {
    if (this.arpErrDisabledPorts.has(port)) return;
    this.arpErrDisabledPorts.add(port);
    this.arpErrDisableTimestamps.set(port, Date.now());
    const p = this.getPort(port);
    if (p) p.setUp(false);
    this.getBus().publish({
      topic: 'arp.errdisable.set',
      payload: { switchId: this.id, switchName: this.name, port, cause: 'arp-inspection' },
    });
    Logger.warn(this.id, 'switch:arp-errdisable',
      `${this.name}: ${port} err-disabled by arp-inspection`);
    this.ensureRecoveryTimer();
  }

  private ensureRecoveryTimer(): void {
    if (this.arpRecoveryTimer !== null) return;
    if (this.arpInspection.errDisableRecoverySec <= 0) return;
    const scheduler = this.getScheduler();
    this.arpRecoveryScheduler = scheduler;
    this.arpRecoveryTimer = scheduler.setInterval(() => this.recoverErrDisabled(), 1000);
  }

  private recoverErrDisabled(): void {
    const recoverySec = this.arpInspection.errDisableRecoverySec;
    if (recoverySec <= 0 || this.arpErrDisabledPorts.size === 0) {
      this.stopRecoveryTimer();
      return;
    }
    const now = Date.now();
    for (const port of [...this.arpErrDisabledPorts]) {
      const ts = this.arpErrDisableTimestamps.get(port) ?? now;
      if ((now - ts) / 1000 >= recoverySec) {
        this.arpErrDisabledPorts.delete(port);
        this.arpErrDisableTimestamps.delete(port);
        const p = this.getPort(port);
        if (p) p.setUp(true);
        this.getBus().publish({
          topic: 'arp.errdisable.cleared',
          payload: { switchId: this.id, switchName: this.name, port },
        });
        Logger.info(this.id, 'switch:arp-recover',
          `${this.name}: ${port} recovered from arp-inspection err-disable`);
      }
    }
    if (this.arpErrDisabledPorts.size === 0) this.stopRecoveryTimer();
  }

  private stopRecoveryTimer(): void {
    if (this.arpRecoveryTimer !== null) {
      (this.arpRecoveryScheduler ?? this.getScheduler()).clear(this.arpRecoveryTimer);
      this.arpRecoveryTimer = null;
      this.arpRecoveryScheduler = null;
    }
  }

  // ─── Vendor Hooks (overridden by subclasses) ───────────────────

  /** Get port name for given index (vendor-specific naming) */
  protected abstract getPortName(index: number, total: number): string;

  /** Get initial STP state for new ports */
  protected abstract getInitialSTPState(): STPPortState;

  /** Create the appropriate CLI shell */
  protected abstract createShell(): ISwitchShell;

  /** Handle ports when their VLAN is deleted (vendor-specific behavior) */
  protected abstract onVlanDeleted(vlanId: number, affectedPorts: string[]): void;

  /** Handle ports when a previously deleted VLAN is recreated */
  protected abstract onVlanRecreated(vlanId: number): string[];

  /** Get OS type string */
  abstract getOSType(): string;

  /** Get boot sequence text */
  abstract getBootSequence(): string;

  private initPorts(count: number): void {
    const initialSTP = this.getInitialSTPState();

    for (let i = 0; i < count; i++) {
      const portName = this.getPortName(i, count);
      const port = new Port(portName, 'ethernet');
      this.addPort(port);

      // Default switchport config: access mode, VLAN 1
      this.switchportConfigs.set(portName, {
        mode: 'access',
        accessVlan: 1,
        trunkNativeVlan: 1,
        trunkAllowedVlans: new Set(Array.from({ length: 4094 }, (_, i) => i + 1)),
      });

      // STP initial state
      this.stpStates.set(portName, initialSTP);
      // Port VLAN state
      this.portVlanStates.set(portName, 'active');

      // Auto-advance STP on link-up (simulates RSTP rapid transition)
      port.onLinkChange((state) => {
        if (state === 'up') {
          const stp = this.stpStates.get(portName);
          if (stp === 'listening' || stp === 'learning') {
            this.stpStates.set(portName, 'forwarding');
          }
        }
      });
    }
  }

  private initDefaultVLAN(): void {
    // VLAN 1 is the default VLAN — always exists
    const allPorts = new Set(this.getPortNames());
    this.vlans.set(1, { id: 1, name: 'default', ports: allPorts });
  }

  override setEventBus(bus: import('@/events/EventBus').IEventBus | null): void {
    super.setEventBus(bus);
    // Subscribers are attached to a specific bus instance — re-install
    // them so they observe the bus that publishes go through.
    for (const u of this.arpUnsubscribers) u();
    this.arpUnsubscribers = [];
    for (const u of this.psecUnsubscribers) u();
    this.psecUnsubscribers = [];
    if (this.arpInspectionPipeline) this.initArpInspection();
    this.initPortSecurity();
  }

  // ─── Power Management ────────────────────────────────────────────

  override powerOff(): void {
    super.powerOff();
    this.stopMACAgingProcess();
    this.stopRecoveryTimer();
    this.stopPsecRecoveryTimer();
    this.stopPsecAgingProcess();
    for (const u of this.arpUnsubscribers) u();
    this.arpUnsubscribers = [];
    for (const u of this.psecUnsubscribers) u();
    this.psecUnsubscribers = [];
    this.arpInspectionPipeline?.resetStats();
    this.arpErrDisabledPorts.clear();
    this.arpErrDisableTimestamps.clear();
    this.psecErrDisabledPorts.clear();
    this.psecErrDisableTimestamps.clear();
  }

  override powerOn(): void {
    super.powerOn();
    // Reset volatile state (simulates DRAM loss)
    this.hostname = this.initialHostname;
    this.name = this.initialHostname;
    this.macTable.clear();
    this.vlans.clear();
    this.initDefaultVLAN();
    // Reset all port configs to defaults
    for (const [portName, cfg] of this.switchportConfigs) {
      cfg.mode = 'access';
      cfg.accessVlan = 1;
      cfg.trunkNativeVlan = 1;
      cfg.trunkAllowedVlans = new Set(Array.from({ length: 4094 }, (_, i) => i + 1));
      const port = this.getPort(portName);
      if (port) port.setUp(true);
    }
    // Reset shell FSM to user mode
    this.shell = this.createShell();
    this.startMACAgingProcess();
    // Reset volatile DAI runtime (keep config — it lives in NVRAM via running-config).
    this.arpErrDisabledPorts.clear();
    this.arpErrDisableTimestamps.clear();
    this.psecErrDisabledPorts.clear();
    this.psecErrDisableTimestamps.clear();
    this.initArpInspection();
    this.initPortSecurity();
    // Restore startup config (NVRAM) if available
    if (this.startupConfig) {
      this.restoreFromStartupConfig();
    }
  }

  // ─── VLAN Database API ────────────────────────────────────────────

  createVLAN(id: number, name?: string): boolean {
    if (id < 1 || id > 4094) return false;
    if (this.vlans.has(id)) return false;
    const newVlan: VLANEntry = { id, name: name || `VLAN${String(id).padStart(4, '0')}`, ports: new Set() };
    this.vlans.set(id, newVlan);

    // Let subclass handle VLAN recreation (e.g., Cisco reactivates suspended ports)
    const reactivated = this.onVlanRecreated(id);
    for (const portName of reactivated) {
      newVlan.ports.add(portName);
    }

    Logger.info(this.id, 'switch:vlan-create', `${this.name}: created VLAN ${id}`);
    return true;
  }

  deleteVLAN(id: number): boolean {
    if (id === 1) return false; // Can't delete default VLAN
    if (!this.vlans.has(id)) return false;

    // Collect affected access ports
    const vlan = this.vlans.get(id)!;
    const affectedPorts: string[] = [];
    for (const portName of vlan.ports) {
      const cfg = this.switchportConfigs.get(portName);
      if (cfg && cfg.mode === 'access' && cfg.accessVlan === id) {
        affectedPorts.push(portName);
      }
    }

    // Let subclass handle port behavior (Cisco: suspend, Huawei: move to VLAN 1)
    this.onVlanDeleted(id, affectedPorts);

    this.vlans.delete(id);
    // Remove MAC entries for this VLAN
    for (const [key, entry] of this.macTable) {
      if (entry.vlan === id) this.macTable.delete(key);
    }
    Logger.info(this.id, 'switch:vlan-delete', `${this.name}: deleted VLAN ${id}`);
    return true;
  }

  renameVLAN(id: number, name: string): boolean {
    const vlan = this.vlans.get(id);
    if (!vlan) return false;
    vlan.name = name;
    return true;
  }

  getVLAN(id: number): VLANEntry | undefined {
    return this.vlans.get(id);
  }

  getVLANs(): Map<number, VLANEntry> {
    return new Map(this.vlans);
  }

  // ─── Switchport Configuration API ─────────────────────────────────

  getSwitchportConfig(portName: string): SwitchportConfig | undefined {
    return this.switchportConfigs.get(portName);
  }

  setSwitchportMode(portName: string, mode: SwitchportMode): boolean {
    const cfg = this.switchportConfigs.get(portName);
    if (!cfg) return false;

    const oldMode = cfg.mode;
    cfg.mode = mode;

    if (oldMode === 'access' && mode === 'trunk') {
      // Remove from VLAN port list when going to trunk
      const vlan = this.vlans.get(cfg.accessVlan);
      if (vlan) vlan.ports.delete(portName);
    } else if (oldMode === 'trunk' && mode === 'access') {
      // Add to access VLAN port list
      const vlan = this.vlans.get(cfg.accessVlan);
      if (vlan) vlan.ports.add(portName);
    }

    Logger.info(this.id, 'switch:switchport-mode', `${this.name}: ${portName} set to ${mode}`);
    return true;
  }

  setSwitchportAccessVlan(portName: string, vlanId: number): boolean {
    const cfg = this.switchportConfigs.get(portName);
    if (!cfg) return false;
    if (!this.vlans.has(vlanId)) {
      // Auto-create VLAN if it doesn't exist
      this.createVLAN(vlanId);
    }

    // Remove from old VLAN
    const oldVlan = this.vlans.get(cfg.accessVlan);
    if (oldVlan) oldVlan.ports.delete(portName);

    // Add to new VLAN
    cfg.accessVlan = vlanId;
    const newVlan = this.vlans.get(vlanId);
    if (newVlan && cfg.mode === 'access') newVlan.ports.add(portName);

    Logger.info(this.id, 'switch:access-vlan', `${this.name}: ${portName} access VLAN ${vlanId}`);
    return true;
  }

  setTrunkNativeVlan(portName: string, vlanId: number): boolean {
    const cfg = this.switchportConfigs.get(portName);
    if (!cfg) return false;
    cfg.trunkNativeVlan = vlanId;
    return true;
  }

  setTrunkAllowedVlans(portName: string, vlans: Set<number>): boolean {
    const cfg = this.switchportConfigs.get(portName);
    if (!cfg) return false;
    cfg.trunkAllowedVlans = vlans;
    return true;
  }

  addTrunkAllowedVlan(portName: string, vlanId: number): boolean {
    const cfg = this.switchportConfigs.get(portName);
    if (!cfg) return false;
    cfg.trunkAllowedVlans.add(vlanId);
    return true;
  }

  addTrunkAllowedVlans(portName: string, vlans: Set<number>): boolean {
    const cfg = this.switchportConfigs.get(portName);
    if (!cfg) return false;
    for (const v of vlans) cfg.trunkAllowedVlans.add(v);
    return true;
  }

  removeTrunkAllowedVlan(portName: string, vlanId: number): boolean {
    const cfg = this.switchportConfigs.get(portName);
    if (!cfg) return false;
    cfg.trunkAllowedVlans.delete(vlanId);
    return true;
  }

  removeTrunkAllowedVlans(portName: string, vlans: Set<number>): boolean {
    const cfg = this.switchportConfigs.get(portName);
    if (!cfg) return false;
    for (const v of vlans) cfg.trunkAllowedVlans.delete(v);
    return true;
  }

  setTrunkAllowedVlansAll(portName: string): boolean {
    const cfg = this.switchportConfigs.get(portName);
    if (!cfg) return false;
    const all = new Set<number>();
    for (let i = 1; i <= 4094; i++) all.add(i);
    cfg.trunkAllowedVlans = all;
    return true;
  }

  setTrunkAllowedVlansNone(portName: string): boolean {
    const cfg = this.switchportConfigs.get(portName);
    if (!cfg) return false;
    cfg.trunkAllowedVlans = new Set();
    return true;
  }

  setTrunkAllowedVlansExcept(portName: string, vlans: Set<number>): boolean {
    const cfg = this.switchportConfigs.get(portName);
    if (!cfg) return false;
    const all = new Set<number>();
    for (let i = 1; i <= 4094; i++) {
      if (!vlans.has(i)) all.add(i);
    }
    cfg.trunkAllowedVlans = all;
    return true;
  }

  // ─── STP API ──────────────────────────────────────────────────────

  getSTPState(portName: string): STPPortState {
    return this.stpStates.get(portName) || 'disabled';
  }

  setSTPState(portName: string, state: STPPortState): void {
    this.stpStates.set(portName, state);
  }

  /** Advance STP timer for a port: listening→learning→forwarding */
  advanceSTPTimer(portName: string): void {
    const current = this.stpStates.get(portName);
    if (current === 'listening') {
      this.stpStates.set(portName, 'learning');
    } else if (current === 'learning') {
      this.stpStates.set(portName, 'forwarding');
    }
  }

  /** Set all ports to the given STP state */
  setAllPortsSTPState(state: STPPortState): void {
    for (const portName of this.stpStates.keys()) {
      this.stpStates.set(portName, state);
    }
  }

  // ─── MAC Move Detection API ───────────────────────────────────

  getMACMoveCount(): number {
    return this.macMoveCount;
  }

  // ─── Port VLAN State API ──────────────────────────────────────

  getPortVlanState(portName: string): 'active' | 'suspended' {
    return this.portVlanStates.get(portName) || 'active';
  }

  // ─── Interface Description API ────────────────────────────────

  setInterfaceDescription(portName: string, desc: string): void {
    this.interfaceDescriptions.set(portName, desc);
  }

  getInterfaceDescription(portName: string): string | undefined {
    return this.interfaceDescriptions.get(portName);
  }

  // ─── MAC Table API ────────────────────────────────────────────────

  getMACTable(): MACTableEntry[] {
    return Array.from(this.macTable.values());
  }

  getMACTableRaw(): Map<string, MACTableEntry> {
    return new Map(this.macTable);
  }

  clearMACTable(): void {
    this.macTable.clear();
  }

  getMACAgingTime(): number {
    return this.macAgingTime;
  }

  setMACAgingTime(seconds: number): void {
    this.macAgingTime = seconds;
  }

  addStaticMAC(mac: string, vlan: number, port: string): boolean {
    const key = `${vlan}:${mac.toLowerCase()}`;
    this.macTable.set(key, {
      mac: mac.toLowerCase(),
      vlan,
      port,
      type: 'static',
      age: -1,
      timestamp: Date.now(),
    });
    return true;
  }

  // ─── Frame Handling Pipeline ──────────────────────────────────────

  protected handleFrame(portName: string, frame: EthernetFrame): void {
    if (!this.isPoweredOn) return;

    // STP: drop frames on blocking/disabled/listening ports
    const stpState = this.stpStates.get(portName);
    if (stpState === 'blocking' || stpState === 'disabled' || stpState === 'listening') {
      Logger.debug(this.id, 'switch:stp-drop', `${this.name}: dropping frame on ${portName} (${stpState})`);
      return;
    }

    // Port shutdown check
    const port = this.getPort(portName);
    if (port && !port.getIsUp()) return;

    const cfg = this.switchportConfigs.get(portName);
    if (!cfg) return;

    const taggedFrame = frame as TaggedEthernetFrame;

    // ─── Step 1: Determine ingress VLAN ─────────────────────────
    let ingressVlan: number;

    if (cfg.mode === 'access') {
      ingressVlan = cfg.accessVlan;
    } else {
      // Trunk mode
      if (taggedFrame.dot1q) {
        ingressVlan = taggedFrame.dot1q.vid;
        if (!cfg.trunkAllowedVlans.has(ingressVlan)) {
          Logger.debug(this.id, 'switch:trunk-filtered', `${this.name}: VLAN ${ingressVlan} not allowed on trunk ${portName}`);
          return;
        }
      } else {
        ingressVlan = cfg.trunkNativeVlan;
      }
    }

    // ─── Step 1.5: Dynamic ARP Inspection (untrusted / DAI-enabled VLANs)
    if (frame.etherType === ETHERTYPE_ARP && this.arpInspectionPipeline) {
      const arp = frame.payload as ARPPacket;
      if (arp && arp.type === 'arp') {
        const passed = this.arpInspectionPipeline.process({
          ingressPort: portName,
          vlan: ingressVlan,
          senderIp: arp.senderIP,
          senderMac: arp.senderMAC,
          targetIp: arp.targetIP,
          targetMac: arp.targetMAC,
          ethSrcMac: frame.srcMAC,
          ethDstMac: frame.dstMAC,
          operation: arp.operation,
        });
        if (!passed) return;
        this.snoopLearnArp(arp, portName, ingressVlan);
      }
    }

    // ─── Step 2: MAC Learning (allowed in learning + forwarding) ─
    const srcMAC = frame.srcMAC.toString().toLowerCase();
    const macKey = `${ingressVlan}:${srcMAC}`;
    const existing = this.macTable.get(macKey);

    if (!existing || existing.type === 'dynamic') {
      // MAC move detection: if MAC exists on a different port
      if (existing && existing.type === 'dynamic' && existing.port !== portName) {
        this.macMoveCount++;
        Logger.warn(this.id, 'switch:mac-move',
          `${this.name}: MAC ${srcMAC} moved from ${existing.port} to ${portName} (VLAN ${ingressVlan})`);
      }
      this.macTable.set(macKey, {
        mac: srcMAC,
        vlan: ingressVlan,
        port: portName,
        type: 'dynamic',
        age: this.macAgingTime,
        timestamp: Date.now(),
      });
      Logger.debug(this.id, 'switch:mac-learn', `${this.name}: learned ${srcMAC} VLAN ${ingressVlan} on ${portName}`);
    }

    // ─── Step 3: Forwarding Decision ────────────────────────────
    // In learning state: learn MACs but do NOT forward frames
    if (stpState === 'learning') {
      return;
    }

    const dstMAC = frame.dstMAC.toString().toLowerCase();

    const dstOctets = frame.dstMAC.getOctets();
    const isMulticast = frame.dstMAC.isBroadcast() ||
                        (dstOctets[0] === 0x33 && dstOctets[1] === 0x33);

    if (isMulticast || !this.macTable.has(`${ingressVlan}:${dstMAC}`)) {
      const snoopedPorts = isMulticast ? this.resolveSnoopedMulticastEgressPorts(portName, frame, ingressVlan) : null;
      if (snoopedPorts) {
        Logger.debug(
          this.id, 'switch:igmp-snoop-forward',
          `${this.name}: snooped multicast ${dstMAC} VLAN ${ingressVlan} → [${snoopedPorts.join(', ')}] (ingress ${portName})`,
          { dstMAC: dstMAC.toString(), srcMAC: srcMAC.toString(), vlan: ingressVlan, ingress: portName, egress: snoopedPorts },
        );
        for (const egressPort of snoopedPorts) this.forwardToPort(egressPort, frame, ingressVlan);
        return;
      }
      Logger.debug(
        this.id, 'switch:flood',
        `${this.name}: flood ${dstMAC} VLAN ${ingressVlan} (ingress ${portName})`,
        { dstMAC: dstMAC.toString(), srcMAC: srcMAC.toString(), vlan: ingressVlan, ingress: portName, reason: isMulticast ? 'multicast' : 'unknown-unicast' },
      );
      this.floodFrame(portName, frame, ingressVlan);
    } else {
      const dstEntry = this.macTable.get(`${ingressVlan}:${dstMAC}`)!;
      if (dstEntry.port !== portName) {
        Logger.debug(
          this.id, 'switch:forward',
          `${this.name}: forward ${dstMAC} VLAN ${ingressVlan} ${portName} → ${dstEntry.port}`,
          { dstMAC: dstMAC.toString(), srcMAC: srcMAC.toString(), vlan: ingressVlan, ingress: portName, egress: dstEntry.port },
        );
        this.forwardToPort(dstEntry.port, frame, ingressVlan);
      }
    }
  }

  protected resolveSnoopedMulticastEgressPorts(_ingressPort: string, frame: EthernetFrame, _vlan: number): string[] | null {
    if (frame.etherType !== ETHERTYPE_IPV4) return null;
    const ipPkt = frame.payload as IPv4Packet | undefined;
    if (!ipPkt || ipPkt.type !== 'ipv4' || !(ipPkt.destinationIP instanceof IPAddress)) return null;
    const firstOctet = ipPkt.destinationIP.getOctets()[0];
    if (firstOctet < 224 || firstOctet > 239) return null;
    return null;
  }

  // ─── Flood within VLAN ────────────────────────────────────────────

  private floodFrame(exceptPort: string, frame: EthernetFrame, vlan: number): void {
    for (const [portName, cfg] of this.switchportConfigs) {
      if (portName === exceptPort) continue;

      const port = this.getPort(portName);
      if (!port || !port.getIsUp() || !port.isConnected()) continue;

      const stpState = this.stpStates.get(portName);
      if (stpState === 'blocking' || stpState === 'disabled' || stpState === 'listening' || stpState === 'learning') continue;

      if (cfg.mode === 'access') {
        // Only flood to access ports in the same VLAN
        if (cfg.accessVlan === vlan) {
          this.sendFrame(portName, this.stripTag(frame));
        }
      } else {
        // Trunk: send if VLAN is allowed
        if (cfg.trunkAllowedVlans.has(vlan)) {
          if (vlan === cfg.trunkNativeVlan) {
            // Native VLAN: send untagged
            this.sendFrame(portName, this.stripTag(frame));
          } else {
            // Non-native: send tagged
            this.sendFrame(portName, this.addTag(frame, vlan));
          }
        }
      }
    }
  }

  // ─── Forward to Specific Port ─────────────────────────────────────

  private forwardToPort(portName: string, frame: EthernetFrame, vlan: number): void {
    const cfg = this.switchportConfigs.get(portName);
    if (!cfg) return;

    const port = this.getPort(portName);
    if (!port || !port.getIsUp()) return;

    const stpState = this.stpStates.get(portName);
    if (stpState === 'blocking' || stpState === 'disabled' || stpState === 'listening' || stpState === 'learning') return;

    if (cfg.mode === 'access') {
      // Access port: strip tag
      this.sendFrame(portName, this.stripTag(frame));
    } else {
      // Trunk port: check if VLAN is allowed before sending
      if (!cfg.trunkAllowedVlans.has(vlan)) {
        Logger.debug(this.id, 'switch:trunk-filtered', `${this.name}: VLAN ${vlan} not allowed on trunk ${portName} (egress)`);
        return;
      }
      if (vlan === cfg.trunkNativeVlan) {
        this.sendFrame(portName, this.stripTag(frame));
      } else {
        this.sendFrame(portName, this.addTag(frame, vlan));
      }
    }
  }

  // ─── 802.1Q Tagging Helpers ───────────────────────────────────────

  private addTag(frame: EthernetFrame, vlan: number): TaggedEthernetFrame {
    return {
      ...frame,
      dot1q: { tpid: 0x8100, pcp: 0, dei: 0, vid: vlan },
    };
  }

  private stripTag(frame: EthernetFrame): EthernetFrame {
    const tagged = frame as TaggedEthernetFrame;
    if (tagged.dot1q) {
      const { dot1q, ...untagged } = tagged;
      return untagged;
    }
    return frame;
  }

  // ─── MAC Aging Process ────────────────────────────────────────────

  /** Test-only / multi-topology scheduler injection (Phase 4 of the
   *  reactive refactor). When unset, the default scheduler singleton is
   *  used so existing call sites are unaffected. Setting this after the
   *  switch was constructed restarts the MAC-aging process on the new
   *  scheduler so subsequent `clear()` calls land on the right one. */
  setScheduler(scheduler: IScheduler | null): void {
    if (this.schedulerOverride === scheduler) return;
    const wasRunning = this.macAgingTimer !== null;
    if (wasRunning) this.stopMACAgingProcess();
    this.schedulerOverride = scheduler;
    if (wasRunning) this.startMACAgingProcess();
  }

  private getScheduler(): IScheduler {
    return this.schedulerOverride ?? getDefaultScheduler();
  }

  private startMACAgingProcess(): void {
    if (this.macAgingTimer !== null) return;
    const scheduler = this.getScheduler();
    this.macAgingScheduler = scheduler;
    this.macAgingTimer = scheduler.setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of this.macTable) {
        if (entry.type === 'dynamic') {
          const elapsed = Math.floor((now - entry.timestamp) / 1000);
          entry.age = Math.max(0, this.macAgingTime - elapsed);
          if (entry.age <= 0) {
            this.macTable.delete(key);
            Logger.debug(this.id, 'switch:mac-age', `${this.name}: aged out ${entry.mac} VLAN ${entry.vlan}`);
          }
        }
      }
    }, 1000);
  }

  private stopMACAgingProcess(): void {
    if (this.macAgingTimer !== null) {
      // Use the scheduler that *scheduled* the timer, not the current
      // override — they may differ if `setScheduler` was called after
      // the timer was registered.
      const scheduler = this.macAgingScheduler ?? this.getScheduler();
      scheduler.clear(this.macAgingTimer);
      this.macAgingTimer = null;
      this.macAgingScheduler = null;
    }
  }

  // ─── Config Persistence (Running → Startup) ──────────────────────

  getRunningConfig(): string {
    if ('buildRunningConfig' in this.shell) {
      return (this.shell as any).buildRunningConfig(this);
    }
    return '';
  }

  writeMemory(): string {
    this.startupConfig = this.serializeConfig();
    return '[OK]';
  }

  getStartupConfig(): string | null {
    return this.startupConfig;
  }

  private serializeConfig(): string {
    const config: any = {
      hostname: this.hostname,
      vlans: [] as any[],
      ports: [] as any[],
      macAgingTime: this.macAgingTime,
    };

    for (const [id, vlan] of this.vlans) {
      if (id !== 1) {
        config.vlans.push({ id, name: vlan.name });
      }
    }

    for (const [portName, cfg] of this.switchportConfigs) {
      const port = this.getPort(portName);
      config.ports.push({
        name: portName,
        mode: cfg.mode,
        accessVlan: cfg.accessVlan,
        trunkNativeVlan: cfg.trunkNativeVlan,
        trunkAllowedVlans: Array.from(cfg.trunkAllowedVlans),
        isUp: port ? port.getIsUp() : true,
      });
    }

    return JSON.stringify(config);
  }

  private restoreFromStartupConfig(): void {
    if (!this.startupConfig) return;
    try {
      const config = JSON.parse(this.startupConfig);
      this.hostname = config.hostname || this.hostname;
      this.macAgingTime = config.macAgingTime || 300;

      // Restore VLANs
      for (const v of config.vlans || []) {
        this.createVLAN(v.id, v.name);
      }

      // Restore port configs
      for (const p of config.ports || []) {
        const cfg = this.switchportConfigs.get(p.name);
        if (cfg) {
          cfg.mode = p.mode;
          cfg.accessVlan = p.accessVlan;
          cfg.trunkNativeVlan = p.trunkNativeVlan;
          cfg.trunkAllowedVlans = new Set(p.trunkAllowedVlans);
        }
        const port = this.getPort(p.name);
        if (port) port.setUp(p.isUp);
      }

      // Rebuild VLAN port assignments
      for (const [portName, cfg] of this.switchportConfigs) {
        if (cfg.mode === 'access') {
          const vlan = this.vlans.get(cfg.accessVlan);
          if (vlan) vlan.ports.add(portName);
        }
      }
    } catch {
      Logger.error(this.id, 'switch:restore-error', `${this.name}: failed to restore startup config`);
    }
  }

  // ─── Internal Accessors (for Shell) ───────────────────────────────

  /** @internal Used by CiscoSwitchShell */
  _getPortsInternal(): Map<string, Port> { return this.ports; }
  _getHostnameInternal(): string { return this.hostname; }
  _setHostnameInternal(name: string): void {
    this.hostname = name;
    this.name = name;
  }
  _getSwitchportConfigs(): Map<string, SwitchportConfig> { return this.switchportConfigs; }
  _getSTPStates(): Map<string, STPPortState> { return this.stpStates; }
  _getDHCPSnoopingConfig(): DHCPSnoopingConfig { return this.dhcpSnooping; }
  _getSnoopingBindings(): DHCPSnoopingBinding[] { return this.snoopingBindings; }
  _getSnoopingLog(): string[] { return this.snoopingLog; }
  _getSyslogServer(): string | null { return this.syslogServer; }
  _setSyslogServer(ip: string): void { this.syslogServer = ip; }
  _addSnoopingLog(msg: string): void { this.snoopingLog.push(msg); }
  _getInterfaceDescriptions(): Map<string, string> { return this.interfaceDescriptions; }

  // ─── ARP Snoop-learn into management table ──────────────────────

  /**
   * Real switches with an SVI populate their management ARP cache from
   * every broadcast/unicast ARP they observe — that's how `show ip arp`
   * lists hosts on the local segment without the switch ever sending an
   * ARP request itself. We replicate the same behaviour: any ARP frame
   * accepted by inspection is mirrored into the local `arpTable` (as
   * `dynamic`, never overwriting a `static` entry) and announced on the
   * bus so observers can react.
   */
  private snoopLearnArp(arp: ARPPacket, ingressPort: string, vlan: number): void {
    const ip = arp.senderIP.toString();
    if (ip === '0.0.0.0') return;
    const existing = this.arpTable.get(ip);
    if (existing && existing.type === 'static') return;
    const senderMacStr = arp.senderMAC.toString().toLowerCase();
    if (existing &&
        existing.mac.toString().toLowerCase() === senderMacStr &&
        existing.iface === ingressPort) {
      existing.timestamp = Date.now();
      return;
    }
    this.arpTable.set(ip, {
      mac: arp.senderMAC,
      iface: ingressPort,
      timestamp: Date.now(),
      type: 'dynamic',
    });
    this.getBus().publish({
      topic: 'arp.snoop.learned',
      payload: {
        switchId: this.id, switchName: this.name,
        ip, mac: senderMacStr, ingressPort, vlan,
      },
    });
  }

  // ─── ARP Accessors (ARPProvider interface) ──────────────────────

  _getArpTableInternal() { return this.arpTable; }

  _addStaticARP(ip: string, mac: MACAddress, iface: string): void {
    this.arpTable.set(ip, { mac, iface, timestamp: Date.now(), type: 'static' });
  }

  _deleteARP(ip: string): boolean {
    return this.arpTable.delete(ip);
  }

  _clearARPCache(): void {
    for (const [ip, entry] of this.arpTable) {
      if (entry.type !== 'static') {
        this.arpTable.delete(ip);
      }
    }
  }

  _vtpListVlans(): Array<{ id: number; name: string; mtu: number; type: 'ethernet' }> {
    const out: Array<{ id: number; name: string; mtu: number; type: 'ethernet' }> = [];
    for (const [, v] of this.vlans) {
      out.push({ id: v.id, name: v.name, mtu: 1500, type: 'ethernet' });
    }
    return out;
  }

  _vtpApplyVlans(incoming: ReadonlyArray<{ id: number; name: string }>): { added: number[]; removed: number[] } {
    const incomingIds = new Set(incoming.map(v => v.id));
    const added: number[] = [];
    const removed: number[] = [];
    for (const [id] of this.vlans) {
      if (id === 1) continue;
      if (!incomingIds.has(id)) {
        if (this.deleteVLAN(id)) removed.push(id);
      }
    }
    for (const v of incoming) {
      if (v.id === 1) continue;
      const existing = this.vlans.get(v.id);
      if (!existing) {
        if (this.createVLAN(v.id, v.name)) added.push(v.id);
      } else if (existing.name !== v.name) {
        this.renameVLAN(v.id, v.name);
      }
    }
    return { added, removed };
  }

  _vtpIsTrunkPort(portName: string): boolean {
    const cfg = this.switchportConfigs.get(portName);
    return !!cfg && cfg.mode === 'trunk';
  }

  // ─── DAI Accessors ────────────────────────────────────────────────

  _getArpInspectionConfig(): ArpInspectionConfig { return this.arpInspection; }
  _getArpAccessLists(): Map<string, ArpAccessList> { return this.arpAccessLists; }
  _getArpErrDisabledPorts(): Set<string> { return this.arpErrDisabledPorts; }
  _getArpInspectionStats() {
    return this.arpInspectionPipeline?.getStats() ?? new Map();
  }
  _getArpInspectionPortStats(port: string) {
    return this.arpInspectionPipeline?.getPortStats(port);
  }
  _clearArpInspectionErrDisable(port: string): boolean {
    if (!this.arpErrDisabledPorts.delete(port)) return false;
    this.arpErrDisableTimestamps.delete(port);
    const p = this.getPort(port);
    if (p) p.setUp(true);
    this.getBus().publish({
      topic: 'arp.errdisable.cleared',
      payload: { switchId: this.id, switchName: this.name, port },
    });
    if (this.arpErrDisabledPorts.size === 0) this.stopRecoveryTimer();
    return true;
  }
  _setArpRecoverySec(sec: number): void {
    this.arpInspection.errDisableRecoverySec = Math.max(0, sec);
    if (this.arpInspection.errDisableRecoverySec > 0 && this.arpErrDisabledPorts.size > 0) {
      this.ensureRecoveryTimer();
    } else if (this.arpInspection.errDisableRecoverySec === 0) {
      this.stopRecoveryTimer();
    }
  }
  _resetArpInspectionStats(): void {
    this.arpInspectionPipeline?.resetStats();
  }

  // ─── Port-Security accessors ─────────────────────────────────────

  _getPsecRecoverySec(): number { return this.psecRecoverySec; }
  _setPsecRecoverySec(sec: number): void {
    this.psecRecoverySec = Math.max(0, sec);
    if (this.psecRecoverySec > 0 && this.psecErrDisabledPorts.size > 0) {
      this.ensurePsecRecoveryTimer();
    } else if (this.psecRecoverySec === 0) {
      this.stopPsecRecoveryTimer();
    }
  }
  _getPsecErrDisabledPorts(): Set<string> { return this.psecErrDisabledPorts; }
  _clearPsecErrDisable(port: string): boolean {
    if (!this.psecErrDisabledPorts.delete(port)) return false;
    this.psecErrDisableTimestamps.delete(port);
    const p = this.getPort(port);
    if (p) {
      p.getPortSecurity().resetViolationCount();
      p.setUp(true);
    }
    this.getBus().publish({
      topic: 'port.security.errdisable.cleared',
      payload: { deviceId: this.id, portName: port },
    });
    if (this.psecErrDisabledPorts.size === 0) this.stopPsecRecoveryTimer();
    return true;
  }

  // ─── CLI ──────────────────────────────────────────────────────────

  getPrompt(): string { return this.shell.getPrompt(this); }

  /** Get CLI help for the given input (used by terminal UI for inline ? behavior) */
  cliHelp(inputBeforeQuestion: string): string {
    return this.shell.getHelp(inputBeforeQuestion);
  }

  /** Get CLI tab completion for the given input (used by terminal UI) */
  cliTabComplete(input: string): string | null {
    return this.shell.tabComplete(input);
  }

  // getBootSequence() and getOSType() are abstract — implemented by CiscoSwitch / HuaweiSwitch

  getBanner(type: string): string {
    if (type === 'motd') return '';
    return '';
  }

  async executeCommand(command: string): Promise<string> {
    if (!this.isPoweredOn) return '% Device is powered off';
    return this.shell.execute(this, command);
  }
}
