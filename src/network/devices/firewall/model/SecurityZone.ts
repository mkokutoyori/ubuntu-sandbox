export type ZoneType =
  | 'layer3'
  | 'layer2'
  | 'virtual-wire'
  | 'tap'
  | 'external'
  | 'tunnel';

export type IntraZoneAction = 'allow' | 'deny';

export interface SecurityZone {
  readonly name: string;
  readonly interfaces: readonly string[];
  readonly type: ZoneType;
  readonly intraZoneAction: IntraZoneAction;
  readonly securityLevel?: number;
  readonly predefined: boolean;
  readonly comment?: string;
}

export interface ZoneOptions {
  type?: ZoneType;
  intraZoneAction?: IntraZoneAction;
  securityLevel?: number;
  predefined?: boolean;
  comment?: string;
}

export type ZoneError =
  | { kind: 'duplicate-name'; zone: string }
  | { kind: 'unknown-zone'; zone: string }
  | { kind: 'interface-already-in-zone'; iface: string; zone: string }
  | { kind: 'zone-referenced'; zone: string; referents: readonly string[] }
  | { kind: 'incompatible-interface-mode'; iface: string; mode: string; zoneType: ZoneType }
  | { kind: 'predefined-zone'; zone: string };

export type ZoneMutation = { ok: true } | { ok: false; error: ZoneError };

export const ZONE_OK: ZoneMutation = Object.freeze({ ok: true as const });

export function zoneFailure(error: ZoneError): ZoneMutation {
  return Object.freeze({ ok: false as const, error: Object.freeze(error) });
}

const ZONE_TYPE_ACCEPTS_MODE: Readonly<Record<ZoneType, readonly string[]>> = {
  layer3: ['layer3'],
  layer2: ['layer2'],
  'virtual-wire': ['virtual-wire'],
  tap: ['tap'],
  external: ['layer3'],
  tunnel: ['layer3', 'tunnel'],
};

export function zoneTypeAcceptsMode(zoneType: ZoneType, mode: string): boolean {
  return ZONE_TYPE_ACCEPTS_MODE[zoneType].includes(mode);
}
