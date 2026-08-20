/**
 * Kerberos V5 (RFC 4120 §5) ASN.1 DER encode/decode. The RFC's own module
 * (`KerberosV5Spec2`) is declared `DEFINITIONS EXPLICIT TAGS`, so every
 * `[n] Type` field wraps the *complete* TLV encoding of the underlying
 * type inside a constructed context tag — not just raw content.
 *
 * Reuses the generic X.690 BER codec already built for LDAP
 * (`@/network/devices/windows/server/ad/ldap/Ber.ts`, RFC 4511 §5.1's
 * definite-length subset, which is DER-compatible) rather than
 * duplicating a byte-level ASN.1 codec — the same reuse
 * `Qpack.ts` already made of HPACK's integer/string helpers this session.
 */
import {
  encodeTLV, concat, parseTLV, parseAll, encodeInteger, decodeInteger,
  encodeOctetString, decodeOctetString, encodeSequence,
  encodeContextConstructed, encodeApplication, UNIVERSAL_TAG,
  type ParsedTLV,
} from '@/network/devices/windows/server/ad/ldap/Ber';
import {
  type PrincipalName, type EncryptionKey, type EncryptedData, type TicketFlags, NO_TICKET_FLAGS,
  type Ticket, type EncTicketPart, type PaData, type KdcReqBody, type KdcReq,
  type EncKdcRepPart, type KdcRep, type KrbError, type Authenticator, type ApReq,
} from './types';

const GENERALIZED_TIME_TAG = 0x18;
const BIT_STRING_TAG = 0x03;
const KRB_PVNO = 5;

// ─── EXPLICIT-tag field helpers ─────────────────────────────────────────────

function explicit(tagNumber: number, inner: Uint8Array): Uint8Array {
  return encodeContextConstructed(tagNumber, [inner]);
}

/** Unwraps one level of EXPLICIT tagging for every top-level context field of a SEQUENCE body, keyed by tag number. */
function fieldsOf(sequenceContent: Uint8Array): Map<number, ParsedTLV> {
  const map = new Map<number, ParsedTLV>();
  for (const node of parseAll(sequenceContent)) {
    if (node.tagClass === 'context') map.set(node.tagNumber, parseTLV(node.content, 0));
  }
  return map;
}

function rawOctetString(bytes: Uint8Array): Uint8Array {
  return encodeTLV('universal', UNIVERSAL_TAG.OCTET_STRING, false, bytes);
}

function encodeKerberosTime(epochSeconds: number): Uint8Array {
  const d = new Date(epochSeconds * 1000);
  const pad = (n: number): string => String(n).padStart(2, '0');
  const str = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`
    + `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
  return encodeTLV('universal', GENERALIZED_TIME_TAG, false, new TextEncoder().encode(str));
}

function decodeKerberosTime(content: Uint8Array): number {
  const str = new TextDecoder().decode(content);
  const y = Number(str.slice(0, 4)), mo = Number(str.slice(4, 6)), d = Number(str.slice(6, 8));
  const h = Number(str.slice(8, 10)), mi = Number(str.slice(10, 12)), s = Number(str.slice(12, 14));
  return Math.floor(Date.UTC(y, mo - 1, d, h, mi, s) / 1000);
}

// RFC 4120 §5.2.8 — bit N is set at position (31 - N) of a 32-bit big-endian word.
const FLAG_BITS: ReadonlyArray<[keyof TicketFlags, number]> = [
  ['forwardable', 1], ['forwarded', 2], ['proxiable', 3], ['proxy', 4],
  ['renewable', 8], ['initial', 9], ['preAuthent', 10], ['hwAuthent', 11],
];

function encodeTicketFlags(flags: TicketFlags): Uint8Array {
  let bits = 0;
  for (const [key, bitIndex] of FLAG_BITS) if (flags[key]) bits |= (1 << (31 - bitIndex));
  const content = new Uint8Array([0, (bits >>> 24) & 0xff, (bits >>> 16) & 0xff, (bits >>> 8) & 0xff, bits & 0xff]);
  return encodeTLV('universal', BIT_STRING_TAG, false, content);
}

