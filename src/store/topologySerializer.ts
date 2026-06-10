/**
 * Topology Serializer - JSON export/import for network topologies
 *
 * Export format includes:
 *   - Project metadata (name, version)
 *   - Devices: type, name, hostname, position, power state, interface IP configs
 *   - Connections: source/target device+interface, type
 */

import {
  Equipment, Cable, Port,
  IPAddress, SubnetMask,
  DeviceType, ConnectionType,
  createDevice, resetDeviceCounters,
  generateId, resetCounters,
  Logger,
  EndHost, Router,
} from '@/network';
import type { Connection } from './networkStore';

// ── Export schema ──

/** A static route as configured by the user (`ip route add`, `ip route`). */
interface TopologyRouteExport {
  network: string;
  mask: string;
  nextHop: string;
  metric?: number;
}

interface TopologyDeviceExport {
  id: string;
  type: DeviceType;
  name: string;
  hostname: string;
  x: number;
  y: number;
  isPoweredOn: boolean;
  interfaces: {
    name: string;
    ipAddress?: string;
    subnetMask?: string;
  }[];
  /** End-host default gateway (PCs/servers). Optional for backward compat. */
  defaultGateway?: string;
  /** User-configured static routes (hosts and routers). */
  staticRoutes?: TopologyRouteExport[];
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

    const interfaces = ports.map((port: Port) => {
      const entry: TopologyDeviceExport['interfaces'][0] = {
        name: port.getName(),
      };
      const ip = port.getIPAddress();
      const mask = port.getSubnetMask();
      if (ip) entry.ipAddress = ip.toString();
      if (mask) entry.subnetMask = mask.toString();
      return entry;
    });

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

    // Network configuration that lives outside the ports: default gateway
    // and user-configured static routes. Losing them made every save/load
    // round-trip break host connectivity.
    if (device instanceof EndHost) {
      const gw = device.getDefaultGateway();
      if (gw) entry.defaultGateway = gw.toString();
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

export function importTopology(json: TopologyExport): ImportResult {
  if (!json || json.version !== 1) {
    throw new Error('Invalid topology file: unsupported version or format');
  }

  // Reset counters for fresh ID generation
  resetDeviceCounters();
  resetCounters();
  Logger.reset();

  // Map old IDs to new devices
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

    // Configure interface IPs
    for (const ifConfig of devData.interfaces) {
      if (ifConfig.ipAddress && ifConfig.subnetMask) {
        const port = device.getPort(ifConfig.name);
        if (port) {
          port.configureIP(
            new IPAddress(ifConfig.ipAddress),
            new SubnetMask(ifConfig.subnetMask),
          );
        }
      }
    }

    // Restore L3 configuration after the interfaces are addressed —
    // addStaticRoute() verifies next-hop reachability against port subnets.
    if (devData.defaultGateway && device instanceof EndHost) {
      try {
        device.setDefaultGateway(new IPAddress(devData.defaultGateway));
      } catch { /* malformed address in file — skip */ }
    }
    if (devData.staticRoutes && (device instanceof EndHost || device instanceof Router)) {
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

    idMap.set(devData.id, device);
    deviceInstances.set(device.getId(), device);
  }

  // Recreate connections
  const connections: Connection[] = [];

  for (const connData of json.connections) {
    const sourceDevice = idMap.get(connData.sourceDeviceId);
    const targetDevice = idMap.get(connData.targetDeviceId);
    if (!sourceDevice || !targetDevice) continue;

    const sourcePort = sourceDevice.getPort(connData.sourceInterfaceId);
    const targetPort = targetDevice.getPort(connData.targetInterfaceId);
    if (!sourcePort || !targetPort) continue;

    const connId = generateId();
    const cable = new Cable(connId);
    cable.connect(sourcePort, targetPort);

    connections.push({
      id: connId,
      type: connData.type,
      sourceDeviceId: sourceDevice.getId(),
      sourceInterfaceId: connData.sourceInterfaceId,
      targetDeviceId: targetDevice.getId(),
      targetInterfaceId: connData.targetInterfaceId,
      isActive: true,
      cable,
    });
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
