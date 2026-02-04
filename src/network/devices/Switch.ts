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

  // ─── Config Persistence ─────────────────────────────────────────
  private startupConfig: string | null = null;

  // ─── CLI Shell ──────────────────────────────────────────────────
  private shell: CiscoSwitchShell;

  constructor(type: DeviceType = 'switch-cisco', name: string = 'Switch', portCount: number = 24, x: number = 0, y: number = 0) {
    super(type, name, x, y);
    this.createPorts(portCount);
    this.initDefaultVLAN();
    this.startMACAgingProcess();
    this.shell = new CiscoSwitchShell();
  }

  private createPorts(count: number): void {
    // Cisco naming: FastEthernet for first 24, GigabitEthernet for uplinks
    const isCisco = this.deviceType.includes('cisco');
    for (let i = 0; i < count; i++) {
      const portName = isCisco
        ? (i < 24 ? `FastEthernet0/${i}` : `GigabitEthernet0/${i - 24}`)
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

      // Default STP state: forwarding
      this.stpStates.set(portName, 'forwarding');
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
    this.startMACAgingProcess();
    // Restore startup config if available
    if (this.startupConfig) {
      this.restoreFromStartupConfig();
    }
  }

  // ─── VLAN Database API ────────────────────────────────────────────

  createVLAN(id: number, name?: string): boolean {
    if (id < 1 || id > 4094) return false;
    if (this.vlans.has(id)) return false;
    this.vlans.set(id, { id, name: name || `VLAN${String(id).padStart(4, '0')}`, ports: new Set() });
    Logger.info(this.id, 'switch:vlan-create', `${this.name}: created VLAN ${id}`);
    return true;
  }

  deleteVLAN(id: number): boolean {
    if (id === 1) return false; // Can't delete default VLAN
    if (!this.vlans.has(id)) return false;

    // Move ports back to VLAN 1
    const vlan = this.vlans.get(id)!;
    const vlan1 = this.vlans.get(1)!;
    for (const portName of vlan.ports) {
      const cfg = this.switchportConfigs.get(portName);
      if (cfg && cfg.mode === 'access' && cfg.accessVlan === id) {
        cfg.accessVlan = 1;
        vlan1.ports.add(portName);
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

    // STP: drop frames on blocking ports (except BPDUs — not simulated)
    const stpState = this.stpStates.get(portName);
    if (stpState === 'blocking' || stpState === 'disabled') {
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
      // Strip any existing tag (access port doesn't expect tags)
    } else {
      // Trunk mode
      if (taggedFrame.dot1q) {
        ingressVlan = taggedFrame.dot1q.vid;
        // Check if VLAN is allowed on this trunk
        if (!cfg.trunkAllowedVlans.has(ingressVlan)) {
          Logger.debug(this.id, 'switch:trunk-filtered', `${this.name}: VLAN ${ingressVlan} not allowed on trunk ${portName}`);
          return;
        }
      } else {
        // Untagged frame on trunk → native VLAN
        ingressVlan = cfg.trunkNativeVlan;
      }
    }

    // ─── Step 2: MAC Learning ───────────────────────────────────
    const srcMAC = frame.srcMAC.toString().toLowerCase();
    const macKey = `${ingressVlan}:${srcMAC}`;
    const existing = this.macTable.get(macKey);

    if (!existing || existing.type === 'dynamic') {
      this.macTable.set(macKey, {
        mac: srcMAC,
        vlan: ingressVlan,
        port: portName,
        type: 'dynamic',
        age: this.macAgingTime,
        timestamp: Date.now(),
      });
      Logger.debug(this.id, 'switch:mac-learn', `${this.name}: learned ${srcMAC} VLAN ${ingressVlan} on ${portName}`);
    } else if (existing.type === 'dynamic') {
      // Refresh existing entry
      existing.port = portName;
      existing.age = this.macAgingTime;
      existing.timestamp = Date.now();
    }

    // ─── Step 3: Forwarding Decision ────────────────────────────
    const dstMAC = frame.dstMAC.toString().toLowerCase();

    if (frame.dstMAC.isBroadcast() || !this.macTable.has(`${ingressVlan}:${dstMAC}`)) {
      // Broadcast or unknown unicast → flood within VLAN
      this.floodFrame(portName, frame, ingressVlan);
    } else {
      // Known unicast
      const dstEntry = this.macTable.get(`${ingressVlan}:${dstMAC}`)!;
      if (dstEntry.port !== portName) {
        this.forwardToPort(dstEntry.port, frame, ingressVlan);
      }
      // Else: src and dst on same port → drop (learned locally)
    }
  }

  // ─── Flood within VLAN ────────────────────────────────────────────

  private floodFrame(exceptPort: string, frame: EthernetFrame, vlan: number): void {
    for (const [portName, cfg] of this.switchportConfigs) {
      if (portName === exceptPort) continue;

      const port = this.getPort(portName);
      if (!port || !port.getIsUp() || !port.isConnected()) continue;

      const stpState = this.stpStates.get(portName);
      if (stpState === 'blocking' || stpState === 'disabled') continue;

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
    if (stpState === 'blocking' || stpState === 'disabled') return;

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
    return this.shell.buildRunningConfig(this);
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

  // ─── CLI ──────────────────────────────────────────────────────────

  getOSType(): string { return 'cisco-ios'; }

  getPrompt(): string { return this.shell.getPrompt(this); }

  getBootSequence(): string {
    return [
      '',
      `Cisco IOS Software, C2960 Software (C2960-LANBASEK9-M), Version 15.2(7)E2`,
      `Copyright (c) 1986-2025 by Cisco Systems, Inc.`,
      '',
      `${this.hostname} processor with 65536K bytes of memory.`,
      `24 FastEthernet interfaces`,
      `2 Gigabit Ethernet interfaces`,
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

    // Handle ? for help
    if (trimmed.endsWith('?')) {
      this.swRef = sw;
      const helpInput = trimmed.slice(0, -1).trim();
      const result = this.getHelp(helpInput);
      this.swRef = null;
      return result;
    }

    // Global shortcuts
    if (trimmed.toLowerCase() === 'exit') return this.cmdExit();
    if (trimmed.toLowerCase() === 'end' || trimmed === '\x03') return this.cmdEnd();
    if (trimmed.toLowerCase() === 'logout' && this.mode === 'user') return 'Connection closed.';
    if (trimmed.toLowerCase() === 'disable' && this.mode === 'privileged') {
      this.mode = 'user';
      return '';
    }

    // Bind switch reference for command closures
    this.swRef = sw;

    // Get the trie for current mode
    const trie = this.getActiveTrie();
    const result = trie.match(trimmed);

    let output: string;
    switch (result.status) {
      case 'ok':
        output = result.node?.action ? result.node.action(result.args, trimmed) : '';
        break;

      case 'ambiguous':
        output = result.error || `% Ambiguous command: "${trimmed}"`;
        break;

      case 'incomplete':
        output = result.error || '% Incomplete command.';
        break;

      case 'invalid':
        output = result.error || `% Invalid input detected at '^' marker.`;
        break;

      default:
        output = `% Unrecognized command "${trimmed}"`;
    }

    this.swRef = null;
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
    // enable
    this.userTrie.register('enable', 'Enter privileged EXEC mode', () => {
      this.mode = 'privileged';
      return '';
    });

    // show version
    this.userTrie.register('show version', 'Display system hardware and software status', () => {
      if (!this.swRef) return '';
      return `Cisco IOS Software, C2960 Software\n${this.swRef.getHostname()} uptime is 0 days, 0 hours`;
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