function decodeTicketFlags(content: Uint8Array): TicketFlags {
  const bits = (content[1] << 24) | (content[2] << 16) | (content[3] << 8) | content[4];
  const flags = { ...NO_TICKET_FLAGS };
  for (const [key, bitIndex] of FLAG_BITS) (flags as Record<string, boolean>)[key] = (bits & (1 << (31 - bitIndex))) !== 0;
  return flags;
}

/** The real klist-style hex rendering of a `TicketFlags` set (e.g. `0x40e10000`) — for `klist`'s output, not part of the wire codec proper. */
export function ticketFlagsToHex(flags: TicketFlags): string {
  let bits = 0;
  for (const [key, bitIndex] of FLAG_BITS) if (flags[key]) bits |= (1 << (31 - bitIndex));
  return '0x' + (bits >>> 0).toString(16).padStart(8, '0');
}

// ─── PrincipalName (RFC 4120 §5.2.2) ─────────────────────────────────────────

function encodePrincipalName(p: PrincipalName): Uint8Array {
  return encodeSequence([
    explicit(0, encodeInteger(p.nameType)),
    explicit(1, encodeSequence(p.nameString.map(encodeOctetString))),
  ]);
}

function decodePrincipalName(node: ParsedTLV): PrincipalName {
  const fields = fieldsOf(node.content);
  const nameType = decodeInteger(fields.get(0)!.content);
  const nameString = parseAll(fields.get(1)!.content).map((n) => decodeOctetString(n.content));
  return { nameType, nameString };
}

// ─── EncryptionKey / EncryptedData (RFC 4120 §5.2.9) ────────────────────────

function encodeEncryptionKey(k: EncryptionKey): Uint8Array {
  return encodeSequence([
    explicit(0, encodeInteger(k.keyType)),
    explicit(1, rawOctetString(k.keyValue)),
  ]);
}

function decodeEncryptionKey(node: ParsedTLV): EncryptionKey {
  const fields = fieldsOf(node.content);
  return { keyType: decodeInteger(fields.get(0)!.content), keyValue: fields.get(1)!.content };
}

export function encodeEncryptedData(e: EncryptedData): Uint8Array {
  const parts = [explicit(0, encodeInteger(e.etype))];
  if (e.kvno !== undefined) parts.push(explicit(1, encodeInteger(e.kvno)));
  parts.push(explicit(2, rawOctetString(e.cipher)));
  return encodeSequence(parts);
}

export function decodeEncryptedData(node: ParsedTLV): EncryptedData {
  const fields = fieldsOf(node.content);
  const kvnoNode = fields.get(1);
  return {
    etype: decodeInteger(fields.get(0)!.content),
    kvno: kvnoNode ? decodeInteger(kvnoNode.content) : undefined,
    cipher: fields.get(2)!.content,
  };
}

// ─── PA-DATA (RFC 4120 §5.2.7) ───────────────────────────────────────────────

function encodePaData(p: PaData): Uint8Array {
  return encodeSequence([
    explicit(1, encodeInteger(p.type)),
    explicit(2, rawOctetString(p.value)),
  ]);
}

function decodePaData(node: ParsedTLV): PaData {
  const fields = fieldsOf(node.content);
  return { type: decodeInteger(fields.get(1)!.content), value: fields.get(2)!.content };
}

export function encodePaDataSeq(padata: readonly PaData[]): Uint8Array {
  return encodeSequence(padata.map(encodePaData));
}

export function decodePaDataSeq(node: ParsedTLV): PaData[] {
  return parseAll(node.content).map(decodePaData);
}

