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
import { fwRules, resolveAdapterName } from '@/network/devices/windows/WinNetsh';
import { IPAddress, SubnetMask } from '@/network/core/types';

type FwRow = {
  name: string; displayName: string; enabled: boolean;
  action: string; direction: string; protocol: string;
  localPort: string; remotePort: string; description: string;
};
import { JobProvider } from '@/powershell/providers/JobProvider';
import type {
  PSProviders,
  IFileSystemProvider, IRegistryProvider, IServiceProvider,
  INetworkProvider, IProcessProvider, IUserProvider, IEventLogProvider,
  IVpnProvider, IScheduledTaskProvider, IDiskProvider, IEnvironmentProvider,
  DirEntry, ServiceInfo, ProcessInfo, UserInfo, GroupInfo,
  NetworkAdapterInfo, IPAddressInfo, RouteInfo, EventLogEntryInfo,
  VpnConnectionInfo, ScheduledTaskInfo, DiskInfo, VolumeInfo,
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
    // Real PowerShell Restart-Service tolerates a pre-stopped target: it
    // just starts it. Only abort on permission errors or "service not found".
    if (stopRes && /denied|does not exist/i.test(stopRes)) return stopRes;
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
  startProcess(imageName: string, opts?: { arguments?: string; user?: string }): ProcessInfo | null {
    const mgr = this.mgr();
    // Parent the new process to explorer.exe (interactive shell session).
    const parent = mgr.getAllProcesses().find(p => p.name.toLowerCase() === 'explorer.exe');
    const ppid = parent?.pid ?? 1;
    const spawned = mgr.spawnProcess(
      imageName,
      ppid,
      opts?.user ?? (this.pc as unknown as { getCurrentUser?: () => string }).getCurrentUser?.() ?? 'User',
      { session: 'Console', sessionId: 1, commandLine: opts?.arguments },
    );
    return spawned ? toProcessInfo(spawned) : null;
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
  getItemPropertyValues(path: string) { return this.reg.getItemPropertyValues(path); }
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
    return this.log.getAllLogsStructured();
  }
  getEntries(logName: string, opts?: { newest?: number; entryType?: string; source?: string }): EventLogEntryInfo[] {
    const raw = this.log.getEntriesStructured(logName, opts ?? {});
    if (!raw) return [];
    return raw.map(e => ({
      index: e.index,
      timeGenerated: e.timeGenerated,
      entryType: e.entryType,
      source: e.source,
      eventId: e.eventId,
      category: e.category,
      message: e.message,
    }));
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
    // Loopback is always present in real Windows.
    if (!ifAlias || ifAlias.toLowerCase() === 'loopback pseudo-interface 1') {
      out.push({
        ipAddress: '127.0.0.1',
        prefixLength: 8,
        ifAlias: 'Loopback Pseudo-Interface 1',
        ifIndex: 1,
        prefixOrigin: 'WellKnown',
        suffixOrigin: 'WellKnown',
        addressFamily: 'IPv4',
      });
      out.push({
        ipAddress: '::1',
        prefixLength: 128,
        ifAlias: 'Loopback Pseudo-Interface 1',
        ifIndex: 1,
        prefixOrigin: 'WellKnown',
        suffixOrigin: 'WellKnown',
        addressFamily: 'IPv6',
      });
    }
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
    // Mirror onto the device port so cmd's `ipconfig` / `netsh ipv4 show
    // addresses` see the same address PowerShell just added.
    if (!ip.includes(':')) {
      const ports = (this.pc as unknown as { ports: Map<string, unknown> }).ports;
      const portName = resolveAdapterName(ifAlias, ports);
      if (ports.has(portName)) {
        const maskOctets = prefixToMaskOctets(prefixLength);
        try {
          (this.pc as unknown as { configureInterface: (n: string, ip: IPAddress, m: SubnetMask) => void })
            .configureInterface(portName, new IPAddress(ip), new SubnetMask(maskOctets));
        } catch { /* ignore — extraIPs already records the assignment */ }
      }
    }
  }
  removeIPAddress(ip: string): void {
    if (ip === '127.0.0.1' || ip === '::1') {
      throw new Error('Cannot remove loopback address.');
    }
    const entry = this.state.extraIPs.get(ip.toLowerCase());
    this.state.extraIPs.delete(ip.toLowerCase());
    // Also strip the address from the underlying device port so cmd's
    // `ipconfig` no longer reports it. We only clear if the port currently
    // carries that exact IP (matches netsh's `delete address` semantics).
    if (entry && !ip.includes(':')) {
      const ports = (this.pc as unknown as { ports: Map<string, { getIPAddress: () => unknown; clearIP: () => void }> }).ports;
      const portName = resolveAdapterName(entry.ifAlias, ports as Map<string, unknown>);
      const port = ports.get(portName);
      if (port && String(port.getIPAddress()) === ip) port.clearIP();
    }
  }

  // ─ Routes ───────────────────────────────────────────────────────────────

  getRoutes(): RouteInfo[] {
    const out: RouteInfo[] = [];
    // Built-in defaults (loopback + per-port connected networks + default
    // route) so the cmdlet output matches what real `Get-NetRoute` shows
    // on a fresh box. Built from device state — no fallback to executor.
    const gw = this.getDefaultGateway() ?? '0.0.0.0';
    const ports = (this.pc as unknown as { getPorts: () => Array<{ name: string; getIPAddress: () => unknown; getSubnetMask?: () => unknown }> }).getPorts();
    const firstIf = ports[0] ? portToDisplayName(ports[0].name) : 'Ethernet';
    if (!this.state.extraRoutes.has('0.0.0.0/0')) {
      out.push({ destinationPrefix: '0.0.0.0/0', ifAlias: firstIf, nextHop: gw, routeMetric: 0 });
    }
    out.push({ destinationPrefix: '127.0.0.0/8', ifAlias: 'Loopback Pseudo-Interface 1', nextHop: '0.0.0.0', routeMetric: 306 });
    for (const p of ports) {
      const ip = p.getIPAddress()?.toString() ?? '';
      const maskRaw = p.getSubnetMask?.()?.toString() ?? '';
      if (ip && maskRaw) {
        const prefix = maskToPrefixLength(maskRaw);
        const network = ip.split('.').map((o, i) =>
          (parseInt(o, 10) & parseInt((maskRaw.split('.')[i] ?? '0'), 10)).toString()
        ).join('.');
        out.push({ destinationPrefix: `${network}/${prefix}`, ifAlias: portToDisplayName(p.name), nextHop: '0.0.0.0', routeMetric: 256 });
      }
    }
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
  setRoute(dest: string, opts: { nextHop?: string; routeMetric?: number; ifAlias?: string }): string {
    const cur = this.state.extraRoutes.get(dest);
    if (!cur) {
      // Upsert (matches the legacy executor) using whatever was provided.
      this.state.extraRoutes.set(dest, {
        ifAlias: opts.ifAlias ?? '',
        nextHop: opts.nextHop ?? '0.0.0.0',
        metric:  opts.routeMetric ?? 256,
      });
      return '';
    }
    if (opts.ifAlias     !== undefined) cur.ifAlias = opts.ifAlias;
    if (opts.nextHop     !== undefined) cur.nextHop = opts.nextHop;
    if (opts.routeMetric !== undefined) cur.metric  = opts.routeMetric;
    return '';
  }
  setIPAddress(ip: string, opts: { prefixLength?: number }): string {
    const cur = this.state.extraIPs.get(ip.toLowerCase());
    if (!cur) return `Cannot find IP ${ip}.`;
    if (opts.prefixLength !== undefined) cur.prefixLength = opts.prefixLength;
    return '';
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
  testConnection(target: string): boolean {
    const probe = this.testPingProbe(target);
    return probe?.success ?? false;
  }
  resolveDns(): string[]      { return []; }
  testPingProbe(target: string) {
    const ip = this.resolveTargetSync(target);
    if (!ip) return null;
    const r = this.pc.sendPingProbeSync(ip);
    return { success: r.success, rttMs: r.rttMs, resolvedIp: ip.toString() };
  }
  testTcpProbe(target: string, port: number): boolean {
    const ip = this.resolveTargetSync(target);
    if (!ip) return false;
    return this.pc.tcpProbeSync(ip, port);
  }
  egressInfoFor(target: string) {
    const ip = this.resolveTargetSync(target);
    if (!ip) return null;
    const eg = this.pc.getEgressFor(ip);
    if (!eg) return null;
    return {
      sourceIp: eg.sourceIp.toString(),
      interfaceAlias: eg.interfaceName,
      nextHop: eg.nextHopIP.toString(),
    };
  }
  private resolveTargetSync(target: string): IPAddress | null {
    return this.pc.resolveHostnameSync(target);
  }
  getTcpConnections() {
    const table = (this.pc as unknown as { getSocketTable?: () => { getAll: () => Array<{ protocol: string; localAddress: string; localPort: number; remoteAddress: string; remotePort: number; state: string; pid: number }> } }).getSocketTable?.();
    if (!table) return [];
    return table.getAll()
      .filter(s => s.protocol.toLowerCase() === 'tcp')
      .map(s => ({
        localAddress:  s.localAddress,
        localPort:     s.localPort,
        remoteAddress: s.state === 'LISTEN' ? '0.0.0.0' : s.remoteAddress,
        remotePort:    s.state === 'LISTEN' ? 0 : s.remotePort,
        state:         s.state === 'LISTEN' ? 'Listen' : s.state,
        pid:           s.pid,
      }));
  }

  // ─ Firewall ─────────────────────────────────────────────────────────────

  getFirewallRules() {
    // Built-in Windows Firewall rules — matches the static set the legacy
    // formatter shipped so cmdlets relying on these names keep working.
    const builtins = [
      { name: 'CoreNet-DHCP-In',      displayName: 'DHCP (UDP-In)',              enabled: true,  action: 'Allow', direction: 'Inbound',  protocol: 'UDP', localPort: '68',    remotePort: '67',  description: 'Built-in: DHCP client' },
      { name: 'CoreNet-DHCP-Out',     displayName: 'DHCP (UDP-Out)',             enabled: true,  action: 'Allow', direction: 'Outbound', protocol: 'UDP', localPort: '68',    remotePort: '67',  description: 'Built-in: DHCP client' },
      { name: 'CoreNet-DNS-Out',      displayName: 'DNS (UDP-Out)',              enabled: true,  action: 'Allow', direction: 'Outbound', protocol: 'UDP', localPort: 'Any',   remotePort: '53',  description: 'Built-in: DNS client' },
      { name: 'FPS-ICMP4-ERQ-In',     displayName: 'File and Printer Sharing',   enabled: true,  action: 'Allow', direction: 'Inbound',  protocol: 'ICMPv4', localPort: 'Any', remotePort: 'Any', description: 'Built-in: ICMP echo request' },
      { name: 'RemoteDesktop-In-TCP', displayName: 'Remote Desktop - User Mode', enabled: false, action: 'Allow', direction: 'Inbound',  protocol: 'TCP', localPort: '3389',  remotePort: 'Any', description: 'Built-in: RDP' },
      { name: 'WinRM-HTTP-In-TCP',    displayName: 'Windows Remote Management',  enabled: false, action: 'Allow', direction: 'Inbound',  protocol: 'TCP', localPort: '5985',  remotePort: 'Any', description: 'Built-in: WinRM' },
      { name: 'BlockTelemetry',       displayName: 'Block Windows Telemetry',    enabled: true,  action: 'Block', direction: 'Outbound', protocol: 'TCP', localPort: 'Any',   remotePort: '443', description: 'Built-in: Block Telemetry' },
    ];
    // Coherent view: dynamic rules added via PowerShell live in
    // `state.dynamicFirewallRules`; cmd's `netsh advfirewall firewall add`
    // pushes into the shared module-level `fwRules` array. We merge both
    // sources by displayName so callers see a single coherent list.
    const dynamicMap = new Map<string, FwRow>();
    for (const r of this.state.dynamicFirewallRules.values()) {
      dynamicMap.set((r.displayName ?? r.name).toLowerCase(), { ...r });
    }
    for (const r of fwRules) {
      const key = r.name.toLowerCase();
      if (dynamicMap.has(key)) continue;
      dynamicMap.set(key, {
        name: r.name,
        displayName: r.name,
        enabled: true,
        action: r.action.charAt(0).toUpperCase() + r.action.slice(1),
        direction: r.dir === 'out' ? 'Outbound' : 'Inbound',
        protocol: r.protocol,
        localPort: r.localport,
        remotePort: 'Any',
        description: '',
      });
    }
    return [...builtins, ...dynamicMap.values()];
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
    // Mirror into the cmd-visible store so `netsh advfirewall firewall show
    // rule name="<n>"` can find the same rule.
    if (!fwRules.some(r => r.name.toLowerCase() === rule.name.toLowerCase())) {
      fwRules.push({
        name:      rule.name,
        dir:       rule.direction === 'Outbound' ? 'out' : 'in',
        action:    rule.action.toLowerCase(),
        protocol:  rule.protocol ?? 'TCP',
        localport: rule.localPort ?? 'Any',
        program:   '',
        profile:   'any',
      });
    }
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
    const removed = this.state.dynamicFirewallRules.delete(key);
    const i = fwRules.findIndex(r => r.name.toLowerCase() === name.toLowerCase());
    if (i >= 0) fwRules.splice(i, 1);
    return (removed || i >= 0) ? '' : `No firewall rule named '${name}'.`;
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
  runSyncNativeCommand(cmd: string, args: string[]): string | null {
    const m = this.pc as unknown as { runSyncNativeCommand?: (c: string, a: string[]) => string | null };
    return m.runSyncNativeCommand ? m.runSyncNativeCommand(cmd, args) : null;
  }
}

/** CIDR prefix length → 4-octet subnet mask. */
function prefixToMaskOctets(prefix: number): number[] {
  const bits = Math.max(0, Math.min(32, prefix));
  const m = bits === 0 ? 0 : 0xFFFFFFFF << (32 - bits);
  return [(m >>> 24) & 0xFF, (m >>> 16) & 0xFF, (m >>> 8) & 0xFF, m & 0xFF];
}

function notImpl(name: string): Error {
  // The cmdlet layer recognises "not implemented" and falls through to the
  // legacy PowerShellExecutor; keep the message in sync with isFallbackError.
  return new Error(`${name} is not recognized as a network provider operation`);
}

// Port name → PS-style adapter display name (`eth0` → `Ethernet`).
function portToDisplayName(portName: string): string {
  const m = portName.match(/^eth(\d+)$/i);
  if (!m) return portName;
  const idx = parseInt(m[1], 10);
  return idx === 0 ? 'Ethernet' : `Ethernet ${idx + 1}`;
}

// 255.255.255.0 → 24.
function maskToPrefixLength(mask: string): number {
  let bits = 0;
  for (const part of mask.split('.')) {
    bits += ((parseInt(part, 10) | 0) >>> 0).toString(2).split('').filter(b => b === '1').length;
  }
  return bits;
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

// ── Scheduled tasks (simple in-memory, seeded with built-ins) ─────────────

interface ScheduledTaskState {
  readonly tasks: Map<string, ScheduledTaskInfo>;
}

const SEEDED_TASKS: ScheduledTaskInfo[] = [
  { taskName: 'GoogleUpdateTaskUser',                taskPath: '\\',                            state: 'Ready' },
  { taskName: 'OneDrive Standalone Update Task',     taskPath: '\\',                            state: 'Ready' },
  { taskName: '.NET Framework NGEN v4.0.30319',      taskPath: '\\Microsoft\\Windows\\.NET',    state: 'Ready' },
  { taskName: 'SimTestTask',                          taskPath: '\\',                            state: 'Ready' },
];

class WindowsScheduledTaskAdapter implements IScheduledTaskProvider {
  /**
   * Reads/writes go through the device's shared `scheduledTasks` map so
   * cmd `schtasks` and PS `*-ScheduledTask` cmdlets observe identical state.
   */
  constructor(private readonly pc: WindowsPC) {}

  private store(): Map<string, ScheduledTaskInfo> {
    return (this.pc as unknown as { scheduledTasks: Map<string, ScheduledTaskInfo> }).scheduledTasks;
  }

  listTasks(nameFilter?: string): ScheduledTaskInfo[] {
    const all = Array.from(this.store().values());
    return nameFilter
      ? all.filter(t => t.taskName.toLowerCase().includes(nameFilter.toLowerCase()))
      : all;
  }
  registerTask(task: ScheduledTaskInfo): string {
    this.store().set(task.taskName.toLowerCase(), task);
    return `\\${task.taskName}`;
  }
  unregisterTask(name: string): string {
    return this.store().delete(name.toLowerCase()) ? '' : `Cannot find scheduled task '${name}'.`;
  }
}

// ── Disks / volumes (read-only seeded data) ───────────────────────────────

class WindowsEnvironmentAdapter implements IEnvironmentProvider {
  /** Well-known Windows env vars that always exist on a real machine.
   *  We compute them from the device's hostname / current user so the
   *  values stay consistent when the user switches with runas. */
  constructor(private readonly pc: WindowsPC) {}

  private wellKnown(): Map<string, string> {
    const out = new Map<string, string>();
    const user = (this.pc as unknown as { getCurrentUser?: () => string }).getCurrentUser?.()
              ?? 'User';
    const host = (this.pc as unknown as { hostname?: string; getHostname?: () => string })
      .getHostname?.() ?? (this.pc as unknown as { hostname?: string }).hostname ?? 'WIN-PC';
    out.set('USERNAME',             user);
    out.set('COMPUTERNAME',         host);
    out.set('USERPROFILE',          `C:\\Users\\${user}`);
    out.set('SYSTEMROOT',           'C:\\Windows');
    out.set('WINDIR',               'C:\\Windows');
    out.set('TEMP',                 `C:\\Users\\${user}\\AppData\\Local\\Temp`);
    out.set('TMP',                  `C:\\Users\\${user}\\AppData\\Local\\Temp`);
    out.set('PATH',                 'C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\Wbem');
    out.set('HOMEDRIVE',            'C:');
    out.set('HOMEPATH',             `\\Users\\${user}`);
    out.set('PROCESSOR_ARCHITECTURE', 'AMD64');
    out.set('OS',                   'Windows_NT');
    out.set('COMSPEC',              'C:\\Windows\\System32\\cmd.exe');
    out.set('APPDATA',              `C:\\Users\\${user}\\AppData\\Roaming`);
    out.set('LOCALAPPDATA',         `C:\\Users\\${user}\\AppData\\Local`);
    out.set('PROGRAMFILES',         'C:\\Program Files');
    out.set('PROGRAMFILES(X86)',    'C:\\Program Files (x86)');
    out.set('PROGRAMDATA',          'C:\\ProgramData');
    out.set('PATHEXT',              '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC;.PS1');
    out.set('NUMBER_OF_PROCESSORS', '4');
    out.set('USERDOMAIN',           'WORKGROUP');
    out.set('LOGONSERVER',          `\\\\${host}`);
    out.set('SESSIONNAME',          'Console');
    out.set('SYSTEMDRIVE',          'C:');
    out.set('PUBLIC',               'C:\\Users\\Public');
    out.set('ALLUSERSPROFILE',      'C:\\ProgramData');
    return out;
  }

  list(): Array<{ Name: string; Value: string }> {
    const merged = this.wellKnown();
    const deviceEnv = (this.pc as unknown as { getEnvVars?: () => Map<string, string> }).getEnvVars?.();
    if (deviceEnv) for (const [k, v] of deviceEnv) merged.set(k.toUpperCase(), v);
    return Array.from(merged.entries(), ([Name, Value]) => ({ Name, Value }));
  }

  get(name: string): string | undefined {
    const u = name.toUpperCase();
    const deviceEnv = (this.pc as unknown as { getEnvVars?: () => Map<string, string> }).getEnvVars?.();
    if (deviceEnv) {
      for (const [k, v] of deviceEnv) if (k.toUpperCase() === u) return v;
    }
    return this.wellKnown().get(u);
  }

  set(name: string, value: string): void {
    const deviceEnv = (this.pc as unknown as { getEnvVars?: () => Map<string, string> }).getEnvVars?.();
    if (deviceEnv) deviceEnv.set(name, value);
  }

  remove(name: string): void {
    const deviceEnv = (this.pc as unknown as { getEnvVars?: () => Map<string, string> }).getEnvVars?.();
    if (!deviceEnv) return;
    const u = name.toUpperCase();
    for (const k of [...deviceEnv.keys()]) if (k.toUpperCase() === u) deviceEnv.delete(k);
  }
}

class WindowsDiskAdapter implements IDiskProvider {
  constructor(private readonly pc: WindowsPC) {}
  listDisks(): DiskInfo[] {
    return [
      { number: 0, friendlyName: 'Virtual HD',     size: 100 * 1024 ** 3, partitionStyle: 'GPT', operationalStatus: 'Online' },
      { number: 1, friendlyName: 'Data Disk',      size:  50 * 1024 ** 3, partitionStyle: 'GPT', operationalStatus: 'Online' },
    ];
  }
  listVolumes(): VolumeInfo[] {
    void this.pc; // future: hook into device drives if/when modelled
    return [
      { driveLetter: 'C', fileSystemLabel: 'System',     fileSystem: 'NTFS', sizeRemaining: 60 * 1024 ** 3, size: 100 * 1024 ** 3, driveType: 'Fixed' },
      { driveLetter: 'D', fileSystemLabel: 'Data',        fileSystem: 'NTFS', sizeRemaining: 30 * 1024 ** 3, size:  50 * 1024 ** 3, driveType: 'Fixed' },
    ];
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
    registry?:       PSRegistryProvider;
    eventLog?:       PSEventLogProvider;
    network?:        NetworkStateRefs;
    vpn?:            VpnState;
    scheduledTasks?: ScheduledTaskState;
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
  const tasks = shared?.scheduledTasks ?? {
    tasks: new Map(SEEDED_TASKS.map(t => [t.taskName.toLowerCase(), t])),
  };
  return {
    filesystem:     new WindowsFileSystemAdapter(pc),
    services:       new WindowsServiceAdapter(pc),
    processes:      new WindowsProcessAdapter(pc),
    jobs:           new JobProvider({
      now: () => (pc as unknown as { simulatedNow: () => number }).simulatedNow(),
      advance: (ms) => (pc as unknown as { advanceTime: (ms: number) => void }).advanceTime(ms),
    }),
    users:          new WindowsUserAdapter(pc),
    registry:       new WindowsRegistryAdapter(reg),
    eventLog:       new WindowsEventLogAdapter(log),
    network:        new WindowsNetworkAdapter(pc, net),
    vpn:            new WindowsVpnAdapter(vpn),
    scheduledTasks: new WindowsScheduledTaskAdapter(pc),
    disks:          new WindowsDiskAdapter(pc),
    environment:    new WindowsEnvironmentAdapter(pc),
  };
}
