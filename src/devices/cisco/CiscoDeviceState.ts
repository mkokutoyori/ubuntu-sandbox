/**
 * CiscoDeviceState - Isolated state for Cisco IOS devices
 * Each Cisco device instance has its own configuration, VLANs, routing tables, etc.
 */

import {
  DeviceState,
  DeviceStateConfig,
  FileNode,
  FilePermissions,
  User,
  Group,
  Process,
  Service,
  Package,
  NetworkInterface,
  Route,
  ARPEntry,
  DNSConfig,
  HostEntry,
  Environment
} from '../common/DeviceState';

// ============================================================================
// CISCO SPECIFIC TYPES
// ============================================================================

export type CiscoDeviceType = 'router' | 'switch' | 'multilayer-switch';
export type CiscoInterfaceType = 'FastEthernet' | 'GigabitEthernet' | 'TenGigabitEthernet' | 'Serial' | 'Loopback' | 'Vlan' | 'Port-channel' | 'Tunnel';
export type CiscoPortMode = 'access' | 'trunk' | 'dynamic auto' | 'dynamic desirable';
export type CiscoSTPMode = 'pvst' | 'rapid-pvst' | 'mst';
export type CiscoInterfaceStatus = 'up' | 'down' | 'administratively down';
export type CiscoCLIMode = 'user' | 'privileged' | 'global-config' | 'interface-config' | 'line-config' | 'router-config' | 'vlan-config';

export interface CiscoDeviceStateConfig extends DeviceStateConfig {
  ciscoType: CiscoDeviceType;
  model?: string;
  iosVersion?: string;
  serialNumber?: string;
  interfaces?: CiscoInterfaceConfig[];
}

export interface CiscoInterfaceConfig {
  name: string;
  type: CiscoInterfaceType;
  slot?: number;
  port: number;
  subInterface?: number;
  description?: string;
  ipAddress?: string;
  netmask?: string;
  secondaryIPs?: { ip: string; mask: string }[];
  macAddress: string;
  status: CiscoInterfaceStatus;
  protocol: 'up' | 'down';
  speed?: string;
  duplex?: 'full' | 'half' | 'auto';
  mtu: number;
  bandwidth?: number; // in Kbps
  delay?: number; // in microseconds
  // Layer 2 settings
  switchportMode?: CiscoPortMode;
  accessVlan?: number;
  voiceVlan?: number;
  nativeVlan?: number;
  allowedVlans?: number[];
  trunkEncapsulation?: 'dot1q' | 'isl' | 'negotiate';
  portSecurity?: {
    enabled: boolean;
    maxMacAddresses: number;
    violation: 'protect' | 'restrict' | 'shutdown';
    stickyMac: boolean;
  };
  // STP settings
  stpPortFast?: boolean;
  stpBpduGuard?: boolean;
  stpRootGuard?: boolean;
  stpCost?: number;
  stpPriority?: number;
  // Counters
  rxPackets: number;
  txPackets: number;
  rxBytes: number;
  txBytes: number;
  rxErrors: number;
  txErrors: number;
  collisions: number;
  crcErrors: number;
}

export interface VLANConfig {
  id: number;
  name: string;
  state: 'active' | 'suspend';
  ports: string[];
  sviInterface?: string;
}

export interface MACTableEntry {
  vlan: number;
  macAddress: string;
  type: 'dynamic' | 'static' | 'secure';
  interface: string;
  age: number;
}

export interface CiscoRoute {
  protocol: 'C' | 'S' | 'R' | 'O' | 'B' | 'D' | 'EX' | 'i' | 'L'; // Connected, Static, RIP, OSPF, BGP, EIGRP, External, IGRP, Local
  network: string;
  mask: string;
  nextHop?: string;
  interface?: string;
  metric?: number;
  administrativeDistance: number;
  age?: number; // seconds
  tag?: number;
}

export interface OSPFConfig {
  processId: number;
  routerId?: string;
  networks: { network: string; wildcardMask: string; area: number }[];
  passiveInterfaces: string[];
  defaultInformationOriginate?: boolean;
  redistributeConnected?: boolean;
  redistributeStatic?: boolean;
}

export interface EIGRPConfig {
  asNumber: number;
  networks: string[];
  passiveInterfaces: string[];
  redistributeConnected?: boolean;
  redistributeStatic?: boolean;
}

export interface RIPConfig {
  version: 1 | 2;
  networks: string[];
  passiveInterfaces: string[];
  defaultInformationOriginate?: boolean;
}

export interface BGPConfig {
  asNumber: number;
  routerId?: string;
  neighbors: { ip: string; remoteAs: number; description?: string }[];
  networks: { network: string; mask: string }[];
}

