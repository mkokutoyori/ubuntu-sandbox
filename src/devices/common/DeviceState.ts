/**
 * DeviceState - Base abstractions for isolated device state
 * Each device instance will have its own state including filesystem, processes, services, etc.
 */

// ============================================================================
// FILE SYSTEM ABSTRACTIONS
// ============================================================================

export type FileType = 'file' | 'directory' | 'symlink' | 'device' | 'socket' | 'pipe';

export interface FilePermissions {
  owner: { read: boolean; write: boolean; execute: boolean };
  group: { read: boolean; write: boolean; execute: boolean };
  other: { read: boolean; write: boolean; execute: boolean };
  setuid?: boolean;
  setgid?: boolean;
  sticky?: boolean;
}

export interface FileMetadata {
  size: number;
  created: Date;
  modified: Date;
  accessed: Date;
  permissions: FilePermissions;
  owner: string;
  group: string;
  inode: number;
  links: number;
}

export interface FileNode {
  name: string;
  type: FileType;
  content?: string;
  children?: Map<string, FileNode>;
  metadata: FileMetadata;
  target?: string; // For symlinks
  deviceType?: 'block' | 'char'; // For device files
  major?: number;
  minor?: number;
}

export interface User {
  uid: number;
  gid: number;
  username: string;
  home: string;
  shell: string;
  password?: string; // hashed
  groups: string[];
  fullName?: string;
  locked?: boolean;
}

export interface Group {
  gid: number;
  name: string;
  members: string[];
}

// ============================================================================
// PROCESS MANAGEMENT
// ============================================================================

export type ProcessState = 'running' | 'sleeping' | 'stopped' | 'zombie' | 'waiting';

export interface Process {
  pid: number;
  ppid: number; // Parent PID
  uid: number;
  gid: number;
  command: string;
  args: string[];
  state: ProcessState;
  priority: number;
  nice: number;
  startTime: Date;
  cpuTime: number; // milliseconds
  memory: number; // bytes
  workingDirectory: string;
  environment: Map<string, string>;
  tty?: string;
  threads: number;
}

export interface Job {
  jobId: number;
  pid: number;
  command: string;
  state: 'running' | 'stopped' | 'done';
  background: boolean;
}

// ============================================================================
// SERVICE MANAGEMENT
// ============================================================================

export type ServiceState = 'running' | 'stopped' | 'failed' | 'starting' | 'stopping' | 'reloading';

export interface Service {
  name: string;
  displayName: string;
  description: string;
  state: ServiceState;
  enabled: boolean; // Start on boot
  pid?: number;
  startType: 'auto' | 'manual' | 'disabled';
  dependencies: string[];
  user: string;
  group: string;
  execStart: string;
  execStop?: string;
  restartPolicy: 'always' | 'on-failure' | 'no';
  ports?: number[];
  logs: string[];
}

// ============================================================================
// PACKAGE MANAGEMENT
// ============================================================================

export interface Package {
  name: string;
  version: string;
  description: string;
  installed: boolean;
  installedDate?: Date;
  size: number;
  dependencies: string[];
  provides: string[];
  architecture: string;
  repository?: string;
  priority?: 'required' | 'important' | 'standard' | 'optional' | 'extra';
}

// ============================================================================
// NETWORK CONFIGURATION
// ============================================================================

export interface NetworkInterface {
  id: string;
  name: string;
  type: 'ethernet' | 'loopback' | 'wifi' | 'serial' | 'virtual' | 'bridge' | 'vlan';
  macAddress: string;
  ipAddress?: string;
  netmask?: string;
  gateway?: string;
  ipv6Address?: string;
  ipv6Prefix?: number;
  isUp: boolean;
  isAdminUp: boolean;
  mtu: number;
  speed?: string;
  duplex?: 'full' | 'half' | 'auto';
  rxBytes: number;
  txBytes: number;
  rxPackets: number;
  txPackets: number;
  rxErrors: number;
  txErrors: number;
  rxDropped: number;
  txDropped: number;
  vlanId?: number;
  bridgeGroup?: string;
}

export interface Route {
  destination: string;
  netmask: string;
  gateway: string;
  interface: string;
  metric: number;
  flags: string[];
  protocol: 'static' | 'connected' | 'kernel' | 'ospf' | 'rip' | 'bgp' | 'eigrp';
}

