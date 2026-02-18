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
import { EthernetFrame, DeviceType, MACAddress } from '../core/types';
import { Logger } from '../core/Logger';
import {
  DHCPSnoopingConfig,
  DHCPSnoopingBinding,
  createDefaultSnoopingConfig,
} from '../dhcp/types';
import type { ISwitchShell } from './shells/ISwitchShell';

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
  // ─── MAC Table ──────────────────────────────────────────────────
  private macTable: Map<string, MACTableEntry> = new Map(); // key: "vlan:mac"
  private macAgingTime: number = 300; // seconds
  private macAgingTimer: ReturnType<typeof setInterval> | null = null;

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

  // ─── CLI Shell ──────────────────────────────────────────────────
  private shell: ISwitchShell;

  constructor(type: DeviceType = 'switch-cisco', name: string = 'Switch', portCount: number = 50, x: number = 0, y: number = 0) {
    super(type, name, x, y);
    this.initialHostname = name;
    this.initPorts(portCount);
    this.initDefaultVLAN();
    this.startMACAgingProcess();
    this.shell = this.createShell();
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
    }
  }

  private initDefaultVLAN(): void {
    // VLAN 1 is the default VLAN — always exists
    const allPorts = new Set(this.getPortNames());
    this.vlans.set(1, { id: 1, name: 'default', ports: allPorts });
  }

  // ─── Power Management ────────────────────────────────────────────

  override powerOff(): void {
    super.powerOff();
    this.stopMACAgingProcess();
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
      this.floodFrame(portName, frame, ingressVlan);
    } else {
      const dstEntry = this.macTable.get(`${ingressVlan}:${dstMAC}`)!;
      if (dstEntry.port !== portName) {
        this.forwardToPort(dstEntry.port, frame, ingressVlan);
      }
    }
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
      // Trunk port
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

  private startMACAgingProcess(): void {
    if (this.macAgingTimer) return;
    this.macAgingTimer = setInterval(() => {
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
    if (this.macAgingTimer) {
      clearInterval(this.macAgingTimer);
      this.macAgingTimer = null;
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
