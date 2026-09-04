/**
 * Topology Serializer - JSON export/import for network topologies
 *
 * Captures the real configurable state of every device so that an
 * exported topology round-trips to the same simulator state on
 * import. The set is widened as new state surfaces become important:
 *
 *   - Per-interface: IP/mask, admin up/down, description, secondary IPs
 *   - Per-interface: the NIC's MAC, and the physical layer (MTU, speed,
 *                    duplex, auto-negotiation, bandwidth, delay)
 *   - Per-cable:     admin state, injected loss/corruption/latency
 *   - Per-host:      netfilter rules (via `iptables-save`), the systemd
 *                    units' enable/active state, and the Oracle database
 *                    (accounts + a Data Pump dump)
 *   - Per-host:      default gateway, static routes, static ARP entries,
 *                    every Linux OR Windows file that differs from a
 *                    fresh filesystem
 *   - Per-Windows-host: the local SAM, the registry (as a diff against a
 *                    pristine hive of the same edition, deletions
 *                    included), and every service whose configuration or
 *                    state is no longer the factory one
 *   - Per-switch:    VLAN database, switchport mode + VLAN assignment
 *   - Per-router/switch: the full vendor running-config/NVRAM text,
 *                    re-applied on import via a real CLI replay
 *                    (`replayVendorConfig`) — this is what carries
 *                    ACL/NAT/OSPF/BGP/trunk-allowed-lists/port-security/etc.
 *                    across the round-trip, not just the narrow fields above.
 */

