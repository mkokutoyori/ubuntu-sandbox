import { isValidIPv4 } from '../../../core/ip';

export const VRF_NAME_MAX = 32;

export type VrfSpelling = 'modern' | 'legacy';

export interface VrfInstance {
  name: string;
  spelling: VrfSpelling;
  rd?: string;
  rts: { import: string[]; export: string[] };
  interfaces: Set<string>;
}

export type VrfStore = Map<string, VrfInstance>;

export interface VrfHost {
  _vrfs?: VrfStore;
}

export function vrfStoreOf(host: VrfHost): VrfStore {
  return host._vrfs ??= new Map();
}

export function isVrfName(name: string | undefined): name is string {
  return name !== undefined && name.length > 0 && name.length <= VRF_NAME_MAX;
}

export function ensureVrf(
  store: VrfStore, name: string, spelling: VrfSpelling,
): VrfInstance {
  const existing = store.get(name);
  if (existing) return existing;
  const created: VrfInstance = {
    name, spelling, rts: { import: [], export: [] }, interfaces: new Set(),
  };
  store.set(name, created);
  return created;
}

/**
 * Un RD et une RT s'ecrivent pareil — `ASN:nn` ou `A.B.C.D:nn` — et
 * c'est la meme fonction qui les lit.
 */
export function parseRouteDistinguisher(token: string | undefined): string | null {
  if (token === undefined) return null;
  const coupe = token.lastIndexOf(':');
  if (coupe <= 0) return null;
  const gauche = token.slice(0, coupe);
  const droite = token.slice(coupe + 1);
  if (!/^\d+$/.test(droite)) return null;
  const suffixe = Number(droite);
  if (!Number.isSafeInteger(suffixe) || suffixe > 4294967295) return null;

  if (isValidIPv4(gauche)) return token;
  if (!/^\d+$/.test(gauche)) return null;
  const asn = Number(gauche);
  if (!Number.isSafeInteger(asn) || asn > 4294967295) return null;
  return token;
}

export type RouteTargetDirection = 'import' | 'export' | 'both';

export interface RouteTargetParse {
  readonly direction?: RouteTargetDirection;
  readonly value?: string;
  readonly refus?: string;
  readonly incomplet?: boolean;
}

export function parseRouteTarget(args: readonly string[]): RouteTargetParse {
  const direction = args[0];
  if (direction === undefined) return { incomplet: true };
  if (direction !== 'import' && direction !== 'export' && direction !== 'both') {
    return { refus: direction };
  }
  if (args[1] === undefined) return { incomplet: true };
  const value = parseRouteDistinguisher(args[1]);
  if (value === null) return { refus: args[1] };
  return { direction, value };
}

export function applyRouteTarget(
  vrf: VrfInstance, direction: RouteTargetDirection, value: string,
): void {
  const sens: ReadonlyArray<'import' | 'export'> =
    direction === 'both' ? ['import', 'export'] : [direction];
  for (const s of sens) {
    if (!vrf.rts[s].includes(value)) vrf.rts[s].push(value);
  }
}

export function vrfRunningConfigLines(store: VrfStore | undefined): string[] {
  if (!store || store.size === 0) return [];
  const lines: string[] = [];
  for (const vrf of store.values()) {
    lines.push(vrf.spelling === 'modern'
      ? `vrf definition ${vrf.name}`
      : `ip vrf ${vrf.name}`);
    if (vrf.rd) lines.push(` rd ${vrf.rd}`);
    for (const value of vrf.rts.export) lines.push(` route-target export ${value}`);
    for (const value of vrf.rts.import) lines.push(` route-target import ${value}`);
  }
  return lines;
}
