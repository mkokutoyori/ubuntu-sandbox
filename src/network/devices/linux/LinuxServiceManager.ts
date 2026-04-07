/**
 * LinuxServiceManager — systemd-style service supervisor for the sandbox.
 *
 * Loads unit files from /lib/systemd/system and /etc/systemd/system in the
 * VFS, tracks service state, spawns/kills processes via LinuxProcessManager,
 * and persists enable/disable state through symlinks under
 * /etc/systemd/system/multi-user.target.wants/.
 *
 * The implementation is intentionally faithful to systemd semantics where
 * it matters for the simulator (ordering of override paths, drop-in dirs,
 * Wants vs Active state) so users can drop new .service files in /etc and
 * have them recognized after `systemctl daemon-reload`.
 */

import type { VirtualFileSystem } from './VirtualFileSystem';
import type { LinuxProcessManager } from './LinuxProcessManager';

/** systemd-equivalent activation state for a unit. */
export type ServiceState =
  | 'active'
  | 'inactive'
  | 'failed'
  | 'activating'
  | 'deactivating';

/** Whether the unit is enabled at boot via Wants symlinks. */
export type EnabledState = 'enabled' | 'disabled' | 'static' | 'masked';

/** systemd Type= directive: how the supervisor tracks the main process. */
export type ServiceType = 'simple' | 'forking' | 'oneshot' | 'notify' | 'idle' | 'dbus';

/** Restart= directive: when to restart the service automatically. */
export type RestartPolicy = 'no' | 'on-failure' | 'on-success' | 'always' | 'on-abnormal';

/** A loaded systemd unit file with parsed directives and runtime state. */
export interface ServiceUnit {
  name: string;
  description: string;
  type: ServiceType;
  execStart: string;
  execStop?: string;
  execReload?: string;
  user: string;
  group: string;
  wantedBy: string[];
  after: string[];
  requires: string[];
  restart: RestartPolicy;
  /** Source file the unit was loaded from. */
  loadedFrom: string;
  // ── Runtime state (mutated by start/stop/etc.) ────────────────
  state: ServiceState;
  enabled: EnabledState;
  mainPid?: number;
  activeSince?: Date;
}

export interface ServiceManagerOptions {
  isServer: boolean;
}

export interface OperationResult {
  ok: boolean;
  error?: string;
}

export interface ListFilter {
  state?: ServiceState;
  enabled?: EnabledState;
}

/** Directory where the system stores vendor-shipped unit files.
 *  Canonical path; /lib/systemd/system is a symlink that some VFS layers
 *  do not resolve transparently, so we always read/write through /usr/lib. */
const SYSTEM_UNIT_DIR = '/usr/lib/systemd/system';
/** Directory where local administrator overrides live (highest precedence). */
const ETC_UNIT_DIR = '/etc/systemd/system';
/** multi-user.target.wants — Wants symlinks for the default boot target. */
const WANTS_DIR = '/etc/systemd/system/multi-user.target.wants';

// ─── Default unit definitions ─────────────────────────────────────────

/** A default unit to be installed at first boot. */
interface DefaultUnit {
  name: string;
  description: string;
  type: ServiceType;
  execStart: string;
  execReload?: string;
  user?: string;
  after?: string[];
  enabledByDefault: boolean;
  /** Whether the service should be active right after boot. */
  startByDefault: boolean;
}

