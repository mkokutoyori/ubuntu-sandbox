import type { GssSecurityContext } from '@/network/kerberos/gssapi/GssSecurityContext';
import { GSS_C_CONF_FLAG, GSS_C_INTEG_FLAG } from '@/network/kerberos/gssapi/GssToken';

export const LAYER_NONE = 1;
export const LAYER_INTEGRITY = 2;
export const LAYER_CONFIDENTIALITY = 4;
export const SECURITY_TOKEN_BYTES = 4;
export const MAX_BUFFER_FIELD = 0xffffff;

const encoder = new TextEncoder();

export function layersOfContextFlags(contextFlags: number): number {
  if ((contextFlags & GSS_C_INTEG_FLAG) === 0) return LAYER_NONE;
  if ((contextFlags & GSS_C_CONF_FLAG) === 0) return LAYER_NONE | LAYER_INTEGRITY;
  return LAYER_NONE | LAYER_INTEGRITY | LAYER_CONFIDENTIALITY;
}

export interface LayerPolicy {
  readonly minSsf: number;
  readonly maxSsf: number;
  readonly externalSsf: number;
  readonly maxBufferSize: number;
}

export type ClientLayerOutcome =
  | {
    readonly kind: 'chosen'; readonly layer: number; readonly mechSsf: number; readonly maxOutbuf: number;
    readonly choiceToken: Uint8Array;
  }
  | { readonly kind: 'malformed'; readonly message: string }
  | { readonly kind: 'too-weak' }
  | { readonly kind: 'bad-param' };

function bigEndian24(value: number): Uint8Array {
  return new Uint8Array([(value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

export function chooseClientLayer(
  context: GssSecurityContext, contextFlags: number, offer: Uint8Array, policy: LayerPolicy, authzid: string,
): ClientLayerOutcome {
  if (offer.length !== SECURITY_TOKEN_BYTES) {
    return { kind: 'malformed', message: offer.length < SECURITY_TOKEN_BYTES ? 'token too short' : 'token too long' };
  }
  const mechSsf = context.sessionStrengthBits;
  if (policy.minSsf > mechSsf + policy.externalSsf) return { kind: 'too-weak' };
  if (policy.minSsf > policy.maxSsf) return { kind: 'bad-param' };
  const allowed = policy.maxSsf >= policy.externalSsf ? policy.maxSsf - policy.externalSsf : 0;
  const need = policy.minSsf >= policy.externalSsf ? policy.minSsf - policy.externalSsf : 0;
  const serverHas = offer[0];
  const supported = layersOfContextFlags(contextFlags);

  let layer: number;
  let selectedSsf: number;
  if ((supported & LAYER_CONFIDENTIALITY) !== 0 && allowed >= mechSsf && need <= mechSsf && (serverHas & LAYER_CONFIDENTIALITY) !== 0) {
    layer = LAYER_CONFIDENTIALITY;
    selectedSsf = mechSsf;
  } else if ((supported & LAYER_INTEGRITY) !== 0 && allowed >= 1 && need <= 1 && (serverHas & LAYER_INTEGRITY) !== 0) {
    layer = LAYER_INTEGRITY;
    selectedSsf = 1;
  } else if ((supported & LAYER_NONE) !== 0 && need <= 0 && (serverHas & LAYER_NONE) !== 0) {
    layer = LAYER_NONE;
    selectedSsf = 0;
  } else {
    return { kind: 'too-weak' };
  }
  const serverBuffer = (offer[1] << 16) | (offer[2] << 8) | offer[3];
  const maxOutbuf = selectedSsf !== 0 ? Math.max(0, serverBuffer - context.wrapOverhead(true)) : serverBuffer;
  const user = encoder.encode(authzid);
  const choiceToken = new Uint8Array(SECURITY_TOKEN_BYTES + user.length);
  if (layer > LAYER_NONE) choiceToken.set(bigEndian24(Math.min(policy.maxBufferSize, MAX_BUFFER_FIELD)), 1);
  choiceToken[0] = layer;
  choiceToken.set(user, SECURITY_TOKEN_BYTES);
  return { kind: 'chosen', layer, mechSsf: selectedSsf, maxOutbuf, choiceToken };
}

export interface LayerOffer {
  readonly layers: number;
  readonly maxBuffer: number;
}

export function encodeLayerOffer(offer: LayerOffer): Uint8Array {
  const token = new Uint8Array(SECURITY_TOKEN_BYTES);
  token[0] = offer.layers;
  token.set(bigEndian24(Math.min(offer.maxBuffer, MAX_BUFFER_FIELD)), 1);
  return token;
}

export type LayerChoice =
  | { readonly kind: 'accepted'; readonly layer: number; readonly clientMaxBuffer: number; readonly authzid: string }
  | { readonly kind: 'refused'; readonly reason: 'too-short' | 'not-offered' | 'no-buffer' };

export function decodeLayerChoice(offer: LayerOffer, token: Uint8Array): LayerChoice {
  if (token.length < SECURITY_TOKEN_BYTES) return { kind: 'refused', reason: 'too-short' };
  const layer = token[0];
  const single = layer === LAYER_NONE || layer === LAYER_INTEGRITY || layer === LAYER_CONFIDENTIALITY;
  if (!single || (offer.layers & layer) === 0) return { kind: 'refused', reason: 'not-offered' };
  const clientMaxBuffer = (token[1] << 16) | (token[2] << 8) | token[3];
  if (layer !== LAYER_NONE && clientMaxBuffer === 0) return { kind: 'refused', reason: 'no-buffer' };
  return { kind: 'accepted', layer, clientMaxBuffer, authzid: new TextDecoder().decode(token.subarray(SECURITY_TOKEN_BYTES)) };
}
