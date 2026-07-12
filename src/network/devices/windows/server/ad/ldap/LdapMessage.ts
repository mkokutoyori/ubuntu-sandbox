/**
 * LdapMessage — RFC 4511 §4 LDAPMessage envelope and protocolOp CHOICE:
 * real APPLICATION-tagged BER PDUs (Bind/Search/Add/Modify/Delete/Compare/
 * Unbind, request and response), encoded/decoded byte-for-byte via Ber.ts —
 * not a JSON stand-in. `LdapServer`/`LdapClient` exchange these directly
 * as `Uint8Array`s over the simulated TCP/389 socket.
 */

import {
  type BerNode, UNIVERSAL_TAG, parseTLV, parseAll,
  encodeInteger, decodeInteger, encodeEnumerated,
  encodeBoolean, decodeBoolean,
  encodeOctetString, decodeOctetString, encodeRawOctetString,
  encodeSequence, encodeSet, encodeApplication, encodeContextPrimitiveString, encodeContextConstructed,
  encodeContextPrimitive,
  concat,
} from './Ber';
import { type LdapFilter, encodeFilter, decodeFilter } from './LdapFilter';
import type { SearchScope, ModOperation } from './DirectoryTree';

// ── RFC 4511 §4.1.10 result codes (the subset this server actually returns) ──

export const LdapResultCode = {
  success: 0,
  operationsError: 1,
  protocolError: 2,
  compareFalse: 5,
  compareTrue: 6,
  authMethodNotSupported: 7,
  noSuchAttribute: 16,
  undefinedAttributeType: 17,
  invalidAttributeSyntax: 21,
  noSuchObject: 32,
  invalidDNSyntax: 34,
  invalidCredentials: 49,
  insufficientAccessRights: 50,
  namingViolation: 64,
  objectClassViolation: 65,
  notAllowedOnNonLeaf: 66,
  entryAlreadyExists: 68,
  referral: 10,
  unwillingToPerform: 53,
  other: 80,
} as const;
export type LdapResultCodeValue = typeof LdapResultCode[keyof typeof LdapResultCode];

export interface LdapResult {
  resultCode: number;
  matchedDN: string;
  diagnosticMessage: string;
}

export interface PartialAttribute { type: string; values: string[] }

/** RFC 4511 §4.2 AuthenticationChoice — `simple [0] OCTET STRING` (password) or `sasl [3] SaslCredentials` (GSSAPI/Kerberos, PRD-Windows-Server-Advanced.md §5 P3). `sasl` is undefined for a simple bind. */
export interface SaslCredentials { mechanism: string; credentials: Uint8Array }

export type ProtocolOp =
  | { kind: 'bindRequest'; version: number; name: string; password: string; sasl?: SaslCredentials }
  | { kind: 'bindResponse'; result: LdapResult }
  | { kind: 'unbindRequest' }
  | {
      kind: 'searchRequest'; baseObject: string; scope: SearchScope; derefAliases: number;
      sizeLimit: number; timeLimit: number; typesOnly: boolean; filter: LdapFilter; attributes: string[];
    }
  | { kind: 'searchResultEntry'; objectName: string; attributes: PartialAttribute[] }
  | { kind: 'searchResultDone'; result: LdapResult }
  | { kind: 'modifyRequest'; object: string; changes: { operation: ModOperation; modification: PartialAttribute }[] }
  | { kind: 'modifyResponse'; result: LdapResult }
  | { kind: 'addRequest'; entry: string; attributes: PartialAttribute[] }
  | { kind: 'addResponse'; result: LdapResult }
  | { kind: 'delRequest'; entry: string }
  | { kind: 'delResponse'; result: LdapResult }
  | { kind: 'compareRequest'; entry: string; attributeDesc: string; assertionValue: string }
  | { kind: 'compareResponse'; result: LdapResult }
  | { kind: 'abandonRequest'; messageID: number }
  | { kind: 'searchResultReference'; uris: string[] }
  | { kind: 'modifyDNRequest'; entry: string; newRdn: string; deleteOldRdn: boolean; newSuperior?: string }
  | { kind: 'modifyDNResponse'; result: LdapResult }
  | { kind: 'extendedRequest'; requestName: string; requestValue?: Uint8Array }
  | { kind: 'extendedResponse'; result: LdapResult; responseName?: string };

