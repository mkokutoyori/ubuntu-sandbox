/**
 * WindowsPSProviders — Device-backed implementation of PSProviders.
 *
 * Wraps a WindowsPC's managers (filesystem, services, processes, users) so the
 * PSInterpreter can read/write the same simulated state as the rest of the
 * device (and as the legacy PowerShellExecutor). Phase 1 of the executor →
 * interpreter migration: this lets the interpreter access device state via
 * its existing PSProviders DI bag instead of going through the legacy
 * string-based PowerShellExecutor.
 *
 * Network / event-log surfaces are partial — only the calls needed by the
 * core cmdlets that are already migrated. The rest throw `NotImplemented`
 * which the cmdlet layer treats as a fallback signal.
 */

import type { WindowsPC } from '@/network/devices/WindowsPC';
import { PSRegistryProvider } from '@/network/devices/windows/PSRegistryProvider';
import { PSEventLogProvider } from '@/network/devices/windows/PSEventLogProvider';
import type {
  PSProviders,
  IFileSystemProvider, IRegistryProvider, IServiceProvider,
  INetworkProvider, IProcessProvider, IUserProvider, IEventLogProvider,
  IVpnProvider,
  DirEntry, ServiceInfo, ProcessInfo, UserInfo, GroupInfo,
  NetworkAdapterInfo, IPAddressInfo, RouteInfo, EventLogEntryInfo,
  VpnConnectionInfo,
} from '@/powershell/providers/PSProviders';

// ── Filesystem adapter ────────────────────────────────────────────────────

class WindowsFileSystemAdapter implements IFileSystemProvider {
  constructor(private readonly pc: WindowsPC) {}

  private fs() { return this.pc.getFileSystem(); }

  exists(path: string): boolean {
    return this.fs().exists(this.abs(path));
  }
  readFile(path: string): string {
    const r = this.fs().readFile(this.abs(path));
    if (!r.ok) throw new Error(r.error ?? `Cannot read ${path}`);
    return r.content ?? '';
  }
  tailFile(path: string, lines: number): string[] {
    const all = this.readFile(path).split(/\r?\n/);
    return all.slice(Math.max(0, all.length - lines));
  }
  writeFile(path: string, content: string): void {
    const r = this.fs().createFile(this.abs(path), content);
    if (!r.ok) throw new Error(r.error ?? `Cannot write ${path}`);
  }
  appendFile(path: string, content: string): void {
    const abs = this.abs(path);
    if (!this.fs().exists(abs)) {
      this.writeFile(path, content);
      return;
    }
    const r = this.fs().appendFile(abs, content);
    if (!r.ok) throw new Error(r.error ?? `Cannot append to ${path}`);
  }
  listDir(path: string): DirEntry[] {
    const entries = this.fs().listDirectory(this.abs(path));
    return entries.map(e => ({
      name: e.name,
      isDirectory: e.entry.type === 'directory',
      size: e.entry.size,
      mtime: e.entry.mtime,
      attributes: new Set(e.entry.attributes),
      owner: e.entry.owner,
    }));
  }
  createFile(path: string): void {
    this.writeFile(path, '');
  }
  createDir(path: string): void {
    this.fs().mkdirp(this.abs(path));
  }
  remove(path: string, recurse: boolean): void {
    const abs = this.abs(path);
    if (this.fs().isDirectory(abs)) {
      const r = recurse
        ? this.fs().rmdirRecursive(abs)
        : this.fs().rmdir(abs);
      if (!r.ok) throw new Error(r.error ?? `Cannot remove ${path}`);
    } else {
      const r = this.fs().deleteFile(abs);
      if (!r.ok) throw new Error(r.error ?? `Cannot remove ${path}`);
    }
  }
  copy(src: string, dest: string): void {
    const r = this.fs().copyFile(this.abs(src), this.abs(dest));
    if (!r.ok) throw new Error(r.error ?? `Cannot copy`);
  }
  move(src: string, dest: string): void {
    const r = this.fs().moveFile(this.abs(src), this.abs(dest));
    if (!r.ok) throw new Error(r.error ?? `Cannot move`);
  }
  normalizePath(path: string, cwd: string): string {
    return this.fs().normalizePath(path, cwd);
  }
  getCwd(): string {
    return this.pc.getCwd();
  }
  setCwd(path: string): void {
    this.pc.setCwd(this.abs(path));
  }
  isDirectory(path: string): boolean {
    return this.fs().isDirectory(this.abs(path));
  }
  getAcl(path: string) {
    const e = this.fs().resolve(this.abs(path));
    if (!e) return null;
    return {
      owner: e.owner,
      acl: e.acl.map(a => ({ principal: a.principal, type: a.type, permissions: [...a.permissions] })),
    };
  }
  setOwner(path: string, owner: string): boolean {
    return this.fs().setOwner(this.abs(path), owner);
  }
  addAce(path: string, ace: { principal: string; type: 'allow' | 'deny'; permissions: string[] }): boolean {
    return this.fs().addACE(this.abs(path), { ...ace });
  }