export interface ACLEntry {
  sequence: number;
  action: 'permit' | 'deny';
  protocol: string;
  source: string;
  sourceWildcard?: string;
  sourcePort?: string;
  destination: string;
  destinationWildcard?: string;
  destinationPort?: string;
  established?: boolean;
  log?: boolean;
}

export interface AccessList {
  name: string; // number or name
  type: 'standard' | 'extended';
  entries: ACLEntry[];
}

export interface NATEntry {
  type: 'static' | 'dynamic' | 'pat';
  inside?: { local: string; global: string };
  outside?: { local: string; global: string };
  poolName?: string;
  aclName?: string;
  interface?: string;
  overload?: boolean;
}

export interface DHCPPool {
  name: string;
  network: string;
  mask: string;
  defaultRouter?: string[];
  dnsServer?: string[];
  domain?: string;
  lease?: { days: number; hours: number; minutes: number };
  excludedAddresses?: { start: string; end: string }[];
}

export interface CiscoTerminalState {
  mode: CiscoCLIMode;
  enablePassword?: string;
  enableSecret?: string;
  configuredInterface?: string;
  configuredLine?: string;
  configuredRouter?: string;
  configuredVlan?: number;
  history: string[];
  historyIndex: number;
}

// ============================================================================
// CISCO DEVICE STATE IMPLEMENTATION
// ============================================================================

export class CiscoDeviceState extends DeviceState {
  private ciscoType: CiscoDeviceType;
  private model: string;
  private iosVersion: string;
  private serialNumber: string;

  // Cisco-specific state
  private ciscoInterfaces: Map<string, CiscoInterfaceConfig> = new Map();
  private vlans: Map<number, VLANConfig> = new Map();
  private macTable: Map<string, MACTableEntry> = new Map();
  private ciscoRoutes: CiscoRoute[] = [];
  private ospfConfig?: OSPFConfig;
  private eigrpConfig?: EIGRPConfig;
  private ripConfig?: RIPConfig;
  private bgpConfig?: BGPConfig;
  private accessLists: Map<string, AccessList> = new Map();
  private natEntries: NATEntry[] = [];
  private dhcpPools: Map<string, DHCPPool> = new Map();

  // Configuration
  private runningConfig: string[] = [];
  private startupConfig: string[] = [];
  private configRegister: string = '0x2102';

  // Terminal state
  private terminalState: CiscoTerminalState;

  // Banner messages
  private bannerMotd?: string;
  private bannerLogin?: string;
  private bannerExec?: string;

  // Line configurations
  private lineConfigs: Map<string, { password?: string; login?: boolean; transport?: string[] }> = new Map();

  constructor(config: CiscoDeviceStateConfig) {
    super({
      deviceId: config.deviceId,
      hostname: config.hostname,
      osType: 'cisco-ios'
    });
    this.ciscoType = config.ciscoType;
    this.model = config.model || (config.ciscoType === 'router' ? 'Cisco 2901' : 'Cisco Catalyst 2960');
    this.iosVersion = config.iosVersion || '15.1(4)M4';
    this.serialNumber = config.serialNumber || this.generateSerialNumber();

    this.terminalState = {
      mode: 'user',
      history: [],
      historyIndex: -1
    };

    // Initialize interfaces if provided
    if (config.interfaces) {
      for (const iface of config.interfaces) {
        this.ciscoInterfaces.set(iface.name, iface);
      }
    }

    // Initialize after setting derived class properties
    this.initialize();
  }

  private generateSerialNumber(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let serial = 'FTX';
    for (let i = 0; i < 8; i++) {
      serial += chars[Math.floor(Math.random() * chars.length)];
    }
    return serial;
  }

  // ============================================================================
  // FILE SYSTEM CREATION (IOS Flash/NVRAM)
  // ============================================================================

  protected createRootFileSystem(): FileNode {
    const root = this.createDirectoryNode('');

    // flash: - main storage
    const flash = this.createDirectoryNode('flash:');
    flash.children!.set(`c${this.ciscoType === 'router' ? '2900' : '2960'}-universalk9-mz.SPA.${this.iosVersion.replace(/[()]/g, '')}.bin`,
      this.createFileNode(`c${this.ciscoType === 'router' ? '2900' : '2960'}-universalk9-mz.SPA.${this.iosVersion.replace(/[()]/g, '')}.bin`, ''));
    flash.children!.set('vlan.dat', this.createFileNode('vlan.dat', ''));
    root.children!.set('flash:', flash);

    // nvram: - non-volatile RAM
    const nvram = this.createDirectoryNode('nvram:');
    nvram.children!.set('startup-config', this.createFileNode('startup-config', ''));
    root.children!.set('nvram:', nvram);

    // system: - read-only system files
    const system = this.createDirectoryNode('system:');
    system.children!.set('running-config', this.createFileNode('running-config', ''));
    root.children!.set('system:', system);

    // bootflash: (for some devices)
    root.children!.set('bootflash:', this.createDirectoryNode('bootflash:'));

    return root;
  }