/** RFC 4120 §5.2.7.2 — PA-ENC-TS-ENC, the plaintext encrypted for PA-ENC-TIMESTAMP. */
export function encodePaEncTsEnc(patimestamp: number): Uint8Array {
  return encodeSequence([explicit(0, encodeKerberosTime(patimestamp))]);
}
export function decodePaEncTsEnc(bytes: Uint8Array): number {
  const node = parseTLV(bytes, 0);
  const fields = fieldsOf(node.content);
  return decodeKerberosTime(fields.get(0)!.content);
}

// ─── Ticket / EncTicketPart (RFC 4120 §5.3) ─────────────────────────────────

export function encodeTicket(t: Ticket): Uint8Array {
  const body = encodeSequence([
    explicit(0, encodeInteger(t.tktVno)),
    explicit(1, encodeOctetString(t.realm)),
    explicit(2, encodePrincipalName(t.sname)),
    explicit(3, encodeEncryptedData(t.encPart)),
  ]);
  return encodeApplication(1, true, body);
}

function decodeTicketFromNode(app: ParsedTLV): Ticket {
  const seq = parseTLV(app.content, 0);
  const fields = fieldsOf(seq.content);
  return {
    tktVno: decodeInteger(fields.get(0)!.content),
    realm: decodeOctetString(fields.get(1)!.content),
    sname: decodePrincipalName(fields.get(2)!),
    encPart: decodeEncryptedData(fields.get(3)!),
  };
}

export function decodeTicket(bytes: Uint8Array): Ticket {
  return decodeTicketFromNode(parseTLV(bytes, 0));
}

// RFC 4120 §5.3.4 — TransitedEncoding; no cross-realm transit modeled yet (§ PRD 2.1.10), always empty DOMAIN-X500-COMPRESS.
function encodeTransitedEncoding(): Uint8Array {
  return encodeSequence([explicit(0, encodeInteger(0)), explicit(1, rawOctetString(new Uint8Array(0)))]);
}

export function encodeEncTicketPart(e: EncTicketPart): Uint8Array {
  const parts = [
    explicit(0, encodeTicketFlags(e.flags)),
    explicit(1, encodeEncryptionKey(e.key)),
    explicit(2, encodeOctetString(e.crealm)),
    explicit(3, encodePrincipalName(e.cname)),
    explicit(4, encodeTransitedEncoding()),
    explicit(5, encodeKerberosTime(e.authtime)),
  ];
  if (e.starttime !== undefined) parts.push(explicit(6, encodeKerberosTime(e.starttime)));
  parts.push(explicit(7, encodeKerberosTime(e.endtime)));
  if (e.renewTill !== undefined) parts.push(explicit(8, encodeKerberosTime(e.renewTill)));
  return encodeApplication(3, true, encodeSequence(parts));
}

export function decodeEncTicketPart(bytes: Uint8Array): EncTicketPart {
  const app = parseTLV(bytes, 0);
  const seq = parseTLV(app.content, 0);
  const fields = fieldsOf(seq.content);
  const starttimeNode = fields.get(6);
  const renewTillNode = fields.get(8);
  return {
    flags: decodeTicketFlags(fields.get(0)!.content),
    key: decodeEncryptionKey(fields.get(1)!),
    crealm: decodeOctetString(fields.get(2)!.content),
    cname: decodePrincipalName(fields.get(3)!),
    authtime: decodeKerberosTime(fields.get(5)!.content),
    starttime: starttimeNode ? decodeKerberosTime(starttimeNode.content) : undefined,
    endtime: decodeKerberosTime(fields.get(7)!.content),
    renewTill: renewTillNode ? decodeKerberosTime(renewTillNode.content) : undefined,
  };
}

// ─── KDC-REQ / AS-REQ / TGS-REQ (RFC 4120 §5.4.1) ───────────────────────────