  private abs(p: string): string {
    return this.fs().normalizePath(p, this.pc.getCwd());
  }
}

// ── Service adapter ────────────────────────────────────────────────────────

class WindowsServiceAdapter implements IServiceProvider {
  constructor(private readonly pc: WindowsPC) {}

  private mgr() { return this.pc.getServiceManager(); }
  private isAdmin(): boolean { return this.pc.getUserManager().isCurrentUserAdmin(); }

  listServices(nameFilter?: string): ServiceInfo[] {
    const all = this.mgr().getAllServices();
    const filtered = nameFilter
      ? all.filter(s => s.name.toLowerCase().includes(nameFilter.toLowerCase()))
      : all;
    return filtered.map(toServiceInfo);
  }
  getService(name: string): ServiceInfo | null {
    const s = this.mgr().getService(name);
    return s ? toServiceInfo(s) : null;
  }
  startService(name: string): string {
    return this.mgr().startService(name, this.isAdmin());
  }
  stopService(name: string): string {
    return this.mgr().stopService(name, this.isAdmin());
  }
  restartService(name: string): string {
    const stopRes = this.mgr().stopService(name, this.isAdmin());
    if (stopRes && /error|denied|not/i.test(stopRes)) return stopRes;
    return this.mgr().startService(name, this.isAdmin());
  }
  setService(name: string, opts: { startType?: string; description?: string; displayName?: string; status?: string }): string {
    const admin = this.isAdmin();
    const m = this.mgr();
    const msgs: string[] = [];
    if (opts.startType)   msgs.push(m.setStartType(name, opts.startType, admin));
    if (opts.displayName) msgs.push(m.setDisplayName(name, opts.displayName, admin));
    if (opts.description) msgs.push(m.setDescription(name, opts.description, admin));
    if (opts.status === 'Running') msgs.push(m.startService(name, admin));
    if (opts.status === 'Stopped') msgs.push(m.stopService(name, admin));
    return msgs.filter(Boolean).join('\n');
  }
  suspendService(name: string): string {
    return this.mgr().pauseService(name, this.isAdmin());
  }
  resumeService(name: string): string {
    return this.mgr().resumeService(name, this.isAdmin());
  }
  newService(name: string, opts: { binaryPath: string; displayName?: string; startType?: string; description?: string }): string {
    return this.mgr().createService(name, {
      binaryPath: opts.binaryPath,
      displayName: opts.displayName ?? name,
      startType: opts.startType ?? 'Manual',
      description: opts.description ?? '',
    }, this.isAdmin());
  }
  removeService(name: string): string {
    return this.mgr().deleteService(name, this.isAdmin());
  }
}

function toServiceInfo(s: import('@/network/devices/windows/WindowsServiceManager').WindowsService): ServiceInfo {
  return {
    name: s.name,
    displayName: s.displayName,
    description: s.description,
    state: String(s.state),
    startType: String(s.startType),
    serviceType: String(s.serviceType),
    binaryPath: s.binaryPath,
    account: s.account,
    dependencies: [...s.dependencies],
    canPauseAndContinue: s.canPauseAndContinue,
  };
}

// ── Process adapter ────────────────────────────────────────────────────────

class WindowsProcessAdapter implements IProcessProvider {
  constructor(private readonly pc: WindowsPC) {}

