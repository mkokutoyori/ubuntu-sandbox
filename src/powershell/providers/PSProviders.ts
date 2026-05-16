/**
 * PSProviders — Dependency-injection bag for system resource providers.
 *
 * Each interface defines the minimal surface a category of Windows cmdlets needs.
 * The PSRuntime receives a PSProviders instance at construction time; core cmdlets
 * (Write-Host, ForEach-Object, etc.) do not use providers at all.
 *
 * Concrete implementations:
 *   - WindowsPSProviders (src/powershell/providers/WindowsPSProviders.ts)
 *     → wraps the real WindowsPC managers (filesystem, registry, services…)
 *   - NullProviders (src/powershell/providers/NullProviders.ts)
 *     → all nulls, used by the standalone PSInterpreter (no Windows device)
 */

// ─── Entry types re-exported for cmdlet use ────────────────────────────────

export interface DirEntry {
  name: string;
  isDirectory: boolean;
  size: number;
  mtime: Date;
  attributes?: Set<string>;
  owner?: string;
}

export interface RegistryValue {
  name: string;
  value: string | number;
  type: 'String' | 'DWord' | 'QWord' | 'ExpandString' | 'MultiString' | 'Binary';
}

export interface ServiceInfo {
  name: string;
  displayName: string;
  description: string;
  state: string;
  startType: string;
  serviceType: string;
  binaryPath: string;
  account: string;
  dependencies: string[];
  canPauseAndContinue: boolean;
}

export interface ProcessInfo {
  pid: number;
  name: string;
  ppid: number;
  owner: string;
  handles: number;
  npmK: number;
  pmK: number;
  wsK: number;
  cpuSec: number;
  status: string;
  sessionId: number;
  critical: boolean;
}

export interface UserInfo {
  name: string;
  fullName: string;
  description: string;
  sid: string;
  enabled: boolean;
  passwordRequired: boolean;
  lastLogon: Date | null;
}

export interface GroupInfo {
  name: string;
  description: string;
  sid: string;
  members: string[];
}

export interface EventLogEntryInfo {
  index: number;
  timeGenerated: Date;
  entryType: string;
  source: string;
  eventId: number;
  category: string;
  message: string;
}

export interface NetworkAdapterInfo {
  name: string;
  displayName: string;
  ifIndex: number;
  status: string;
  macAddress: string;
  linkSpeed: string;
}

export interface IPAddressInfo {
  ipAddress: string;
  prefixLength: number;
  ifAlias: string;
  ifIndex: number;
  prefixOrigin: string;
  suffixOrigin: string;
  addressFamily: string;
  gateway?: string;
}

export interface RouteInfo {
  destinationPrefix: string;
  ifAlias: string;
  nextHop: string;
  routeMetric: number;
}

// ─── Provider interfaces ────────────────────────────────────────────────────

export interface IFileSystemProvider {
  /** Check if a path exists (file or directory). */
  exists(path: string): boolean;
  /** Read a file's full text content. Throws if not found. */
  readFile(path: string): string;
  /** Read the last n lines of a file. */
  tailFile(path: string, lines: number): string[];
  /** Write (overwrite) a file. Creates if needed. */
  writeFile(path: string, content: string): void;
  /** Append text to a file. Creates if needed. */
  appendFile(path: string, content: string): void;
  /** List directory entries. */
  listDir(path: string): DirEntry[];
  /** Create a new empty file. */
  createFile(path: string): void;
  /** Create a directory (and parents if needed). */
  createDir(path: string): void;
  /** Delete a path. If recurse=false and path is non-empty dir, throw. */
  remove(path: string, recurse: boolean): void;
  /** Copy src to dest. */
  copy(src: string, dest: string): void;
  /** Move (rename) src to dest. */
  move(src: string, dest: string): void;
  /** Resolve to absolute path given current working directory. */
  normalizePath(path: string, cwd: string): string;
  /** Return current working directory. */
  getCwd(): string;
  /** Update current working directory. */
  setCwd(path: string): void;
  /** Check if path is a directory. */
  isDirectory(path: string): boolean;
  /** Get ACL info for a path. */
  getAcl(path: string): { owner: string; acl: Array<{ principal: string; type: string; permissions: string[] }> } | null;
  /** Set the owner of a path. Returns true on success. */
  setOwner(path: string, owner: string): boolean;
  /** Add an ACE (Access Control Entry) to a path. Returns true on success. */
  addAce(path: string, ace: { principal: string; type: 'allow' | 'deny'; permissions: string[] }): boolean;
}

