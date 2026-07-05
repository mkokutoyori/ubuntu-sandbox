/**
 * Kerberos V5 (RFC 4120) — core message shapes (PRD-Windows-Server-Advanced.md
 * §2.1.1/§2.1.2). Field names/tag structure follow the RFC's ASN.1 module
 * (§5) so `codec.ts`'s encode/decode functions map onto them directly;
 * fields this simulator's scope doesn't need (from/rtime/addresses/
 * enc-authorization-data/additional-tickets on KDC-REQ-BODY, most of
 * HostAddresses/AuthorizationData) are simply omitted rather than modeled
 * as always-empty.
 */

// RFC 4120 §6.2 — name-type values this simulator actually produces.
export const enum PrincipalNameType {
  NT_UNKNOWN = 0,
  NT_PRINCIPAL = 1,
  NT_SRV_INST = 2,
  NT_SRV_HST = 3,
}

export interface PrincipalName {
  readonly nameType: number;
  readonly nameString: readonly string[];
}

export interface EncryptionKey {
  readonly keyType: number;
  readonly keyValue: Uint8Array;
}

export interface EncryptedData {
  readonly etype: number;
  readonly kvno?: number;
  readonly cipher: Uint8Array;
}

// RFC 4120 §5.2.8 — only the bits this simulator sets/reads.
export interface TicketFlags {
  readonly forwardable: boolean;
  readonly forwarded: boolean;
  readonly proxiable: boolean;
  readonly proxy: boolean;
  readonly renewable: boolean;
  readonly initial: boolean;
  readonly preAuthent: boolean;
  readonly hwAuthent: boolean;
}

export const NO_TICKET_FLAGS: TicketFlags = {
  forwardable: false, forwarded: false, proxiable: false, proxy: false,
  renewable: false, initial: false, preAuthent: false, hwAuthent: false,
};

export interface Ticket {
  readonly tktVno: number;
  readonly realm: string;
  readonly sname: PrincipalName;
  readonly encPart: EncryptedData; // encrypts an EncTicketPart
}

export interface EncTicketPart {
  readonly flags: TicketFlags;
  readonly key: EncryptionKey;
  readonly crealm: string;
  readonly cname: PrincipalName;
  readonly authtime: number; // epoch seconds
  readonly starttime?: number;
  readonly endtime: number;
  readonly renewTill?: number;
}

export interface PaData {
  readonly type: number;
  readonly value: Uint8Array;
}

// RFC 4120 §7.5.2 — the only padata-type values this simulator produces/reads.
export const PA_TGS_REQ = 1;
export const PA_ENC_TIMESTAMP = 2;

export interface KdcReqBody {
  readonly kdcOptions: number;
  readonly cname?: PrincipalName;
  readonly realm: string;
  readonly sname: PrincipalName;
  readonly till: number;
  readonly nonce: number;
  readonly etype: readonly number[];
}

export interface KdcReq {
  readonly msgType: 'AS-REQ' | 'TGS-REQ';
  readonly padata: readonly PaData[];
  readonly reqBody: KdcReqBody;
}

export interface EncKdcRepPart {
  readonly key: EncryptionKey;
  readonly nonce: number;
  readonly flags: TicketFlags;
  readonly authtime: number;
  readonly starttime?: number;
  readonly endtime: number;
  readonly renewTill?: number;
  readonly srealm: string;
  readonly sname: PrincipalName;
}

export interface KdcRep {
  readonly msgType: 'AS-REP' | 'TGS-REP';
  readonly padata: readonly PaData[];
  readonly crealm: string;
  readonly cname: PrincipalName;
  readonly ticket: Ticket;
  readonly encPart: EncryptedData; // encrypts an EncKdcRepPart
}

// RFC 4120 §7.5.9 — only the codes this simulator's KDC actually emits.
export const enum KrbErrorCode {
  KDC_ERR_NAME_EXP = 1,
  KDC_ERR_C_PRINCIPAL_UNKNOWN = 6,
  KDC_ERR_S_PRINCIPAL_UNKNOWN = 7,
  KDC_ERR_ETYPE_NOSUPP = 14,
  KDC_ERR_PREAUTH_FAILED = 24,
  KDC_ERR_PREAUTH_REQUIRED = 25,
  KRB_AP_ERR_TKT_EXPIRED = 32,
}

export interface KrbError {
  readonly stime: number;
  readonly susec: number;
  readonly errorCode: number;
  readonly realm: string;
  readonly sname: PrincipalName;
  readonly eText?: string;
}

export function principalName(nameType: number, ...parts: string[]): PrincipalName {
  return { nameType, nameString: parts };
}

export function principalNameToString(p: PrincipalName): string {
  return p.nameString.join('/');
}