  // ============================================================================
  // ENVIRONMENT CREATION
  // ============================================================================

  protected createDefaultEnvironment(): Environment {
    return {
      variables: new Map([
        ['HOSTNAME', this.hostname],
      ]),
      aliases: new Map(),
      path: [],
      workingDirectory: 'flash:',
      user: '',
      hostname: this.hostname,
      shell: 'ios',
      term: 'vt100',
      lang: '',
      tz: 'UTC',
      history: [],
      historyIndex: -1
    };
  }

  // ============================================================================
  // SYSTEM INITIALIZATION
  // ============================================================================

  protected initializeSystem(): void {
    this.initializeVLANs();
    this.initializeInterfaces();
    this.initializeRouting();
    this.initializeLineConfigs();
  }

  private initializeVLANs(): void {
    // Default VLAN 1
    this.vlans.set(1, {
      id: 1,
      name: 'default',
      state: 'active',
      ports: []
    });

    // System VLANs
    this.vlans.set(1002, { id: 1002, name: 'fddi-default', state: 'active', ports: [] });
    this.vlans.set(1003, { id: 1003, name: 'token-ring-default', state: 'active', ports: [] });
    this.vlans.set(1004, { id: 1004, name: 'fddinet-default', state: 'active', ports: [] });
    this.vlans.set(1005, { id: 1005, name: 'trnet-default', state: 'active', ports: [] });
  }

  private initializeInterfaces(): void {
    if (this.ciscoType === 'router') {
      // Router interfaces
      const routerInterfaces: CiscoInterfaceConfig[] = [
        this.createCiscoInterface('GigabitEthernet', 0, 0),
        this.createCiscoInterface('GigabitEthernet', 0, 1),
        this.createCiscoInterface('Serial', 0, 0),
        this.createCiscoInterface('Serial', 0, 1),
      ];

      for (const iface of routerInterfaces) {
        this.ciscoInterfaces.set(iface.name, iface);
      }
    } else {
      // Switch interfaces
      for (let port = 1; port <= 24; port++) {
        const iface = this.createCiscoInterface('FastEthernet', 0, port);
        iface.switchportMode = 'access';
        iface.accessVlan = 1;
        this.ciscoInterfaces.set(iface.name, iface);
        this.vlans.get(1)!.ports.push(iface.name);
      }

      // Uplink ports
      for (let port = 1; port <= 2; port++) {
        const iface = this.createCiscoInterface('GigabitEthernet', 0, port);
        iface.switchportMode = 'trunk';
        iface.allowedVlans = [1, 2, 3, 4, 5, 10, 20, 30, 100];
        this.ciscoInterfaces.set(iface.name, iface);
      }

      // VLAN 1 interface (SVI)
      const vlan1: CiscoInterfaceConfig = {
        name: 'Vlan1',
        type: 'Vlan',
        port: 1,
        macAddress: this.generateMAC(),
        status: 'administratively down',
        protocol: 'down',
        mtu: 1500,
        rxPackets: 0,
        txPackets: 0,
        rxBytes: 0,
        txBytes: 0,
        rxErrors: 0,
        txErrors: 0,
        collisions: 0,
        crcErrors: 0
      };
      this.ciscoInterfaces.set('Vlan1', vlan1);
    }
  }

  private createCiscoInterface(type: CiscoInterfaceType, slot: number, port: number): CiscoInterfaceConfig {
    const name = type === 'FastEthernet' || type === 'GigabitEthernet' || type === 'TenGigabitEthernet'
      ? `${type}${slot}/${port}`
      : type === 'Serial'
        ? `${type}${slot}/${port}`
        : `${type}${port}`;

    return {
      name,
      type,
      slot,
      port,
      macAddress: this.generateMAC(),
      status: 'administratively down',
      protocol: 'down',
      mtu: type === 'Serial' ? 1500 : 1500,
      bandwidth: type === 'GigabitEthernet' ? 1000000 : type === 'FastEthernet' ? 100000 : type === 'Serial' ? 1544 : 1000000,
      rxPackets: 0,
      txPackets: 0,
      rxBytes: 0,
      txBytes: 0,
      rxErrors: 0,
      txErrors: 0,
      collisions: 0,
      crcErrors: 0
    };
  }