/** RFC 4511 §4.14.1 — StartTLS's request OID, the only `extendedRequest` this simulator issues/serves. */
export const START_TLS_OID = '1.3.6.1.4.1.1466.20037';

/** RFC 4511 §4.1.11 Controls / §4.1.9 Control — `criticality` defaults to `false` per the ASN.1 DEFAULT. */
export interface LdapControl { controlType: string; criticality: boolean; controlValue?: Uint8Array }

/** RFC 2696 — the paged-results control's OID and controlValue payload shape. */
export const PAGED_RESULTS_CONTROL_OID = '1.2.840.113556.1.4.319';
export interface PagedResultsValue { size: number; cookie: Uint8Array }

export function encodePagedResultsValue(v: PagedResultsValue): Uint8Array {
  return encodeSequence([encodeInteger(v.size), encodeRawOctetString(v.cookie)]);
}
export function decodePagedResultsValue(bytes: Uint8Array): PagedResultsValue {
  const seq = parseTLV(bytes, 0);
  const [sizeNode, cookieNode] = parseAll(seq.content);
  return { size: decodeInteger(sizeNode.content), cookie: cookieNode.content };
}

export interface LdapMessage {
  messageID: number;
  protocolOp: ProtocolOp;
  /** RFC 4511 §4.1.11 — optional `[0] Controls`, e.g. RFC 2696 paged results. */
  controls?: LdapControl[];
}

const APP_TAG = {
  bindRequest: 0, bindResponse: 1, unbindRequest: 2,
  searchRequest: 3, searchResultEntry: 4, searchResultDone: 5,
  modifyRequest: 6, modifyResponse: 7,
  addRequest: 8, addResponse: 9,
  delRequest: 10, delResponse: 11,
  modifyDNRequest: 12, modifyDNResponse: 13,
  compareRequest: 14, compareResponse: 15,
  abandonRequest: 16,
  searchResultReference: 19,
  extendedRequest: 23, extendedResponse: 24,
} as const;

const SCOPE_TO_NUM: Record<SearchScope, number> = { base: 0, one: 1, sub: 2 };
const NUM_TO_SCOPE: Record<number, SearchScope> = { 0: 'base', 1: 'one', 2: 'sub' };
const MODOP_TO_NUM: Record<ModOperation, number> = { add: 0, delete: 1, replace: 2 };
const NUM_TO_MODOP: Record<number, ModOperation> = { 0: 'add', 1: 'delete', 2: 'replace' };

// ── LDAPResult — COMPONENTS OF, inlined into the enclosing response SEQUENCE ─

function encodeLdapResult(r: LdapResult): Uint8Array[] {
  return [
    encodeEnumerated(r.resultCode),
    encodeOctetString(r.matchedDN),
    encodeOctetString(r.diagnosticMessage),
  ];
}

/** Decodes the 3 leading LDAPResult fields from `nodes` starting at `idx`; returns the index just past them. */
function decodeLdapResult(nodes: BerNode[], idx: number): { result: LdapResult; next: number } {
  const resultCode = decodeInteger(nodes[idx].content);
  const matchedDN = decodeOctetString(nodes[idx + 1].content);
  const diagnosticMessage = decodeOctetString(nodes[idx + 2].content);
  return { result: { resultCode, matchedDN, diagnosticMessage }, next: idx + 3 };
}

// ── PartialAttribute / AttributeList ─────────────────────────────────────────

function encodePartialAttribute(a: PartialAttribute): Uint8Array {
  return encodeSequence([
    encodeOctetString(a.type),
    encodeSet(a.values.map(encodeOctetString)),
  ]);
}

function decodePartialAttribute(node: BerNode): PartialAttribute {
  const [typeNode, valsNode] = parseAll(node.content);
  const type = decodeOctetString(typeNode.content);
  const values = parseAll(valsNode.content).map(v => decodeOctetString(v.content));
  return { type, values };
}

// ── protocolOp encode ────────────────────────────────────────────────────────