/** Vendor unit set installed in /lib/systemd/system on every machine. */
const BASE_UNITS: DefaultUnit[] = [
  {
    name: 'ssh',
    description: 'OpenBSD Secure Shell server',
    type: 'notify',
    execStart: '/usr/sbin/sshd -D',
    execReload: '/bin/kill -HUP $MAINPID',
    after: ['network.target', 'auditd.service'],
    enabledByDefault: true,
    startByDefault: true,
  },
  {
    name: 'cron',
    description: 'Regular background program processing daemon',
    type: 'forking',
    execStart: '/usr/sbin/cron -f',
    after: ['network.target'],
    enabledByDefault: true,
    startByDefault: true,
  },
  {
    name: 'rsyslog',
    description: 'System Logging Service',
    type: 'notify',
    execStart: '/usr/sbin/rsyslogd -n -iNONE',
    after: ['network.target'],
    enabledByDefault: true,
    startByDefault: true,
  },
  {
    name: 'systemd-resolved',
    description: 'Network Name Resolution',
    type: 'notify',
    execStart: '/lib/systemd/systemd-resolved',
    user: 'systemd-resolve',
    enabledByDefault: true,
    startByDefault: true,
  },
  {
    name: 'systemd-journald',
    description: 'Journal Service',
    type: 'notify',
    execStart: '/lib/systemd/systemd-journald',
    enabledByDefault: true,
    startByDefault: true,
  },
  {
    name: 'systemd-logind',
    description: 'User Login Management',
    type: 'dbus',
    execStart: '/lib/systemd/systemd-logind',
    enabledByDefault: true,
    startByDefault: true,
  },
  {
    name: 'dbus',
    description: 'D-Bus System Message Bus',
    type: 'dbus',
    execStart: '/usr/bin/dbus-daemon --system --address=systemd: --nofork --nopidfile --systemd-activation --syslog-only',
    user: 'messagebus',
    enabledByDefault: true,
    startByDefault: true,
  },
  {
    name: 'networking',
    description: 'Raise network interfaces',
    type: 'oneshot',
    execStart: '/sbin/ifup -a --read-environment',
    after: ['network-pre.target'],
    enabledByDefault: true,
    startByDefault: true,
  },
  {
    name: 'ufw',
    description: 'Uncomplicated firewall',
    type: 'oneshot',
    execStart: '/lib/ufw/ufw-init start quiet',
    after: ['local-fs.target'],
    enabledByDefault: true,
    startByDefault: true,
  },
  {
    name: 'apparmor',
    description: 'Load AppArmor profiles',
    type: 'oneshot',
    execStart: '/lib/apparmor/apparmor.systemd reload',
    enabledByDefault: true,
    startByDefault: true,
  },
];

/** Extra units only installed on machines flagged as servers. */
const SERVER_UNITS: DefaultUnit[] = [
  {
    name: 'apache2',
    description: 'The Apache HTTP Server',
    type: 'forking',
    execStart: '/usr/sbin/apachectl start',
    execReload: '/usr/sbin/apachectl graceful',
    user: 'www-data',
    after: ['network.target', 'remote-fs.target'],
    enabledByDefault: false,
    startByDefault: false,
  },
  {
    name: 'nginx',
    description: 'A high performance web server and a reverse proxy server',
    type: 'forking',
    execStart: '/usr/sbin/nginx -g "daemon on; master_process on;"',
    execReload: '/usr/sbin/nginx -s reload',
    user: 'www-data',
    after: ['network.target', 'remote-fs.target'],
    enabledByDefault: false,
    startByDefault: false,
  },
  {
    name: 'mysql',
    description: 'MySQL Community Server',
    type: 'notify',
    execStart: '/usr/sbin/mysqld',
    user: 'mysql',
    after: ['network.target'],
    enabledByDefault: false,
    startByDefault: false,
  },
  {
    name: 'postgresql',
    description: 'PostgreSQL RDBMS',
    type: 'oneshot',
    execStart: '/bin/true',
    user: 'postgres',
    after: ['network.target'],
    enabledByDefault: false,
    startByDefault: false,
  },
  {
    name: 'oracle-ohasd',
    description: 'Oracle High Availability Services',
    type: 'simple',
    execStart: '/etc/init.d/init.ohasd run',
    user: 'oracle',
    enabledByDefault: true,
    startByDefault: true,
  },
];

export class LinuxServiceManager {
  /** Loaded units indexed by short name (without .service suffix). */
  private units = new Map<string, ServiceUnit>();

