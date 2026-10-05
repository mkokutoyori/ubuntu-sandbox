import { DSCP_CODEPOINTS, DiffServField, EcnCodepoint } from '../core/IpHeaderFields';
import { ecnForOuterHeader, ecnOnDecapsulation } from '../core/EcnTunnel';

type UppercaseKeys<T> = { readonly [K in keyof T as Uppercase<K & string>]: T[K] };

export const DSCP = Object.fromEntries(
  Object.entries(DSCP_CODEPOINTS)
    .filter(([name]) => name !== 'default')
    .map(([name, value]) => [name.toUpperCase(), value]),
) as Omit<UppercaseKeys<typeof DSCP_CODEPOINTS>, 'DEFAULT'>;

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
  return DiffServField.of(tos).dscp;
}

export function ecnOf(tos: number): number {
  return DiffServField.of(tos).ecn.bits;
}

export function withDscp(tos: number, dscp: number): number {
  return DiffServField.of(tos).withDscp(dscp).value;
}

export function computeOuterTos(innerTos: number, cfg: DscpTunnelConfig): number {
  const innerDscp = dscpOf(innerTos);
  const innerEcn = EcnCodepoint.ofField(innerTos);
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
  const outerEcn = cfg.ecnEnabled ? ecnForOuterHeader(innerEcn) : EcnCodepoint.NOT_ECT;
  return DiffServField.fromDscp(outerDscp & 0x3f).withEcn(outerEcn).value;
}

export function ecnOnDecapsulatedTos(outerTos: number, innerTos: number, cfg: DscpTunnelConfig): number | null {
  if (!cfg.ecnEnabled) return innerTos;
  const verdict = ecnOnDecapsulation(EcnCodepoint.ofField(outerTos), EcnCodepoint.ofField(innerTos));
  return verdict.forward ? DiffServField.of(innerTos).withEcn(verdict.inner).value : null;
}
