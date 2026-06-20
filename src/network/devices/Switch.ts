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
import { EthernetFrame, DeviceType, MACAddress, ETHERTYPE_ARP, ARPPacket, IPAddress, SubnetMask, ETHERTYPE_IPV4, IPv4Packet } from '../core/types';
import { SwitchSvi, type SviInterface } from './SwitchSvi';
import type { CiscoPingRow } from './shells/cisco/ciscoPing';
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
  voiceVlan?: number;             // Voice VLAN (switchport voice vlan N)
}

// ─── IGMP snooping seam ─────────────────────────────────────────────

/**
 * Minimal surface the base Switch needs from a vendor's IGMP-snooping
 * agent (Interface Segregation: the base never sees the full agent).
 */
export interface IgmpSnoopingAgentLike {
  getVlanState(vlan: number): { enabled: boolean } | undefined;
  computeEgressPorts(ingressPort: string, groupAddress: string): string[];
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
  /**
   * STP topology-change fast aging (802.1D-1998 §8.3.5): while set,
   * dynamic entries age with this value (forward delay) instead of
   * `macAgingTime`, so stale paths flush quickly after a reconvergence.
   */
  private stpFastAgingTime: number | null = null;
  private macAgingTimer: TimerHandle | null = null;
  private macAgingScheduler: IScheduler | null = null;
  private schedulerOverride: IScheduler | null = null;

  // ─── VLAN Database ──────────────────────────────────────────────
  protected vlans: Map<number, VLANEntry> = new Map();

  // ─── Port Configurations ────────────────────────────────────────
  private switchportConfigs: Map<string, SwitchportConfig> = new Map();

  // ─── STP Port States ────────────────────────────────────────────
  private stpStates: Map<string, STPPortState> = new Map();
  private stpVlanStates: Map<string, STPPortState> = new Map();

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
  private dhcpSnoopingUnsubscribers: Array<() => void> = [];

  // ─── Port-Security err-disable + aging ─────────────────────────
  private psecRecoverySec: number = 0;
  private psecErrDisabledPorts: Set<string> = new Set();
  private psecErrDisableTimestamps: Map<string, number> = new Map();
  private psecRecoveryTimer: TimerHandle | null = null;
  private psecRecoveryScheduler: IScheduler | null = null;
  private psecAgingTimer: TimerHandle | null = null;
  private psecAgingScheduler: IScheduler | null = null;
  private psecUnsubscribers: Array<() => void> = [];

  // ─── L3 Management Plane (SVIs) ────────────────────────────────
  private readonly svi: SwitchSvi = new SwitchSvi({
    deviceId: this.id,
    getHostname: () => this.getHostname(),
    getBridgeMac: () => this.getBridgeMac(),
    egressOnVlan: (vlan, frame) => this.egressOnVlan(vlan, frame),
    vlanHasActivePort: (vlan) => this.vlanHasActivePort(vlan),
    lookupArp: (ip) => this.arpTable.get(ip)?.mac ?? null,
    learnArp: (ip, mac, iface) => {
      const existing = this.arpTable.get(ip);
      if (existing && existing.type === 'static') return;
      this.arpTable.set(ip, { mac, iface, timestamp: Date.now(), type: 'dynamic' });
    },
  });

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
    this.initDhcpSnooping();
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

  private findClientMacEntry(clientMac: string): MACTableEntry | null {
    const mac = clientMac.toLowerCase();
    for (const entry of this.macTable.values()) {
      if (entry.mac === mac) return entry;
    }
    return null;
  }

  private upsertSnoopingBinding(binding: DHCPSnoopingBinding): void {
    const idx = this.snoopingBindings.findIndex((b) => b.macAddress === binding.macAddress && b.vlan === binding.vlan);
    if (idx >= 0) this.snoopingBindings[idx] = binding;
    else this.snoopingBindings.push(binding);
    this.snoopingLog.push(`DHCP_SNOOPING: added binding ${binding.macAddress} ${binding.ipAddress} VLAN ${binding.vlan} ${binding.port}`);
  }