  constructor(
    private readonly vfs: VirtualFileSystem,
    private readonly processMgr: LinuxProcessManager,
    private readonly opts: ServiceManagerOptions,
  ) {
    this.bootstrapDefaultUnits();
    this.daemonReload();
    this.startEnabledServices();
  }

  // ─── Public API ───────────────────────────────────────────────────

  /** Start a service. Spawns its main process if not already active. */
  start(name: string): OperationResult {
    const unit = this.requireUnit(name);
    if (!unit.ok) return unit;
    const u = unit.unit;
    if (u.state === 'active') return { ok: true };
    return this.activate(u);
  }

  /** Stop a service. Kills its main process if running. */
  stop(name: string): OperationResult {
    const unit = this.requireUnit(name);
    if (!unit.ok) return unit;
    const u = unit.unit;
    if (u.state !== 'active' && u.state !== 'activating') {
      return { ok: true };
    }
    return this.deactivate(u);
  }

  /** Stop then start a service in a single operation. */
  restart(name: string): OperationResult {
    const stopRes = this.stop(name);
    if (!stopRes.ok) return stopRes;
    return this.start(name);
  }

  /** Send SIGHUP (or run ExecReload) to the main process. */
  reload(name: string): OperationResult {
    const unit = this.requireUnit(name);
    if (!unit.ok) return unit;
    const u = unit.unit;
    if (u.state !== 'active' || u.mainPid === undefined) {
      return { ok: false, error: `Job for ${name}.service failed because the unit is not active.` };
    }
    if (!u.execReload) {
      return { ok: false, error: `${name}.service: Refusing to reload: ExecReload= is not set.` };
    }
    this.processMgr.kill(u.mainPid, 'SIGHUP');
    return { ok: true };
  }

  /** Mark service as enabled and create the Wants symlink. */
  enable(name: string): OperationResult {
    const unit = this.requireUnit(name);
    if (!unit.ok) return unit;
    const u = unit.unit;
    if (u.enabled === 'enabled') return { ok: true };
    this.vfs.mkdirp(WANTS_DIR, 0o755, 0, 0);
    const linkPath = `${WANTS_DIR}/${name}.service`;
    if (!this.vfs.existsNoFollow(linkPath)) {
      const target = `${u.loadedFrom}`;
      this.vfs.createSymlink(linkPath, target, 0, 0);
    }
    u.enabled = 'enabled';
    return { ok: true };
  }

  /** Mark service as disabled and remove the Wants symlink. */
  disable(name: string): OperationResult {
    const unit = this.requireUnit(name);
    if (!unit.ok) return unit;
    const u = unit.unit;
    const linkPath = `${WANTS_DIR}/${name}.service`;
    if (this.vfs.existsNoFollow(linkPath)) {
      this.vfs.deleteFile(linkPath);
    }
    u.enabled = 'disabled';
    return { ok: true };
  }

  /** Return the unit, or null if not loaded. */
  status(name: string): ServiceUnit | null {
    return this.units.get(name) ?? null;
  }

  /** True if the service is currently active. */
  isActive(name: string): boolean {
    return this.units.get(name)?.state === 'active';
  }

  /** True if the service is enabled at boot. */
  isEnabled(name: string): boolean {
    return this.units.get(name)?.enabled === 'enabled';
  }