export interface IRegistryProvider {
  testPath(path: string): boolean;
  getItem(path: string): string;
  getChildItem(path: string): string;
  newItem(path: string, force: boolean): string;
  removeItem(path: string, recurse: boolean): string;
  getItemProperty(path: string, name?: string): string;
  /**
   * Read registry values as a structured object: `{ propName: value, ... }`.
   * Returns `null` when the path does not exist. Used by Get-ItemProperty to
   * expose individual properties (`(Get-ItemProperty ...).PropName`) without
   * parsing the human-readable formatted string.
   */
  getItemPropertyValues?(path: string): Record<string, string | number> | null;
  setItemProperty(path: string, name: string, value: string | number): string;
  removeItemProperty(path: string, name: string): string;
  getPSDrive(): string;
}

export interface IServiceProvider {
  listServices(nameFilter?: string): ServiceInfo[];
  getService(name: string): ServiceInfo | null;
  startService(name: string): string;
  stopService(name: string): string;
  restartService(name: string): string;
  setService(name: string, opts: { startType?: string; description?: string; displayName?: string; status?: string }): string;
  suspendService(name: string): string;
  resumeService(name: string): string;
  newService(name: string, opts: { binaryPath: string; displayName?: string; startType?: string; description?: string }): string;
  removeService(name: string): string;
}

export interface IProcessProvider {
  listProcesses(nameFilter?: string): ProcessInfo[];
  getProcess(nameOrPid: string | number): ProcessInfo | null;
  killProcess(nameOrPid: string | number, force: boolean): string;
  /**
   * Spawn a new process. Used by `Start-Process` and cmd `start <prog>`
   * so the device's process table is shared between both shells.
   * Returns the new ProcessInfo (or `null` if the call was rejected).
   */
  startProcess?(imageName: string, opts?: { arguments?: string; user?: string }): ProcessInfo | null;
}

export interface INetworkProvider {
  getHostname(): string;
  getAdapters(): NetworkAdapterInfo[];
  getAdapter(name: string): NetworkAdapterInfo | null;
  getIPAddresses(ifAlias?: string): IPAddressInfo[];
  addIPAddress(ip: string, prefixLength: number, ifAlias: string, opts?: { gateway?: string }): void;
  removeIPAddress(ip: string, ifAlias?: string): void;
  getRoutes(ifAlias?: string): RouteInfo[];
  addRoute(dest: string, ifAlias: string, nextHop: string, metric: number): void;
  removeRoute(dest: string, ifAlias?: string): void;
  /** Modify properties of an existing route — usually nextHop or metric. */
  setRoute(dest: string, opts: { nextHop?: string; routeMetric?: number; ifAlias?: string }): string;
  /** Modify properties of an existing IP — usually prefixLength. */
  setIPAddress(ip: string, opts: { prefixLength?: number }): string;
  getDnsServers(ifAlias: string): string[];
  setDnsServers(ifAlias: string, servers: string[]): void;
  getDefaultGateway(): string | null;
  isDHCPConfigured(ifAlias: string): boolean;
  /** Test-Connection (ping) */
  testConnection(target: string): boolean;
  /** Resolve-DnsName */
  resolveDns(name: string): string[];
  /** Get-NetTCPConnection */
  getTcpConnections(): Array<{ localAddress: string; localPort: number; remoteAddress: string; remotePort: number; state: string; pid: number }>;
  getFirewallRules(): Array<{ name: string; displayName: string; enabled: boolean; action: string; direction: string; protocol: string; localPort: string; remotePort: string; description: string }>;
  addFirewallRule(rule: { name: string; displayName?: string; enabled?: boolean; action: string; direction: string; protocol?: string; localPort?: string; remotePort?: string; description?: string }): void;
  setFirewallRule(name: string, opts: { enabled?: boolean; action?: string }): string;
  removeFirewallRule(name: string): string;
  /** Adapter enable/disable/rename */
  setAdapterStatus(name: string, status: 'Up' | 'Down'): void;
  renameAdapter(name: string, newName: string): void;
  /** Network profiles */
  getNetworkProfile(ifIndex: number): string;
  setNetworkProfile(ifIndex: number, category: string): void;
  /** WLAN */
  getWlanSSID(): string;
  getWlanProfiles(): string[];
  /** WinHTTP proxy */
  getWinhttpProxy(): string;
  setWinhttpProxy(proxy: string): void;
  /** Execute a CMD-level native command (ping, ipconfig, tracert, etc.) */
  executeCmdCommand(cmd: string): Promise<string>;
  /**
   * Synchronous variant for native commands whose underlying handler is
   * sync (ipconfig / netsh / arp / route / getmac / systeminfo / ver /
   * nslookup). Returns null when the command is async or unknown — callers
   * should fall back to executeCmdCommand or skip the call.
   */
  runSyncNativeCommand(cmd: string, args: string[]): string | null;
}

