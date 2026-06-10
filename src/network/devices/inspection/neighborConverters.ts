/**
 * Neighbor-table DTO converters shared by every vendor device.
 *
 * CDP/LLDP agents expose protocol-shaped rows; the inspection layer
 * (DeviceStateView, properties panel, `show cdp/lldp neighbors`) consumes a
 * vendor-neutral NeighborDTO. These converters were previously copy-pasted
 * at module scope in CiscoRouter, HuaweiRouter, CiscoSwitch and
 * HuaweiSwitch — any NeighborDTO schema change had to be applied in up to
 * six places.
 */
import type { CdpNeighbor } from '../../cdp/CdpAgent';
import type { LldpNeighbor } from '../../lldp/LldpAgent';
import type { NeighborDTO } from './DeviceStateView';

export function cdpToNeighborDTO(rows: readonly CdpNeighbor[]): NeighborDTO[] {
  return rows.map(n => ({
    localPort: n.localPort,
    remoteHost: n.remoteHost,
    remotePort: n.remotePort,
    remoteType: n.remoteType,
    remotePlatform: n.remotePlatform,
    remoteCapability: n.remoteCapability,
  }));
}

export function lldpToNeighborDTO(rows: readonly LldpNeighbor[]): NeighborDTO[] {
  return rows.map(n => ({
    localPort: n.localPort,
    remoteHost: n.systemName,
    remotePort: n.portId,
    remoteType: n.remoteType,
    // LLDP advertises a full system description ("Cisco IOS, Version …");
    // the DTO keeps only the platform part before the first comma.
    remotePlatform: n.systemDescription.split(',')[0] ?? n.systemDescription,
    remoteCapability: n.remoteCapabilities[0] === 'Router' ? 'Router'
      : n.remoteCapabilities[0] === 'Bridge' ? 'Switch' : 'Host',
  }));
}