const REQ_APP_TAG: Record<KdcReq['msgType'], number> = { 'AS-REQ': 10, 'TGS-REQ': 12 };
const REQ_MSG_TYPE: Record<KdcReq['msgType'], number> = { 'AS-REQ': 10, 'TGS-REQ': 12 };
const REP_APP_TAG: Record<KdcRep['msgType'], number> = { 'AS-REP': 11, 'TGS-REP': 13 };
const REP_MSG_TYPE: Record<KdcRep['msgType'], number> = { 'AS-REP': 11, 'TGS-REP': 13 };
const REP_ENC_PART_APP_TAG: Record<KdcRep['msgType'], number> = { 'AS-REP': 25, 'TGS-REP': 26 };

// kdc-options is itself a KerberosFlags/BIT STRING, kept as a plain bitmask
// number here (simplified — no named option bits modeled yet, cf. PRD scope).
function encodeBitmask32(bits: number): Uint8Array {
  const content = new Uint8Array([0, (bits >>> 24) & 0xff, (bits >>> 16) & 0xff, (bits >>> 8) & 0xff, bits & 0xff]);
  return encodeTLV('universal', BIT_STRING_TAG, false, content);
}
function decodeBitmask32(content: Uint8Array): number {
  return (content[1] << 24) | (content[2] << 16) | (content[3] << 8) | content[4];
}

function encodeKdcReqBody(b: KdcReqBody): Uint8Array {
  const parts = [explicit(0, encodeBitmask32(b.kdcOptions))];
  if (b.cname) parts.push(explicit(1, encodePrincipalName(b.cname)));
  parts.push(explicit(2, encodeOctetString(b.realm)));
  parts.push(explicit(3, encodePrincipalName(b.sname)));
  parts.push(explicit(5, encodeKerberosTime(b.till)));
  parts.push(explicit(7, encodeInteger(b.nonce)));
  parts.push(explicit(8, encodeSequence(b.etype.map(encodeInteger))));
  if (b.additionalTickets && b.additionalTickets.length > 0) {
    parts.push(explicit(11, encodeSequence(b.additionalTickets.map(encodeTicket))));
  }
  return encodeSequence(parts);
}

function decodeKdcReqBody(node: ParsedTLV): KdcReqBody {
  const fields = fieldsOf(node.content);
  const kdcOptions = decodeBitmask32(fields.get(0)!.content);
  const cnameNode = fields.get(1);
  const additionalTicketsNode = fields.get(11);
  return {
    kdcOptions,
    cname: cnameNode ? decodePrincipalName(cnameNode) : undefined,
    realm: decodeOctetString(fields.get(2)!.content),
    sname: decodePrincipalName(fields.get(3)!),
    till: decodeKerberosTime(fields.get(5)!.content),
    nonce: decodeInteger(fields.get(7)!.content),
    etype: parseAll(fields.get(8)!.content).map((n) => decodeInteger(n.content)),
    additionalTickets: additionalTicketsNode ? parseAll(additionalTicketsNode.content).map(decodeTicketFromNode) : undefined,
  };
}

export function encodeKdcReq(req: KdcReq): Uint8Array {
  const parts = [
    explicit(1, encodeInteger(KRB_PVNO)),
    explicit(2, encodeInteger(REQ_MSG_TYPE[req.msgType])),
  ];
  if (req.padata.length > 0) parts.push(explicit(3, encodePaDataSeq(req.padata)));
  parts.push(explicit(4, encodeKdcReqBody(req.reqBody)));
  return encodeApplication(REQ_APP_TAG[req.msgType], true, encodeSequence(parts));
}

export function decodeKdcReq(bytes: Uint8Array): KdcReq {
  const app = parseTLV(bytes, 0);
  const msgType = app.tagNumber === REQ_APP_TAG['AS-REQ'] ? 'AS-REQ' : 'TGS-REQ';
  const seq = parseTLV(app.content, 0);
  const fields = fieldsOf(seq.content);
  const padataNode = fields.get(3);
  return {
    msgType,
    padata: padataNode ? decodePaDataSeq(padataNode) : [],
    reqBody: decodeKdcReqBody(fields.get(4)!),
  };
}