export function encodeProtocolOp(op: ProtocolOp): Uint8Array {
  switch (op.kind) {
    case 'bindRequest':
      return encodeApplication(APP_TAG.bindRequest, true, concat([
        encodeInteger(op.version),
        encodeOctetString(op.name),
        // AuthenticationChoice ::= CHOICE { simple [0] OCTET STRING, sasl [3] SaslCredentials }.
        op.sasl
          ? encodeContextConstructed(3, [encodeOctetString(op.sasl.mechanism), encodeRawOctetString(op.sasl.credentials)])
          : encodeContextPrimitiveString(0, op.password),
      ]));
    case 'bindResponse':
      return encodeApplication(APP_TAG.bindResponse, true, concat(encodeLdapResult(op.result)));
    case 'unbindRequest':
      return encodeApplication(APP_TAG.unbindRequest, false, new Uint8Array(0));
    case 'searchRequest':
      return encodeApplication(APP_TAG.searchRequest, true, concat([
        encodeOctetString(op.baseObject),
        encodeEnumerated(SCOPE_TO_NUM[op.scope]),
        encodeEnumerated(op.derefAliases),
        encodeInteger(op.sizeLimit),
        encodeInteger(op.timeLimit),
        encodeBoolean(op.typesOnly),
        encodeFilter(op.filter),
        encodeSequence(op.attributes.map(encodeOctetString)),
      ]));
    case 'searchResultEntry':
      return encodeApplication(APP_TAG.searchResultEntry, true, concat([
        encodeOctetString(op.objectName),
        encodeSequence(op.attributes.map(encodePartialAttribute)),
      ]));
    case 'searchResultDone':
      return encodeApplication(APP_TAG.searchResultDone, true, concat(encodeLdapResult(op.result)));
    case 'modifyRequest':
      return encodeApplication(APP_TAG.modifyRequest, true, concat([
        encodeOctetString(op.object),
        encodeSequence(op.changes.map(c => encodeSequence([
          encodeEnumerated(MODOP_TO_NUM[c.operation]),
          encodePartialAttribute(c.modification),
        ]))),
      ]));
    case 'modifyResponse':
      return encodeApplication(APP_TAG.modifyResponse, true, concat(encodeLdapResult(op.result)));
    case 'addRequest':
      return encodeApplication(APP_TAG.addRequest, true, concat([
        encodeOctetString(op.entry),
        encodeSequence(op.attributes.map(encodePartialAttribute)),
      ]));
    case 'addResponse':
      return encodeApplication(APP_TAG.addResponse, true, concat(encodeLdapResult(op.result)));
    case 'delRequest':
      return encodeApplication(APP_TAG.delRequest, false, new TextEncoder().encode(op.entry));
    case 'delResponse':
      return encodeApplication(APP_TAG.delResponse, true, concat(encodeLdapResult(op.result)));
    case 'compareRequest':
      return encodeApplication(APP_TAG.compareRequest, true, concat([
        encodeOctetString(op.entry),
        encodeSequence([encodeOctetString(op.attributeDesc), encodeOctetString(op.assertionValue)]),
      ]));
    case 'compareResponse':
      return encodeApplication(APP_TAG.compareResponse, true, concat(encodeLdapResult(op.result)));
    case 'abandonRequest': {
      const intTlv = parseTLV(encodeInteger(op.messageID), 0);
      return encodeApplication(APP_TAG.abandonRequest, false, intTlv.content);
    }
    case 'searchResultReference':
      return encodeApplication(APP_TAG.searchResultReference, true, concat(op.uris.map(encodeOctetString)));
    case 'modifyDNRequest':
      return encodeApplication(APP_TAG.modifyDNRequest, true, concat([
        encodeOctetString(op.entry),
        encodeOctetString(op.newRdn),
        encodeBoolean(op.deleteOldRdn),
        ...(op.newSuperior !== undefined ? [encodeContextPrimitiveString(0, op.newSuperior)] : []),
      ]));
    case 'modifyDNResponse':
      return encodeApplication(APP_TAG.modifyDNResponse, true, concat(encodeLdapResult(op.result)));
    case 'extendedRequest':
      return encodeApplication(APP_TAG.extendedRequest, true, concat([
        encodeContextPrimitiveString(0, op.requestName),
        ...(op.requestValue !== undefined ? [encodeContextPrimitive(1, op.requestValue)] : []),
      ]));
    case 'extendedResponse':
      return encodeApplication(APP_TAG.extendedResponse, true, concat([
        ...encodeLdapResult(op.result),
        ...(op.responseName !== undefined ? [encodeContextPrimitiveString(10, op.responseName)] : []),
      ]));
  }
}