  private initializeRouting(): void {
    // Add loopback route
    this.ciscoRoutes.push({
      protocol: 'L',
      network: '127.0.0.0',
      mask: '255.0.0.0',
      interface: 'Loopback',
      administrativeDistance: 0
    });
  }

  private initializeLineConfigs(): void {
    // Console line
    this.lineConfigs.set('con 0', { login: false });

    // VTY lines
    for (let i = 0; i <= 15; i++) {
      this.lineConfigs.set(`vty ${i}`, { login: false, transport: ['none'] });
    }

    // Aux line
    this.lineConfigs.set('aux 0', { login: false });
  }

  // ============================================================================
  // FILE SYSTEM OPERATIONS
  // ============================================================================

  resolvePath(path: string): string {
    if (!path || path === '') return this.environment.workingDirectory;

    // Handle IOS-style paths
    if (path.includes(':')) {
      return path;
    }

    return this.environment.workingDirectory + path;
  }

  getNode(path: string): FileNode | null {
    const resolvedPath = this.resolvePath(path);
    const parts = resolvedPath.split(/[:/]/).filter(p => p !== '');

    if (parts.length === 0) return this.root;

    // Get filesystem (flash:, nvram:, etc.)
    const fsName = parts[0] + ':';
    let current = this.root.children!.get(fsName);
    if (!current) return null;

    for (let i = 1; i < parts.length; i++) {
      if (current.type !== 'directory' || !current.children) return null;
      const child = current.children.get(parts[i]);
      if (!child) return null;
      current = child;
    }

    return current;
  }

  createFile(path: string, content: string = '', permissions?: Partial<FilePermissions>): boolean {
    const resolvedPath = this.resolvePath(path);
    const lastSlash = resolvedPath.lastIndexOf('/');
    const parentPath = lastSlash > 0 ? resolvedPath.substring(0, lastSlash) : resolvedPath.split(':')[0] + ':';
    const fileName = lastSlash > 0 ? resolvedPath.substring(lastSlash + 1) : resolvedPath.split(':')[1];

    const parent = this.getNode(parentPath);
    if (!parent || parent.type !== 'directory') return false;

    parent.children!.set(fileName, this.createFileNode(fileName, content));
    return true;
  }

  createDirectory(path: string, recursive: boolean = false): boolean {
    const resolvedPath = this.resolvePath(path);
    const parts = resolvedPath.split(/[:/]/).filter(p => p !== '');

    if (parts.length === 0) return false;

    const fsName = parts[0] + ':';
    let current = this.root.children!.get(fsName);
    if (!current) return false;

    for (let i = 1; i < parts.length; i++) {
      if (!current.children!.has(parts[i])) {
        if (!recursive && i < parts.length - 1) return false;
        current.children!.set(parts[i], this.createDirectoryNode(parts[i]));
      }
      current = current.children!.get(parts[i])!;
      if (current.type !== 'directory') return false;
    }

    return true;
  }

  deleteNode(path: string, recursive: boolean = false): boolean {
    const resolvedPath = this.resolvePath(path);
    const lastSlash = resolvedPath.lastIndexOf('/');
    if (lastSlash < 0) return false;

    const parentPath = resolvedPath.substring(0, lastSlash);
    const nodeName = resolvedPath.substring(lastSlash + 1);

    const parent = this.getNode(parentPath);
    if (!parent || parent.type !== 'directory') return false;

    const node = parent.children!.get(nodeName);
    if (!node) return false;
    if (node.type === 'directory' && node.children!.size > 0 && !recursive) return false;

    parent.children!.delete(nodeName);
    return true;
  }

  readFile(path: string): string | null {
    const node = this.getNode(path);
    if (!node || node.type !== 'file') return null;
    return node.content || '';
  }

  writeFile(path: string, content: string, append: boolean = false): boolean {
    let node = this.getNode(path);
    if (!node) {
      if (!this.createFile(path, content)) return false;
      return true;
    }
    if (node.type !== 'file') return false;

    node.content = append ? (node.content || '') + content : content;
    node.metadata.modified = new Date();
    node.metadata.size = node.content.length;
    return true;
  }

  listDirectory(path: string): FileNode[] | null {
    const node = this.getNode(path);
    if (!node || node.type !== 'directory') return null;
    return Array.from(node.children!.values());
  }

  exists(path: string): boolean {
    return this.getNode(path) !== null;
  }

  isDirectory(path: string): boolean {
    const node = this.getNode(path);
    return node !== null && node.type === 'directory';
  }