  /** List units, optionally filtered by state or enabled flag. */
  list(filter: ListFilter = {}): ServiceUnit[] {
    const out: ServiceUnit[] = [];
    for (const u of this.units.values()) {
      if (filter.state !== undefined && u.state !== filter.state) continue;
      if (filter.enabled !== undefined && u.enabled !== filter.enabled) continue;
      out.push(u);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Re-scan unit files from /etc/systemd/system (overrides) and
   * /lib/systemd/system. Preserves runtime state of already-loaded units.
   */
  daemonReload(): void {
    const etcUnits = this.scanDir(ETC_UNIT_DIR);
    const libUnits = this.scanDir(SYSTEM_UNIT_DIR);

    // /etc/systemd/system overrides /lib/systemd/system
    const merged = new Map<string, { path: string; content: string }>();
    for (const u of libUnits) merged.set(u.name, { path: u.path, content: u.content });
    for (const u of etcUnits) merged.set(u.name, { path: u.path, content: u.content });

    for (const [name, src] of merged) {
      const parsed = parseUnitFile(src.content);
      const previous = this.units.get(name);
      const unit: ServiceUnit = {
        name,
        description: parsed.description ?? name,
        type: parsed.type ?? 'simple',
        execStart: parsed.execStart ?? '/bin/true',
        execStop: parsed.execStop,
        execReload: parsed.execReload,
        user: parsed.user ?? 'root',
        group: parsed.group ?? 'root',
        wantedBy: parsed.wantedBy ?? [],
        after: parsed.after ?? [],
        requires: parsed.requires ?? [],
        restart: parsed.restart ?? 'no',
        loadedFrom: src.path,
        // Preserve previous runtime state if the unit already existed.
        state: previous?.state ?? 'inactive',
        enabled: this.computeEnabledState(name),
        mainPid: previous?.mainPid,
        activeSince: previous?.activeSince,
      };
      this.units.set(name, unit);
    }

    // Drop units that no longer have a backing file (and stop them).
    for (const name of Array.from(this.units.keys())) {
      if (!merged.has(name)) {
        const u = this.units.get(name)!;
        if (u.mainPid !== undefined) this.processMgr.kill(u.mainPid, 'SIGKILL');
        this.units.delete(name);
      }
    }
  }

  // ─── Private helpers ──────────────────────────────────────────────

  private requireUnit(
    name: string,
  ): { ok: true; unit: ServiceUnit } | { ok: false; error: string } {
    const short = name.replace(/\.service$/, '');
    const u = this.units.get(short);
    if (!u) {
      return { ok: false, error: `Unit ${short}.service not found.` };
    }
    return { ok: true, unit: u };
  }

  private activate(u: ServiceUnit): OperationResult {
    u.state = 'activating';
    const userEntry = u.user || 'root';
    const uid = userEntry === 'root' ? 0 : 1;
    const gid = userEntry === 'root' ? 0 : 1;
    const expanded = u.execStart.replace(/\$MAINPID/g, '');
    const proc = this.processMgr.spawn({
      command: expanded,
      user: userEntry,
      uid,
      gid,
      serviceName: u.name,
      vsize: 80000,
      rss: 8000,
    });
    u.mainPid = proc.pid;
    u.activeSince = new Date();
    u.state = u.type === 'oneshot' ? 'active' : 'active';
    return { ok: true };
  }

  private deactivate(u: ServiceUnit): OperationResult {
    u.state = 'deactivating';
    if (u.mainPid !== undefined) {
      this.processMgr.kill(u.mainPid, 'SIGTERM');
      u.mainPid = undefined;
    }
    u.activeSince = undefined;
    u.state = 'inactive';
    return { ok: true };
  }

  private computeEnabledState(name: string): EnabledState {
    return this.vfs.existsNoFollow(`${WANTS_DIR}/${name}.service`) ? 'enabled' : 'disabled';
  }

  private scanDir(dir: string): Array<{ name: string; path: string; content: string }> {
    if (!this.vfs.exists(dir)) return [];
    const entries = this.vfs.listDirectory(dir) ?? [];
    const out: Array<{ name: string; path: string; content: string }> = [];
    for (const entry of entries) {
      if (entry.name === '.' || entry.name === '..') continue;
      if (!entry.name.endsWith('.service')) continue;
      // Skip the wants directory entries (they live in a subdir, not here).
      const path = `${dir}/${entry.name}`;
      const content = this.vfs.readFile(path);
      if (content === null) continue;
      const name = entry.name.replace(/\.service$/, '');
      out.push({ name, path, content });
    }
    return out;
  }

  /** Install the vendor unit file set in /lib/systemd/system. */
  private bootstrapDefaultUnits(): void {
    this.vfs.mkdirp(SYSTEM_UNIT_DIR, 0o755, 0, 0);
    this.vfs.mkdirp(ETC_UNIT_DIR, 0o755, 0, 0);
    this.vfs.mkdirp(WANTS_DIR, 0o755, 0, 0);

    const units = [...BASE_UNITS, ...(this.opts.isServer ? SERVER_UNITS : [])];
    for (const u of units) {
      const path = `${SYSTEM_UNIT_DIR}/${u.name}.service`;
      if (!this.vfs.exists(path)) {
        this.vfs.writeFile(path, renderUnitFile(u), 0, 0, 0o022);
      }
      if (u.enabledByDefault) {
        const linkPath = `${WANTS_DIR}/${u.name}.service`;
        if (!this.vfs.existsNoFollow(linkPath)) {
          this.vfs.createSymlink(linkPath, path, 0, 0);
        }
      }
    }
  }

  /** Start every unit that has startByDefault and is enabled. */
  private startEnabledServices(): void {
    const startByDefault = new Set(
      [...BASE_UNITS, ...(this.opts.isServer ? SERVER_UNITS : [])]
        .filter(u => u.startByDefault)
        .map(u => u.name),
    );
    for (const u of this.units.values()) {
      if (startByDefault.has(u.name) && u.enabled === 'enabled') {
        this.activate(u);
      }
    }
  }
}

// ─── Unit file rendering and parsing ──────────────────────────────────

/** Serialize a default unit definition into ini-format unit file content. */
function renderUnitFile(u: DefaultUnit): string {
  const lines: string[] = [];
  lines.push('[Unit]');
  lines.push(`Description=${u.description}`);
  if (u.after && u.after.length) lines.push(`After=${u.after.join(' ')}`);
  lines.push('');
  lines.push('[Service]');
  lines.push(`Type=${u.type}`);
  lines.push(`ExecStart=${u.execStart}`);
  if (u.execReload) lines.push(`ExecReload=${u.execReload}`);
  if (u.user) lines.push(`User=${u.user}`);
  lines.push('Restart=on-failure');
  lines.push('');
  lines.push('[Install]');
  lines.push('WantedBy=multi-user.target');
  lines.push('');
  return lines.join('\n');
}

/** Parsed directives from a unit file (all fields optional). */
interface ParsedUnit {
  description?: string;
  type?: ServiceType;
  execStart?: string;
  execStop?: string;
  execReload?: string;
  user?: string;
  group?: string;
  wantedBy?: string[];
  after?: string[];
  requires?: string[];
  restart?: RestartPolicy;
}

/** Minimal ini-style parser for systemd unit files. */
export function parseUnitFile(content: string): ParsedUnit {
  const out: ParsedUnit = {};
  let section: 'Unit' | 'Service' | 'Install' | null = null;
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    if (line.startsWith('[') && line.endsWith(']')) {
      const name = line.slice(1, -1);
      section = name === 'Unit' || name === 'Service' || name === 'Install' ? name : null;
      continue;
    }
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim();
    if (section === 'Unit') {
      if (key === 'Description') out.description = val;
      else if (key === 'After') out.after = val.split(/\s+/);
      else if (key === 'Requires') out.requires = val.split(/\s+/);
    } else if (section === 'Service') {
      if (key === 'Type') out.type = val as ServiceType;
      else if (key === 'ExecStart') out.execStart = val;
      else if (key === 'ExecStop') out.execStop = val;
      else if (key === 'ExecReload') out.execReload = val;
      else if (key === 'User') out.user = val;
      else if (key === 'Group') out.group = val;
      else if (key === 'Restart') out.restart = val as RestartPolicy;
    } else if (section === 'Install') {
      if (key === 'WantedBy') out.wantedBy = val.split(/\s+/);
    }
  }
  return out;
}
