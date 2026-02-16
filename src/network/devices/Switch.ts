/**
 * Switch - Layer 2 Cisco Catalyst switching device
 *
 * Implements:
 *   - VLAN database (802.1Q tagging)
 *   - MAC address table with configurable aging (default 300s)
 *   - Access / Trunk port modes
 *   - Native VLAN on trunk links
 *   - Trunk allowed VLAN filtering
 *   - Running-config / Startup-config (NVRAM simulation)
 *   - Full Cisco IOS CLI via CiscoSwitchShell (FSM-based)
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

// ─── Switch Class ───────────────────────────────────────────────────

export class Switch extends Equipment {
  // ─── MAC Table ──────────────────────────────────────────────────
  private macTable: Map<string, MACTableEntry> = new Map(); // key: "vlan:mac"
  private macAgingTime: number = 300; // seconds
  private macAgingTimer: ReturnType<typeof setInterval> | null = null;

  // ─── VLAN Database ──────────────────────────────────────────────
  private vlans: Map<number, VLANEntry> = new Map();

  // ─── Port Configurations ────────────────────────────────────────
  private switchportConfigs: Map<string, SwitchportConfig> = new Map();

  // ─── STP Port States ────────────────────────────────────────────
  private stpStates: Map<string, STPPortState> = new Map();

  // ─── MAC Move Detection ───────────────────────────────────────
  private macMoveCount: number = 0;

  // ─── Port VLAN State (active/suspended) ────────────────────────
  private portVlanStates: Map<string, 'active' | 'suspended'> = new Map();

  // ─── Config Persistence ─────────────────────────────────────────
  private startupConfig: string | null = null;
  private readonly initialHostname: string;

  // ─── DHCP Snooping ────────────────────────────────────────────
  private dhcpSnooping: DHCPSnoopingConfig = createDefaultSnoopingConfig();
  private snoopingBindings: DHCPSnoopingBinding[] = [];
  private snoopingLog: string[] = [];
  private syslogServer: string | null = null;

  // ─── Interface Descriptions ──────────────────────────────────────
  private interfaceDescriptions: Map<string, string> = new Map();

  // ─── CLI Shell ──────────────────────────────────────────────────
  private shell: CiscoSwitchShell | HuaweiVRPSwitchShell;

  constructor(type: DeviceType = 'switch-cisco', name: string = 'Switch', portCount: number = 50, x: number = 0, y: number = 0) {
    super(type, name, x, y);
    this.initialHostname = name;
    this.createPorts(portCount);
    this.initDefaultVLAN();
    this.startMACAgingProcess();
    this.shell = this.isHuawei() ? new HuaweiVRPSwitchShell() : new CiscoSwitchShell();
  }

  /** Check if this switch is a Huawei device */
  isHuawei(): boolean { return this.deviceType.includes('huawei'); }

  private createPorts(count: number): void {
    const isCisco = this.deviceType.includes('cisco');
    const isHuawei = this.deviceType.includes('huawei');
    // Huawei: new ports start in listening (802.1D), Cisco: forwarding (portfast default)
    const initialSTP: STPPortState = isHuawei ? 'listening' : 'forwarding';

    for (let i = 0; i < count; i++) {
      const portName = isCisco
        ? (i < 24 ? `FastEthernet0/${i}` : `GigabitEthernet0/${i - 24}`)
        : isHuawei
          ? `GigabitEthernet0/0/${i}`
          : `eth${i}`;
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
    this.shell = this.isHuawei() ? new HuaweiVRPSwitchShell() : new CiscoSwitchShell();
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

    // Reactivate any suspended ports that were assigned to this VLAN
    for (const [portName, cfg] of this.switchportConfigs) {
      if (cfg.mode === 'access' && cfg.accessVlan === id && this.portVlanStates.get(portName) === 'suspended') {
        this.portVlanStates.set(portName, 'active');
        newVlan.ports.add(portName);
      }
    }

    Logger.info(this.id, 'switch:vlan-create', `${this.name}: created VLAN ${id}`);
    return true;
  }

  deleteVLAN(id: number): boolean {
    if (id === 1) return false; // Can't delete default VLAN
    if (!this.vlans.has(id)) return false;

    // Suspend ports that were in this VLAN (do NOT move to VLAN 1)
    const vlan = this.vlans.get(id)!;
    for (const portName of vlan.ports) {
      const cfg = this.switchportConfigs.get(portName);
      if (cfg && cfg.mode === 'access' && cfg.accessVlan === id) {
        // Port stays assigned to deleted VLAN but becomes suspended
        this.portVlanStates.set(portName, 'suspended');
      }
    }

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

  getOSType(): string { return this.isHuawei() ? 'huawei-vrp' : 'cisco-ios'; }

  getPrompt(): string { return this.shell.getPrompt(this); }

  /** Get CLI help for the given input (used by terminal UI for inline ? behavior) */
  cliHelp(inputBeforeQuestion: string): string {
    if ('getHelp' in this.shell && typeof (this.shell as any).getHelp === 'function') {
      return (this.shell as any).getHelp(inputBeforeQuestion);
    }
    return '';
  }

  /** Get CLI tab completion for the given input (used by terminal UI) */
  cliTabComplete(input: string): string | null {
    if ('tabComplete' in this.shell && typeof (this.shell as any).tabComplete === 'function') {
      return (this.shell as any).tabComplete(input);
    }
    return null;
  }

  getBootSequence(): string {
    if (this.isHuawei()) {
      return [
        '',
        `Huawei Versatile Routing Platform Software`,
        `VRP (R) software, Version 5.170 (S5720 V200R019C10SPC500)`,
        `Copyright (C) 2000-2025 HUAWEI TECH CO., LTD`,
        '',
        `${this.hostname} with ${this.getPortNames().length} GigabitEthernet interfaces`,
        `Base ethernet MAC address: ${this.getPort(this.getPortNames()[0])?.getMAC() || '00:00:00:00:00:00'}`,
        '',
        'Press ENTER to get started.',
      ].join('\n');
    }
    return [
      '',
      `Cisco IOS Software, C2960 Software (C2960-LANBASEK9-M), Version 15.2(7)E2`,
      `Copyright (c) 1986-2025 by Cisco Systems, Inc.`,
      '',
      `${this.hostname} processor with 65536K bytes of memory.`,
      `${this.getPortNames().filter(n => n.startsWith('Fast')).length} FastEthernet interfaces`,
      `${this.getPortNames().filter(n => n.startsWith('Gig')).length} Gigabit Ethernet interfaces`,
      '',
      `Base ethernet MAC address: ${this.getPort(this.getPortNames()[0])?.getMAC() || '00:00:00:00:00:00'}`,
      '',
      'Press RETURN to get started.',
    ].join('\n');
  }

  getBanner(type: string): string {
    if (type === 'motd') return '';
    return '';
  }

  async executeCommand(command: string): Promise<string> {
    if (!this.isPoweredOn) return '% Device is powered off';
    return this.shell.execute(this, command);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// CiscoSwitchShell - Cisco IOS CLI Engine with FSM
// ═══════════════════════════════════════════════════════════════════════

import { CommandTrie, type CommandAction, type MatchResult } from './shells/CommandTrie';

/** CLI Mode (FSM State) */
export type CLIMode = 'user' | 'privileged' | 'config' | 'config-if' | 'config-vlan';

export class CiscoSwitchShell {
  private mode: CLIMode = 'user';
  private selectedInterface: string | null = null;
  private selectedInterfaceRange: string[] = [];
  private selectedVlan: number | null = null;

  // Per-mode command tries
  private userTrie = new CommandTrie();
  private privilegedTrie = new CommandTrie();
  private configTrie = new CommandTrie();
  private configIfTrie = new CommandTrie();
  private configVlanTrie = new CommandTrie();

  constructor() {
    this.buildUserCommands();
    this.buildPrivilegedCommands();
    this.buildConfigCommands();
    this.buildConfigIfCommands();
    this.buildConfigVlanCommands();
  }

  // ─── Mode Management ──────────────────────────────────────────────

  getMode(): CLIMode { return this.mode; }

  getPrompt(sw: Switch): string {
    const host = sw.getHostname();
    switch (this.mode) {
      case 'user':        return `${host}>`;
      case 'privileged':  return `${host}#`;
      case 'config':      return `${host}(config)#`;
      case 'config-if':   return `${host}(config-if)#`;
      case 'config-vlan': return `${host}(config-vlan)#`;
      default:            return `${host}>`;
    }
  }

  getSelectedInterface(): string | null { return this.selectedInterface; }
  getSelectedInterfaceRange(): string[] { return [...this.selectedInterfaceRange]; }

  // ─── Main Execute ─────────────────────────────────────────────────

  execute(sw: Switch, input: string): string {
    const trimmed = input.trim();
    if (!trimmed) return '';

    // Handle pipe filtering: "show logging | include DHCP"
    let pipeFilter: { type: string; pattern: string } | null = null;
    let cmdPart = trimmed;
    const pipeIdx = trimmed.indexOf(' | ');
    if (pipeIdx !== -1) {
      cmdPart = trimmed.substring(0, pipeIdx).trim();
      const filterPart = trimmed.substring(pipeIdx + 3).trim();
      const filterMatch = filterPart.match(/^(include|exclude|grep|findstr)\s+(.+)$/i);
      if (filterMatch) {
        pipeFilter = { type: filterMatch[1].toLowerCase(), pattern: filterMatch[2] };
      }
    }

    // Handle ? for help (preserve trailing space: "show ?" vs "show?")
    if (cmdPart.endsWith('?')) {
      this.swRef = sw;
      const helpInput = cmdPart.slice(0, -1);
      const result = this.getHelp(helpInput);
      this.swRef = null;
      return result;
    }

    // Global shortcuts
    if (cmdPart.toLowerCase() === 'exit') return this.cmdExit();
    if (cmdPart.toLowerCase() === 'end' || cmdPart === '\x03') return this.cmdEnd();
    if (cmdPart.toLowerCase() === 'logout' && this.mode === 'user') return 'Connection closed.';
    if (cmdPart.toLowerCase() === 'disable' && this.mode === 'privileged') {
      this.mode = 'user';
      return '';
    }

    // Bind switch reference for command closures
    this.swRef = sw;

    // Get the trie for current mode
    const trie = this.getActiveTrie();
    const result = trie.match(cmdPart);

    let output: string;
    switch (result.status) {
      case 'ok':
        output = result.node?.action ? result.node.action(result.args, cmdPart) : '';
        break;

      case 'ambiguous':
        output = result.error || `% Ambiguous command: "${cmdPart}"`;
        break;

      case 'incomplete':
        output = result.error || '% Incomplete command.';
        break;

      case 'invalid':
        output = result.error || `% Invalid input detected at '^' marker.`;
        break;

      default:
        output = `% Unrecognized command "${cmdPart}"`;
    }

    this.swRef = null;

    // Apply pipe filter if present
    if (pipeFilter && output) {
      const lines = output.split('\n');
      const pattern = pipeFilter.pattern.toLowerCase();
      if (pipeFilter.type === 'include' || pipeFilter.type === 'grep' || pipeFilter.type === 'findstr') {
        output = lines.filter(l => l.toLowerCase().includes(pattern)).join('\n');
      } else if (pipeFilter.type === 'exclude') {
        output = lines.filter(l => !l.toLowerCase().includes(pattern)).join('\n');
      }
    }

    return output;
  }

  // ─── Help / Completion ────────────────────────────────────────────

  getHelp(input: string): string {
    const trie = this.getActiveTrie();
    const completions = trie.getCompletions(input);
    if (completions.length === 0) return '% Unrecognized command';
    const maxKw = Math.max(...completions.map(c => c.keyword.length));
    return completions
      .map(c => `  ${c.keyword.padEnd(maxKw + 2)}${c.description}`)
      .join('\n');
  }

  tabComplete(input: string): string | null {
    const trie = this.getActiveTrie();
    return trie.tabComplete(input);
  }

  // ─── Running Config Builder ───────────────────────────────────────

  buildRunningConfig(sw: Switch): string {
    const lines = [
      'Building configuration...',
      '',
      'Current configuration:',
      '!',
      `hostname ${sw.getHostname()}`,
      '!',
    ];

    // VLANs
    for (const [id, vlan] of sw.getVLANs()) {
      if (id === 1) continue;
      lines.push(`vlan ${id}`);
      lines.push(` name ${vlan.name}`);
      lines.push('!');
    }

    // Interfaces
    const ports = sw._getPortsInternal();
    const configs = sw._getSwitchportConfigs();
    for (const [portName, port] of ports) {
      const cfg = configs.get(portName);
      if (!cfg) continue;

      lines.push(`interface ${portName}`);
      if (cfg.mode === 'trunk') {
        lines.push(` switchport mode trunk`);
        if (cfg.trunkNativeVlan !== 1) {
          lines.push(` switchport trunk native vlan ${cfg.trunkNativeVlan}`);
        }
      } else {
        lines.push(` switchport mode access`);
        if (cfg.accessVlan !== 1) {
          lines.push(` switchport access vlan ${cfg.accessVlan}`);
        }
      }
      if (!port.getIsUp()) {
        lines.push(` shutdown`);
      }
      lines.push('!');
    }

    lines.push('end');
    return lines.join('\n');
  }

  // ─── FSM Transitions ─────────────────────────────────────────────

  private cmdExit(): string {
    switch (this.mode) {
      case 'config-if':
        this.mode = 'config';
        this.selectedInterface = null;
        this.selectedInterfaceRange = [];
        return '';
      case 'config-vlan':
        this.mode = 'config';
        this.selectedVlan = null;
        return '';
      case 'config':
        this.mode = 'privileged';
        return '';
      case 'privileged':
        this.mode = 'user';
        return '';
      case 'user':
        return 'Connection closed.';
      default:
        return '';
    }
  }

  private cmdEnd(): string {
    if (this.mode === 'config' || this.mode === 'config-if' || this.mode === 'config-vlan') {
      this.mode = 'privileged';
      this.selectedInterface = null;
      this.selectedInterfaceRange = [];
      this.selectedVlan = null;
      return '';
    }
    return '';
  }

  private getActiveTrie(): CommandTrie {
    switch (this.mode) {
      case 'user':        return this.userTrie;
      case 'privileged':  return this.privilegedTrie;
      case 'config':      return this.configTrie;
      case 'config-if':   return this.configIfTrie;
      case 'config-vlan': return this.configVlanTrie;
      default:            return this.userTrie;
    }
  }

  // ─── Command Tree: User EXEC Mode (>) ────────────────────────────

  private swRef: Switch | null = null;

  /** Bind switch reference for command closures */
  private withSwitch(sw: Switch, fn: () => string): string {
    this.swRef = sw;
    const result = fn();
    this.swRef = null;
    return result;
  }

  private buildUserCommands(): void {
    // enable — the only way to enter privileged mode from user EXEC
    this.userTrie.register('enable', 'Enter privileged EXEC mode', () => {
      this.mode = 'privileged';
      return '';
    });

    // show version (limited show commands available in user mode)
    this.userTrie.register('show version', 'Display system hardware and software status', () => {
      if (!this.swRef) return '';
      return `Cisco IOS Software, C2960 Software\n${this.swRef.getHostname()} uptime is 0 days, 0 hours`;
    });

    // show commands (delegate to privileged show handlers)
    this.userTrie.register('show ip dhcp snooping', 'Display DHCP snooping configuration', () => {
      if (!this.swRef) return '';
      return this.showDHCPSnooping(this.swRef);
    });

    this.userTrie.register('show ip dhcp snooping binding', 'Display DHCP snooping binding table', () => {
      if (!this.swRef) return '';
      return this.showDHCPSnoopingBinding(this.swRef);
    });

    this.userTrie.register('show logging', 'Display syslog messages', () => {
      if (!this.swRef) return '';
      return this.showLogging(this.swRef);
    });

    // ping (basic in user mode)
    this.userTrie.registerGreedy('ping', 'Send echo messages', (args) => {
      return `Type escape sequence to abort.\n% Ping not yet implemented on switch.`;
    });
  }

  // ─── Command Tree: Privileged EXEC Mode (#) ──────────────────────

  private buildPrivilegedCommands(): void {
    // enable (no-op in privileged)
    this.privilegedTrie.register('enable', 'Already in privileged mode', () => '');

    // configure terminal
    this.privilegedTrie.register('configure terminal', 'Enter configuration mode', () => {
      this.mode = 'config';
      return 'Enter configuration commands, one per line.  End with CNTL/Z.';
    });

    // show mac address-table
    this.privilegedTrie.register('show mac address-table', 'Display MAC address table', () => {
      if (!this.swRef) return '';
      return this.showMACAddressTable(this.swRef);
    });

    // show vlan brief
    this.privilegedTrie.register('show vlan brief', 'Display VLAN summary', () => {
      if (!this.swRef) return '';
      return this.showVlanBrief(this.swRef);
    });

    // show vlan
    this.privilegedTrie.register('show vlan', 'Display VLAN information', () => {
      if (!this.swRef) return '';
      return this.showVlanBrief(this.swRef);
    });

    // show interfaces status
    this.privilegedTrie.register('show interfaces status', 'Display interface status', () => {
      if (!this.swRef) return '';
      return this.showInterfacesStatus(this.swRef);
    });

    // show interfaces
    this.privilegedTrie.register('show interfaces', 'Display interface information', () => {
      if (!this.swRef) return '';
      return this.showInterfacesStatus(this.swRef);
    });

    // show running-config
    this.privilegedTrie.register('show running-config', 'Display current running configuration', () => {
      if (!this.swRef) return '';
      return this.buildRunningConfig(this.swRef);
    });

    // show startup-config
    this.privilegedTrie.register('show startup-config', 'Display startup configuration', () => {
      if (!this.swRef) return '';
      const startup = this.swRef.getStartupConfig();
      return startup ? `Startup config (serialized):\n${startup}` : 'startup-config is not present';
    });

    // show spanning-tree
    this.privilegedTrie.register('show spanning-tree', 'Display spanning tree state', () => {
      if (!this.swRef) return '';
      return this.showSpanningTree(this.swRef);
    });

    // write memory / copy run start
    this.privilegedTrie.register('write memory', 'Save running-config to startup-config', () => {
      if (!this.swRef) return '';
      return this.swRef.writeMemory();
    });

    this.privilegedTrie.register('write', 'Save running-config to startup-config', () => {
      if (!this.swRef) return '';
      return this.swRef.writeMemory();
    });

    this.privilegedTrie.register('copy running-config startup-config', 'Save running-config to startup-config', () => {
      if (!this.swRef) return '';
      return this.swRef.writeMemory();
    });

    // show version
    this.privilegedTrie.register('show version', 'Display system information', () => {
      if (!this.swRef) return '';
      return `Cisco IOS Software, C2960 Software (C2960-LANBASEK9-M), Version 15.2(7)E2\n${this.swRef.getHostname()} uptime is 0 days, 0 hours`;
    });

    // reload
    this.privilegedTrie.register('reload', 'Restart the switch', () => {
      if (!this.swRef) return '';
      this.swRef.powerOff();
      this.swRef.powerOn();
      this.mode = 'user';
      return 'System restarting...';
    });

    // ─── DHCP Snooping Show Commands ────────────────────────────
    this.privilegedTrie.register('show ip dhcp snooping', 'Display DHCP snooping configuration', () => {
      if (!this.swRef) return '';
      return this.showDHCPSnooping(this.swRef);
    });

    this.privilegedTrie.register('show ip dhcp snooping binding', 'Display DHCP snooping binding table', () => {
      if (!this.swRef) return '';
      return this.showDHCPSnoopingBinding(this.swRef);
    });

    // show logging
    this.privilegedTrie.register('show logging', 'Display syslog messages', () => {
      if (!this.swRef) return '';
      return this.showLogging(this.swRef);
    });
  }

  // ─── Command Tree: Global Config Mode ((config)#) ────────────────

  private buildConfigCommands(): void {
    // hostname
    this.configTrie.registerGreedy('hostname', 'Set system hostname', (args) => {
      if (!this.swRef || args.length < 1) return '% Incomplete command.';
      this.swRef._setHostnameInternal(args[0]);
      return '';
    });

    // vlan <id>
    this.configTrie.registerGreedy('vlan', 'VLAN configuration', (args) => {
      if (!this.swRef || args.length < 1) return '% Incomplete command.';
      const id = parseInt(args[0], 10);
      if (isNaN(id) || id < 1 || id > 4094) return '% Invalid VLAN ID';
      if (!this.swRef.getVLAN(id)) {
        this.swRef.createVLAN(id);
      }
      this.selectedVlan = id;
      this.mode = 'config-vlan';
      return '';
    });

    // no vlan <id>
    this.configTrie.registerGreedy('no vlan', 'Delete a VLAN', (args) => {
      if (!this.swRef || args.length < 1) return '% Incomplete command.';
      const id = parseInt(args[0], 10);
      if (isNaN(id)) return '% Invalid VLAN ID';
      if (id === 1) return '% Default VLAN 1 may not be deleted.';
      return this.swRef.deleteVLAN(id) ? '' : `% VLAN ${id} not found.`;
    });

    // interface <id>
    this.configTrie.registerGreedy('interface', 'Select an interface to configure', (args) => {
      if (!this.swRef || args.length < 1) return '% Incomplete command.';

      // Handle "interface range"
      if (args[0].toLowerCase() === 'range') {
        return this.handleInterfaceRange(args.slice(1));
      }

      const portName = this.resolveInterfaceName(args[0]);
      if (!portName || !this.swRef.getPort(portName)) {
        return `% Invalid interface name "${args[0]}"`;
      }
      this.selectedInterface = portName;
      this.selectedInterfaceRange = [portName];
      this.mode = 'config-if';
      return '';
    });

    // mac address-table aging-time
    this.configTrie.registerGreedy('mac address-table aging-time', 'Set MAC address aging time', (args) => {
      if (!this.swRef || args.length < 1) return '% Incomplete command.';
      const seconds = parseInt(args[0], 10);
      if (isNaN(seconds) || seconds < 0) return '% Invalid aging time';
      this.swRef.setMACAgingTime(seconds);
      return '';
    });

    // no shutdown (no-op in global config)
    this.configTrie.register('no shutdown', 'Enable interface', () => '');

    // show running-config (available from config mode too)
    this.configTrie.register('show running-config', 'Display current configuration', () => {
      if (!this.swRef) return '';
      return this.buildRunningConfig(this.swRef);
    });

    this.configTrie.register('do show running-config', 'Display current configuration', () => {
      if (!this.swRef) return '';
      return this.buildRunningConfig(this.swRef);
    });

    this.configTrie.register('do show vlan brief', 'Display VLAN summary', () => {
      if (!this.swRef) return '';
      return this.showVlanBrief(this.swRef);
    });

    this.configTrie.register('do show mac address-table', 'Display MAC address table', () => {
      if (!this.swRef) return '';
      return this.showMACAddressTable(this.swRef);
    });

    this.configTrie.register('do write memory', 'Save configuration', () => {
      if (!this.swRef) return '';
      return this.swRef.writeMemory();
    });

    // ─── DHCP Snooping Commands ─────────────────────────────────
    this.configTrie.register('ip dhcp snooping', 'Enable DHCP snooping globally', () => {
      if (!this.swRef) return '';
      this.swRef._getDHCPSnoopingConfig().enabled = true;
      return '';
    });

    this.configTrie.registerGreedy('ip dhcp snooping vlan', 'Enable DHCP snooping on VLANs', (args) => {
      if (!this.swRef || args.length < 1) return '% Incomplete command.';
      const cfg = this.swRef._getDHCPSnoopingConfig();
      // Parse VLAN list: "1,10,20" or "1-10" or "1,10,20-30"
      const parts = args[0].split(',');
      for (const part of parts) {
        if (part.includes('-')) {
          const [s, e] = part.split('-').map(Number);
          if (!isNaN(s) && !isNaN(e)) {
            for (let i = s; i <= e; i++) cfg.vlans.add(i);
          }
        } else {
          const v = parseInt(part, 10);
          if (!isNaN(v)) cfg.vlans.add(v);
        }
      }
      return '';
    });

    this.configTrie.register('ip dhcp snooping verify mac-address', 'Enable MAC address verification', () => {
      if (!this.swRef) return '';
      this.swRef._getDHCPSnoopingConfig().verifyMac = true;
      return '';
    });

    this.configTrie.registerGreedy('logging', 'Configure syslog server', (args) => {
      if (!this.swRef || args.length < 1) return '% Incomplete command.';
      this.swRef._setSyslogServer(args[0]);
      return '';
    });
  }

  // ─── Command Tree: Interface Config Mode ((config-if)#) ──────────

  private buildConfigIfCommands(): void {
    // switchport mode access
    this.configIfTrie.register('switchport mode access', 'Set interface to access mode', () => {
      if (!this.swRef) return '';
      return this.applyToSelectedInterfaces(portName =>
        this.swRef!.setSwitchportMode(portName, 'access') ? '' : '% Error'
      );
    });

    // switchport mode trunk
    this.configIfTrie.register('switchport mode trunk', 'Set interface to trunk mode', () => {
      if (!this.swRef) return '';
      return this.applyToSelectedInterfaces(portName =>
        this.swRef!.setSwitchportMode(portName, 'trunk') ? '' : '% Error'
      );
    });

    // switchport access vlan <id>
    this.configIfTrie.registerGreedy('switchport access vlan', 'Assign interface to access VLAN', (args) => {
      if (!this.swRef || args.length < 1) return '% Incomplete command.';
      const vlanId = parseInt(args[0], 10);
      if (isNaN(vlanId) || vlanId < 1 || vlanId > 4094) return '% Invalid VLAN ID';
      return this.applyToSelectedInterfaces(portName =>
        this.swRef!.setSwitchportAccessVlan(portName, vlanId) ? '' : '% Error'
      );
    });

    // switchport trunk native vlan <id>
    this.configIfTrie.registerGreedy('switchport trunk native vlan', 'Set trunk native VLAN', (args) => {
      if (!this.swRef || args.length < 1) return '% Incomplete command.';
      const vlanId = parseInt(args[0], 10);
      if (isNaN(vlanId)) return '% Invalid VLAN ID';
      return this.applyToSelectedInterfaces(portName =>
        this.swRef!.setTrunkNativeVlan(portName, vlanId) ? '' : '% Error'
      );
    });

    // switchport trunk allowed vlan <list>
    this.configIfTrie.registerGreedy('switchport trunk allowed vlan', 'Set trunk allowed VLANs', (args) => {
      if (!this.swRef || args.length < 1) return '% Incomplete command.';
      const vlans = this.parseVlanList(args[0]);
      if (!vlans) return '% Invalid VLAN list';
      return this.applyToSelectedInterfaces(portName =>
        this.swRef!.setTrunkAllowedVlans(portName, vlans) ? '' : '% Error'
      );
    });

    // shutdown
    this.configIfTrie.register('shutdown', 'Disable interface', () => {
      if (!this.swRef) return '';
      return this.applyToSelectedInterfaces(portName => {
        const port = this.swRef!.getPort(portName);
        if (port) { port.setUp(false); return ''; }
        return '% Error';
      });
    });

    // no shutdown
    this.configIfTrie.register('no shutdown', 'Enable interface', () => {
      if (!this.swRef) return '';
      return this.applyToSelectedInterfaces(portName => {
        const port = this.swRef!.getPort(portName);
        if (port) { port.setUp(true); return ''; }
        return '% Error';
      });
    });

    // description (ignored but accepted for realism)
    this.configIfTrie.registerGreedy('description', 'Interface description', () => '');

    // ─── DHCP Snooping Interface Commands ──────────────────────
    this.configIfTrie.register('ip dhcp snooping trust', 'Set interface as trusted for DHCP snooping', () => {
      if (!this.swRef) return '';
      const cfg = this.swRef._getDHCPSnoopingConfig();
      return this.applyToSelectedInterfaces(portName => {
        cfg.trustedPorts.add(portName);
        return '';
      });
    });

    this.configIfTrie.registerGreedy('ip dhcp snooping limit rate', 'Set DHCP snooping rate limit', (args) => {
      if (!this.swRef || args.length < 1) return '% Incomplete command.';
      const rate = parseInt(args[0], 10);
      if (isNaN(rate) || rate < 1) return '% Invalid rate value';
      const cfg = this.swRef._getDHCPSnoopingConfig();
      return this.applyToSelectedInterfaces(portName => {
        cfg.rateLimits.set(portName, rate);
        return '';
      });
    });

    // show running-config (do show)
    this.configIfTrie.register('do show running-config', 'Display current configuration', () => {
      if (!this.swRef) return '';
      return this.buildRunningConfig(this.swRef);
    });
  }

  // ─── Command Tree: VLAN Config Mode ((config-vlan)#) ─────────────

  private buildConfigVlanCommands(): void {
    // name <vlan-name>
    this.configVlanTrie.registerGreedy('name', 'Set VLAN name', (args) => {
      if (!this.swRef || !this.selectedVlan || args.length < 1) return '% Incomplete command.';
      return this.swRef.renameVLAN(this.selectedVlan, args[0]) ? '' : '% VLAN not found';
    });
  }

  // ─── Show Command Implementations ────────────────────────────────

  private showMACAddressTable(sw: Switch): string {
    const entries = sw.getMACTable();
    if (entries.length === 0) return 'Mac Address Table\n-------------------------------------------\nNo entries.';

    const lines = [
      'Mac Address Table',
      '-------------------------------------------',
      '',
      'Vlan    Mac Address       Type        Ports',
      '----    -----------       --------    -----',
    ];

    const sorted = [...entries].sort((a, b) => a.vlan - b.vlan || a.mac.localeCompare(b.mac));
    for (const e of sorted) {
      const vlan = String(e.vlan).padEnd(8);
      const mac = e.mac.padEnd(18);
      const type = e.type === 'static' ? 'STATIC  ' : 'DYNAMIC ';
      lines.push(`${vlan}${mac}${type}    ${e.port}`);
    }

    lines.push('');
    lines.push(`Total Mac Addresses for this criterion: ${entries.length}`);
    return lines.join('\n');
  }

  private showVlanBrief(sw: Switch): string {
    const vlans = sw.getVLANs();
    const configs = sw._getSwitchportConfigs();

    const lines = [
      'VLAN Name                             Status    Ports',
      '---- -------------------------------- --------- -------------------------------',
    ];

    for (const [id, vlan] of vlans) {
      const name = vlan.name.padEnd(33);
      const status = 'active';

      // Collect access ports in this VLAN
      const portsInVlan: string[] = [];
      for (const [portName, cfg] of configs) {
        if (cfg.mode === 'access' && cfg.accessVlan === id) {
          portsInVlan.push(this.abbreviateInterface(portName));
        }
      }

      const portsStr = portsInVlan.join(', ');
      lines.push(`${String(id).padEnd(5)}${name}${status.padEnd(10)}${portsStr}`);
    }

    return lines.join('\n');
  }

  private showInterfacesStatus(sw: Switch): string {
    const ports = sw._getPortsInternal();
    const configs = sw._getSwitchportConfigs();

    const lines = [
      'Port        Name               Status       Vlan       Duplex  Speed Type',
      '----------  -----------------  -----------  ---------  ------  ----- ----',
    ];

    for (const [portName, port] of ports) {
      const cfg = configs.get(portName);
      const shortName = this.abbreviateInterface(portName).padEnd(12);
      const desc = ''.padEnd(19);
      const status = (port.getIsUp() ? (port.isConnected() ? 'connected' : 'notconnect') : 'disabled').padEnd(13);
      const vlanStr = cfg?.mode === 'trunk' ? 'trunk' : String(cfg?.accessVlan || 1);
      const duplex = 'a-full';
      const speed = portName.startsWith('Gi') ? 'a-1000' : 'a-100';
      const type = portName.startsWith('Gi') ? '1000BASE-T' : '10/100BaseTX';

      lines.push(`${shortName}${desc}${status}${vlanStr.padEnd(11)}${duplex.padEnd(8)}${speed.padEnd(6)}${type}`);
    }

    return lines.join('\n');
  }

  private showSpanningTree(sw: Switch): string {
    const stpStates = sw._getSTPStates();
    const lines = [
      'VLAN0001',
      '  Spanning tree enabled protocol ieee',
      '  Root ID    Priority    32769',
      `             Address     ${sw.getPort(sw.getPortNames()[0])?.getMAC() || '0000.0000.0000'}`,
      '',
      'Interface        Role  Sts  Cost      Prio.Nbr  Type',
      '---------------- ----  ---  --------  --------  ----',
    ];

    for (const [portName, state] of stpStates) {
      const shortName = this.abbreviateInterface(portName).padEnd(17);
      const role = 'Desg';
      const sts = state === 'forwarding' ? 'FWD' :
                  state === 'blocking'   ? 'BLK' :
                  state === 'listening'  ? 'LIS' :
                  state === 'learning'   ? 'LRN' : 'DIS';
      lines.push(`${shortName}${role.padEnd(6)}${sts.padEnd(5)}19        128.${portName.replace(/\D/g, '').padEnd(6)}P2p`);
    }

    return lines.join('\n');
  }

  // ─── DHCP Snooping Display ───────────────────────────────────────

  private showDHCPSnooping(sw: Switch): string {
    const cfg = sw._getDHCPSnoopingConfig();
    const lines: string[] = [];

    lines.push(`Switch DHCP snooping is ${cfg.enabled ? 'enabled' : 'disabled'}`);

    if (cfg.vlans.size > 0) {
      const vlanList = Array.from(cfg.vlans).sort((a, b) => a - b).join(',');
      lines.push(`DHCP snooping is configured on following VLANs:`);
      lines.push(`${vlanList}`);
    }

    if (cfg.verifyMac) {
      lines.push(`DHCP snooping verify mac-address is enabled`);
    }

    // Show trusted ports
    if (cfg.trustedPorts.size > 0) {
      const trusted = Array.from(cfg.trustedPorts)
        .map(p => this.abbreviateInterface(p))
        .join(', ');
      lines.push(`Trusted ports: ${trusted}`);
    }

    // Show rate-limited ports
    for (const [port, rate] of cfg.rateLimits) {
      lines.push(`  ${this.abbreviateInterface(port)}: rate limit ${rate} pps`);
    }

    return lines.join('\n');
  }

  private showDHCPSnoopingBinding(sw: Switch): string {
    const bindings = sw._getSnoopingBindings();
    const lines: string[] = [];

    lines.push('MacAddress          IP address        Lease(sec)  Type           VLAN  Interface');
    lines.push('------------------  ----------------  ----------  -------------  ----  --------------------');

    if (bindings.length === 0) {
      lines.push('Total number of bindings: 0');
    } else {
      for (const b of bindings) {
        const mac = b.macAddress.padEnd(20);
        const ip = b.ipAddress.padEnd(18);
        const lease = String(b.lease).padEnd(12);
        const type = b.type.padEnd(15);
        const vlan = String(b.vlan).padEnd(6);
        lines.push(`${mac}${ip}${lease}${type}${vlan}${b.port}`);
      }
      lines.push(`Total number of bindings: ${bindings.length}`);
    }

    return lines.join('\n');
  }

  private showLogging(sw: Switch): string {
    const logs = sw._getSnoopingLog();
    const syslog = sw._getSyslogServer();
    const lines: string[] = [];

    lines.push(`Syslog logging: enabled`);
    if (syslog) {
      lines.push(`  Logging to ${syslog}`);
    }
    lines.push('');

    if (logs.length > 0) {
      for (const log of logs) {
        lines.push(log);
      }
    } else {
      // Add default DHCP snooping messages if snooping is enabled
      const cfg = sw._getDHCPSnoopingConfig();
      if (cfg.enabled) {
        lines.push(`*${new Date().toLocaleString()}: %DHCP_SNOOPING-5-DHCP_SNOOPING_ENABLED: DHCP Snooping enabled globally`);
        if (cfg.verifyMac) {
          lines.push(`*${new Date().toLocaleString()}: %DHCP_SNOOPING-5-DHCP_SNOOPING_VERIFY_MAC: DHCP snooping verify mac-address enabled`);
        }
      }
    }

    return lines.join('\n');
  }

  // ─── Interface Resolution ─────────────────────────────────────────

  /** Resolve abbreviated interface names: fa0/1 → FastEthernet0/1, gi0/0 → GigabitEthernet0/0 */
  private resolveInterfaceName(input: string): string | null {
    const lower = input.toLowerCase();

    // Direct match
    if (this.swRef) {
      for (const name of this.swRef.getPortNames()) {
        if (name.toLowerCase() === lower) return name;
      }
    }

    // Abbreviation expansion
    const prefixMap: Record<string, string> = {
      'fa': 'FastEthernet',
      'fas': 'FastEthernet',
      'fast': 'FastEthernet',
      'faste': 'FastEthernet',
      'fastet': 'FastEthernet',
      'fasteth': 'FastEthernet',
      'fastetherr': 'FastEthernet',
      'fastethernet': 'FastEthernet',
      'gi': 'GigabitEthernet',
      'gig': 'GigabitEthernet',
      'giga': 'GigabitEthernet',
      'gigab': 'GigabitEthernet',
      'gigabi': 'GigabitEthernet',
      'gigabit': 'GigabitEthernet',
      'gigabite': 'GigabitEthernet',
      'gigabitet': 'GigabitEthernet',
      'gigabiteth': 'GigabitEthernet',
      'gigabitethernet': 'GigabitEthernet',
      'eth': 'eth',
    };

    // Extract prefix and number
    const match = lower.match(/^([a-z]+)([\d/.-]+)$/);
    if (!match) return null;

    const [, prefix, numbers] = match;
    const fullPrefix = prefixMap[prefix];
    if (!fullPrefix) return null;

    const resolved = `${fullPrefix}${numbers}`;

    // Verify exists on switch
    if (this.swRef) {
      for (const name of this.swRef.getPortNames()) {
        if (name === resolved) return name;
      }
    }

    return null;
  }

  /** Handle "interface range FastEthernet 0/1 - 24" */
  private handleInterfaceRange(args: string[]): string {
    if (args.length < 1) return '% Incomplete command.';

    // Join and parse: "FastEthernet 0/1 - 24" or "fa0/1-24" or "fa0/1 - 24"
    const rangeStr = args.join(' ').replace(/\s*-\s*/g, '-');
    const rangeMatch = rangeStr.match(/^([a-zA-Z]+)\s*([\d/]+)-([\d/]+)$/);

    if (!rangeMatch) {
      // Try single range: "fa0/1-fa0/24" or "fa0/1 - 24"
      const simpleMatch = rangeStr.match(/^([a-zA-Z]+)([\d]+\/[\d]+)-([\d]+)$/);
      if (!simpleMatch) return '% Invalid interface range.';

      const [, prefix, start, endNum] = simpleMatch;
      const slashIdx = start.lastIndexOf('/');
      const baseNum = start.substring(0, slashIdx + 1);
      const startNum = parseInt(start.substring(slashIdx + 1), 10);
      const end = parseInt(endNum, 10);

      const interfaces: string[] = [];
      for (let i = startNum; i <= end; i++) {
        const name = this.resolveInterfaceName(`${prefix}${baseNum}${i}`);
        if (name) interfaces.push(name);
      }

      if (interfaces.length === 0) return '% No valid interfaces in range.';
      this.selectedInterface = interfaces[0];
      this.selectedInterfaceRange = interfaces;
      this.mode = 'config-if';
      return '';
    }

    const [, prefix, startSlot, endSlot] = rangeMatch;
    const slashIdx = startSlot.lastIndexOf('/');
    const baseSlot = startSlot.substring(0, slashIdx + 1);
    const startNum = parseInt(startSlot.substring(slashIdx + 1), 10);
    const endNum = parseInt(endSlot, 10);

    const interfaces: string[] = [];
    for (let i = startNum; i <= endNum; i++) {
      const name = this.resolveInterfaceName(`${prefix}${baseSlot}${i}`);
      if (name) interfaces.push(name);
    }

    if (interfaces.length === 0) return '% No valid interfaces in range.';
    this.selectedInterface = interfaces[0];
    this.selectedInterfaceRange = interfaces;
    this.mode = 'config-if';
    return '';
  }

  /** Apply a config command to all selected interfaces (range support) */
  private applyToSelectedInterfaces(fn: (portName: string) => string): string {
    const results: string[] = [];
    for (const portName of this.selectedInterfaceRange) {
      const result = fn(portName);
      if (result) results.push(result);
    }
    return results.join('\n');
  }

  // ─── VLAN List Parser ────────────────────────────────────────────

  private parseVlanList(input: string): Set<number> | null {
    const vlans = new Set<number>();
    const parts = input.split(',');
    for (const part of parts) {
      if (part.includes('-')) {
        const [start, end] = part.split('-').map(Number);
        if (isNaN(start) || isNaN(end)) return null;
        for (let i = start; i <= end; i++) vlans.add(i);
      } else {
        const num = parseInt(part, 10);
        if (isNaN(num)) return null;
        vlans.add(num);
      }
    }
    return vlans;
  }

  // ─── Abbreviation Helper ──────────────────────────────────────────

  private abbreviateInterface(name: string): string {
    return name
      .replace('FastEthernet', 'Fa')
      .replace('GigabitEthernet', 'Gi');
  }
}

// ═══════════════════════════════════════════════════════════════════════
// HuaweiVRPSwitchShell - Huawei VRP CLI Engine for Switches
// ═══════════════════════════════════════════════════════════════════════

type VRPSwitchMode = 'user' | 'system' | 'interface' | 'vlan';

export class HuaweiVRPSwitchShell {
  private mode: VRPSwitchMode = 'user';
  private selectedInterface: string | null = null;
  private selectedVlan: number | null = null;

  getMode(): VRPSwitchMode { return this.mode; }

  getPrompt(sw: Switch): string {
    const host = sw.getHostname();
    switch (this.mode) {
      case 'user':      return `<${host}>`;
      case 'system':    return `[${host}]`;
      case 'interface': return `[${host}-${this.selectedInterface}]`;
      case 'vlan':      return `[${host}-vlan${this.selectedVlan}]`;
      default:          return `<${host}>`;
    }
  }

  execute(sw: Switch, input: string): string {
    const trimmed = input.trim();
    if (!trimmed) return '';

    // Global navigation commands
    const lower = trimmed.toLowerCase();
    if (lower === 'return') {
      this.mode = 'user';
      this.selectedInterface = null;
      this.selectedVlan = null;
      return '';
    }
    if (lower === 'quit') return this.cmdQuit();

    // Route to mode-specific handler
    switch (this.mode) {
      case 'user':      return this.executeUserMode(sw, trimmed);
      case 'system':    return this.executeSystemMode(sw, trimmed);
      case 'interface': return this.executeInterfaceMode(sw, trimmed);
      case 'vlan':      return this.executeVlanMode(sw, trimmed);
      default:          return `Error: Unrecognized command "${trimmed}"`;
    }
  }

  private cmdQuit(): string {
    switch (this.mode) {
      case 'interface':
        this.mode = 'system';
        this.selectedInterface = null;
        return '';
      case 'vlan':
        this.mode = 'system';
        this.selectedVlan = null;
        return '';
      case 'system':
        this.mode = 'user';
        return '';
      case 'user':
        return '';
      default:
        return '';
    }
  }

  // ─── User View (<hostname>) ──────────────────────────────────────

  private executeUserMode(sw: Switch, input: string): string {
    const lower = input.toLowerCase();
    const parts = input.split(/\s+/);

    if (lower === 'system-view') {
      this.mode = 'system';
      return 'Enter system view, return user view with return command.';
    }

    if (parts[0].toLowerCase() === 'display') {
      return this.cmdDisplay(sw, parts.slice(1));
    }

    return `Error: Unrecognized command "${input}"`;
  }

  // ─── System View ([hostname]) ────────────────────────────────────

  private executeSystemMode(sw: Switch, input: string): string {
    const parts = input.split(/\s+/);
    const cmd = parts[0].toLowerCase();

    if (cmd === 'display') return this.cmdDisplay(sw, parts.slice(1));

    if (cmd === 'sysname') {
      if (parts.length < 2) return 'Error: Incomplete command.';
      sw._setHostnameInternal(parts[1]);
      return '';
    }

    if (cmd === 'vlan') {
      return this.cmdVlan(sw, parts.slice(1));
    }

    if (cmd === 'undo') {
      return this.cmdUndo(sw, parts.slice(1));
    }

    if (cmd === 'interface') {
      if (parts.length < 2) return 'Error: Incomplete command.';
      const portName = this.resolveInterfaceName(sw, parts[1]);
      if (!portName) return `Error: Wrong parameter found at '^' position.`;
      this.selectedInterface = portName;
      this.mode = 'interface';
      return '';
    }

    if (cmd === 'mac-address') {
      // mac-address aging-time <seconds>
      if (parts.length >= 3 && parts[1].toLowerCase() === 'aging-time') {
        const seconds = parseInt(parts[2], 10);
        if (isNaN(seconds) || seconds < 0) return 'Error: Invalid parameter.';
        sw.setMACAgingTime(seconds);
        return '';
      }
      return 'Error: Incomplete command.';
    }

    return `Error: Unrecognized command "${input}"`;
  }

  // ─── Interface View ([hostname-GigabitEthernet0/0/X]) ──────────

  private executeInterfaceMode(sw: Switch, input: string): string {
    const parts = input.split(/\s+/);
    const lower = input.toLowerCase();

    if (lower === 'shutdown') {
      const port = sw.getPort(this.selectedInterface!);
      if (port) port.setUp(false);
      return '';
    }

    if (lower === 'undo shutdown') {
      const port = sw.getPort(this.selectedInterface!);
      if (port) port.setUp(true);
      return '';
    }

    if (parts[0].toLowerCase() === 'description') {
      if (parts.length < 2) return 'Error: Incomplete command.';
      sw.setInterfaceDescription(this.selectedInterface!, parts.slice(1).join(' '));
      return '';
    }

    if (parts[0].toLowerCase() === 'port') {
      return this.cmdPort(sw, parts.slice(1));
    }

    if (parts[0].toLowerCase() === 'display') {
      return this.cmdDisplay(sw, parts.slice(1));
    }

    return `Error: Unrecognized command "${input}"`;
  }

  // ─── VLAN View ([hostname-vlanX]) ────────────────────────────────

  private executeVlanMode(sw: Switch, input: string): string {
    const parts = input.split(/\s+/);

    if (parts[0].toLowerCase() === 'name') {
      if (parts.length < 2 || this.selectedVlan === null) return 'Error: Incomplete command.';
      sw.renameVLAN(this.selectedVlan, parts[1]);
      return '';
    }

    return `Error: Unrecognized command "${input}"`;
  }

  // ─── VLAN Command (system view) ─────────────────────────────────

  private cmdVlan(sw: Switch, args: string[]): string {
    if (args.length < 1) return 'Error: Incomplete command.';

    // vlan batch <id> <id> ...
    if (args[0].toLowerCase() === 'batch') {
      for (let i = 1; i < args.length; i++) {
        const id = parseInt(args[i], 10);
        if (!isNaN(id) && id >= 1 && id <= 4094) {
          sw.createVLAN(id);
        }
      }
      return '';
    }

    // vlan <id> → enter VLAN config mode
    const id = parseInt(args[0], 10);
    if (isNaN(id) || id < 1 || id > 4094) return 'Error: Wrong parameter found.';
    if (!sw.getVLAN(id)) sw.createVLAN(id);
    this.selectedVlan = id;
    this.mode = 'vlan';
    return '';
  }

  // ─── Undo Command (system view) ─────────────────────────────────

  private cmdUndo(sw: Switch, args: string[]): string {
    if (args.length < 1) return 'Error: Incomplete command.';

    if (args[0].toLowerCase() === 'vlan') {
      if (args.length < 2) return 'Error: Incomplete command.';
      const id = parseInt(args[1], 10);
      if (isNaN(id)) return 'Error: Wrong parameter.';
      if (id === 1) return 'Error: Default VLAN 1 cannot be deleted.';
      return sw.deleteVLAN(id) ? '' : `Error: VLAN ${id} does not exist.`;
    }

    if (args[0].toLowerCase() === 'shutdown') {
      // undo shutdown in interface mode
      if (this.selectedInterface) {
        const port = sw.getPort(this.selectedInterface);
        if (port) port.setUp(true);
        return '';
      }
    }

    return `Error: Unrecognized command "undo ${args.join(' ')}"`;
  }

  // ─── Port Command (interface view) ──────────────────────────────

  private cmdPort(sw: Switch, args: string[]): string {
    if (args.length < 1 || !this.selectedInterface) return 'Error: Incomplete command.';
    const sub = args.join(' ').toLowerCase();

    // port link-type access|trunk
    if (sub.startsWith('link-type')) {
      const mode = args[1]?.toLowerCase();
      if (mode === 'access' || mode === 'trunk') {
        sw.setSwitchportMode(this.selectedInterface, mode);
        return '';
      }
      return 'Error: Wrong parameter.';
    }

    // port default vlan <id>
    if (sub.startsWith('default vlan')) {
      if (args.length < 3) return 'Error: Incomplete command.';
      const vlanId = parseInt(args[2], 10);
      if (isNaN(vlanId)) return 'Error: Wrong parameter.';
      sw.setSwitchportAccessVlan(this.selectedInterface, vlanId);
      return '';
    }

    // port trunk allow-pass vlan <id> [<id>...]
    if (sub.startsWith('trunk allow-pass vlan')) {
      if (args.length < 4) return 'Error: Incomplete command.';
      const vlans = new Set<number>();
      for (let i = 3; i < args.length; i++) {
        const id = parseInt(args[i], 10);
        if (!isNaN(id)) vlans.add(id);
      }
      sw.setTrunkAllowedVlans(this.selectedInterface, vlans);
      return '';
    }

    // port trunk pvid vlan <id>
    if (sub.startsWith('trunk pvid vlan')) {
      if (args.length < 4) return 'Error: Incomplete command.';
      const vlanId = parseInt(args[3], 10);
      if (isNaN(vlanId)) return 'Error: Wrong parameter.';
      sw.setTrunkNativeVlan(this.selectedInterface, vlanId);
      return '';
    }

    return `Error: Unrecognized command "port ${args.join(' ')}"`;
  }

  // ─── Display Command ────────────────────────────────────────────

  private cmdDisplay(sw: Switch, args: string[]): string {
    if (args.length === 0) return 'Error: Incomplete command.';
    const sub = args.join(' ').toLowerCase();

    if (sub === 'version') return this.displayVersion(sw);
    if (sub === 'vlan') return this.displayVlan(sw);
    if (sub === 'interface brief') return this.displayInterfaceBrief(sw);
    if (sub.startsWith('interface ')) return this.displayInterface(sw, args.slice(1).join(' '));
    if (sub === 'mac-address') return this.displayMacAddress(sw);
    if (sub === 'mac-address aging-time') return this.displayMacAgingTime(sw);
    if (sub === 'current-configuration') return this.displayCurrentConfig(sw);
    if (sub.startsWith('current-configuration interface ')) {
      return this.displayCurrentConfigInterface(sw, args.slice(2).join(' '));
    }

    return `Error: Unrecognized command "display ${args.join(' ')}"`;
  }

  private displayVersion(sw: Switch): string {
    return [
      'Huawei Versatile Routing Platform Software',
      'VRP (R) software, Version 5.170 (S5720 V200R019C10SPC500)',
      'Copyright (C) 2000-2025 HUAWEI TECH CO., LTD',
      '',
      `BOARD TYPE:          S5720-28X-LI-AC`,
      `CPLD Version:        1.0`,
      `BootROM Version:     1.0`,
      `${sw.getHostname()} uptime is 0 days, 0 hours, 0 minutes`,
    ].join('\n');
  }

  private displayVlan(sw: Switch): string {
    const vlans = sw.getVLANs();
    const configs = sw._getSwitchportConfigs();

    const lines = [
      'VLAN ID  Name                          Status   Ports',
      '-------  ----------------------------  -------  ----------------------------',
    ];

    for (const [id, vlan] of vlans) {
      const name = vlan.name.padEnd(30);
      const portsInVlan: string[] = [];
      for (const [portName, cfg] of configs) {
        if (cfg.mode === 'access' && cfg.accessVlan === id) {
          portsInVlan.push(portName);
        }
      }
      const portsStr = portsInVlan.join(', ');
      lines.push(`${String(id).padEnd(9)}${name}active   ${portsStr}`);
    }

    return lines.join('\n');
  }

  private displayInterfaceBrief(sw: Switch): string {
    const ports = sw._getPortsInternal();
    const configs = sw._getSwitchportConfigs();

    const lines = ['Interface                     PHY     Protocol  InUti  OutUti'];
    for (const [portName, port] of ports) {
      const phys = port.getIsUp() ? (port.isConnected() ? 'up' : 'down') : 'down';
      const proto = port.getIsUp() ? (port.isConnected() ? 'up' : 'down') : 'down';
      lines.push(`${portName.padEnd(30)}${phys.padEnd(8)}${proto.padEnd(10)}0%     0%`);
    }
    return lines.join('\n');
  }

  private displayInterface(sw: Switch, ifName: string): string {
    const portName = this.resolveInterfaceName(sw, ifName) || ifName;
    const port = sw.getPort(portName);
    if (!port) return `Error: Wrong parameter found at '^' position.`;

    const desc = sw.getInterfaceDescription(portName) || '';
    const isUp = port.getIsUp();
    const isConn = port.isConnected();

    return [
      `${portName} current state : ${isUp ? (isConn ? 'UP' : 'DOWN') : 'Administratively DOWN'}`,
      `Line protocol current state : ${isConn ? 'UP' : 'DOWN'}`,
      `Description: ${desc}`,
      `The Maximum Transmit Unit is 1500`,
      `Internet protocol processing : disabled`,
      `Input:  0 packets, 0 bytes`,
      `Output: 0 packets, 0 bytes`,
    ].join('\n');
  }

  private displayMacAddress(sw: Switch): string {
    const entries = sw.getMACTable();
    const lines = [
      'MAC address table of slot 0:',
      '-------------------------------------------------------------------------------',
      'MAC Address    VLAN/VSI   Learned-From   Type',
      '-------------------------------------------------------------------------------',
    ];

    if (entries.length === 0) {
      lines.push('No entries found.');
    } else {
      for (const e of entries) {
        lines.push(`${e.mac.padEnd(15)}${String(e.vlan).padEnd(11)}${e.port.padEnd(15)}${e.type}`);
      }
    }

    lines.push('-------------------------------------------------------------------------------');
    lines.push(`Total items displayed = ${entries.length}`);
    return lines.join('\n');
  }

  private displayMacAgingTime(sw: Switch): string {
    return `Aging time: ${sw.getMACAgingTime()} seconds`;
  }

  private displayCurrentConfig(sw: Switch): string {
    const lines = [
      '#',
      `sysname ${sw.getHostname()}`,
      '#',
    ];

    // VLANs
    for (const [id, vlan] of sw.getVLANs()) {
      if (id === 1) continue;
      lines.push(`vlan ${id}`);
      lines.push(` name ${vlan.name}`);
      lines.push('#');
    }

    // Interfaces
    const ports = sw._getPortsInternal();
    const configs = sw._getSwitchportConfigs();
    const descs = sw._getInterfaceDescriptions();
    for (const [portName, port] of ports) {
      const cfg = configs.get(portName);
      if (!cfg) continue;

      lines.push(`interface ${portName}`);
      const desc = descs.get(portName);
      if (desc) lines.push(` description ${desc}`);
      if (cfg.mode === 'trunk') {
        lines.push(` port link-type trunk`);
        if (cfg.trunkNativeVlan !== 1) {
          lines.push(` port trunk pvid vlan ${cfg.trunkNativeVlan}`);
        }
        const allowedArr = Array.from(cfg.trunkAllowedVlans).sort((a, b) => a - b);
        if (allowedArr.length < 4094) {
          lines.push(` port trunk allow-pass vlan ${allowedArr.join(' ')}`);
        }
      } else {
        lines.push(` port link-type access`);
        if (cfg.accessVlan !== 1) {
          lines.push(` port default vlan ${cfg.accessVlan}`);
        }
      }
      if (!port.getIsUp()) lines.push(` shutdown`);
      lines.push('#');
    }

    lines.push('return');
    return lines.join('\n');
  }

  private displayCurrentConfigInterface(sw: Switch, ifName: string): string {
    const portName = this.resolveInterfaceName(sw, ifName) || ifName;
    const port = sw.getPort(portName);
    const cfg = sw.getSwitchportConfig(portName);
    if (!port || !cfg) return `Error: Wrong parameter found at '^' position.`;

    const lines = [`interface ${portName}`];
    const desc = sw.getInterfaceDescription(portName);
    if (desc) lines.push(` description ${desc}`);
    if (cfg.mode === 'trunk') {
      lines.push(` port link-type trunk`);
      if (cfg.trunkNativeVlan !== 1) {
        lines.push(` port trunk pvid vlan ${cfg.trunkNativeVlan}`);
      }
      const allowedArr = Array.from(cfg.trunkAllowedVlans).sort((a, b) => a - b);
      if (allowedArr.length < 4094) {
        lines.push(` port trunk allow-pass vlan ${allowedArr.join(' ')}`);
      }
    } else {
      lines.push(` port link-type access`);
      if (cfg.accessVlan !== 1) {
        lines.push(` port default vlan ${cfg.accessVlan}`);
      }
    }
    if (!port.getIsUp()) lines.push(` shutdown`);
    lines.push('#');
    return lines.join('\n');
  }

  // ─── Interface Name Resolution ──────────────────────────────────

  private resolveInterfaceName(sw: Switch, input: string): string | null {
    // Direct match
    for (const name of sw.getPortNames()) {
      if (name.toLowerCase() === input.toLowerCase()) return name;
    }

    // Abbreviation: GE0/0/0 → GigabitEthernet0/0/0
    const lower = input.toLowerCase();
    const match = lower.match(/^(ge|gigabitethernet|gi)([\d/]+)$/);
    if (match) {
      const numbers = match[2];
      const resolved = `GigabitEthernet${numbers}`;
      for (const name of sw.getPortNames()) {
        if (name === resolved) return name;
      }
    }

    return null;
  }
}