// ── protocolOp decode ────────────────────────────────────────────────────────

export function decodeProtocolOp(node: BerNode): ProtocolOp {
  switch (node.tagNumber) {
    case APP_TAG.bindRequest: {
      const parts = parseAll(node.content);
      const version = decodeInteger(parts[0].content);
      const name = decodeOctetString(parts[1].content);
      const authChoice = parts[2];
      if (authChoice.tagNumber === 3) {
        const [mechNode, credNode] = parseAll(authChoice.content);
        const sasl: SaslCredentials = { mechanism: decodeOctetString(mechNode.content), credentials: credNode.content };
        return { kind: 'bindRequest', version, name, password: '', sasl };
      }
      const password = decodeOctetString(authChoice.content); // AuthenticationChoice simple [0]
      return { kind: 'bindRequest', version, name, password };
    }
    case APP_TAG.bindResponse: {
      const { result } = decodeLdapResult(parseAll(node.content), 0);
      return { kind: 'bindResponse', result };
    }
    case APP_TAG.unbindRequest:
      return { kind: 'unbindRequest' };
    case APP_TAG.searchRequest: {
      const parts = parseAll(node.content);
      const baseObject = decodeOctetString(parts[0].content);
      const scope = NUM_TO_SCOPE[decodeInteger(parts[1].content)];
      const derefAliases = decodeInteger(parts[2].content);
      const sizeLimit = decodeInteger(parts[3].content);
      const timeLimit = decodeInteger(parts[4].content);
      const typesOnly = decodeBoolean(parts[5].content);
      const filter = decodeFilter(parts[6]);
      const attributes = parseAll(parts[7].content).map(a => decodeOctetString(a.content));
      return { kind: 'searchRequest', baseObject, scope, derefAliases, sizeLimit, timeLimit, typesOnly, filter, attributes };
    }
    case APP_TAG.searchResultEntry: {
      const parts = parseAll(node.content);
      const objectName = decodeOctetString(parts[0].content);
      const attributes = parseAll(parts[1].content).map(decodePartialAttribute);
      return { kind: 'searchResultEntry', objectName, attributes };
    }
    case APP_TAG.searchResultDone: {
      const { result } = decodeLdapResult(parseAll(node.content), 0);
      return { kind: 'searchResultDone', result };
    }
    case APP_TAG.modifyRequest: {
      const parts = parseAll(node.content);
      const object = decodeOctetString(parts[0].content);
      const changes = parseAll(parts[1].content).map(changeNode => {
        const [opNode, modNode] = parseAll(changeNode.content);
        return { operation: NUM_TO_MODOP[decodeInteger(opNode.content)], modification: decodePartialAttribute(modNode) };
      });
      return { kind: 'modifyRequest', object, changes };
    }
    case APP_TAG.modifyResponse: {
      const { result } = decodeLdapResult(parseAll(node.content), 0);
      return { kind: 'modifyResponse', result };
    }
    case APP_TAG.addRequest: {
      const parts = parseAll(node.content);
      const entry = decodeOctetString(parts[0].content);
      const attributes = parseAll(parts[1].content).map(decodePartialAttribute);
      return { kind: 'addRequest', entry, attributes };
    }
    case APP_TAG.addResponse: {
      const { result } = decodeLdapResult(parseAll(node.content), 0);
      return { kind: 'addResponse', result };
    }
    case APP_TAG.delRequest:
      return { kind: 'delRequest', entry: decodeOctetString(node.content) };
    case APP_TAG.delResponse: {
      const { result } = decodeLdapResult(parseAll(node.content), 0);
      return { kind: 'delResponse', result };
    }
    case APP_TAG.compareRequest: {
      const parts = parseAll(node.content);
      const entry = decodeOctetString(parts[0].content);
      const [attrNode, valueNode] = parseAll(parts[1].content);
      return {
        kind: 'compareRequest', entry,
        attributeDesc: decodeOctetString(attrNode.content),
        assertionValue: decodeOctetString(valueNode.content),
      };
    }
    case APP_TAG.compareResponse: {
      const { result } = decodeLdapResult(parseAll(node.content), 0);
      return { kind: 'compareResponse', result };
    }
    case APP_TAG.abandonRequest:
      return { kind: 'abandonRequest', messageID: decodeInteger(node.content) };
    case APP_TAG.searchResultReference:
      return { kind: 'searchResultReference', uris: parseAll(node.content).map(u => decodeOctetString(u.content)) };
    case APP_TAG.modifyDNRequest: {
      const parts = parseAll(node.content);
      const entry = decodeOctetString(parts[0].content);
      const newRdn = decodeOctetString(parts[1].content);
      const deleteOldRdn = decodeBoolean(parts[2].content);
      const newSuperiorNode = parts[3];
      const newSuperior = newSuperiorNode && newSuperiorNode.tagClass === 'context' && newSuperiorNode.tagNumber === 0
        ? decodeOctetString(newSuperiorNode.content) : undefined;
      return { kind: 'modifyDNRequest', entry, newRdn, deleteOldRdn, newSuperior };
    }
    case APP_TAG.modifyDNResponse: {
      const { result } = decodeLdapResult(parseAll(node.content), 0);
      return { kind: 'modifyDNResponse', result };
    }
    case APP_TAG.extendedRequest: {
      const parts = parseAll(node.content);
      const requestName = decodeOctetString(parts[0].content);
      const valueNode = parts.find(p => p.tagClass === 'context' && p.tagNumber === 1);
      return { kind: 'extendedRequest', requestName, requestValue: valueNode?.content };
    }
    case APP_TAG.extendedResponse: {
      const parts = parseAll(node.content);
      const { result, next } = decodeLdapResult(parts, 0);
      const responseNameNode = parts[next];
      const responseName = responseNameNode && responseNameNode.tagClass === 'context' && responseNameNode.tagNumber === 10
        ? decodeOctetString(responseNameNode.content) : undefined;
      return { kind: 'extendedResponse', result, responseName };
    }
    default:
      throw new Error(`LdapMessage: unknown protocolOp APPLICATION tag ${node.tagNumber}`);
  }
}