  isFile(path: string): boolean {
    const node = this.getNode(path);
    return node !== null && node.type === 'file';
  }

  copyNode(source: string, destination: string): boolean {
    const srcNode = this.getNode(source);
    if (!srcNode) return false;

    if (srcNode.type === 'file') {
      return this.createFile(destination, srcNode.content || '');
    }
    return false;
  }

  moveNode(source: string, destination: string): boolean {
    if (!this.copyNode(source, destination)) return false;
    return this.deleteNode(source, true);
  }

  chmod(path: string, permissions: FilePermissions): boolean {
    return true; // IOS doesn't have traditional permissions
  }

  chown(path: string, owner: string, group?: string): boolean {
    return true; // IOS doesn't have traditional ownership
  }

  // ============================================================================
  // USER MANAGEMENT (IOS uses enable passwords instead)
  // ============================================================================

  addUser(user: User): boolean {
    this.users.set(user.username, user);
    return true;
  }

  removeUser(username: string): boolean {
    return this.users.delete(username);
  }

  getUser(username: string): User | null {
    return this.users.get(username) || null;
  }

  getUserByUid(uid: number): User | null {
    return null;
  }

  addGroup(group: Group): boolean {
    return true;
  }

  removeGroup(name: string): boolean {
    return true;
  }

  getGroup(name: string): Group | null {
    return null;
  }

  addUserToGroup(username: string, groupName: string): boolean {
    return true;
  }

  removeUserFromGroup(username: string, groupName: string): boolean {
    return true;
  }

  // ============================================================================
  // PROCESS MANAGEMENT (IOS doesn't have traditional processes)
  // ============================================================================

  createProcess(command: string, args: string[], options?: Partial<Process>): number {
    return 0;
  }

  killProcess(pid: number, signal?: number): boolean {
    return false;
  }

  getProcess(pid: number): Process | null {
    return null;
  }

  getProcessByName(name: string): Process[] {
    return [];
  }

  listProcesses(): Process[] {
    return [];
  }

  updateProcess(pid: number, updates: Partial<Process>): boolean {
    return false;
  }

  // ============================================================================
  // SERVICE MANAGEMENT (IOS services)
  // ============================================================================

  registerService(service: Service): boolean {
    this.services.set(service.name, service);
    return true;
  }

  unregisterService(name: string): boolean {
    return this.services.delete(name);
  }

  startService(name: string): boolean {
    const service = this.services.get(name);
    if (!service) return false;
    service.state = 'running';
    return true;
  }

  stopService(name: string): boolean {
    const service = this.services.get(name);
    if (!service) return false;
    service.state = 'stopped';
    return true;
  }

  restartService(name: string): boolean {
    this.stopService(name);
    return this.startService(name);
  }

  enableService(name: string): boolean {
    const service = this.services.get(name);
    if (!service) return false;
    service.enabled = true;
    return true;
  }

  disableService(name: string): boolean {
    const service = this.services.get(name);
    if (!service) return false;
    service.enabled = false;
    return true;
  }

  getService(name: string): Service | null {
    return this.services.get(name) || null;
  }

  listServices(): Service[] {
    return Array.from(this.services.values());
  }

  // ============================================================================
  // PACKAGE MANAGEMENT (N/A for IOS)
  // ============================================================================

  installPackage(pkg: Package): boolean {
    return false;
  }

  removePackage(name: string): boolean {
    return false;
  }

  getPackage(name: string): Package | null {
    return null;
  }

  listPackages(installed?: boolean): Package[] {
    return [];
  }

  updatePackage(name: string): boolean {
    return false;
  }

  // ============================================================================
  // NETWORK CONFIGURATION (Cisco-specific)
  // ============================================================================

  configureInterface(name: string, config: Partial<NetworkInterface>): boolean {
    const iface = this.ciscoInterfaces.get(name);
    if (!iface) return false;

    if (config.ipAddress) iface.ipAddress = config.ipAddress;
    if (config.netmask) iface.netmask = config.netmask;
    if (config.isUp !== undefined) {
      iface.status = config.isUp ? 'up' : 'administratively down';
      iface.protocol = config.isUp ? 'up' : 'down';
    }
    if (config.macAddress) iface.macAddress = config.macAddress;
    if (config.mtu) iface.mtu = config.mtu;

    // Add connected route
    if (iface.ipAddress && iface.netmask && iface.status === 'up') {
      this.addConnectedRoute(name, iface.ipAddress, iface.netmask);
    }

    return true;
  }

