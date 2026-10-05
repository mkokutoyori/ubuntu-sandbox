import { EcnCodepoint } from './IpHeaderFields';

export type EcnDecapsulation =
  | { readonly forward: true; readonly inner: EcnCodepoint }
  | { readonly forward: false };

export function ecnForOuterHeader(inner: EcnCodepoint): EcnCodepoint {
  return inner.congestionExperienced ? EcnCodepoint.ECT_0 : inner;
}

export function ecnOnDecapsulation(outer: EcnCodepoint, inner: EcnCodepoint): EcnDecapsulation {
  if (!inner.capable) {
    return outer.congestionExperienced ? { forward: false } : { forward: true, inner };
  }
  if (outer.congestionExperienced) return { forward: true, inner: EcnCodepoint.CE };
  if (outer === EcnCodepoint.ECT_1 && inner === EcnCodepoint.ECT_0) {
    return { forward: true, inner: EcnCodepoint.ECT_1 };
  }
  return { forward: true, inner };
}