// ─── KDC-REP / AS-REP / TGS-REP (RFC 4120 §5.4.2) ───────────────────────────

export function encodeKdcRep(rep: KdcRep): Uint8Array {
  const parts = [
    explicit(0, encodeInteger(KRB_PVNO)),
    explicit(1, encodeInteger(REP_MSG_TYPE[rep.msgType])),
  ];
  if (rep.padata.length > 0) parts.push(explicit(2, encodePaDataSeq(rep.padata)));
  parts.push(explicit(3, encodeOctetString(rep.crealm)));
  parts.push(explicit(4, encodePrincipalName(rep.cname)));
  parts.push(explicit(5, encodeTicket(rep.ticket)));
  parts.push(explicit(6, encodeEncryptedData(rep.encPart)));
  return encodeApplication(REP_APP_TAG[rep.msgType], true, encodeSequence(parts));
}

export function decodeKdcRep(bytes: Uint8Array): KdcRep {
  const app = parseTLV(bytes, 0);
  const msgType = app.tagNumber === REP_APP_TAG['AS-REP'] ? 'AS-REP' : 'TGS-REP';
  const seq = parseTLV(app.content, 0);
  const fields = fieldsOf(seq.content);
  const padataNode = fields.get(2);
  return {
    msgType,
    padata: padataNode ? decodePaDataSeq(padataNode) : [],
    crealm: decodeOctetString(fields.get(3)!.content),
    cname: decodePrincipalName(fields.get(4)!),
    ticket: decodeTicket(encodeApplicationBytesOf(fields.get(5)!)),
    encPart: decodeEncryptedData(fields.get(6)!),
  };
}

/** `fieldsOf` already peeled the Ticket's own [APPLICATION 1] tag via `fieldsOf`'s single unwrap — re-serialize so `decodeTicket` (which expects the full APPLICATION-tagged bytes) can be reused unchanged. */
function encodeApplicationBytesOf(node: ParsedTLV): Uint8Array {
  return encodeTLV('application', node.tagNumber, node.constructed, node.content);
}

export function encodeEncKdcRepPart(msgType: KdcRep['msgType'], e: EncKdcRepPart): Uint8Array {
  const parts = [
    explicit(0, encodeEncryptionKey(e.key)),
    explicit(1, encodeSequence([])), // last-req — always empty (real KDCs may legitimately send none)
    explicit(2, encodeInteger(e.nonce)),
    explicit(4, encodeTicketFlags(e.flags)),
    explicit(5, encodeKerberosTime(e.authtime)),
  ];
  if (e.starttime !== undefined) parts.push(explicit(6, encodeKerberosTime(e.starttime)));
  parts.push(explicit(7, encodeKerberosTime(e.endtime)));
  if (e.renewTill !== undefined) parts.push(explicit(8, encodeKerberosTime(e.renewTill)));
  parts.push(explicit(9, encodeOctetString(e.srealm)));
  parts.push(explicit(10, encodePrincipalName(e.sname)));
  return encodeApplication(REP_ENC_PART_APP_TAG[msgType], true, encodeSequence(parts));
}

export function decodeEncKdcRepPart(bytes: Uint8Array): EncKdcRepPart {
  const app = parseTLV(bytes, 0);
  const seq = parseTLV(app.content, 0);
  const fields = fieldsOf(seq.content);
  const starttimeNode = fields.get(6);
  const renewTillNode = fields.get(8);
  return {
    key: decodeEncryptionKey(fields.get(0)!),
    nonce: decodeInteger(fields.get(2)!.content),
    flags: decodeTicketFlags(fields.get(4)!.content),
    authtime: decodeKerberosTime(fields.get(5)!.content),
    starttime: starttimeNode ? decodeKerberosTime(starttimeNode.content) : undefined,
    endtime: decodeKerberosTime(fields.get(7)!.content),
    renewTill: renewTillNode ? decodeKerberosTime(renewTillNode.content) : undefined,
    srealm: decodeOctetString(fields.get(9)!.content),
    sname: decodePrincipalName(fields.get(10)!),
  };
}