// ── Controls (RFC 4511 §4.1.9/§4.1.11) ──────────────────────────────────────

function encodeControl(c: LdapControl): Uint8Array {
  const parts = [encodeOctetString(c.controlType)];
  if (c.criticality) parts.push(encodeBoolean(true));
  if (c.controlValue !== undefined) parts.push(encodeRawOctetString(c.controlValue));
  return encodeSequence(parts);
}

function decodeControl(node: BerNode): LdapControl {
  const parts = parseAll(node.content);
  const controlType = decodeOctetString(parts[0].content);
  let idx = 1;
  let criticality = false;
  if (parts[idx] && parts[idx].tagClass === 'universal' && parts[idx].tagNumber === UNIVERSAL_TAG.BOOLEAN) {
    criticality = decodeBoolean(parts[idx].content);
    idx++;
  }
  const controlValue = parts[idx] ? parts[idx].content : undefined;
  return { controlType, criticality, controlValue };
}

// ── LDAPMessage envelope ─────────────────────────────────────────────────────

export function encodeLdapMessage(msg: LdapMessage): Uint8Array {
  const parts = [
    encodeInteger(msg.messageID),
    encodeProtocolOp(msg.protocolOp),
  ];
  if (msg.controls && msg.controls.length > 0) {
    parts.push(encodeContextConstructed(0, msg.controls.map(encodeControl)));
  }
  return encodeSequence(parts);
}

export function decodeLdapMessage(bytes: Uint8Array): LdapMessage {
  const node = parseTLV(bytes, 0);
  const parts = parseAll(node.content);
  const messageID = decodeInteger(parts[0].content);
  const protocolOp = decodeProtocolOp(parts[1]);
  const controlsNode = parts[2];
  const controls = controlsNode && controlsNode.tagClass === 'context' && controlsNode.tagNumber === 0
    ? parseAll(controlsNode.content).map(decodeControl) : undefined;
  return { messageID, protocolOp, controls };
}

export function ldapResult(resultCode: number, matchedDN = '', diagnosticMessage = ''): LdapResult {
  return { resultCode, matchedDN, diagnosticMessage };
}