  private mgr() { return this.pc.getProcessManager(); }
  private isAdmin(): boolean { return this.pc.getUserManager().isCurrentUserAdmin(); }

  listProcesses(nameFilter?: string): ProcessInfo[] {
    const all = this.mgr().getAllProcesses();
    const filtered = nameFilter
      ? all.filter(p => p.name.toLowerCase().includes(nameFilter.toLowerCase()))
      : all;
    return filtered.map(toProcessInfo);
  }
  getProcess(nameOrPid: string | number): ProcessInfo | null {
    if (typeof nameOrPid === 'number') {
      const p = this.mgr().getProcess(nameOrPid);
      return p ? toProcessInfo(p) : null;
    }
    const byName = this.mgr().getProcessesByName(nameOrPid);
    return byName.length > 0 ? toProcessInfo(byName[0]) : null;
  }
  killProcess(nameOrPid: string | number, force: boolean): string {
    if (typeof nameOrPid === 'number') {
      return this.mgr().killProcess(nameOrPid, force, this.isAdmin());
    }
    return this.mgr().killByName(nameOrPid, force, this.isAdmin(), false);
  }
}

function toProcessInfo(p: import('@/network/devices/windows/WindowsProcessManager').WindowsProcess): ProcessInfo {
  return {
    pid: p.pid,
    name: p.name,
    ppid: p.ppid,
    owner: p.owner,
    handles: p.handles,
    npmK: p.npmK,
    pmK: p.pmK,
    wsK: p.wsK,
    cpuSec: p.cpuSec,
    status: p.status,
    sessionId: p.sessionId,
    critical: p.critical,
  };
}

// ── User / group adapter ───────────────────────────────────────────────────

class WindowsUserAdapter implements IUserProvider {
  constructor(private readonly pc: WindowsPC) {}

  private mgr() { return this.pc.getUserManager(); }

  listUsers(): UserInfo[] {
    return this.mgr().getAllUsers().map(toUserInfo);
  }
  getUser(name: string): UserInfo | null {
    const u = this.mgr().getUser(name);
    return u ? toUserInfo(u) : null;
  }
  createUser(name: string, opts: { password?: string; fullName?: string; description?: string }): string {
    return this.mgr().createUser(name, opts.password ?? '', {
      fullName: opts.fullName,
      description: opts.description,
    });
  }
  removeUser(name: string): string {
    return this.mgr().deleteUser(name);
  }
  setUser(name: string, opts: { enabled?: boolean; fullName?: string; description?: string; password?: string }): string {
    const m = this.mgr();
    const msgs: string[] = [];
    if (opts.fullName !== undefined)     msgs.push(m.setUserProperty(name, 'fullName',    opts.fullName));
    if (opts.description !== undefined)  msgs.push(m.setUserProperty(name, 'description', opts.description));
    if (opts.password !== undefined)     msgs.push(m.setUserProperty(name, 'password',    opts.password));
    if (opts.enabled === true)           msgs.push(m.enableUser(name));
    if (opts.enabled === false)          msgs.push(m.disableUser(name));
    return msgs.filter(Boolean).join('\n');
  }
  enableUser(name: string): string {
    return this.mgr().enableUser(name);
  }
  disableUser(name: string): string {
    return this.mgr().disableUser(name);
  }
  renameUser(oldName: string, newName: string): string {
    const m = this.mgr() as unknown as { renameUser?: (a: string, b: string) => string };
    return m.renameUser ? m.renameUser(oldName, newName) : `Rename-LocalUser not supported`;
  }

  listGroups(): GroupInfo[] {
    return this.mgr().getAllGroups().map(toGroupInfo);
  }
  getGroup(name: string): GroupInfo | null {
    const g = this.mgr().getGroup(name);
    return g ? toGroupInfo(g) : null;
  }
  createGroup(name: string, opts?: { description?: string }): string {
    return this.mgr().createGroup(name, opts?.description ?? '');
  }
  removeGroup(name: string): string {
    return this.mgr().deleteGroup(name);
  }
  addGroupMember(group: string, member: string): string {
    return this.mgr().addGroupMember(group, member);
  }
  removeGroupMember(group: string, member: string): string {
    return this.mgr().removeGroupMember(group, member);
  }
  getGroupMembers(group: string): UserInfo[] {
    const g = this.mgr().getGroup(group);
    if (!g) return [];
    const out: UserInfo[] = [];
    for (const memberName of g.members) {
      const u = this.mgr().getUser(memberName);
      if (u) out.push(toUserInfo(u));
    }
    return out;
  }
  isAdmin(userName: string): boolean {
    return this.mgr().isAdmin(userName);
  }
}