  private addConnectedRoute(interfaceName: string, ipAddress: string, netmask: string): void {
    const ipParts = ipAddress.split('.').map(Number);
    const maskParts = netmask.split('.').map(Number);
    const networkParts = ipParts.map((ip, i) => ip & maskParts[i]);
    const network = networkParts.join('.');

    // Remove existing connected route for this interface
    this.ciscoRoutes = this.ciscoRoutes.filter(r =>
      !(r.interface === interfaceName && r.protocol === 'C')
    );

    // Add connected route
    this.ciscoRoutes.push({
      protocol: 'C',
      network,
      mask: netmask,
      interface: interfaceName,
      administrativeDistance: 0
    });

    // Add local route for the interface IP
    this.ciscoRoutes.push({
      protocol: 'L',
      network: ipAddress,
      mask: '255.255.255.255',
      interface: interfaceName,
      administrativeDistance: 0
    });
  }

  getInterface(name: string): NetworkInterface | null {
    const ciscoIface = this.ciscoInterfaces.get(name);
    if (!ciscoIface) return null;

    return {
      id: `${this.deviceId}-${name}`,
      name: ciscoIface.name,
      type: 'ethernet',
      macAddress: ciscoIface.macAddress,
      ipAddress: ciscoIface.ipAddress,
      netmask: ciscoIface.netmask,
      isUp: ciscoIface.status === 'up',
      isAdminUp: ciscoIface.status !== 'administratively down',
      mtu: ciscoIface.mtu,
      speed: ciscoIface.speed,
      duplex: ciscoIface.duplex,
      rxBytes: ciscoIface.rxBytes,
      txBytes: ciscoIface.txBytes,
      rxPackets: ciscoIface.rxPackets,
      txPackets: ciscoIface.txPackets,
      rxErrors: ciscoIface.rxErrors,
      txErrors: ciscoIface.txErrors,
      rxDropped: 0,
      txDropped: 0
    };
  }

  listInterfaces(): NetworkInterface[] {
    const result: NetworkInterface[] = [];
    for (const [name] of this.ciscoInterfaces) {
      const iface = this.getInterface(name);
      if (iface) result.push(iface);
    }
    return result;
  }

  addRoute(route: Route): boolean {
    this.ciscoRoutes.push({
      protocol: 'S',
      network: route.destination,
      mask: route.netmask,
      nextHop: route.gateway !== '0.0.0.0' ? route.gateway : undefined,
      interface: route.interface,
      administrativeDistance: 1,
      metric: route.metric
    });
    return true;
  }

  removeRoute(destination: string, netmask: string): boolean {
    const index = this.ciscoRoutes.findIndex(r =>
      r.network === destination && r.mask === netmask && r.protocol === 'S'
    );
    if (index === -1) return false;
    this.ciscoRoutes.splice(index, 1);
    return true;
  }

  getRoutes(): Route[] {
    return this.ciscoRoutes.map(r => ({
      destination: r.network,
      netmask: r.mask,
      gateway: r.nextHop || '0.0.0.0',
      interface: r.interface || '',
      metric: r.metric || 0,
      flags: [],
      protocol: r.protocol === 'C' ? 'connected' : r.protocol === 'S' ? 'static' : 'kernel'
    }));
  }

  addARPEntry(entry: ARPEntry): void {
    this.arpTable.set(entry.ipAddress, entry);
  }

  removeARPEntry(ip: string): boolean {
    return this.arpTable.delete(ip);
  }

  getARPTable(): ARPEntry[] {
    return Array.from(this.arpTable.values());
  }

  setDNS(config: Partial<DNSConfig>): void {
    Object.assign(this.dnsConfig, config);
  }

  getDNS(): DNSConfig {
    return { ...this.dnsConfig };
  }

  addHost(entry: HostEntry): void {
    this.hosts.push(entry);
  }

  removeHost(ip: string): boolean {
    const index = this.hosts.findIndex(h => h.ip === ip);
    if (index === -1) return false;
    this.hosts.splice(index, 1);
    return true;
  }

  getHosts(): HostEntry[] {
    return [...this.hosts];
  }

  resolveHostname(hostname: string): string | null {
    for (const entry of this.hosts) {
      if (entry.hostnames.includes(hostname)) return entry.ip;
    }
    return null;
  }

  // ============================================================================
  // ENVIRONMENT
  // ============================================================================

  getEnv(name: string): string | undefined {
    return this.environment.variables.get(name);
  }

  setEnv(name: string, value: string): void {
    this.environment.variables.set(name, value);
  }

  unsetEnv(name: string): void {
    this.environment.variables.delete(name);
  }

  getWorkingDirectory(): string {
    return this.environment.workingDirectory;
  }