// ─── KRB-ERROR (RFC 4120 §5.9.1) ─────────────────────────────────────────────

export function encodeKrbError(err: KrbError): Uint8Array {
  const parts = [
    explicit(0, encodeInteger(KRB_PVNO)),
    explicit(1, encodeInteger(30)),
    explicit(4, encodeKerberosTime(err.stime)),
    explicit(5, encodeInteger(err.susec)),
    explicit(6, encodeInteger(err.errorCode)),
    explicit(9, encodeOctetString(err.realm)),
    explicit(10, encodePrincipalName(err.sname)),
  ];
  if (err.eText !== undefined) parts.push(explicit(11, encodeOctetString(err.eText)));
  return encodeApplication(30, true, encodeSequence(parts));
}

export function decodeKrbError(bytes: Uint8Array): KrbError {
  const app = parseTLV(bytes, 0);
  const seq = parseTLV(app.content, 0);
  const fields = fieldsOf(seq.content);
  const eTextNode = fields.get(11);
  return {
    stime: decodeKerberosTime(fields.get(4)!.content),
    susec: decodeInteger(fields.get(5)!.content),
    errorCode: decodeInteger(fields.get(6)!.content),
    realm: decodeOctetString(fields.get(9)!.content),
    sname: decodePrincipalName(fields.get(10)!),
    eText: eTextNode ? decodeOctetString(eTextNode.content) : undefined,
  };
}

/** RFC 4120 §5.10 — every KDC reply on the wire is either a KDC-REP or a KRB-ERROR; the application tag alone disambiguates. */
export function isKrbError(bytes: Uint8Array): boolean {
  return parseTLV(bytes, 0).tagNumber === 30;
}

// ─── Authenticator / AP-REQ (RFC 4120 §5.5.1) ───────────────────────────────
// cksum/subkey/seq-number/authorization-data omitted — no cross-realm
// authorization data or session-key renegotiation modeled yet (PRD scope).

export function encodeAuthenticator(a: Authenticator): Uint8Array {
  const body = encodeSequence([
    explicit(0, encodeInteger(KRB_PVNO)),
    explicit(1, encodeOctetString(a.crealm)),
    explicit(2, encodePrincipalName(a.cname)),
    explicit(4, encodeInteger(a.cusec)),
    explicit(5, encodeKerberosTime(a.ctime)),
  ]);
  return encodeApplication(2, true, body);
}

export function decodeAuthenticator(bytes: Uint8Array): Authenticator {
  const app = parseTLV(bytes, 0);
  const seq = parseTLV(app.content, 0);
  const fields = fieldsOf(seq.content);
  return {
    crealm: decodeOctetString(fields.get(1)!.content),
    cname: decodePrincipalName(fields.get(2)!),
    cusec: decodeInteger(fields.get(4)!.content),
    ctime: decodeKerberosTime(fields.get(5)!.content),
  };
}

export function encodeApReq(req: ApReq): Uint8Array {
  const body = encodeSequence([
    explicit(0, encodeInteger(KRB_PVNO)),
    explicit(1, encodeInteger(14)),
    explicit(2, encodeBitmask32(req.apOptions)),
    explicit(3, encodeTicket(req.ticket)),
    explicit(4, encodeEncryptedData(req.authenticator)),
  ]);
  return encodeApplication(14, true, body);
}

export function decodeApReq(bytes: Uint8Array): ApReq {
  const app = parseTLV(bytes, 0);
  const seq = parseTLV(app.content, 0);
  const fields = fieldsOf(seq.content);
  return {
    apOptions: decodeBitmask32(fields.get(2)!.content),
    ticket: decodeTicket(encodeApplicationBytesOf(fields.get(3)!)),
    authenticator: decodeEncryptedData(fields.get(4)!),
  };
}
