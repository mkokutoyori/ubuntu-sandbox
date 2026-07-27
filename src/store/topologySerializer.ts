/**
 * Topology Serializer - JSON export/import for network topologies
 *
 * Captures the real configurable state of every device so that an
 * exported topology round-trips to the same simulator state on
 * import. The set is widened as new state surfaces become important:
 *
 *   - Per-interface: IP/mask, admin up/down, description, secondary IPs
 *   - Per-host:      default gateway, static routes, static ARP entries,
 *                    every Linux file that differs from a fresh boot
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
  createDevice, resetDeviceCounters,
  generateId, resetCounters,
  Logger,
  EndHost, Router,
  Switch,
  type SwitchportMode,
} from '@/network';
import { LinuxMachine } from '@/network/devices/LinuxMachine';
import { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
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
  ipAddress?: string;
  subnetMask?: string;
  isUp?: boolean;
  description?: string;
  secondaryIPs?: TopologySecondaryIpExport[];
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

function captureInterface(port: Port): TopologyInterfaceExport {
  const entry: TopologyInterfaceExport = { name: port.getName() };
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
    }
    if (device instanceof Switch) {
      const vlans = captureVlans(device);
      if (vlans.length > 0) entry.vlans = vlans;
      const sp = captureSwitchports(device);
      if (sp.length > 0) entry.switchports = sp;
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

  const conns: TopologyConnectionExport[] = connections.map((c) => ({
    sourceDeviceId: c.sourceDeviceId,
    sourceInterfaceId: c.sourceInterfaceId,
    targetDeviceId: c.targetDeviceId,
    targetInterfaceId: c.targetInterfaceId,
    type: c.type,
  }));

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
async function replayVendorConfig(device: Router | Switch, text: string): Promise<void> {
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

  let wasIndented = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('Building configuration') || line.startsWith('Current configuration')) continue;
    const indented = /^\s/.test(raw);
    if (!indented && wasIndented) {
      for (const l of toBase) await device.executeCommand(l);
    }
    await device.executeCommand(line);
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

  const idMap = new Map<string, Equipment>();
  const deviceInstances = new Map<string, Equipment>();

  for (const devData of json.devices) {
    const device = createDevice(devData.type, devData.x, devData.y);
    device.setName(devData.name);
    device.setHostname(devData.hostname);

    if (devData.isPoweredOn) {
      device.powerOn();
    } else {
      device.powerOff();
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
    if (connection) connections.push(connection);
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
    if (devData.files && device instanceof LinuxMachine) {
      restoreLinuxFiles(device, devData.files);
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
