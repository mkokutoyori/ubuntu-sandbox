/**
 * EquipmentStateView — concrete DeviceStateView reading the REAL
 * Equipment / Port / Cable topology graph. Single source of truth for
 * inspection collection logic (DRY across vendors & commands).
 *
 * See docs/DESIGN-DEVICE-STATE-INSPECTION.md (Lot A).
 */
import { Equipment } from '@/network/equipment/Equipment';
import type { Port } from '@/network/hardware/Port';
import type { DeviceType } from '@/network/core/types';
import type {
  DeviceStateView, DeviceIdentityDTO, InterfaceStateDTO, NeighborDTO,
} from './DeviceStateView';

/** Minimal real-device surface this view reads from. */
export interface InspectableDevice {
  getHostname(): string;
  getType(): DeviceType;
  getPorts(): Port[];
  getInterfaceDescription?(portName: string): string | undefined;
}

function platformOf(type: DeviceType): string {
  switch (type) {
    case 'router-cisco': return 'Cisco 2911';
    case 'switch-cisco': return 'Cisco Catalyst 2960';
    case 'router-huawei': return 'Huawei AR2220';
    case 'switch-huawei': return 'Huawei S5720';
    case 'linux-pc': case 'linux-server': return 'Linux Host';
    case 'windows-pc': case 'windows-server': return 'Windows Host';
    default: return type;
  }
}

function capabilityOf(type: DeviceType): 'Router' | 'Switch' | 'Host' {
  if (type.startsWith('router')) return 'Router';
  if (type.startsWith('switch')) return 'Switch';
  return 'Host';
}

/** Resolve the real peer (device + port) cabled to a local port. */
function peerOf(port: Port): { dev: InspectableDevice; portName: string } | null {
  const cable = port.getCable();
  if (!cable) return null;
  const a = cable.getPortA();
  const b = cable.getPortB();
  const peerPort = a === port ? b : a;
  if (!peerPort) return null;
  const dev = Equipment.getById(peerPort.getEquipmentId());
  if (!dev) return null;
  return { dev: dev as unknown as InspectableDevice, portName: peerPort.getName() };
}

export class EquipmentStateView implements DeviceStateView {
  constructor(private readonly dev: InspectableDevice) {}

  identity(): DeviceIdentityDTO {
    const type = this.dev.getType();
    return {
      hostname: this.dev.getHostname(),
      type,
      platform: platformOf(type),
      capability: capabilityOf(type),
    };
  }

  interfaces(): InterfaceStateDTO[] {
    return this.dev.getPorts().map((p) => {
      const ip = p.getIPAddress();
      const mask = p.getSubnetMask();
      const adminUp = p.getIsUp();
      return {
        name: p.getName(),
        adminUp,
        connected: p.isConnected(),
        lineProtocolUp: adminUp && p.isConnected(),
        ip: ip ? String(ip) : null,
        prefixLength: mask ? mask.toCIDR() : null,
        mac: String(p.getMAC()),
        speedKbps: p.getSpeed(),
        duplex: String(p.getDuplex()),
        description: this.dev.getInterfaceDescription?.(p.getName()) || undefined,
      };
    });
  }

  neighbors(): NeighborDTO[] {
    const out: NeighborDTO[] = [];
    for (const port of this.dev.getPorts()) {
      const peer = peerOf(port);
      if (!peer) continue;
      const rType = peer.dev.getType();
      out.push({
        localPort: port.getName(),
        remoteHost: peer.dev.getHostname(),
        remotePort: peer.portName,
        remoteType: rType,
        remotePlatform: platformOf(rType),
        remoteCapability: capabilityOf(rType),
      });
    }
    return out;
  }
}
