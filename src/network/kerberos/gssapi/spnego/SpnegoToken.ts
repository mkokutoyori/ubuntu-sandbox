import {
  concat, encodeContextConstructed, encodeEnumerated, encodeRawOctetString, encodeSequence, encodeTLV, parseAll, parseTLV,
  type ParsedTLV,
} from '@/network/devices/windows/server/ad/ldap/Ber';
import { decodeOid, encodeOid } from '../GssToken';

export const SPNEGO_MECHANISM_OID = '1.3.6.1.5.5.2';

export const NegState = {
  ACCEPT_COMPLETE: 0,
  ACCEPT_INCOMPLETE: 1,
  REJECT: 2,
  REQUEST_MIC: 3,
} as const;

const OBJECT_IDENTIFIER_TAG = 6;
const OCTET_STRING_TAG = 4;
const ENUMERATED_TAG = 10;
const MECH_TYPES_FIELD = 0;
const NEG_STATE_FIELD = 0;
const SUPPORTED_MECH_FIELD = 1;
const TOKEN_FIELD = 2;
const MIC_FIELD = 3;
const NEG_TOKEN_INIT_CHOICE = 0;
const NEG_TOKEN_RESP_CHOICE = 1;

export interface NegTokenInit {
  readonly kind: 'init';
  readonly mechTypes: readonly string[];
  readonly mechTypesDer: Uint8Array;
  readonly mechToken: Uint8Array | null;
  readonly mechListMic: Uint8Array | null;
}

export interface NegTokenResp {
  readonly kind: 'resp';
  readonly negState: number | null;
  readonly supportedMech: string | null;
  readonly responseToken: Uint8Array | null;
  readonly mechListMic: Uint8Array | null;
}

export type SpnegoToken = NegTokenInit | NegTokenResp;

export function encodeMechTypes(mechTypes: readonly string[]): Uint8Array {
  return encodeSequence(mechTypes.map(encodeOid));
}

function optionalOctetString(tagNumber: number, value: Uint8Array | null): Uint8Array[] {
  return value === null ? [] : [encodeContextConstructed(tagNumber, [encodeRawOctetString(value)])];
}

export function encodeNegTokenInit(init: { mechTypes: readonly string[]; mechToken: Uint8Array | null; mechListMic: Uint8Array | null }): Uint8Array {
  const fields = [
    encodeContextConstructed(MECH_TYPES_FIELD, [encodeMechTypes(init.mechTypes)]),
    ...optionalOctetString(TOKEN_FIELD, init.mechToken),
    ...optionalOctetString(MIC_FIELD, init.mechListMic),
  ];
  const choice = encodeContextConstructed(NEG_TOKEN_INIT_CHOICE, [encodeSequence(fields)]);
  return encodeTLV('application', 0, true, concat([encodeOid(SPNEGO_MECHANISM_OID), choice]));
}

export function encodeNegTokenResp(resp: {
  negState: number; supportedMech: string | null; responseToken: Uint8Array | null; mechListMic: Uint8Array | null;
}): Uint8Array {
  const fields = [
    encodeContextConstructed(NEG_STATE_FIELD, [encodeEnumerated(resp.negState)]),
    ...(resp.supportedMech === null ? [] : [encodeContextConstructed(SUPPORTED_MECH_FIELD, [encodeOid(resp.supportedMech)])]),
    ...optionalOctetString(TOKEN_FIELD, resp.responseToken !== null && resp.responseToken.length > 0 ? resp.responseToken : null),
    ...optionalOctetString(MIC_FIELD, resp.mechListMic),
  ];
  return encodeContextConstructed(NEG_TOKEN_RESP_CHOICE, [encodeSequence(fields)]);
}

function fieldsOf(sequence: ParsedTLV): Map<number, ParsedTLV> {
  const fields = new Map<number, ParsedTLV>();
  for (const node of parseAll(sequence.content)) {
    if (node.tagClass === 'context') fields.set(node.tagNumber, parseTLV(node.content, 0));
  }
  return fields;
}

function octetStringField(fields: Map<number, ParsedTLV>, tagNumber: number): Uint8Array | null {
  const node = fields.get(tagNumber);
  if (node === undefined) return null;
  if (node.tagNumber !== OCTET_STRING_TAG) throw new Error('SPNEGO: field is not an OCTET STRING');
  return node.content;
}

function decodeNegTokenInit(sequence: ParsedTLV): NegTokenInit {
  const holder = parseAll(sequence.content).find((node) => node.tagClass === 'context' && node.tagNumber === MECH_TYPES_FIELD);
  if (holder === undefined) throw new Error('SPNEGO: no mechTypes');
  const list = parseTLV(holder.content, 0);
  const fields = fieldsOf(sequence);
  return {
    kind: 'init',
    mechTypes: parseAll(list.content).map((node) => {
      if (node.tagNumber !== OBJECT_IDENTIFIER_TAG) throw new Error('SPNEGO: mechType is not an OID');
      return decodeOid(node.content);
    }),
    mechTypesDer: holder.content,
    mechToken: octetStringField(fields, TOKEN_FIELD),
    mechListMic: octetStringField(fields, MIC_FIELD),
  };
}

function decodeNegTokenResp(sequence: ParsedTLV): NegTokenResp {
  const fields = fieldsOf(sequence);
  const state = fields.get(NEG_STATE_FIELD);
  if (state !== undefined && state.tagNumber !== ENUMERATED_TAG) throw new Error('SPNEGO: negState is not ENUMERATED');
  const mech = fields.get(SUPPORTED_MECH_FIELD);
  if (mech !== undefined && mech.tagNumber !== OBJECT_IDENTIFIER_TAG) throw new Error('SPNEGO: supportedMech is not an OID');
  return {
    kind: 'resp',
    negState: state === undefined ? null : state.content.length === 0 ? 0 : state.content[state.content.length - 1],
    supportedMech: mech === undefined ? null : decodeOid(mech.content),
    responseToken: octetStringField(fields, TOKEN_FIELD),
    mechListMic: octetStringField(fields, MIC_FIELD),
  };
}

export function decodeSpnegoToken(bytes: Uint8Array): SpnegoToken | null {
  try {
    const outer = parseTLV(bytes, 0);
    if (outer.tagClass === 'application' && outer.tagNumber === 0) {
      const oid = parseTLV(outer.content, 0);
      if (oid.tagNumber !== OBJECT_IDENTIFIER_TAG || decodeOid(oid.content) !== SPNEGO_MECHANISM_OID) return null;
      const choice = parseTLV(outer.content, oid.nextOffset);
      if (choice.tagClass !== 'context' || choice.tagNumber !== NEG_TOKEN_INIT_CHOICE) return null;
      return decodeNegTokenInit(parseTLV(choice.content, 0));
    }
    if (outer.tagClass === 'context' && outer.tagNumber === NEG_TOKEN_RESP_CHOICE) {
      return decodeNegTokenResp(parseTLV(outer.content, 0));
    }
    return null;
  } catch {
    return null;
  }
}
