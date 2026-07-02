export const DSCP = {
  CS0: 0, CS1: 8, CS2: 16, CS3: 24, CS4: 32, CS5: 40, CS6: 48, CS7: 56,
  AF11: 10, AF12: 12, AF13: 14,
  AF21: 18, AF22: 20, AF23: 22,
  AF31: 26, AF32: 28, AF33: 30,
  AF41: 34, AF42: 36, AF43: 38,
  EF: 46,
} as const;

export type DscpMode = 'copy' | 'set' | 'map';

export interface DscpTunnelConfig {
  readonly dscpMode: DscpMode;
  readonly dscpValue: number;
  readonly dscpMap: ReadonlyMap<number, number>;
  readonly ecnEnabled: boolean;
}

export function makeCopyConfig(): DscpTunnelConfig {
  return { dscpMode: 'copy', dscpValue: 0, dscpMap: new Map(), ecnEnabled: true };
}

export function makeSetConfig(dscpValue: number): DscpTunnelConfig {
  if (dscpValue < 0 || dscpValue > 63) {
    throw new Error(`DSCP value out of range: ${dscpValue}`);
  }
  return { dscpMode: 'set', dscpValue, dscpMap: new Map(), ecnEnabled: true };
}

export function makeMapConfig(mapping: ReadonlyMap<number, number>): DscpTunnelConfig {
  for (const [k, v] of mapping) {
    if (k < 0 || k > 63) throw new Error(`DSCP key out of range: ${k}`);
    if (v < 0 || v > 63) throw new Error(`DSCP mapped value out of range: ${v}`);
  }
  return { dscpMode: 'map', dscpValue: 0, dscpMap: mapping, ecnEnabled: true };
}

export function dscpOf(tos: number): number {
  return (tos >> 2) & 0x3f;
}

export function ecnOf(tos: number): number {
  return tos & 0x03;
}

export function withDscp(tos: number, dscp: number): number {
  if (dscp < 0 || dscp > 63) throw new Error(`DSCP out of range: ${dscp}`);
  return (dscp << 2) | (tos & 0x03);
}

export function computeOuterTos(innerTos: number, cfg: DscpTunnelConfig): number {
  const innerDscp = dscpOf(innerTos);
  const innerEcn = ecnOf(innerTos);
  let outerDscp: number;
  switch (cfg.dscpMode) {
    case 'copy':
      outerDscp = innerDscp;
      break;
    case 'set':
      outerDscp = cfg.dscpValue & 0x3f;
      break;
    case 'map':
      outerDscp = cfg.dscpMap.get(innerDscp) ?? innerDscp;
      break;
  }
  const outerEcn = cfg.ecnEnabled ? innerEcn : 0;
  return (outerDscp << 2) | outerEcn;
}

export function propagateCeOnDecap(outerTos: number, innerTos: number, cfg: DscpTunnelConfig): number {
  if (!cfg.ecnEnabled) return innerTos;
  const outerEcn = ecnOf(outerTos);
  if (outerEcn === 0b11) {
    return (innerTos & 0xfc) | 0b11;
  }
  return innerTos;
}