  private removeSnoopingBindingByIp(ip: string): void {
    const idx = this.snoopingBindings.findIndex((b) => b.ipAddress === ip);
    if (idx < 0) return;
    const [removed] = this.snoopingBindings.splice(idx, 1);
    this.snoopingLog.push(`DHCP_SNOOPING: removed binding ${removed.macAddress} ${removed.ipAddress} VLAN ${removed.vlan} ${removed.port}`);
  }

  private tryRecordSnoopingBinding(clientMac: string, ip: string, leaseTimeSec: number, retriesLeft: number): void {
    if (!this.dhcpSnooping.enabled) return;
    const entry = this.findClientMacEntry(clientMac);
    if (!entry) {
      if (retriesLeft > 0) {
        this.getScheduler().setTimeout(
          () => this.tryRecordSnoopingBinding(clientMac, ip, leaseTimeSec, retriesLeft - 1),
          50,
        );
      }
      return;
    }
    if (this.dhcpSnooping.vlans.size > 0 && !this.dhcpSnooping.vlans.has(entry.vlan)) return;
    if (this.dhcpSnooping.trustedPorts.has(entry.port)) return;
    this.upsertSnoopingBinding({
      macAddress: entry.mac,
      ipAddress: ip,
      lease: leaseTimeSec,
      type: 'dynamic',
      vlan: entry.vlan,
      port: entry.port,
    });
  }