function toUserInfo(u: import('@/network/devices/windows/WindowsUserManager').WindowsUser): UserInfo {
  return {
    name: u.name,
    fullName: u.fullName,
    description: u.description,
    sid: u.sid,
    enabled: u.enabled,
    passwordRequired: u.passwordRequired,
    lastLogon: u.lastLogon,
  };
}
function toGroupInfo(g: import('@/network/devices/windows/WindowsUserManager').WindowsGroup): GroupInfo {
  return {
    name: g.name,
    description: g.description,
    sid: g.sid,
    members: [...g.members],
  };
}

// ── Registry adapter (direct delegation — same string-returning shape) ─────

class WindowsRegistryAdapter implements IRegistryProvider {
  // Held at provider-construction time so the interpreter and the legacy
  // executor can share the same in-memory hive (see WindowsPSProviders ctor).
  constructor(private readonly reg: PSRegistryProvider) {}

  testPath(path: string): boolean              { return this.reg.testPath(path); }
  getItem(path: string): string                 { return this.reg.getItem(path); }
  getChildItem(path: string): string            { return this.reg.getChildItem(path); }
  newItem(path: string, force: boolean): string { return this.reg.newItem(path, force); }
  removeItem(path: string, recurse: boolean): string { return this.reg.removeItem(path, recurse); }
  getItemProperty(path: string, name?: string): string { return this.reg.getItemProperty(path, name); }
  setItemProperty(path: string, name: string, value: string | number): string {
    return this.reg.setItemProperty(path, name, value);
  }
  removeItemProperty(path: string, name: string): string { return this.reg.removeItemProperty(path, name); }
  getPSDrive(): string                           { return this.reg.getPSDrive(); }
}

// ── Event-log adapter (minimal — returns parsed shape where possible) ──────

class WindowsEventLogAdapter implements IEventLogProvider {
  constructor(private readonly log: PSEventLogProvider) {}

  listLogs() {
    // PSEventLogProvider only exposes a formatted-string view; parse it back.
    const formatted = this.log.getEventLogList();
    const result: Array<{ logName: string; entries: number; maxSizeKB: number }> = [];
    for (const line of formatted.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S.*)$/);
      if (!m) continue;
      result.push({ logName: m[4].trim(), entries: parseInt(m[2], 10), maxSizeKB: parseInt(m[3], 10) });
    }
    return result;
  }
  getEntries(): EventLogEntryInfo[] {
    // Structured entries aren't trivially recoverable from the formatted string.
    // Cmdlets that need details should fall back through PowerShellExecutor for now.
    return [];
  }
  writeEntry(logName: string, source: string, eventId: number, entryType: string, message: string): void {
    this.log.writeEventLog(logName, source, eventId, entryType as 'Information' | 'Warning' | 'Error' | 'SuccessAudit' | 'FailureAudit', message);
  }
  clearLog(logName: string): string { return this.log.clearEventLog(logName); }
  newLog(logName: string, source: string): string { return this.log.newEventLog(logName, source); }
  limitLog(logName: string): void { this.log.limitEventLog(logName); }
}

// ── Network adapter ────────────────────────────────────────────────────────
//
// Most operational state for IP / route / firewall / adapter overrides /
// connection profiles still lives on the legacy PowerShellExecutor
// (`extraIPs`, `extraRoutes`, `adapterOverrides`, `dynamicFirewallRules`,
// `networkProfiles`, …). Until that state is relocated onto WindowsPC we
// share the executor's maps directly so the interpreter and the executor
// fallback path see the same world.