import {
  Equipment, Cable, Port,
  IPAddress, SubnetMask, MACAddress,
  DeviceType, ConnectionType,
  createDevice, resetDeviceCounters, reserveDeviceName,
  generateId, resetCounters,
  Logger,
  EndHost, Router,
  Switch,
  type SwitchportMode,
} from '@/network';
import type { PortDuplex } from '@/network/core/types';
import { LinuxMachine } from '@/network/devices/LinuxMachine';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { WindowsFileSystem } from '@/network/devices/windows/WindowsFileSystem';
import type { WindowsUser, WindowsGroup } from '@/network/devices/windows/WindowsUserManager';
import {
  PSRegistryProvider,
  WINDOWS_CLIENT_PRODUCT_IDENTITY, WINDOWS_SERVER_PRODUCT_IDENTITY,
} from '@/network/devices/windows/PSRegistryProvider';
import {
  WindowsServiceManager,
  type WindowsService,
} from '@/network/devices/windows/WindowsServiceManager';
import {
  captureOracleState, restoreOracleState, type OracleTopologyState,
} from '@/terminal/commands/database';
import { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { bondOptionLines } from '@/network/devices/linux/net/LinuxBonding';
import { Firewall } from '@/network/devices/firewall/Firewall';
import {
  type NetFirewallRuleEntry, firewallRuleKey, seedBuiltInFirewallRules,
} from '@/network/devices/windows/netFirewallRule';
import { buildConnection, type Connection } from './networkStore';

/** Surfaced by Save/Export UI (rapport 09, item #55) so the user knows
 *  this before it happens, not after. Kept in sync with the capture
 *  list in the header comment above: anything not listed there. */
export const TOPOLOGY_SAVE_CAVEATS =
  "Terminal sessions, in-progress editors, and live TCP/SSH connections are not included — they close when this topology is loaded. " +
  "Dynamic state (DHCP leases, OSPF/BGP-learned routes) reconverges from config after loading rather than being restored directly.";

// ── Export schema ──

interface TopologyRouteExport {
  network: string;
  mask: string;
  nextHop: string;
  metric?: number;
}

interface TopologySecondaryIpExport {
  ipAddress: string;
  subnetMask: string;
}

interface TopologyInterfaceExport {
  name: string;
  /**
   * The NIC's burned-in address.
   *
   * Without it every import re-draws MACs from the generator, so a saved
   * static ARP entry, a sticky port-security address or a DHCP
   * reservation ends up naming hardware that no longer exists — the file
   * and the machine it describes disagree the moment they are reloaded.
   */
  mac?: string;
  ipAddress?: string;
  subnetMask?: string;
  isUp?: boolean;
  description?: string;
  secondaryIPs?: TopologySecondaryIpExport[];
  // ── Physical layer. Emitted only when it differs from a fresh port, so
  // a plain topology file stays readable. A router recovers some of this
  // through its running-config replay; a Linux or Windows host has no
  // config text at all, so for those this is the only carrier.
  mtu?: number;
  speed?: number;
  duplex?: PortDuplex;
  autoNegotiation?: boolean;
  bandwidthKbps?: number;
  delayUs?: number;
}

interface TopologyStaticArpExport {
  ip: string;
  mac: string;
  iface: string;
}

interface TopologyFileExport {
  path: string;
  content: string;
}

interface TopologyVlanExport {
  id: number;
  name: string;
}

interface TopologySwitchportExport {
  name: string;
  mode?: SwitchportMode;
  accessVlan?: number;
  trunkNativeVlan?: number;
}

/**
 * A systemd unit's enablement and activation.
 *
 * Unlike the registry, this is NOT a diff, and the reason is the size of
 * what is being described: a machine has a dozen or so units, so the
 * whole table is readable in the file and needs no baseline to interpret
 * — where a registry dump would have been hundreds of seeded values deep.
 * The restore applies only what actually differs on the reopened machine.
 */
interface TopologyLinuxServiceExport {
  name: string;
  enabled: 'enabled' | 'disabled' | 'static' | 'masked';
  active: boolean;
}

interface TopologyLinuxBondExport {
  name: string;
  options: string[];
  slaves: string[];
}

interface TopologyWindowsTeamExport {
  name: string;
  teamingMode: string;
  loadBalancingAlgorithm: string;
  lacpTimer: string;
  members: { name: string; adminMode: string }[];
  teamNics: { name: string; vlanId: number | null; primary: boolean }[];
}

/**
 * A registry diff.
 *
 * Deletions are carried explicitly, and they are the reason this is a
 * diff rather than a dump of what exists: half of what a lab does to the
 * registry is REMOVE a seeded value or key ("disable this by deleting
 * its policy"), and a capture that only listed what was present would
 * bring every one of them back on the next load — the machine would
 * silently undo the exercise.
 */
interface TopologyRegistryExport {
  /** Keys the operator created, including the ones holding no value. */
  keys?: string[];
  /** Values added or changed, `{ path, name, value }`. */
  values?: { path: string; name: string; value: string | number }[];
  /** Seeded values the operator deleted. */
  removedValues?: { path: string; name: string }[];
  /** Seeded keys the operator deleted (the whole subtree with them). */
  removedKeys?: string[];
}

/**
 * A service that is no longer what the image shipped.
 *
 * `created` is present only for a service `sc create`/`New-Service`
 * added, and carries what those commands themselves require; the other
 * fields are the ones `sc config` can change, each present only when it
 * differs from the factory service of the same name.
 */
interface TopologyFirewallExport {
  rules: NetFirewallRuleEntry[];
  removed: string[];
}

interface TopologyWindowsServiceExport {
  name: string;
  created?: {
    binaryPath: string;
    displayName?: string;
    description?: string;
    account?: string;
    dependencies?: string[];
  };
  state?: WindowsService['state'];
  startType?: WindowsService['startType'];
  displayName?: string;
  description?: string;
  account?: string;
  dependencies?: string[];
}

interface TopologyDeviceExport {
  id: string;
  type: DeviceType;
  name: string;
  hostname: string;
  x: number;
  y: number;
  isPoweredOn: boolean;
  interfaces: TopologyInterfaceExport[];
  defaultGateway?: string;
  staticRoutes?: TopologyRouteExport[];
  staticArp?: TopologyStaticArpExport[];
  files?: TopologyFileExport[];
  /**
   * `iptables-save` / `ip6tables-save` text.
   *
   * Netfilter rules are kernel state, not files — which is exactly why a
   * real machine persists them with `iptables-save` and reloads them with
   * `iptables-restore`. Capturing the same text and feeding it back
   * through the same commands means the round-trip uses the machine's own
   * parser rather than a second one written here, which would understand
   * a narrower grammar than the one the operator typed.
   */
  iptablesRules?: string;
  ip6tablesRules?: string;
  /**
   * The machine's systemd units.
   *
   * `systemctl enable`/`disable` is symlink-backed and `systemctl
   * start`/`stop` is not, but neither survived on its own: the file
   * capture only records what EXISTS, so a `disable` — which works by
   * REMOVING the `multi-user.target.wants` symlink — left no trace, and a
   * reopened machine re-created the link at boot and started the service
   * again. A lab whose whole point is a stopped daemon came back healthy.
   */
  linuxServices?: TopologyLinuxServiceExport[];
  linuxBonds?: TopologyLinuxBondExport[];
  windowsTeams?: TopologyWindowsTeamExport[];
  /**
   * The device's Oracle database: its accounts, and a Data Pump dump of
   * everything they own. Absent on a machine that never opened one — the
   * capture peeks at the instance registry rather than asking for a
   * database, which would install Oracle on every host in the topology.
   */
  oracle?: OracleTopologyState;
  /**
   * A Windows host's local SAM.
   *
   * `C:\\users.txt` is captured with the rest of the filesystem, but it is
   * a RENDERING of the account store, not the store — exactly the trap
   * `/etc/passwd` used to be on the Linux side. Restoring the file alone
   * gave a machine where `type C:\\users.txt` listed an account that
   * `net user` did not have.
   */
  windowsAccounts?: { users: WindowsUser[]; groups: WindowsGroup[] };
  /**
   * The machine's registry, as a diff against a pristine hive of the same
   * edition — the same rule the filesystem capture uses, for the same
   * reason: a full dump of the seeded hive in every topology file would
   * bury the one value a lab actually set.
   */
  registry?: TopologyRegistryExport;
  /** Services whose configuration or state is no longer the factory one. */
  windowsServices?: TopologyWindowsServiceExport[];
  windowsFirewallRules?: TopologyFirewallExport;
  vlans?: TopologyVlanExport[];
  switchports?: TopologySwitchportExport[];
  /** `show running-config`/`display current-configuration` text (Router/Switch). */
  runningConfigText?: string;
  /** Saved NVRAM text (`write memory`/`save`), if any. */
  startupConfigText?: string;
}

interface TopologyConnectionExport {
  sourceDeviceId: string;
  sourceInterfaceId: string;
  targetDeviceId: string;
  targetInterfaceId: string;
  type: ConnectionType;
  /**
   * What was done TO the cable, as opposed to what it connects.
   *
   * A lab built to demonstrate a degraded link (docs/PRD-Pannes.md §F5)
   * used to reload as a perfect one: only the endpoints were saved, so
   * the injected loss, corruption, latency and the admin-down state were
   * all dropped. Omitted when the cable is pristine.
   */
  isUp?: boolean;
  packetLossRate?: number;
  corruptionRate?: number;
  artificialDelayMs?: number;
}

export interface TopologyExport {
  version: 1;
  projectName: string;
  exportedAt: string;
  devices: TopologyDeviceExport[];
  connections: TopologyConnectionExport[];
}

// Pseudo-filesystems: content is either device/runtime-generated (procfs,
// sysfs) or backed by simulated hardware nodes (/dev) — neither is
// meaningful to snapshot or safe to write back on import.
const VFS_SKIP_PREFIXES = ['/proc', '/sys', '/dev'];

function isCapturableVfsPath(path: string): boolean {
  return !VFS_SKIP_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

/**
 * A freshly-built `Port`'s physical defaults. Anything equal to these is
 * left out of the file: an operator opening a topology should see what
 * was configured, not a full dump of every field's factory value.
 */
const PORT_DEFAULTS = {
  mtu: 1500,
  speed: 1000,
  duplex: 'full' as PortDuplex,
  autoNegotiation: true,
  bandwidthKbps: 0,
} as const;

function captureInterface(port: Port): TopologyInterfaceExport {
  const entry: TopologyInterfaceExport = { name: port.getName() };
  entry.mac = port.getMAC().toString();
  if (port.getMTU() !== PORT_DEFAULTS.mtu) entry.mtu = port.getMTU();
  if (port.getSpeed() !== PORT_DEFAULTS.speed) entry.speed = port.getSpeed();
  if (port.getDuplex() !== PORT_DEFAULTS.duplex) entry.duplex = port.getDuplex();
  if (port.isNegotiationAuto() !== PORT_DEFAULTS.autoNegotiation) {
    entry.autoNegotiation = port.isNegotiationAuto();
  }
  if (port.getBandwidthKbps() !== PORT_DEFAULTS.bandwidthKbps) {
    entry.bandwidthKbps = port.getBandwidthKbps();
  }
  // Only an operator-set delay: the getter otherwise derives one from the
  // link speed, which is already saved on its own.
  if (port.hasExplicitDelayUs()) entry.delayUs = port.getDelayUs();
  const ip = port.getIPAddress();
  const mask = port.getSubnetMask();
  if (ip) entry.ipAddress = ip.toString();
  if (mask) entry.subnetMask = mask.toString();
  if (!port.getIsUp()) entry.isUp = false;
  const desc = port.getDescriptionText();
  if (desc) entry.description = desc;
  const secondaries = port.getSecondaryIPs();
  if (secondaries.length > 0) {
    entry.secondaryIPs = secondaries.map((s) => ({
      ipAddress: s.ip.toString(),
      subnetMask: s.mask.toString(),
    }));
  }
  return entry;
}

function captureStaticArp(device: EndHost): TopologyStaticArpExport[] {
  const out: TopologyStaticArpExport[] = [];
  for (const [ip, entry] of device.getARPTableFull()) {
    if (entry.type !== 'static') continue;
    out.push({ ip, mac: entry.mac.toString(), iface: entry.iface });
  }
  return out;
}

/**
 * Capture every regular file whose content differs from a freshly-booted
 * device's — i.e. everything a user actually created or edited, rather
 * than the full default tree (`/bin`, `/usr`, …) `initializeRootFS` always
 * populates identically. `pristine` is a bare `VirtualFileSystem` (no
 * device attached) so this has no registry/topology side effects.
 */
function captureLinuxFiles(device: LinuxMachine): TopologyFileExport[] {
  const vfs = (device as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;
  const pristine = new VirtualFileSystem();
  const out: TopologyFileExport[] = [];
  for (const path of vfs.find('/', { type: 'f' })) {
    if (!isCapturableVfsPath(path)) continue;
    if (vfs.resolveInode(path)?.generator) continue; // synthetic — regenerated on read, not real content
    const content = vfs.readFile(path);
    if (content === null) continue;
    const baseline = pristine.exists(path) ? pristine.readFile(path) : null;
    if (content === baseline) continue; // unmodified from a fresh boot — nothing to persist
    out.push({ path, content });
  }
  return out;
}

/**
 * The Windows counterpart of {@link captureLinuxFiles}, and it exists for
 * the same reason: everything the user created or edited, and nothing of
 * the image it came with.
 *
 * Windows machines used to be exported with no filesystem at all — the
 * capture was gated on `instanceof LinuxMachine`, so a lab that put a
 * script, a config or a data file on a Windows host lost it silently on
 * the first save. `WindowsFileSystem` is a different class from the Linux
 * VFS with a different API, which is why this is a second walk rather
 * than a shared one; the RULE is the same, only the traversal differs.
 */
function captureWindowsFiles(device: WindowsPC): TopologyFileExport[] {
  const fs = device.getFileSystem();
  const pristine = new WindowsFileSystem(device.getHostname());
  const out: TopologyFileExport[] = [];
  for (const dir of fs.listDirectoryRecursive('C:\\')) {
    for (const e of dir.entries) {
      if (e.entry.type !== 'file') continue;
      const path = dir.path.endsWith('\\') ? dir.path + e.name : `${dir.path}\\${e.name}`;
      const read = fs.readFile(path);
      if (!read.ok || read.content === undefined) continue;
      const base = pristine.readFile(path);
      if (base.ok && base.content === read.content) continue;
      out.push({ path, content: read.content });
    }
  }
  return out;
}

function restoreWindowsFiles(device: WindowsPC, files: TopologyFileExport[]): void {
  const fs = device.getFileSystem();
  for (const f of files) {
    const parent = f.path.slice(0, f.path.lastIndexOf('\\'));
    if (parent) fs.mkdirp(parent);
    fs.createFile(f.path, f.content);
  }
}

/**
 * A hive as the machine shipped it, to diff the live one against.
 *
 * Two things make it what a fresh machine of the same kind holds, and
 * both matter. The seeded values differ between a client and a server
 * install (build number, edition, `InstallationType`), which is what the
 * product identity carries — diffing a server against a client hive
 * would report those as operator changes and write them into every
 * topology file. And `HKLM:\SYSTEM\CurrentControlSet\Services\<name>` is
 * not seeded at all: the device projects it from the service table at
 * boot, so a bare hive would report the whole subtree as new. Running
 * the very same projection (`projectServiceIntoRegistry`) over a factory
 * service manager is what makes the baseline honest.
 */
function pristineRegistry(device: WindowsPC): PSRegistryProvider {
  const reg = new PSRegistryProvider(
    device.getDeviceType() === 'windows-server'
      ? WINDOWS_SERVER_PRODUCT_IDENTITY
      : WINDOWS_CLIENT_PRODUCT_IDENTITY,
  );
  new WindowsServiceManager().attachRegistrySink(reg);
  return reg;
}

/**
 * Walk a hive through the very same public surface `reg query /s` uses —
 * `listSubkeyNames` + `getItemPropertyValues` — so the capture can only
 * ever see what an operator could have seen.
 */
function walkRegistry(
  reg: PSRegistryProvider,
  path: string,
  visit: (path: string, values: Record<string, string | number>) => void,
): void {
  visit(path, reg.getItemPropertyValues(path) ?? {});
  for (const sub of reg.listSubkeyNames(path)) walkRegistry(reg, `${path}\\${sub}`, visit);
}

function captureRegistry(device: WindowsPC): TopologyRegistryExport | undefined {
  const live = device.registry;
  const base = pristineRegistry(device);

  const out: TopologyRegistryExport = {};
  const keys: string[] = [];
  const values: TopologyRegistryExport['values'] = [];

  for (const hive of ['HKLM:', 'HKCU:']) {
    walkRegistry(live, hive, (path, liveValues) => {
      if (!base.testPath(path)) keys.push(path);
      const baseValues = base.getItemPropertyValues(path) ?? {};
      for (const [name, value] of Object.entries(liveValues)) {
        if (baseValues[name] === value) continue;
        values.push({ path, name, value });
      }
    });

    // The other direction: what the pristine hive has and the live one
    // no longer does.
    const removedKeys: string[] = [];
    const removedValues: TopologyRegistryExport['removedValues'] = [];
    walkRegistry(base, hive, (path, baseValues) => {
      if (!live.testPath(path)) {
        // The parent already carries the whole subtree away with it.
        if (!removedKeys.some((k) => path.startsWith(`${k}\\`))) removedKeys.push(path);
        return;
      }
      const liveValues = live.getItemPropertyValues(path) ?? {};
      for (const name of Object.keys(baseValues)) {
        if (name in liveValues) continue;
        removedValues.push({ path, name });
      }
    });
    if (removedKeys.length > 0) out.removedKeys = [...(out.removedKeys ?? []), ...removedKeys];
    if (removedValues.length > 0) {
      out.removedValues = [...(out.removedValues ?? []), ...removedValues];
    }
  }

  // A key that holds a captured value needs no separate entry — writing
  // the value creates it.
  const keysWithValues = new Set(values.map((v) => v.path));
  const bareKeys = keys.filter((k) => !keysWithValues.has(k));
  if (bareKeys.length > 0) out.keys = bareKeys;
  if (values.length > 0) out.values = values;

  return Object.keys(out).length > 0 ? out : undefined;
}

function restoreRegistry(device: WindowsPC, data: TopologyRegistryExport): void {
  const reg = device.registry;
  // Deletions first: a key removed wholesale must not take a value the
  // same topology re-created inside it away with it.
  for (const path of data.removedKeys ?? []) reg.removeItem(path, true);
  for (const { path, name } of data.removedValues ?? []) reg.removeItemProperty(path, name);
  for (const path of data.keys ?? []) reg.newItem(path, true);
  for (const { path, name, value } of data.values ?? []) {
    // `Set-ItemProperty` refuses a path that does not exist, exactly as
    // the real cmdlet does — so create it the way `reg add` does first.
    reg.newItem(path, true);
    reg.setItemProperty(path, name, value);
  }
}

/**
 * What `sc config`/`sc create` changed about a service, and nothing else.
 *
 * The comparison is against a factory `WindowsServiceManager`, not
 * against a hardcoded list here — the seeded services are its business,
 * and a second copy of them in this file would drift the first time one
 * is added.
 */
function captureWindowsFirewallRules(device: WindowsPC): TopologyFirewallExport | null {
  const factory = new Map<string, NetFirewallRuleEntry>();
  seedBuiltInFirewallRules(factory);
  const rules: NetFirewallRuleEntry[] = [];
  for (const rule of device.firewallRules.values()) {
    const base = factory.get(firewallRuleKey(rule.name));
    if (!base || JSON.stringify(base) !== JSON.stringify(rule)) rules.push({ ...rule });
  }
  const removed = [...factory.values()]
    .filter(base => !device.firewallRules.has(firewallRuleKey(base.name)))
    .map(base => base.name);
  if (rules.length === 0 && removed.length === 0) return null;
  return { rules, removed };
}

function restoreWindowsFirewallRules(device: WindowsPC, exported: TopologyFirewallExport): void {
  for (const name of exported.removed) device.firewallRules.delete(firewallRuleKey(name));
  for (const rule of exported.rules) device.firewallRules.set(firewallRuleKey(rule.name), { ...rule });
}

function captureWindowsServices(device: WindowsPC): TopologyWindowsServiceExport[] {
  const base = new WindowsServiceManager();
  const out: TopologyWindowsServiceExport[] = [];

  for (const svc of device.getServiceManager().getAllServices()) {
    const factory = base.getService(svc.name);
    const entry: TopologyWindowsServiceExport = { name: svc.name };

    if (!factory) {
      entry.created = {
        binaryPath: svc.binaryPath,
        displayName: svc.displayName,
        description: svc.description,
        account: svc.account,
        dependencies: svc.dependencies,
      };
    } else {
      if (svc.displayName !== factory.displayName) entry.displayName = svc.displayName;
      if (svc.description !== factory.description) entry.description = svc.description;
      if (svc.account !== factory.account) entry.account = svc.account;
      if (svc.dependencies.join(' ') !== factory.dependencies.join(' ')) {
        entry.dependencies = svc.dependencies;
      }
    }
    // Start type and state are compared against the factory service for a
    // built-in and against what `sc create` itself produces for a new one.
    const factoryStartType = factory?.startType ?? 'Manual';
    const factoryState = factory?.state ?? 'Stopped';
    if (svc.startType !== factoryStartType) entry.startType = svc.startType;
    if (svc.state !== factoryState) entry.state = svc.state;

    if (Object.keys(entry).length > 1) out.push(entry);
  }
  return out;
}

function restoreWindowsServices(
  device: WindowsPC, services: TopologyWindowsServiceExport[],
): void {
  const mgr = device.getServiceManager();
  // The restore speaks as an administrator because the operator who made
  // these changes had to be one; the current user of the imported machine
  // is nobody's decision yet.
  const ADMIN = true;

  for (const entry of services) {
    if (entry.created && !mgr.getService(entry.name)) {
      mgr.createService(entry.name, {
        binaryPath: entry.created.binaryPath,
        displayName: entry.created.displayName,
        description: entry.created.description,
        account: entry.created.account,
        dependencies: entry.created.dependencies,
      }, ADMIN);
    }
    const svc = mgr.getService(entry.name);
    if (!svc) continue;

    if (entry.displayName !== undefined) mgr.setDisplayName(entry.name, entry.displayName, ADMIN);
    if (entry.description !== undefined) mgr.setDescription(entry.name, entry.description, ADMIN);
    if (entry.account !== undefined) {
      mgr.setAccount(entry.name, entry.account, ADMIN, 'NT AUTHORITY\\SYSTEM');
    }
    if (entry.dependencies !== undefined) mgr.setDependencies(entry.name, entry.dependencies, ADMIN);

    // State BEFORE start type, because the SCM refuses to start a
    // disabled service — and a service disabled while it was running is
    // a real, and deliberately reproducible, machine state.
    const target = entry.state ?? (entry.created ? 'Stopped' : svc.state);
    if (target === 'Running' && svc.state !== 'Running') mgr.startService(entry.name, ADMIN);
    if (target === 'Paused') {
      if (svc.state !== 'Running' && svc.state !== 'Paused') mgr.startService(entry.name, ADMIN);
      mgr.pauseService(entry.name, ADMIN);
    }
    if (target === 'Stopped' && svc.state !== 'Stopped') {
      mgr.stopServiceCascade(entry.name, ADMIN);
    }
    if (entry.startType !== undefined) mgr.setStartType(entry.name, entry.startType, ADMIN);
  }
}

/**
 * A rule set is worth saving only if it says something. `iptables-save`
 * on an untouched machine still prints its header, the `*filter` table
 * and the three default chains — writing that into every topology would
 * bury the one line a lab actually added.
 */
function meaningfulRuleSet(text: string): boolean {
  return text.split('\n').some((l) => l.startsWith('-A') || l.startsWith('-I'));
}

function captureIptables(device: LinuxMachine): { v4?: string; v6?: string } {
  const exec = (device as unknown as {
    executor: { iptables: { executeSave(): string }; ip6tables: { executeSave(): string } };
  }).executor;
  const out: { v4?: string; v6?: string } = {};
  const v4 = exec.iptables.executeSave();
  if (meaningfulRuleSet(v4)) out.v4 = v4;
  const v6 = exec.ip6tables.executeSave();
  if (meaningfulRuleSet(v6)) out.v6 = v6;
  return out;
}

/** The device's systemd manager, reached the way the shell reaches it. */
function serviceMgrOf(device: LinuxMachine): {
  list(): Array<{ name: string; enabled: string; state: string }>;
  enable(n: string): unknown; disable(n: string): unknown;
  mask(n: string): unknown; unmask(n: string): unknown;
  start(n: string): unknown; stop(n: string): unknown;
} {
  return (device as unknown as {
    executor: { serviceMgr: ReturnType<typeof serviceMgrOf> };
  }).executor.serviceMgr;
}

function captureLinuxBonds(device: LinuxMachine): TopologyLinuxBondExport[] {
  return [...device.getBonds().entries()].map(([name, bond]) => ({
    name,
    options: bondOptionLines(bond.options),
    slaves: [...bond.slaves],
  }));
}

function restoreLinuxBonds(device: LinuxMachine, bonds: TopologyLinuxBondExport[]): void {
  for (const bond of bonds) device.restoreBond(bond.name, bond.options, bond.slaves);
}

function captureWindowsTeams(device: WindowsPC): TopologyWindowsTeamExport[] {
  return [...device.getNicTeams().values()].map(team => ({
    name: team.name,
    teamingMode: team.teamingMode,
    loadBalancingAlgorithm: team.loadBalancingAlgorithm,
    lacpTimer: team.lacpTimer,
    members: team.members.map(m => ({ name: m.name, adminMode: m.adminMode })),
    teamNics: team.teamNics.map(n => ({ name: n.name, vlanId: n.vlanId, primary: n.primary })),
  }));
}

function restoreWindowsTeams(device: WindowsPC, teams: TopologyWindowsTeamExport[]): void {
  for (const team of teams) {
    const primaire = team.teamNics.find(n => n.primary) ?? team.teamNics[0];
    device.createNicTeam({
      name: team.name,
      members: team.members.map(m => ({
        name: m.name, adminMode: m.adminMode as 'Active' | 'Standby',
      })),
      teamNics: [{
        name: primaire?.name ?? team.name,
        vlanId: primaire?.vlanId ?? null,
        primary: true,
      }],
      teamingMode: team.teamingMode as 'LACP',
      loadBalancingAlgorithm: team.loadBalancingAlgorithm as 'Dynamic',
      lacpTimer: team.lacpTimer as 'Slow',
    });
    for (const nic of team.teamNics) {
      if (nic.primary || nic.vlanId === null) continue;
      device.addNicTeamNic(team.name, nic.vlanId, nic.name);
    }
  }
}

function captureLinuxServices(device: LinuxMachine): TopologyLinuxServiceExport[] {
  return serviceMgrOf(device).list().map((u) => ({
    name: u.name,
    enabled: u.enabled as TopologyLinuxServiceExport['enabled'],
    active: u.state === 'active',
  }));
}

function restoreLinuxServices(
  device: LinuxMachine, services: TopologyLinuxServiceExport[],
): void {
  const mgr = serviceMgrOf(device);
  const live = new Map(mgr.list().map((u) => [u.name, u]));

  for (const saved of services) {
    const unit = live.get(saved.name);
    if (!unit) continue; // a unit this build no longer ships — nothing to set

    // Enablement first: it is what the SCM would have consulted at boot,
    // and `mask` also blocks a start.
    if (unit.enabled !== saved.enabled) {
      if (saved.enabled === 'masked') mgr.mask(saved.name);
      else {
        if (unit.enabled === 'masked') mgr.unmask(saved.name);
        // `static` has no [Install] section — there is nothing to link or
        // unlink, so it is reported, never set.
        if (saved.enabled === 'enabled') mgr.enable(saved.name);
        else if (saved.enabled === 'disabled') mgr.disable(saved.name);
      }
    }

    const isActive = unit.state === 'active';
    if (saved.active && !isActive) mgr.start(saved.name);
    if (!saved.active && isActive) mgr.stop(saved.name);
  }
}

function restoreIptables(device: LinuxMachine, v4?: string, v6?: string): void {
  const exec = (device as unknown as {
    executor: {
      iptables: { executeRestore(t: string): unknown };
      ip6tables: { executeRestore(t: string): unknown };
    };
  }).executor;
  if (v4) exec.iptables.executeRestore(v4);
  if (v6) exec.ip6tables.executeRestore(v6);
}

/**
 * JSON has no Date, so a round-tripped account carries strings where the
 * model expects `Date` — and `passwordLastSet.getTime()` would throw the
 * first time a policy checked whether the password had expired.
 */
function reviveWindowsUsers(users: readonly WindowsUser[]): WindowsUser[] {
  return users.map((u) => ({
    ...u,
    passwordLastSet: new Date(u.passwordLastSet),
    lastLogon: u.lastLogon === null ? null : new Date(u.lastLogon),
    lockedUntil: u.lockedUntil === null ? null : new Date(u.lockedUntil),
  }));
}

function captureVlans(sw: Switch): TopologyVlanExport[] {
  const out: TopologyVlanExport[] = [];
  for (const v of sw.getVLANs().values()) {
    if (v.id === 1) continue;
    out.push({ id: v.id, name: v.name });
  }
  return out;
}

function captureSwitchports(sw: Switch): TopologySwitchportExport[] {
  const out: TopologySwitchportExport[] = [];
  for (const port of sw.getPorts()) {
    const cfg = sw.getSwitchportConfig(port.getName());
    if (!cfg) continue;
    const entry: TopologySwitchportExport = { name: port.getName() };
    if (cfg.mode !== 'access') entry.mode = cfg.mode;
    if (cfg.accessVlan !== 1) entry.accessVlan = cfg.accessVlan;
    if (cfg.trunkNativeVlan !== 1) entry.trunkNativeVlan = cfg.trunkNativeVlan;
    if (entry.mode === undefined && entry.accessVlan === undefined && entry.trunkNativeVlan === undefined) continue;
    out.push(entry);
  }
  return out;
}

/**
 * The live `Cable` a stored `Connection` describes.
 *
 * The store keeps connections as endpoint ids; the knobs an operator
 * turned (loss, corruption, latency, admin state) live on the Cable
 * object itself, reachable only through one of the two ports.
 */
function cableOf(
  deviceInstances: Map<string, Equipment>,
  c: Connection,
): Cable | null {
  const dev = deviceInstances.get(c.sourceDeviceId);
  return dev?.getPort(c.sourceInterfaceId)?.getCable() ?? null;
}

// ── Export ──

export function exportTopology(
  projectName: string,
  deviceInstances: Map<string, Equipment>,
  connections: Connection[],
): TopologyExport {
  const devices: TopologyDeviceExport[] = [];

  deviceInstances.forEach((device) => {
    const pos = device.getPosition();
    const ports = device.getPorts();

    const interfaces = ports.map(captureInterface);

    const entry: TopologyDeviceExport = {
      id: device.getId(),
      type: device.getType(),
      name: device.getName(),
      hostname: device.getHostname(),
      x: pos.x,
      y: pos.y,
      isPoweredOn: device.getIsPoweredOn(),
      interfaces,
    };

    if (device instanceof EndHost) {
      const gw = device.getDefaultGateway();
      if (gw) entry.defaultGateway = gw.toString();
      const arp = captureStaticArp(device);
      if (arp.length > 0) entry.staticArp = arp;
    }
    if (device instanceof EndHost || device instanceof Router) {
      const statics = device.getRoutingTable()
        .filter((r) => r.type === 'static' && r.nextHop);
      if (statics.length > 0) {
        entry.staticRoutes = statics.map((r) => ({
          network: r.network.toString(),
          mask: r.mask.toString(),
          nextHop: r.nextHop!.toString(),
          metric: r.metric,
        }));
      }
    }
    if (device instanceof LinuxMachine) {
      const files = captureLinuxFiles(device);
      if (files.length > 0) entry.files = files;
      const { v4, v6 } = captureIptables(device);
      if (v4) entry.iptablesRules = v4;
      if (v6) entry.ip6tablesRules = v6;
      const bonds = captureLinuxBonds(device);
      if (bonds.length > 0) entry.linuxBonds = bonds;
      const services = captureLinuxServices(device);
      if (services.length > 0) entry.linuxServices = services;
    }
    const oracle = captureOracleState(device.getId());
    if (oracle) entry.oracle = oracle;
    if (device instanceof WindowsPC) {
      const files = captureWindowsFiles(device);
      if (files.length > 0) entry.files = files;
      const mgr = device.getUserManager();
      entry.windowsAccounts = { users: mgr.getAllUsers(), groups: mgr.getAllGroups() };
      const registry = captureRegistry(device);
      if (registry) entry.registry = registry;
      const teams = captureWindowsTeams(device);
      if (teams.length > 0) entry.windowsTeams = teams;
      const services = captureWindowsServices(device);
      if (services.length > 0) entry.windowsServices = services;
      const firewall = captureWindowsFirewallRules(device);
      if (firewall) entry.windowsFirewallRules = firewall;
    }
    if (device instanceof Switch) {
      const vlans = captureVlans(device);
      if (vlans.length > 0) entry.vlans = vlans;
      const sp = captureSwitchports(device);
      if (sp.length > 0) entry.switchports = sp;
    }
    if (device instanceof Firewall) {
      const texte = device.getRunningConfig();
      if (texte) entry.runningConfigText = texte;
    }
    if (device instanceof Router || device instanceof Switch) {
      const runningConfigText = device.getRunningConfig();
      if (runningConfigText) entry.runningConfigText = runningConfigText;
      const startupConfigText = device instanceof Router
        ? device.getStartupConfigSnapshot()
        : device.getStartupConfig();
      if (startupConfigText) entry.startupConfigText = startupConfigText;
    }

    devices.push(entry);
  });

  const conns: TopologyConnectionExport[] = connections.map((c) => {
    const entry: TopologyConnectionExport = {
      sourceDeviceId: c.sourceDeviceId,
      sourceInterfaceId: c.sourceInterfaceId,
      targetDeviceId: c.targetDeviceId,
      targetInterfaceId: c.targetInterfaceId,
      type: c.type,
    };
    const cable = cableOf(deviceInstances, c);
    if (cable) {
      if (!cable.getIsUp()) entry.isUp = false;
      if (cable.getPacketLossRate() > 0) entry.packetLossRate = cable.getPacketLossRate();
      if (cable.getCorruptionRate() > 0) entry.corruptionRate = cable.getCorruptionRate();
      const delay = cable.getArtificialDelayMs();
      if (delay > 0) entry.artificialDelayMs = delay;
    }
    return entry;
  });

  return {
    version: 1,
    projectName,
    exportedAt: new Date().toISOString(),
    devices,
    connections: conns,
  };
}

// ── Import ──

export interface ImportResult {
  projectName: string;
  deviceInstances: Map<string, Equipment>;
  connections: Connection[];
}

function restoreLinuxFiles(device: LinuxMachine, files: TopologyFileExport[]): void {
  const vfs = (device as unknown as { executor: { vfs: { writeFile(p: string, c: string, uid: number, gid: number, umask: number): void } } }).executor.vfs;
  for (const f of files) {
    try { vfs.writeFile(f.path, f.content, 0, 0, 0o022); } catch { /* unwritable path — skip */ }
  }
}

function restoreSwitchVlans(sw: Switch, devData: TopologyDeviceExport): void {
  if (devData.vlans) {
    for (const v of devData.vlans) sw.createVLAN(v.id, v.name);
  }
  if (devData.switchports) {
    for (const sp of devData.switchports) {
      if (sp.mode === 'trunk') sw.setSwitchportMode(sp.name, 'trunk');
      if (sp.mode === 'access') sw.setSwitchportMode(sp.name, 'access');
      if (sp.accessVlan !== undefined) sw.setSwitchportAccessVlan(sp.name, sp.accessVlan);
    }
  }
}

/**
 * Re-apply a captured `show running-config`/`display current-configuration`
 * text by feeding it, line by line, through the device's own CLI — the same
 * thing a technician typing a paste-config would do. This is what makes
 * ACL/NAT/OSPF/BGP/VLAN trunk-allowed-lists/port-security/etc. survive a
 * topology export → import round-trip: every directive is parsed by the
 * real, already-comprehensive command trie instead of a bespoke re-parser
 * that would only ever understand a hand-picked subset (see
 * `Router._applyConfigText`, which is deliberately narrow — the CLI itself
 * has no such limit). Safe here specifically because this call is a
 * top-level entry point, not a re-entrant call from inside an in-flight
 * `shell.execute()` — unlike `reload`, there is no shared-shell-state
 * re-entrancy risk.
 */
export async function replayVendorConfig(device: Router | Switch, text: string): Promise<void> {
  const huawei = device.getOSType() === 'huawei-vrp';
  const wasOff = !device.getIsPoweredOn();
  if (wasOff) device.powerOn();

  const enterBase = huawei ? ['system-view'] : ['enable', 'configure terminal'];
  // Cisco's shell auto-bubbles a top-level directive typed from inside a
  // sub-mode (e.g. `access-list …` right after `interface X`'s block); the
  // Huawei shell does not, and dispatches it against the wrong view instead
  // of erroring — so between an indented block and the next top-level line,
  // explicitly return to (and re-enter) the base config view for both
  // vendors. For Cisco this is a harmless no-op re-affirmation of a
  // transition the shell already made on its own.
  const toBase = huawei ? ['return', 'system-view'] : ['end', 'configure terminal'];

  for (const line of enterBase) await device.executeCommand(line);
  let isBase = true;

  let wasIndented = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('Building configuration') || line.startsWith('Current configuration')) continue;
    if (line === '!' || line === '#') {
      if (!isBase) { for (const l of toBase) await device.executeCommand(l); isBase = true; }
      wasIndented = false;
      continue;
    }
    const indented = /^\s/.test(raw);
    if (!indented && wasIndented && !isBase) {
      for (const l of toBase) await device.executeCommand(l);
      isBase = true;
    }
    await device.executeCommand(line);
    if (!indented) isBase = false;
    wasIndented = indented;
  }
  for (const line of huawei ? ['return'] : ['end']) {
    await device.executeCommand(line);
  }

  if (wasOff) device.powerOff();
}

export async function importTopology(json: TopologyExport): Promise<ImportResult> {
  if (!json || json.version !== 1) {
    throw new Error('Invalid topology file: unsupported version or format');
  }

  resetDeviceCounters();
  resetCounters();
  Logger.reset();

  for (const devData of json.devices) {
    reserveDeviceName(devData.name);
    for (const ifConfig of devData.interfaces) {
      if (!ifConfig.mac) continue;
      try { MACAddress.reserve(new MACAddress(ifConfig.mac)); } catch { /* malformed address in file */ }
    }
  }

  const idMap = new Map<string, Equipment>();
  const deviceInstances = new Map<string, Equipment>();

  for (const devData of json.devices) {
    const device = createDevice(devData.type, devData.x, devData.y, devData.name);
    device.setName(devData.name);
    device.setHostname(devData.hostname);

    if (devData.isPoweredOn) {
      device.powerOn();
    } else {
      device.powerOff();
    }

    // Before anything is cabled: the burned-in addresses. A switch that
    // sees a frame the moment a link comes up would otherwise learn the
    // generator's fresh address rather than the saved one.
    for (const ifConfig of devData.interfaces) {
      if (!ifConfig.mac) continue;
      const port = device.getPort(ifConfig.name);
      if (!port) continue;
      try {
        port.setMAC(new MACAddress(ifConfig.mac));
      } catch { /* malformed address in file — keep the generated one */ }
    }

    if (device instanceof Switch) {
      restoreSwitchVlans(device, devData);
    }

    idMap.set(devData.id, device);
    deviceInstances.set(device.getId(), device);
  }

  const connections: Connection[] = [];

  for (const connData of json.connections) {
    const sourceDevice = idMap.get(connData.sourceDeviceId);
    const targetDevice = idMap.get(connData.targetDeviceId);
    if (!sourceDevice || !targetDevice) continue;

    const connection = buildConnection(
      sourceDevice, connData.sourceInterfaceId,
      targetDevice, connData.targetInterfaceId,
      connData.type,
    );
    if (connection) {
      connections.push(connection);
      const cable = sourceDevice.getPort(connData.sourceInterfaceId)?.getCable();
      if (cable) {
        if (connData.packetLossRate !== undefined) cable.setPacketLossRate(connData.packetLossRate);
        if (connData.corruptionRate !== undefined) cable.setCorruptionRate(connData.corruptionRate);
        if (connData.artificialDelayMs !== undefined) {
          cable.setArtificialDelayMs(connData.artificialDelayMs);
        }
        // Last: pulling the cable down is what the other knobs are read
        // through, and setting it first would fight the link-up the
        // connection just produced.
        if (connData.isUp === false) cable.setUp(false);
      }
    }
  }

  for (const devData of json.devices) {
    const device = idMap.get(devData.id);
    if (!device) continue;

    for (const ifConfig of devData.interfaces) {
      const port = device.getPort(ifConfig.name);
      if (!port) continue;

      if (ifConfig.ipAddress && ifConfig.subnetMask) {
        const ip = new IPAddress(ifConfig.ipAddress);
        const mask = new SubnetMask(ifConfig.subnetMask);
        if (device instanceof EndHost || device instanceof Router) {
          device.configureInterface(ifConfig.name, ip, mask);
        } else {
          port.configureIP(ip, mask);
        }
      }
      if (ifConfig.description !== undefined) {
        port.setDescriptionText(ifConfig.description);
      }
      if (ifConfig.secondaryIPs && device instanceof Router) {
        for (const sec of ifConfig.secondaryIPs) {
          try {
            device.configureInterface(
              ifConfig.name,
              new IPAddress(sec.ipAddress),
              new SubnetMask(sec.subnetMask),
              true,
            );
          } catch { /* malformed secondary — skip */ }
        }
      }
      // Physical layer before the admin state, for the same reason as the
      // cable: `setUp(false)` is the last word on the port.
      if (ifConfig.mtu !== undefined) port.setMTU(ifConfig.mtu);
      if (ifConfig.speed !== undefined) port.setSpeed(ifConfig.speed);
      if (ifConfig.duplex !== undefined) port.setDuplex(ifConfig.duplex);
      if (ifConfig.autoNegotiation !== undefined) {
        port.setNegotiationAuto(ifConfig.autoNegotiation);
        port.setAutoNegotiation(ifConfig.autoNegotiation);
      }
      if (ifConfig.bandwidthKbps !== undefined) port.setBandwidthKbps(ifConfig.bandwidthKbps);
      if (ifConfig.delayUs !== undefined) port.setDelayUs(ifConfig.delayUs);
      if (ifConfig.isUp === false) port.setUp(false);
    }

    if (devData.defaultGateway && device instanceof EndHost) {
      try {
        device.setDefaultGateway(new IPAddress(devData.defaultGateway));
      } catch { /* malformed address in file — skip */ }
    }
    // Static/default routes are also carried in `runningConfigText` (`ip
    // route`/`ip route-static`) — replaying both would duplicate entries in
    // the routing table, so the CLI replay below owns them for Router when
    // present.
    const routesHandledByReplay = device instanceof Router && !!devData.runningConfigText;
    if (devData.staticRoutes && (device instanceof EndHost || device instanceof Router) && !routesHandledByReplay) {
      for (const route of devData.staticRoutes) {
        try {
          device.addStaticRoute(
            new IPAddress(route.network),
            new SubnetMask(route.mask),
            new IPAddress(route.nextHop),
            route.metric,
          );
        } catch { /* malformed route in file — skip */ }
      }
    }
    if (devData.staticArp && device instanceof EndHost) {
      for (const arp of devData.staticArp) {
        try {
          device.addStaticARP(
            new IPAddress(arp.ip),
            new MACAddress(arp.mac),
            arp.iface,
          );
        } catch { /* malformed entry — skip */ }
      }
    }
    if (device instanceof LinuxMachine) {
      if (devData.files) restoreLinuxFiles(device, devData.files);
      restoreIptables(device, devData.iptablesRules, devData.ip6tablesRules);
      // After the files, because a unit file the lab wrote has to exist
      // before the manager can be asked to enable or start it.
      if (devData.linuxServices) restoreLinuxServices(device, devData.linuxServices);
      if (devData.linuxBonds) restoreLinuxBonds(device, devData.linuxBonds);
    }
    if (devData.oracle) restoreOracleState(device.getId(), devData.oracle);
    if (device instanceof WindowsPC) {
      if (devData.files) restoreWindowsFiles(device, devData.files);
      if (devData.windowsAccounts) {
        device.getUserManager().restoreAccounts(
          reviveWindowsUsers(devData.windowsAccounts.users),
          devData.windowsAccounts.groups,
        );
      }
      // Services first, registry second: `HKLM:\SYSTEM\CurrentControlSet\
      // Services\<name>` is a projection of the service table, written by
      // the device itself, so restoring a service rewrites part of the
      // hive. Replaying the captured registry afterwards means the machine
      // ends up showing exactly what was saved, projection included.
      if (devData.windowsServices) restoreWindowsServices(device, devData.windowsServices);
      if (devData.windowsFirewallRules) {
        restoreWindowsFirewallRules(device, devData.windowsFirewallRules);
      }
      if (devData.registry) restoreRegistry(device, devData.registry);
      if (devData.windowsTeams) restoreWindowsTeams(device, devData.windowsTeams);
    }
    if (device instanceof Firewall && devData.runningConfigText) {
      await device.replayConfig(devData.runningConfigText);
    }
    if ((device instanceof Router || device instanceof Switch) && devData.runningConfigText) {
      await replayVendorConfig(device, devData.runningConfigText);
      if (devData.startupConfigText) device._captureStartupConfig(devData.startupConfigText);
    }
  }

  return {
    projectName: json.projectName,
    deviceInstances,
    connections,
  };
}

// ── File helpers ──

export function downloadTopologyJSON(topology: TopologyExport): void {
  const json = JSON.stringify(topology, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = `${topology.projectName.replace(/[^a-zA-Z0-9_-]/g, '_')}.topology.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function openTopologyFile(): Promise<TopologyExport> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,.topology.json';

    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) {
        reject(new Error('No file selected'));
        return;
      }

      const reader = new FileReader();
      reader.onload = () => {
        try {
          const data = JSON.parse(reader.result as string);
          resolve(data);
        } catch {
          reject(new Error('Invalid JSON file'));
        }
      };
      reader.onerror = () => reject(new Error('Failed to read file'));
      reader.readAsText(file);
    };

    input.click();
  });
}
