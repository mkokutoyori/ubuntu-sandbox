import {
  ZONE_OK,
  zoneFailure,
  zoneTypeAcceptsMode,
  type IntraZoneAction,
  type SecurityZone,
  type ZoneMutation,
  type ZoneOptions,
  type ZoneType,
} from './SecurityZone';

export type ZoneReferenceChecker = (zoneName: string) => readonly string[];
export type InterfaceModeLookup = (ifaceName: string) => string | undefined;

export interface ZoneTableDeps {
  referenceChecker?: ZoneReferenceChecker;
  interfaceModeOf?: InterfaceModeLookup;
  defaultIntraZoneAction?: IntraZoneAction;
}

interface ZoneRecord {
  name: string;
  interfaces: string[];
  type: ZoneType;
  intraZoneAction: IntraZoneAction;
  securityLevel?: number;
  predefined: boolean;
  comment?: string;
}

export class ZoneTable {
  private readonly zones = new Map<string, ZoneRecord>();
  private readonly interfaceOwner = new Map<string, string>();
  private readonly deps: ZoneTableDeps;

  constructor(deps: ZoneTableDeps = {}) {
    this.deps = deps;
  }

  createZone(name: string, options: ZoneOptions = {}): ZoneMutation {
    if (this.zones.has(name)) return zoneFailure({ kind: 'duplicate-name', zone: name });

    this.zones.set(name, {
      name,
      interfaces: [],
      type: options.type ?? 'layer3',
      intraZoneAction: options.intraZoneAction ?? this.deps.defaultIntraZoneAction ?? 'deny',
      securityLevel: options.securityLevel,
      predefined: options.predefined ?? false,
      comment: options.comment,
    });
    return ZONE_OK;
  }

  deleteZone(name: string): ZoneMutation {
    const zone = this.zones.get(name);
    if (!zone) return zoneFailure({ kind: 'unknown-zone', zone: name });
    if (zone.predefined) return zoneFailure({ kind: 'predefined-zone', zone: name });

    const referents = this.deps.referenceChecker?.(name) ?? [];
    if (referents.length > 0) return zoneFailure({ kind: 'zone-referenced', zone: name, referents });

    for (const iface of zone.interfaces) this.interfaceOwner.delete(iface);
    this.zones.delete(name);
    return ZONE_OK;
  }

  assignInterface(zoneName: string, ifaceName: string): ZoneMutation {
    const zone = this.zones.get(zoneName);
    if (!zone) return zoneFailure({ kind: 'unknown-zone', zone: zoneName });

    const currentOwner = this.interfaceOwner.get(ifaceName);
    if (currentOwner === zoneName) return ZONE_OK;
    if (currentOwner !== undefined) {
      return zoneFailure({ kind: 'interface-already-in-zone', iface: ifaceName, zone: currentOwner });
    }

    const mode = this.deps.interfaceModeOf?.(ifaceName);
    if (mode !== undefined && !zoneTypeAcceptsMode(zone.type, mode)) {
      return zoneFailure({
        kind: 'incompatible-interface-mode', iface: ifaceName, mode, zoneType: zone.type,
      });
    }

    zone.interfaces.push(ifaceName);
    this.interfaceOwner.set(ifaceName, zoneName);
    return ZONE_OK;
  }

  removeInterface(ifaceName: string): ZoneMutation {
    const owner = this.interfaceOwner.get(ifaceName);
    if (owner === undefined) return zoneFailure({ kind: 'unknown-zone', zone: ifaceName });

    const zone = this.zones.get(owner);
    if (zone) zone.interfaces = zone.interfaces.filter(name => name !== ifaceName);
    this.interfaceOwner.delete(ifaceName);
    return ZONE_OK;
  }

  setIntraZoneAction(zoneName: string, action: IntraZoneAction): ZoneMutation {
    const zone = this.zones.get(zoneName);
    if (!zone) return zoneFailure({ kind: 'unknown-zone', zone: zoneName });

    zone.intraZoneAction = action;
    return ZONE_OK;
  }

  setSecurityLevel(zoneName: string, level: number): ZoneMutation {
    const zone = this.zones.get(zoneName);
    if (!zone) return zoneFailure({ kind: 'unknown-zone', zone: zoneName });

    zone.securityLevel = level;
    return ZONE_OK;
  }

  getZone(name: string): SecurityZone | undefined {
    const zone = this.zones.get(name);
    return zone ? freezeZone(zone) : undefined;
  }

  zoneOf(ifaceName: string): string | undefined {
    return this.interfaceOwner.get(ifaceName);
  }

  interfacesOf(zoneName: string): readonly string[] {
    return Object.freeze([...(this.zones.get(zoneName)?.interfaces ?? [])]);
  }

  list(): readonly SecurityZone[] {
    return Object.freeze([...this.zones.values()].map(freezeZone));
  }

  has(name: string): boolean {
    return this.zones.has(name);
  }

  size(): number {
    return this.zones.size;
  }
}

function freezeZone(zone: ZoneRecord): SecurityZone {
  return Object.freeze({
    name: zone.name,
    interfaces: Object.freeze([...zone.interfaces]),
    type: zone.type,
    intraZoneAction: zone.intraZoneAction,
    securityLevel: zone.securityLevel,
    predefined: zone.predefined,
    comment: zone.comment,
  });
}