interface NetworkStateRefs {
  readonly extraIPs:             Map<string, { ifAlias: string; prefixLength: number; prefixOrigin: string; suffixOrigin: string; skipAsSource: boolean; gateway?: string; addressFamily: string }>;
  readonly extraRoutes:          Map<string, { ifAlias: string; nextHop: string; metric: number }>;
  readonly adapterOverrides:     Map<string, { status?: string; displayName?: string }>;
  readonly dynamicFirewallRules: Map<string, { name: string; displayName: string; enabled: boolean; action: string; direction: string; protocol: string; localPort: string; remotePort: string; description: string }>;
  readonly networkProfiles:      Map<number, string>;
}

class WindowsNetworkAdapter implements INetworkProvider {
  constructor(
    private readonly pc: WindowsPC,
    private readonly state: NetworkStateRefs,
  ) {}

  // ─ Hostname / adapters / IP enumeration ─────────────────────────────────

  getHostname(): string {
    return (this.pc as unknown as { name: string }).name;
  }
  getAdapters(): NetworkAdapterInfo[] {
    const ports = (this.pc as unknown as { getPorts: () => Array<{ name: string; getMAC: () => { toString: () => string }; getIsUp: () => boolean }> }).getPorts();
    return ports.map((p, idx) => {
      const ov = this.state.adapterOverrides.get(p.name.toLowerCase()) ?? {};
      return {
        name: ov.displayName ?? p.name,
        displayName: ov.displayName ?? p.name,
        ifIndex: idx + 1,
        status: ov.status ?? (p.getIsUp() ? 'Up' : 'Disabled'),
        macAddress: p.getMAC().toString(),
        linkSpeed: '1 Gbps',
      };
    });
  }
  getAdapter(name: string): NetworkAdapterInfo | null {
    const lc = name.toLowerCase();
    return this.getAdapters().find(a => a.name.toLowerCase() === lc) ?? null;
  }
  getIPAddresses(ifAlias?: string): IPAddressInfo[] {
    const out: IPAddressInfo[] = [];
    const ports = (this.pc as unknown as { getPorts: () => Array<{ name: string; getIPAddress: () => unknown }> }).getPorts();
    const filtered = ifAlias
      ? ports.filter(p => p.name.toLowerCase() === ifAlias.toLowerCase())
      : ports;
    filtered.forEach((p, idx) => {
      const raw = p.getIPAddress();
      if (raw) {
        const ip = String((raw as { toString: () => string }).toString());
        out.push({
          ipAddress: ip,
          prefixLength: 24,
          ifAlias: p.name,
          ifIndex: idx + 1,
          prefixOrigin: 'Manual',
          suffixOrigin: 'Manual',
          addressFamily: ip.includes(':') ? 'IPv6' : 'IPv4',
        });
      }
    });
    // Layer extra IPs (added via New-NetIPAddress)
    for (const [ip, meta] of this.state.extraIPs) {
      if (ifAlias && meta.ifAlias.toLowerCase() !== ifAlias.toLowerCase()) continue;
      const ifIndex = ports.findIndex(p => p.name.toLowerCase() === meta.ifAlias.toLowerCase()) + 1;
      out.push({
        ipAddress: ip,
        prefixLength: meta.prefixLength,
        ifAlias: meta.ifAlias,
        ifIndex,
        prefixOrigin: meta.prefixOrigin,
        suffixOrigin: meta.suffixOrigin,
        addressFamily: meta.addressFamily,
        gateway: meta.gateway,
      });
    }
    return out;
  }

  // ─ IP add / remove ──────────────────────────────────────────────────────

  addIPAddress(ip: string, prefixLength: number, ifAlias: string, opts?: { gateway?: string }): void {
    const key = ip.toLowerCase();
    if (this.state.extraIPs.has(key)) {
      throw new Error(`IP address ${ip} already exists.`);
    }
    this.state.extraIPs.set(key, {
      ifAlias,
      prefixLength,
      prefixOrigin: 'Manual',
      suffixOrigin: 'Manual',
      skipAsSource: false,
      gateway: opts?.gateway,
      addressFamily: ip.includes(':') ? 'IPv6' : 'IPv4',
    });
    if (opts?.gateway) {
      const dest = ip.includes(':') ? '::/0' : '0.0.0.0/0';
      this.state.extraRoutes.set(dest, { ifAlias, nextHop: opts.gateway, metric: 256 });
    }
  }
  removeIPAddress(ip: string): void {
    if (ip === '127.0.0.1' || ip === '::1') {
      throw new Error('Cannot remove loopback address.');
    }
    this.state.extraIPs.delete(ip.toLowerCase());
  }