export interface IUserProvider {
  listUsers(): UserInfo[];
  getUser(name: string): UserInfo | null;
  createUser(name: string, opts: { password?: string; fullName?: string; description?: string }): string;
  removeUser(name: string): string;
  setUser(name: string, opts: { enabled?: boolean; fullName?: string; description?: string; password?: string }): string;
  enableUser(name: string): string;
  disableUser(name: string): string;
  renameUser(oldName: string, newName: string): string;

  listGroups(): GroupInfo[];
  getGroup(name: string): GroupInfo | null;
  createGroup(name: string, opts?: { description?: string }): string;
  removeGroup(name: string): string;
  addGroupMember(group: string, member: string): string;
  removeGroupMember(group: string, member: string): string;
  getGroupMembers(group: string): UserInfo[];
  isAdmin(userName: string): boolean;
}

export interface ScheduledTaskInfo {
  taskName: string;
  taskPath: string;
  state: 'Ready' | 'Running' | 'Disabled';
}

export interface IScheduledTaskProvider {
  listTasks(nameFilter?: string): ScheduledTaskInfo[];
  registerTask(task: ScheduledTaskInfo): string;
  unregisterTask(name: string): string;
}

export interface DiskInfo {
  number: number;
  friendlyName: string;
  size: number;       // bytes
  partitionStyle: string;
  operationalStatus: string;
}
export interface VolumeInfo {
  driveLetter: string;
  fileSystemLabel: string;
  fileSystem: string;
  sizeRemaining: number;
  size: number;
  driveType: string;
}
export interface IEnvironmentProvider {
  /** Returns every environment variable visible on the device. */
  list(): Array<{ Name: string; Value: string }>;
  /** Reads one variable (case-insensitive on Windows). */
  get(name: string): string | undefined;
  /** Persists a variable on the device so cmd subshells see it too. */
  set(name: string, value: string): void;
  /** Removes a variable. */
  remove(name: string): void;
}

export interface IDiskProvider {
  listDisks(): DiskInfo[];
  listVolumes(): VolumeInfo[];
}

export interface VpnConnectionInfo {
  name: string;
  serverAddress: string;
  tunnelType: string;
  encryptionLevel: string;
  authMethod: string;
}

export interface IVpnProvider {
  listConnections(nameFilter?: string): VpnConnectionInfo[];
  getConnection(name: string): VpnConnectionInfo | null;
  addConnection(conn: VpnConnectionInfo): void;
  setConnection(name: string, opts: Partial<Omit<VpnConnectionInfo, 'name'>>): string;
  removeConnection(name: string): string;
}

export interface IEventLogProvider {
  listLogs(): Array<{ logName: string; entries: number; maxSizeKB: number }>;
  getEntries(logName: string, opts?: { newest?: number; entryType?: string; source?: string }): EventLogEntryInfo[];
  writeEntry(logName: string, source: string, eventId: number, entryType: string, message: string): void;
  clearLog(logName: string): string;
  newLog(logName: string, source: string): string;
  limitLog(logName: string, maxSizeKB: number): void;
}

// ─── PSProviders bag ────────────────────────────────────────────────────────

/**
 * DI bag injected into every CmdletContext.
 * Fields are null when running without a device (standalone PSInterpreter).
 * Windows-specific cmdlets check for null before using a provider:
 *
 *   if (!ctx.providers.filesystem) throw new PSRuntimeError('No filesystem available');
 */
export interface PSProviders {
  readonly filesystem:     IFileSystemProvider     | null;
  readonly registry:       IRegistryProvider       | null;
  readonly services:       IServiceProvider        | null;
  readonly network:        INetworkProvider        | null;
  readonly processes:      IProcessProvider        | null;
  readonly users:          IUserProvider           | null;
  readonly eventLog:       IEventLogProvider       | null;
  readonly vpn:            IVpnProvider            | null;
  readonly scheduledTasks: IScheduledTaskProvider  | null;
  readonly disks:          IDiskProvider           | null;
  readonly environment:    IEnvironmentProvider    | null;
}