export interface ARPEntry {
  ipAddress: string;
  macAddress: string;
  interface: string;
  type: 'dynamic' | 'static' | 'incomplete';
  age: number; // seconds
}

export interface DNSConfig {
  nameservers: string[];
  searchDomains: string[];
  options: string[];
}

export interface HostEntry {
  ip: string;
  hostnames: string[];
}

// ============================================================================
// ENVIRONMENT
// ============================================================================

export interface Environment {
  variables: Map<string, string>;
  aliases: Map<string, string>;
  path: string[];
  workingDirectory: string;
  user: string;
  hostname: string;
  shell: string;
  term: string;
  lang: string;
  tz: string;
  history: string[];
  historyIndex: number;
}

// ============================================================================
// DEVICE STATE - BASE CLASS
// ============================================================================

export interface DeviceStateConfig {
  deviceId: string;
  hostname: string;
  osType: string;
}

/**
 * Abstract base class for device state
 * Each device type (Linux, Windows, Cisco, etc.) will extend this
 */
export abstract class DeviceState {
  protected deviceId: string;
  protected hostname: string;
  protected osType: string;
  protected bootTime: Date;

  // File system
  protected root: FileNode;
  protected inodeCounter: number = 1;

  // Users and groups
  protected users: Map<string, User> = new Map();
  protected groups: Map<string, Group> = new Map();

  // Processes
  protected processes: Map<number, Process> = new Map();
  protected pidCounter: number = 1;
  protected jobs: Map<number, Job> = new Map();
  protected jobCounter: number = 1;

  // Services
  protected services: Map<string, Service> = new Map();

  // Packages
  protected packages: Map<string, Package> = new Map();

  // Network
  protected interfaces: Map<string, NetworkInterface> = new Map();
  protected routes: Route[] = [];
  protected arpTable: Map<string, ARPEntry> = new Map();
  protected dnsConfig: DNSConfig = { nameservers: [], searchDomains: [], options: [] };
  protected hosts: HostEntry[] = [];

  // Environment
  protected environment: Environment;

  constructor(config: DeviceStateConfig) {
    this.deviceId = config.deviceId;
    this.hostname = config.hostname;
    this.osType = config.osType;
    this.bootTime = new Date();
    // Note: Derived classes must call initialize() after setting their specific properties
    this.root = this.createDirectoryNode('/');
    this.environment = {
      variables: new Map(),
      aliases: new Map(),
      path: [],
      workingDirectory: '/',
      user: '',
      hostname: this.hostname,
      shell: '',
      term: '',
      lang: '',
      tz: '',
      history: [],
      historyIndex: -1
    };
  }

  /**
   * Initialize the device state - must be called by derived class after setting its properties
   */
  protected initialize(): void {
    this.root = this.createRootFileSystem();
    this.environment = this.createDefaultEnvironment();
    this.initializeSystem();
  }

  // Abstract methods that each OS type must implement
  protected abstract createRootFileSystem(): FileNode;
  protected abstract createDefaultEnvironment(): Environment;
  protected abstract initializeSystem(): void;

  // File system operations
  abstract resolvePath(path: string): string;
  abstract getNode(path: string): FileNode | null;
  abstract createFile(path: string, content?: string, permissions?: Partial<FilePermissions>): boolean;
  abstract createDirectory(path: string, recursive?: boolean): boolean;
  abstract deleteNode(path: string, recursive?: boolean): boolean;
  abstract readFile(path: string): string | null;
  abstract writeFile(path: string, content: string, append?: boolean): boolean;
  abstract listDirectory(path: string): FileNode[] | null;
  abstract exists(path: string): boolean;
  abstract isDirectory(path: string): boolean;
  abstract isFile(path: string): boolean;
  abstract copyNode(source: string, destination: string): boolean;
  abstract moveNode(source: string, destination: string): boolean;
  abstract chmod(path: string, permissions: FilePermissions): boolean;
  abstract chown(path: string, owner: string, group?: string): boolean;

  // User management
  abstract addUser(user: User): boolean;
  abstract removeUser(username: string): boolean;
  abstract getUser(username: string): User | null;
  abstract getUserByUid(uid: number): User | null;
  abstract addGroup(group: Group): boolean;
  abstract removeGroup(name: string): boolean;
  abstract getGroup(name: string): Group | null;
  abstract addUserToGroup(username: string, groupName: string): boolean;
  abstract removeUserFromGroup(username: string, groupName: string): boolean;