  private initDhcpSnooping(): void {
    this.dhcpSnoopingUnsubscribers.push(this.getBus().subscribeWhere(
      'dhcp.pool.lease-allocated',
      () => true,
      (e) => this.tryRecordSnoopingBinding(e.payload.clientMac, e.payload.ip, e.payload.leaseTimeSec, 5),
    ));

    this.dhcpSnoopingUnsubscribers.push(this.getBus().subscribeWhere(
      'dhcp.pool.lease-released',
      () => true,
      (e) => { this.removeSnoopingBindingByIp(e.payload.ip); },
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
      if (portName.startsWith('Fast')) port.setSpeed(100);
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
          if (stp === 'listening' || stp === 'learning' || stp === 'disabled') {
            this.stpStates.set(portName, 'forwarding');
          }
        } else {
          // Real switches purge dynamic entries the moment a link drops —
          // frames must not chase a dead port for up to 300 s of aging.
          this.stpStates.set(portName, 'disabled');
          this.flushDynamicMacsOnPort(portName, 'link-down');
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
    for (const u of this.dhcpSnoopingUnsubscribers) u();
    this.dhcpSnoopingUnsubscribers = [];
    if (this.arpInspectionPipeline) this.initArpInspection();
    this.initPortSecurity();
    this.initDhcpSnooping();
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
    for (const u of this.dhcpSnoopingUnsubscribers) u();
    this.dhcpSnoopingUnsubscribers = [];
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

  resolveSnoopingVlan(portName: string): number | undefined {
    const cfg = this.getSwitchportConfig(portName);
    if (!cfg) return undefined;
    if (cfg.mode === 'access') return cfg.accessVlan;
    if (cfg.mode === 'trunk') return cfg.trunkNativeVlan;
    return undefined;
  }

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

    this.flushDynamicMacsOnPort(portName, 'access-vlan-change');

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

  getStpPortVlans(portName: string): number[] {
    const cfg = this.switchportConfigs.get(portName);
    if (!cfg) return [1];
    if (cfg.mode === 'access') {
      return this.vlans.has(cfg.accessVlan) ? [cfg.accessVlan] : [1];
    }
    const out = [...cfg.trunkAllowedVlans]
      .filter((v) => this.vlans.has(v))
      .sort((a, b) => a - b);
    return out.length ? out : [1];
  }

  getStpVlanState(portName: string, vlan: number): STPPortState {
    return this.stpVlanStates.get(`${vlan}:${portName}`) ?? this.getSTPState(portName);
  }

  setStpVlanState(portName: string, vlan: number, state: STPPortState): void {
    this.stpVlanStates.set(`${vlan}:${portName}`, state);
    if (vlan === 1) this.setSTPState(portName, state);
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
    this.getBus().publish({
      topic: 'switch.mac.cleared',
      payload: { deviceId: this.id, hostname: this.getHostname() },
    });
  }

  clearDynamicMACEntries(filter?: { vlan?: number; port?: string }): void {
    for (const [key, entry] of this.macTable) {
      if (entry.type !== 'dynamic') continue;
      if (filter?.vlan !== undefined && entry.vlan !== filter.vlan) continue;
      if (filter?.port !== undefined && entry.port !== filter.port) continue;
      this.macTable.delete(key);
    }
    this.getBus().publish({
      topic: 'switch.mac.cleared',
      payload: { deviceId: this.id, hostname: this.getHostname() },
    });
  }

  /** Purge dynamic entries learned on a port (link-down, err-disable,
   *  802.1X de-authorization). */
  protected flushDynamicMacsOnPort(portName: string, reason: string): void {
    let flushed = 0;
    for (const [key, entry] of this.macTable) {
      if (entry.port === portName && entry.type === 'dynamic') {
        this.macTable.delete(key);
        flushed++;
      }
    }
    if (flushed === 0) return;
    Logger.debug(this.id, 'switch:mac-flush',
      `${this.name}: flushed ${flushed} dynamic MAC(s) on ${portName} (${reason})`);
    this.getBus().publish({
      topic: 'switch.mac.flushed',
      payload: {
        deviceId: this.id, hostname: this.getHostname(),
        port: portName, reason, count: flushed,
      },
    });
  }

  getMACAgingTime(): number {
    return this.macAgingTime;
  }

  setMACAgingTime(seconds: number): void {
    this.macAgingTime = seconds;
  }

  /** STP hook: enable fast aging during a topology change, null restores. */
  _setStpFastAging(agingSec: number | null): void {
    this.stpFastAgingTime = agingSec;
  }

  /** Aging limit in effect (fast aging wins while a TC circulates). */
  private effectiveMacAgingTime(): number {
    return this.stpFastAgingTime ?? this.macAgingTime;
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

    const stpState = this.getStpVlanState(portName, ingressVlan);
    if (stpState === 'blocking' || stpState === 'disabled' || stpState === 'listening') {
      Logger.debug(this.id, 'switch:stp-drop', `${this.name}: dropping frame on ${portName} VLAN ${ingressVlan} (${stpState})`);
      return;
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
      const isNew = !existing;
      this.macTable.set(macKey, {
        mac: srcMAC,
        vlan: ingressVlan,
        port: portName,
        type: 'dynamic',
        age: this.macAgingTime,
        timestamp: Date.now(),
      });
      Logger.debug(this.id, 'switch:mac-learn', `${this.name}: learned ${srcMAC} VLAN ${ingressVlan} on ${portName}`);
      if (isNew) {
        this.getBus().publish({
          topic: 'switch.mac.learned',
          payload: { deviceId: this.id, hostname: this.getHostname(), mac: srcMAC.toString(), vlan: ingressVlan, port: portName },
        });
      } else if (existing.port !== portName) {
        this.getBus().publish({
          topic: 'switch.mac.moved',
          payload: { deviceId: this.id, hostname: this.getHostname(), mac: srcMAC.toString(), vlan: ingressVlan, port: portName, fromPort: existing.port },
        });
      }
    }

    // ─── Step 2.5: Management plane (SVI) intercept ─────────────
    // A frame addressed to one of our SVIs is consumed here (the box is the
    // destination, not a transit bridge). Broadcast ARP for an SVI is answered
    // but still allowed to flood, so `intercept` returns false for it.
    if (this.svi.intercept(ingressVlan, portName, frame)) {
      return;
    }

    // ─── Step 3: Forwarding Decision ────────────────────────────
    // In learning state: learn MACs but do NOT forward frames
    if (stpState === 'learning') {
      return;
    }

    const dstMAC = frame.dstMAC.toString().toLowerCase();

    // IEEE 802.3 §3.2.3 — the I/G bit (LSB of the first octet) marks
    // ANY group address: IPv4 multicast 01:00:5e, IPv6 33:33, protocol
    // MACs 01:80:c2/01:00:0c, … Group frames are never unicast-matched
    // against the MAC table; they are snooped or flooded.
    const dstOctets = frame.dstMAC.getOctets();
    const isMulticast = frame.dstMAC.isBroadcast() ||
                        (dstOctets[0] & 0x01) === 0x01;

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

  /**
   * IGMP-snooping constrained forwarding (RFC 4541 §2.1.2): when a
   * snooping agent is present and enabled on the VLAN, an IPv4
   * multicast frame egresses only the member/router ports. Vendors
   * supply their agent via {@link getIgmpSnoopingAgentOrNull}; the
   * pipeline itself is vendor-neutral and lives here once.
   */
  protected resolveSnoopedMulticastEgressPorts(ingressPort: string, frame: EthernetFrame, vlan: number): string[] | null {
    if (frame.etherType !== ETHERTYPE_IPV4) return null;
    const ipPkt = frame.payload as IPv4Packet | undefined;
    if (!ipPkt || ipPkt.type !== 'ipv4' || !(ipPkt.destinationIP instanceof IPAddress)) return null;
    const firstOctet = ipPkt.destinationIP.getOctets()[0];
    if (firstOctet < 224 || firstOctet > 239) return null;
    const agent = this.getIgmpSnoopingAgentOrNull();
    if (!agent) return null;
    const vlanState = agent.getVlanState(vlan);
    if (!vlanState || !vlanState.enabled) return null;
    const ports = agent.computeEgressPorts(ingressPort, ipPkt.destinationIP.toString());
    return ports.length > 0 ? ports : null;
  }

  /** Vendor hook: the IGMP-snooping agent, when the platform has one. */
  protected getIgmpSnoopingAgentOrNull(): IgmpSnoopingAgentLike | null {
    return null;
  }

  // ─── Flood within VLAN ────────────────────────────────────────────

  private floodFrame(exceptPort: string, frame: EthernetFrame, vlan: number): void {
    for (const [portName, cfg] of this.switchportConfigs) {
      if (portName === exceptPort) continue;

      const port = this.getPort(portName);
      if (!port || !port.getIsUp() || !port.isConnected()) continue;

      const stpState = this.getStpVlanState(portName, vlan);
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

    const stpState = this.getStpVlanState(portName, vlan);
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

  // ─── L3 Management Plane (SVI) plumbing ───────────────────────────

  /** Bridge base MAC — shared by every SVI, like real Catalyst hardware. */
  getBridgeMac(): MACAddress {
    const first = this.getPorts()[0];
    return first ? first.getMAC() : MACAddress.broadcast();
  }

  /** True when `vlan` has at least one up, cabled member port. */
  private vlanHasActivePort(vlan: number): boolean {
    for (const [portName, cfg] of this.switchportConfigs) {
      const port = this.getPort(portName);
      if (!port || !port.getIsUp() || !port.isConnected()) continue;
      if (cfg.mode === 'access' ? cfg.accessVlan === vlan : cfg.trunkAllowedVlans.has(vlan)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Source a frame from the management plane onto `vlan`: reuse the very same
   * unknown-unicast/flood vs known-unicast decision the data plane makes for
   * transit frames, so an SVI packet leaves exactly like a host's would.
   */
  private egressOnVlan(vlan: number, frame: EthernetFrame): void {
    const dstMAC = frame.dstMAC.toString().toLowerCase();
    const dstOctets = frame.dstMAC.getOctets();
    const isGroup = frame.dstMAC.isBroadcast() || (dstOctets[0] & 0x01) === 0x01;
    const entry = isGroup ? undefined : this.macTable.get(`${vlan}:${dstMAC}`);
    if (entry) {
      this.forwardToPort(entry.port, frame, vlan);
    } else {
      this.floodFrame('', frame, vlan);
    }
  }

  // ─── SVI configuration API (used by the vendor shell) ─────────────

  /** `interface Vlan N` — materialise the SVI (admin-down, no IP) if new. */
  ensureSvi(vlan: number): void { this.svi.ensure(vlan); }
  configureSviIp(vlan: number, ip: IPAddress, mask: SubnetMask): void {
    this.svi.configure(vlan, ip, mask);
  }
  clearSviIp(vlan: number): void { this.svi.clearIp(vlan); }
  setSviAdminUp(vlan: number, up: boolean): void { this.svi.setAdminUp(vlan, up); }
  hasSvi(vlan: number): boolean { return this.svi.hasSvi(vlan); }
  getSvis(): SviInterface[] { return this.svi.list(); }
  getSvi(vlan: number): SviInterface | undefined { return this.svi.getSvi(vlan); }
  isSviLineUp(svi: SviInterface): boolean { return this.svi.isLineUp(svi); }

  /** Drive ICMP echoes from the management SVI (mirrors Router API). */
  executePingSequence(
    target: IPAddress, count = 5, timeoutMs = 2000, sourceIPStr?: string,
  ): Promise<CiscoPingRow[]> {
    return this.svi.executePingSequence(target, count, timeoutMs, sourceIPStr);
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
      const limit = this.effectiveMacAgingTime();
      for (const [key, entry] of this.macTable) {
        if (entry.type === 'dynamic') {
          const elapsed = Math.floor((now - entry.timestamp) / 1000);
          entry.age = Math.max(0, limit - elapsed);
          if (entry.age <= 0) {
            this.macTable.delete(key);
            Logger.debug(this.id, 'switch:mac-age', `${this.name}: aged out ${entry.mac} VLAN ${entry.vlan}`);
            this.getBus().publish({
              topic: 'switch.mac.aged',
              payload: { deviceId: this.id, hostname: this.getHostname(), mac: String(entry.mac), vlan: entry.vlan, port: entry.port },
            });
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
    // NVRAM holds the rendered running-config TEXT — the same representation
    // `show startup-config` displays and `reload` re-applies. Real IOS stores
    // and re-parses config text; we do the same instead of a private blob.
    this.startupConfig = this.getRunningConfig();
    return '[OK]';
  }

  getStartupConfig(): string | null {
    return this.startupConfig;
  }

  /** @internal Erase NVRAM (`erase startup-config` / `write erase`). */
  _eraseStartupConfig(): void {
    this.startupConfig = null;
  }

  /** @internal Re-apply NVRAM onto the live config (`copy startup-config
   *  running-config`). Returns false when NVRAM is empty. */
  _restoreStartupConfig(): boolean {
    if (!this.startupConfig) return false;
    this.applyConfigText(this.startupConfig);
    return true;
  }

  /** @internal Re-apply an arbitrary saved config text (`copy flash:X
   *  running-config`). */
  _applyConfigText(text: string): void { this.applyConfigText(text); }

  // ── Simulated flash file system (config backups) ──────────────────
  private flashFiles = new Map<string, string>();
  /** @internal `copy running-config flash:X` — store a named config file. */
  _writeFlashFile(name: string, content: string): void { this.flashFiles.set(name, content); }
  /** @internal `copy flash:X running-config` — read it back (null if absent). */
  _readFlashFile(name: string): string | null { return this.flashFiles.get(name) ?? null; }

  private restoreFromStartupConfig(): void {
    if (this.startupConfig) this.applyConfigText(this.startupConfig);
  }

  /**
   * Re-apply a saved running-config (text) to live switch state. Parses the
   * canonical lines emitted by the vendor shell's `buildRunningConfig` —
   * hostname, VLAN database and per-interface switchport settings — which is
   * exactly the state the previous JSON snapshot restored, but from the single
   * text representation now shared with `show startup-config`.
   */
  private applyConfigText(text: string): void {
    let curVlan: number | null = null;
    let curIface: string | null = null;
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line || line === '!' ||
          line.startsWith('Building config') || line.startsWith('Current configuration')) continue;
      let g: RegExpMatchArray | null;
      if ((g = line.match(/^hostname\s+(\S+)/))) {
        this.hostname = g[1]; this.name = g[1]; curVlan = null; curIface = null;
      } else if ((g = line.match(/^vlan\s+(\d+)$/))) {
        curVlan = parseInt(g[1], 10); curIface = null;
        if (!this.vlans.has(curVlan)) this.createVLAN(curVlan);
      } else if (curVlan !== null && (g = line.match(/^name\s+(.+)/))) {
        this.renameVLAN(curVlan, g[1]);
      } else if ((g = line.match(/^interface\s+(\S+)/))) {
        curIface = g[1]; curVlan = null;
      } else if (curIface) {
        const cfg = this.switchportConfigs.get(curIface);
        if (!cfg) continue;
        if (/^switchport mode trunk/.test(line)) cfg.mode = 'trunk';
        else if (/^switchport mode access/.test(line)) cfg.mode = 'access';
        else if ((g = line.match(/^switchport access vlan\s+(\d+)/))) cfg.accessVlan = parseInt(g[1], 10);
        else if ((g = line.match(/^switchport trunk native vlan\s+(\d+)/))) cfg.trunkNativeVlan = parseInt(g[1], 10);
        else if (/^shutdown$/.test(line)) { const p = this.getPort(curIface); if (p) p.setUp(false); }
      }
    }
    // Rebuild access-VLAN port membership from the restored switchport config.
    for (const [portName, cfg] of this.switchportConfigs) {
      if (cfg.mode === 'access') {
        const vlan = this.vlans.get(cfg.accessVlan);
        if (vlan) vlan.ports.add(portName);
      }
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
  _addSnoopingLog(msg: string): void { this.snoopingLog.push(msg); }
  _getInterfaceDescriptions(): Map<string, string> { return this.interfaceDescriptions; }

  // ─── Management plane: domain / SSH host keys / default-gateway ────
  private _domainName = '';
  private _hasRsaKeys = false;
  private _ipDefaultGateway = '';
  /** @internal `ip domain-name` (device fallback for the shared handler). */
  _setDomainName(name: string): void { this._domainName = name; }
  getDomainName(): string { return this._domainName; }
  /** @internal `crypto key generate rsa`. */
  _generateRsaKeys(): void { this._hasRsaKeys = true; }
  hasRsaKeys(): boolean { return this._hasRsaKeys; }
  /** @internal `ip default-gateway` (L2 switch management route). */
  _setDefaultGateway(ip: string): void { this._ipDefaultGateway = ip; }
  getDefaultGateway(): string { return this._ipDefaultGateway; }

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
    if (type === 'motd') return this.motdBannerText;
    if (type === 'login') return this.loginBannerText;
    if (type === 'exec') return this.execBannerText;
    return '';
  }

  protected motdBannerText: string = '';
  protected loginBannerText: string = '';
  protected execBannerText: string = '';

  _setMotdBanner(text: string): void { this.motdBannerText = text; }
  _setLoginBanner(text: string): void { this.loginBannerText = text; }
  _setExecBanner(text: string): void { this.execBannerText = text; }

  async executeCommand(command: string): Promise<string> {
    if (!this.isPoweredOn) return '% Device is powered off';
    return this.shell.execute(this, command);
  }
}