  // ─ Routes ───────────────────────────────────────────────────────────────

  getRoutes(): RouteInfo[] {
    const out: RouteInfo[] = [];
    for (const [dest, meta] of this.state.extraRoutes) {
      out.push({
        destinationPrefix: dest,
        ifAlias: meta.ifAlias,
        nextHop: meta.nextHop,
        routeMetric: meta.metric,
      });
    }
    return out;
  }
  addRoute(dest: string, ifAlias: string, nextHop: string, metric: number): void {
    this.state.extraRoutes.set(dest, { ifAlias, nextHop, metric });
  }
  removeRoute(dest: string): void {
    this.state.extraRoutes.delete(dest);
  }

  // ─ DNS ──────────────────────────────────────────────────────────────────

  getDnsServers(ifAlias: string): string[] {
    const m = this.pc as unknown as { getDnsServers?: (n: string) => string[] };
    return m.getDnsServers ? m.getDnsServers(ifAlias) : [];
  }
  setDnsServers(ifAlias: string, servers: string[]): void {
    const m = this.pc as unknown as { setDnsServers?: (n: string, s: string[]) => void };
    if (m.setDnsServers) m.setDnsServers(ifAlias, servers);
  }
  getDefaultGateway(): string | null {
    const m = this.pc as unknown as { getDefaultGateway?: () => string | null };
    return m.getDefaultGateway ? m.getDefaultGateway() : null;
  }
  isDHCPConfigured(): boolean { return false; }
  testConnection(): boolean   { return true; }
  resolveDns(): string[]      { return []; }
  getTcpConnections()         { return []; }

  // ─ Firewall ─────────────────────────────────────────────────────────────

  getFirewallRules() {
    return Array.from(this.state.dynamicFirewallRules.values()).map(r => ({ ...r }));
  }
  addFirewallRule(rule: { name: string; displayName?: string; enabled?: boolean; action: string; direction: string; protocol?: string; localPort?: string; remotePort?: string; description?: string }): void {
    const displayName = rule.displayName ?? rule.name;
    const key = displayName.toLowerCase();
    this.state.dynamicFirewallRules.set(key, {
      name: rule.name,
      displayName,
      enabled: rule.enabled ?? true,
      action: rule.action,
      direction: rule.direction,
      protocol: rule.protocol ?? 'TCP',
      localPort: rule.localPort ?? 'Any',
      remotePort: rule.remotePort ?? 'Any',
      description: rule.description ?? '',
    });
  }
  setFirewallRule(name: string, opts: { enabled?: boolean; action?: string }): string {
    const key = name.toLowerCase();
    const rule = this.state.dynamicFirewallRules.get(key);
    if (!rule) return `No firewall rule named '${name}'.`;
    if (opts.enabled !== undefined) rule.enabled = opts.enabled;
    if (opts.action  !== undefined) rule.action  = opts.action;
    return '';
  }
  removeFirewallRule(name: string): string {
    const key = name.toLowerCase();
    return this.state.dynamicFirewallRules.delete(key) ? '' : `No firewall rule named '${name}'.`;
  }

  // ─ Adapter actions ──────────────────────────────────────────────────────

  setAdapterStatus(name: string, status: 'Up' | 'Down'): void {
    const key = name.toLowerCase();
    const ov  = this.state.adapterOverrides.get(key) ?? {};
    ov.status = status === 'Down' ? 'Disabled' : 'Up';
    this.state.adapterOverrides.set(key, ov);
  }
  renameAdapter(name: string, newName: string): void {
    const key = name.toLowerCase();
    const ov  = this.state.adapterOverrides.get(key) ?? {};
    ov.displayName = newName;
    this.state.adapterOverrides.set(key, ov);
    this.state.adapterOverrides.set(newName.toLowerCase(), ov);
  }