  // Process management
  abstract createProcess(command: string, args: string[], options?: Partial<Process>): number;
  abstract killProcess(pid: number, signal?: number): boolean;
  abstract getProcess(pid: number): Process | null;
  abstract getProcessByName(name: string): Process[];
  abstract listProcesses(): Process[];
  abstract updateProcess(pid: number, updates: Partial<Process>): boolean;

  // Service management
  abstract registerService(service: Service): boolean;
  abstract unregisterService(name: string): boolean;
  abstract startService(name: string): boolean;
  abstract stopService(name: string): boolean;
  abstract restartService(name: string): boolean;
  abstract enableService(name: string): boolean;
  abstract disableService(name: string): boolean;
  abstract getService(name: string): Service | null;
  abstract listServices(): Service[];

  // Package management
  abstract installPackage(pkg: Package): boolean;
  abstract removePackage(name: string): boolean;
  abstract getPackage(name: string): Package | null;
  abstract listPackages(installed?: boolean): Package[];
  abstract updatePackage(name: string): boolean;

  // Network configuration
  abstract configureInterface(name: string, config: Partial<NetworkInterface>): boolean;
  abstract getInterface(name: string): NetworkInterface | null;
  abstract listInterfaces(): NetworkInterface[];
  abstract addRoute(route: Route): boolean;
  abstract removeRoute(destination: string, netmask: string): boolean;
  abstract getRoutes(): Route[];
  abstract addARPEntry(entry: ARPEntry): void;
  abstract removeARPEntry(ip: string): boolean;
  abstract getARPTable(): ARPEntry[];
  abstract setDNS(config: Partial<DNSConfig>): void;
  abstract getDNS(): DNSConfig;
  abstract addHost(entry: HostEntry): void;
  abstract removeHost(ip: string): boolean;
  abstract getHosts(): HostEntry[];
  abstract resolveHostname(hostname: string): string | null;

  // Environment
  abstract getEnv(name: string): string | undefined;
  abstract setEnv(name: string, value: string): void;
  abstract unsetEnv(name: string): void;
  abstract getWorkingDirectory(): string;
  abstract setWorkingDirectory(path: string): boolean;
  abstract getCurrentUser(): string;
  abstract setCurrentUser(username: string): boolean;
  abstract getHostname(): string;
  abstract setHostname(hostname: string): void;

  // Getters
  getDeviceId(): string { return this.deviceId; }
  getOsType(): string { return this.osType; }
  getBootTime(): Date { return this.bootTime; }
  getUptime(): number { return Date.now() - this.bootTime.getTime(); }

  // Helper to create file metadata
  protected createMetadata(type: FileType, owner: string = 'root', group: string = 'root'): FileMetadata {
    const now = new Date();
    return {
      size: 0,
      created: now,
      modified: now,
      accessed: now,
      permissions: type === 'directory'
        ? { owner: { read: true, write: true, execute: true }, group: { read: true, write: false, execute: true }, other: { read: true, write: false, execute: true } }
        : { owner: { read: true, write: true, execute: false }, group: { read: true, write: false, execute: false }, other: { read: true, write: false, execute: false } },
      owner,
      group,
      inode: this.inodeCounter++,
      links: 1
    };
  }

  // Helper to create a directory node
  protected createDirectoryNode(name: string, owner: string = 'root', group: string = 'root'): FileNode {
    return {
      name,
      type: 'directory',
      children: new Map(),
      metadata: this.createMetadata('directory', owner, group)
    };
  }

  // Helper to create a file node
  protected createFileNode(name: string, content: string = '', owner: string = 'root', group: string = 'root'): FileNode {
    const metadata = this.createMetadata('file', owner, group);
    metadata.size = content.length;
    return {
      name,
      type: 'file',
      content,
      metadata
    };
  }

  // Generate MAC address
  protected generateMAC(): string {
    const hex = '0123456789ABCDEF';
    let mac = '00';
    for (let i = 0; i < 5; i++) {
      mac += ':' + hex[Math.floor(Math.random() * 16)] + hex[Math.floor(Math.random() * 16)];
    }
    return mac;
  }
}