  setWorkingDirectory(path: string): boolean {
    this.environment.workingDirectory = path;
    return true;
  }

  getCurrentUser(): string {
    return '';
  }

  setCurrentUser(username: string): boolean {
    return true;
  }

  getHostname(): string {
    return this.hostname;
  }

  setHostname(hostname: string): void {
    this.hostname = hostname;
    this.environment.hostname = hostname;
  }

  // ============================================================================
  // CISCO-SPECIFIC GETTERS AND SETTERS
  // ============================================================================

  getCiscoType(): CiscoDeviceType {
    return this.ciscoType;
  }

  getModel(): string {
    return this.model;
  }

  getIOSVersion(): string {
    return this.iosVersion;
  }

  getSerialNumber(): string {
    return this.serialNumber;
  }

  // Terminal state
  getTerminalState(): CiscoTerminalState {
    return this.terminalState;
  }

  setTerminalMode(mode: CiscoCLIMode): void {
    this.terminalState.mode = mode;
  }

  setEnablePassword(password: string): void {
    this.terminalState.enablePassword = password;
  }

  setEnableSecret(secret: string): void {
    this.terminalState.enableSecret = secret;
  }

  // VLAN management
  getVLAN(id: number): VLANConfig | null {
    return this.vlans.get(id) || null;
  }

  getVLANs(): VLANConfig[] {
    return Array.from(this.vlans.values());
  }

  createVLAN(id: number, name: string): boolean {
    if (this.vlans.has(id)) return false;
    if (id < 1 || id > 4094) return false;
    if (id >= 1002 && id <= 1005) return false; // Reserved VLANs

    this.vlans.set(id, {
      id,
      name,
      state: 'active',
      ports: []
    });
    return true;
  }

  deleteVLAN(id: number): boolean {
    if (id === 1 || (id >= 1002 && id <= 1005)) return false;
    return this.vlans.delete(id);
  }

  setVLANName(id: number, name: string): boolean {
    const vlan = this.vlans.get(id);
    if (!vlan) return false;
    vlan.name = name;
    return true;
  }

  // Cisco interface management
  getCiscoInterface(name: string): CiscoInterfaceConfig | null {
    return this.ciscoInterfaces.get(name) || null;
  }

  getCiscoInterfaces(): CiscoInterfaceConfig[] {
    return Array.from(this.ciscoInterfaces.values());
  }

  setCiscoInterfaceConfig(name: string, config: Partial<CiscoInterfaceConfig>): boolean {
    const iface = this.ciscoInterfaces.get(name);
    if (!iface) return false;
    Object.assign(iface, config);
    return true;
  }

  // MAC table
  getMACTable(): MACTableEntry[] {
    return Array.from(this.macTable.values());
  }

  addMACEntry(entry: MACTableEntry): void {
    const key = `${entry.vlan}:${entry.macAddress}`;
    this.macTable.set(key, entry);
  }

  removeMACEntry(vlan: number, mac: string): boolean {
    return this.macTable.delete(`${vlan}:${mac}`);
  }

  clearMACTable(): void {
    this.macTable.clear();
  }

  // Cisco routing
  getCiscoRoutes(): CiscoRoute[] {
    return [...this.ciscoRoutes];
  }

  addCiscoRoute(route: CiscoRoute): boolean {
    this.ciscoRoutes.push(route);
    return true;
  }

  removeCiscoRoute(network: string, mask: string): boolean {
    const index = this.ciscoRoutes.findIndex(r =>
      r.network === network && r.mask === mask && r.protocol === 'S'
    );
    if (index === -1) return false;
    this.ciscoRoutes.splice(index, 1);
    return true;
  }

  // Routing protocols
  getOSPFConfig(): OSPFConfig | undefined {
    return this.ospfConfig;
  }

  setOSPFConfig(config: OSPFConfig): void {
    this.ospfConfig = config;
  }

  getEIGRPConfig(): EIGRPConfig | undefined {
    return this.eigrpConfig;
  }

  setEIGRPConfig(config: EIGRPConfig): void {
    this.eigrpConfig = config;
  }

  getRIPConfig(): RIPConfig | undefined {
    return this.ripConfig;
  }

  setRIPConfig(config: RIPConfig): void {
    this.ripConfig = config;
  }

  getBGPConfig(): BGPConfig | undefined {
    return this.bgpConfig;
  }

  setBGPConfig(config: BGPConfig): void {
    this.bgpConfig = config;
  }

  // Access lists
  getAccessList(name: string): AccessList | null {
    return this.accessLists.get(name) || null;
  }

  getAccessLists(): AccessList[] {
    return Array.from(this.accessLists.values());
  }