  // ─ Network connection profile ──────────────────────────────────────────

  getNetworkProfile(ifIndex: number): string {
    return this.state.networkProfiles.get(ifIndex) ?? 'DomainAuthenticated';
  }
  setNetworkProfile(ifIndex: number, category: string): void {
    this.state.networkProfiles.set(ifIndex, category);
  }

  // ─ WLAN / proxy / native cmd execution — still legacy-only ─────────────

  getWlanSSID(): string         { return ''; }
  getWlanProfiles(): string[]   { return []; }
  getWinhttpProxy(): string     { return ''; }
  setWinhttpProxy(): void       { throw notImpl('setWinhttpProxy'); }
  async executeCmdCommand(): Promise<string> { throw notImpl('executeCmdCommand'); }
}

function notImpl(name: string): Error {
  // The cmdlet layer recognises "not implemented" and falls through to the
  // legacy PowerShellExecutor; keep the message in sync with isFallbackError.
  return new Error(`${name} is not recognized as a network provider operation`);
}

// ── VPN adapter (state still on the legacy executor) ─────────────────────

interface VpnState {
  readonly vpnConnections: Map<string, VpnConnectionInfo>;
}

class WindowsVpnAdapter implements IVpnProvider {
  constructor(private readonly state: VpnState) {}

  listConnections(nameFilter?: string): VpnConnectionInfo[] {
    const all = Array.from(this.state.vpnConnections.values());
    return nameFilter
      ? all.filter(v => v.name.toLowerCase() === nameFilter.toLowerCase())
      : all;
  }
  getConnection(name: string): VpnConnectionInfo | null {
    return this.state.vpnConnections.get(name.toLowerCase()) ?? null;
  }
  addConnection(conn: VpnConnectionInfo): void {
    this.state.vpnConnections.set(conn.name.toLowerCase(), conn);
  }
  setConnection(name: string, opts: Partial<Omit<VpnConnectionInfo, 'name'>>): string {
    const cur = this.state.vpnConnections.get(name.toLowerCase());
    if (!cur) return `Cannot find VPN connection '${name}'.`;
    this.state.vpnConnections.set(name.toLowerCase(), { ...cur, ...opts });
    return '';
  }
  removeConnection(name: string): string {
    return this.state.vpnConnections.delete(name.toLowerCase())
      ? ''
      : `Cannot find VPN connection '${name}'.`;
  }
}

// ── Public factory ─────────────────────────────────────────────────────────

/**
 * Build a PSProviders bag backed by a real WindowsPC device. Optional
 * `shared.registry` / `eventLog` / `network` arguments let callers share
 * the same in-memory state with the legacy PowerShellExecutor, so changes
 * made through the interpreter are visible to fallback paths and vice
 * versa. When `shared.network` is omitted the adapter falls back to its
 * own (empty) maps — useful for standalone tests.
 */
export function createWindowsPSProviders(
  pc: WindowsPC,
  shared?: {
    registry?: PSRegistryProvider;
    eventLog?: PSEventLogProvider;
    network?:  NetworkStateRefs;
    vpn?:      VpnState;
  },
): PSProviders {
  const reg = shared?.registry ?? new PSRegistryProvider();
  const log = shared?.eventLog ?? new PSEventLogProvider();
  const net = shared?.network ?? {
    extraIPs:             new Map(),
    extraRoutes:          new Map(),
    adapterOverrides:     new Map(),
    dynamicFirewallRules: new Map(),
    networkProfiles:      new Map(),
  };
  const vpn = shared?.vpn ?? { vpnConnections: new Map() };
  return {
    filesystem: new WindowsFileSystemAdapter(pc),
    services:   new WindowsServiceAdapter(pc),
    processes:  new WindowsProcessAdapter(pc),
    users:      new WindowsUserAdapter(pc),
    registry:   new WindowsRegistryAdapter(reg),
    eventLog:   new WindowsEventLogAdapter(log),
    network:    new WindowsNetworkAdapter(pc, net),
    vpn:        new WindowsVpnAdapter(vpn),
  };
}
