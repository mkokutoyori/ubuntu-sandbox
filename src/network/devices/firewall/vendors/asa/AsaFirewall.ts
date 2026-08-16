import type { DeviceType } from '../../../../core/types';
import { Firewall, type FirewallOptions } from '../../Firewall';
import { ASA_PROFILE } from './AsaProfile';

export class AsaFirewall extends Firewall {
  private readonly accessGroups = new Map<string, string>();

  constructor(
    deviceType: DeviceType = 'firewall-cisco', name = 'ASA', x = 0, y = 0,
    options: Omit<FirewallOptions, 'profile'> = {},
  ) {
    super(deviceType, name, x, y, { ...options, profile: ASA_PROFILE });
  }

  nameif(iface: string, zoneName: string, securityLevel: number): void {
    const zones = this.getZoneTable();
    const previous = zones.zoneOf(iface);
    if (previous !== undefined) zones.removeInterface(iface);

    if (!zones.has(zoneName)) zones.createZone(zoneName, { securityLevel });
    zones.assignInterface(zoneName, iface);
  }

  securityLevelOf(iface: string): number | undefined {
    const zone = this.getZoneTable().zoneOf(iface);
    return zone === undefined ? undefined : this.getZoneTable().getZone(zone)?.securityLevel;
  }

  accessGroup(aclName: string, iface: string): void {
    this.accessGroups.set(iface, aclName);
    this.bindPolicyToInterface(iface);
  }

  removeAccessGroup(iface: string): void {
    this.accessGroups.delete(iface);
    this.unbindPolicyFromInterface(iface);
  }

  accessGroupOn(iface: string): string | undefined {
    return this.accessGroups.get(iface);
  }

  getOSType(): string {
    return 'asa';
  }
}