  setAccessList(acl: AccessList): void {
    this.accessLists.set(acl.name, acl);
  }

  deleteAccessList(name: string): boolean {
    return this.accessLists.delete(name);
  }

  // NAT
  getNATEntries(): NATEntry[] {
    return [...this.natEntries];
  }

  addNATEntry(entry: NATEntry): void {
    this.natEntries.push(entry);
  }

  clearNAT(): void {
    this.natEntries = [];
  }

  // DHCP
  getDHCPPool(name: string): DHCPPool | null {
    return this.dhcpPools.get(name) || null;
  }

  getDHCPPools(): DHCPPool[] {
    return Array.from(this.dhcpPools.values());
  }

  setDHCPPool(pool: DHCPPool): void {
    this.dhcpPools.set(pool.name, pool);
  }

  deleteDHCPPool(name: string): boolean {
    return this.dhcpPools.delete(name);
  }

  // Configuration
  getRunningConfig(): string[] {
    return this.generateRunningConfig();
  }

  getStartupConfig(): string[] {
    return [...this.startupConfig];
  }

  saveConfig(): void {
    this.startupConfig = this.generateRunningConfig();
  }

  private generateRunningConfig(): string[] {
    const config: string[] = [];

    config.push('!');
    config.push(`! Last configuration change at ${new Date().toISOString()}`);
    config.push('!');
    config.push(`version ${this.iosVersion}`);
    config.push(`hostname ${this.hostname}`);
    config.push('!');

    // Enable password/secret
    if (this.terminalState.enableSecret) {
      config.push(`enable secret ${this.terminalState.enableSecret}`);
    } else if (this.terminalState.enablePassword) {
      config.push(`enable password ${this.terminalState.enablePassword}`);
    }

    // Users
    for (const user of this.users.values()) {
      config.push(`username ${user.username} privilege 15 password ${user.password || '0'}`);
    }

    config.push('!');

    // Interfaces
    for (const iface of this.ciscoInterfaces.values()) {
      config.push(`interface ${iface.name}`);
      if (iface.description) {
        config.push(` description ${iface.description}`);
      }
      if (iface.ipAddress && iface.netmask) {
        config.push(` ip address ${iface.ipAddress} ${iface.netmask}`);
      }
      if (iface.switchportMode) {
        config.push(` switchport mode ${iface.switchportMode}`);
        if (iface.switchportMode === 'access' && iface.accessVlan) {
          config.push(` switchport access vlan ${iface.accessVlan}`);
        }
        if (iface.switchportMode === 'trunk') {
          if (iface.nativeVlan && iface.nativeVlan !== 1) {
            config.push(` switchport trunk native vlan ${iface.nativeVlan}`);
          }
          if (iface.allowedVlans) {
            config.push(` switchport trunk allowed vlan ${iface.allowedVlans.join(',')}`);
          }
        }
      }
      if (iface.status === 'administratively down') {
        config.push(' shutdown');
      } else {
        config.push(' no shutdown');
      }
      config.push('!');
    }

    // Static routes
    for (const route of this.ciscoRoutes) {
      if (route.protocol === 'S') {
        if (route.nextHop) {
          config.push(`ip route ${route.network} ${route.mask} ${route.nextHop}`);
        } else if (route.interface) {
          config.push(`ip route ${route.network} ${route.mask} ${route.interface}`);
        }
      }
    }

    // DNS
    if (this.dnsConfig.nameservers.length > 0) {
      for (const ns of this.dnsConfig.nameservers) {
        config.push(`ip name-server ${ns}`);
      }
    }

    config.push('!');
    config.push('end');

    return config;
  }

  // Banners
  getBanner(type: 'motd' | 'login' | 'exec'): string | undefined {
    switch (type) {
      case 'motd': return this.bannerMotd;
      case 'login': return this.bannerLogin;
      case 'exec': return this.bannerExec;
    }
  }

  setBanner(type: 'motd' | 'login' | 'exec', message: string): void {
    switch (type) {
      case 'motd': this.bannerMotd = message; break;
      case 'login': this.bannerLogin = message; break;
      case 'exec': this.bannerExec = message; break;
    }
  }

  // Line configuration
  getLineConfig(line: string): { password?: string; login?: boolean; transport?: string[] } | null {
    return this.lineConfigs.get(line) || null;
  }

  setLineConfig(line: string, config: { password?: string; login?: boolean; transport?: string[] }): void {
    this.lineConfigs.set(line, config);
  }
}

// Factory function
export function createCiscoDeviceState(config: CiscoDeviceStateConfig): CiscoDeviceState {
  return new CiscoDeviceState(config);
}
