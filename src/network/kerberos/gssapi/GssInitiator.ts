import { systemRandom, type RandomSource } from '@/crypto/random';
import { decodeApRep, decodeEncApRepPart, encodeApReq, encodeAuthenticator, encodeEncKrbCredPart, encodeKrbCred } from '../codec';
import {
  AES256_CTS_HMAC_SHA1_96, KU_AP_REP_ENC_PART, KU_AP_REQ_AUTHENTICATOR, KU_KRB_CRED_ENC_PART, decryptWithUsage, encryptWithUsage,
} from '../crypto';
import { AP_OPT_MUTUAL_REQUIRED, type KrbCredInfo, type PrincipalName, type Ticket } from '../types';
import {
  GSS_C_CONF_FLAG, GSS_C_DELEG_FLAG, GSS_C_INTEG_FLAG, GSS_C_MUTUAL_FLAG, GSS_C_REPLAY_FLAG, GSS_C_SEQUENCE_FLAG, GSS_C_TRANS_FLAG,
  TOKEN_ID_AP_REP, TOKEN_ID_AP_REQ, channelBindingsDigest, frameInitialContextToken, parseInitialContextToken,
} from './GssToken';
import { GssSecurityContext } from './GssSecurityContext';
import { GSS_S_DEFECTIVE_TOKEN, GSS_S_FAILURE, gssFailure, type GssFailure } from './GssStatus';

export const CHECKSUM_TYPE_GSSAPI = 0x8003;

const GRANTED_ON_REQUEST = GSS_C_MUTUAL_FLAG | GSS_C_REPLAY_FLAG | GSS_C_SEQUENCE_FLAG;
const LAYER_FLAGS = GSS_C_CONF_FLAG | GSS_C_INTEG_FLAG;
const BINDING_BYTES = 16;
const SEQUENCE_MASK = 0x7fffffff;
const SESSION_KEY_BYTES = 32;

export interface GssClock {
  nowMicroseconds(): number;
}

export interface ForwardedCredential {
  readonly ticket: Ticket;
  readonly info: KrbCredInfo;
}

export interface GssCredential {
  readonly ticket: Ticket;
  readonly sessionKey: Uint8Array;
  readonly clientName: PrincipalName;
  readonly clientRealm: string;
  readonly forwarded?: ForwardedCredential | null;
}

export interface GssInitiatorOptions {
  readonly credential: GssCredential;
  readonly requestedFlags: number;
  readonly layerFlagsOnlyWhenRequested?: boolean;
  readonly channelBindings?: Uint8Array | null;
  readonly clock: GssClock;
  readonly random?: RandomSource;
}

export type GssStep =
  | { readonly kind: 'continue'; readonly output: Uint8Array }
  | { readonly kind: 'complete'; readonly output: Uint8Array | null }
  | { readonly kind: 'error'; readonly failure: GssFailure };

const DELEGATION_OPTION = 1;
const DELEGATION_HEADER_BYTES = 4;

function checksumValue(flags: number, channelBindings: Uint8Array | null, delegation: Uint8Array | null): Uint8Array {
  const fixed = 4 + BINDING_BYTES + 4;
  const value = new Uint8Array(delegation === null ? fixed : fixed + DELEGATION_HEADER_BYTES + delegation.length);
  const view = new DataView(value.buffer);
  view.setUint32(0, BINDING_BYTES, true);
  value.set(channelBindingsDigest(channelBindings), 4);
  view.setUint32(4 + BINDING_BYTES, flags, true);
  if (delegation !== null) {
    view.setUint16(fixed, DELEGATION_OPTION, true);
    view.setUint16(fixed + 2, delegation.length, true);
    value.set(delegation, fixed + DELEGATION_HEADER_BYTES);
  }
  return value;
}

export interface GssContextInitiator {
  readonly flags: number;
  readonly clientDisplayName: string;
  readonly securityContext: GssSecurityContext | null;
  step(input: Uint8Array | null): GssStep;
}

export class GssInitiator implements GssContextInitiator {
  private state: 'start' | 'awaiting-reply' | 'established' | 'failed' = 'start';
  private sent: { ctime: number; cusec: number; subkey: Uint8Array; sequence: number } | null = null;
  private established: GssSecurityContext | null = null;
  private readonly random: RandomSource;

  constructor(private readonly options: GssInitiatorOptions) {
    this.random = options.random ?? systemRandom;
  }

  get flags(): number {
    const requested = this.options.requestedFlags;
    const delegated = this.options.credential.forwarded ? GSS_C_DELEG_FLAG : 0;
    if (this.options.layerFlagsOnlyWhenRequested === true) return (requested & (GRANTED_ON_REQUEST | LAYER_FLAGS)) | GSS_C_TRANS_FLAG | delegated;
    return (requested & GRANTED_ON_REQUEST) | LAYER_FLAGS | GSS_C_TRANS_FLAG | delegated;
  }

  get clientDisplayName(): string {
    const { clientName, clientRealm } = this.options.credential;
    return `${clientName.nameString.join('/')}@${clientRealm}`;
  }

  get securityContext(): GssSecurityContext | null {
    return this.established;
  }

  step(input: Uint8Array | null): GssStep {
    if (this.state === 'start') return this.start();
    if (this.state === 'awaiting-reply' && input !== null) return this.finish(input);
    return this.fail(gssFailure(GSS_S_FAILURE, 'Invalid context state'));
  }

  private fail(failure: GssFailure): GssStep {
    this.state = 'failed';
    return { kind: 'error', failure };
  }

  private start(): GssStep {
    const { credential } = this.options;
    const subkey = this.random(SESSION_KEY_BYTES);
    const drawn = new DataView(this.random(4).buffer).getUint32(0, false) & SEQUENCE_MASK;
    const delegation = credential.forwarded ? this.forwardingMessage(credential.forwarded, drawn) : null;
    const sequence = delegation === null ? drawn : (drawn + 1) & SEQUENCE_MASK;
    const microseconds = this.options.clock.nowMicroseconds();
    const ctime = Math.floor(microseconds / 1_000_000);
    const cusec = microseconds % 1_000_000;
    const authenticator = encodeAuthenticator({
      crealm: credential.clientRealm,
      cname: credential.clientName,
      cksum: { type: CHECKSUM_TYPE_GSSAPI, checksum: checksumValue(this.flags, this.options.channelBindings ?? null, delegation) },
      cusec,
      ctime,
      subkey: { keyType: AES256_CTS_HMAC_SHA1_96, keyValue: subkey },
      seqNumber: sequence,
    });
    const sealed = encryptWithUsage(credential.sessionKey, KU_AP_REQ_AUTHENTICATOR, authenticator, this.random);
    const mutual = (this.options.requestedFlags & GSS_C_MUTUAL_FLAG) !== 0;
    const apReq = encodeApReq({
      apOptions: mutual ? AP_OPT_MUTUAL_REQUIRED : 0,
      ticket: credential.ticket,
      authenticator: { etype: AES256_CTS_HMAC_SHA1_96, cipher: sealed },
    });
    this.sent = { ctime, cusec, subkey, sequence };
    const output = frameInitialContextToken(TOKEN_ID_AP_REQ, apReq);
    if (mutual) {
      this.state = 'awaiting-reply';
      return { kind: 'continue', output };
    }
    this.establish(null);
    return { kind: 'complete', output };
  }

  private forwardingMessage(forwarded: ForwardedCredential, nonce: number): Uint8Array {
    const microseconds = this.options.clock.nowMicroseconds();
    const part = encodeEncKrbCredPart({
      ticketInfo: [forwarded.info], nonce, timestamp: Math.floor(microseconds / 1_000_000), usec: microseconds % 1_000_000,
    });
    const cipher = encryptWithUsage(this.options.credential.sessionKey, KU_KRB_CRED_ENC_PART, part, this.random);
    return encodeKrbCred({ tickets: [forwarded.ticket], encPart: { etype: AES256_CTS_HMAC_SHA1_96, cipher } });
  }

  private finish(input: Uint8Array): GssStep {
    const token = parseInitialContextToken(input);
    if (token === null || token.tokenId !== TOKEN_ID_AP_REP) {
      return this.fail(gssFailure(GSS_S_DEFECTIVE_TOKEN, 'Token header is malformed or corrupt'));
    }
    try {
      const part = decodeEncApRepPart(
        decryptWithUsage(this.options.credential.sessionKey, KU_AP_REP_ENC_PART, decodeApRep(token.body).encPart.cipher),
      );
      if (part.ctime !== this.sent!.ctime || part.cusec !== this.sent!.cusec) {
        return this.fail(gssFailure(GSS_S_FAILURE, 'Mutual authentication failed'));
      }
      this.establish(part);
    } catch {
      return this.fail(gssFailure(GSS_S_FAILURE, 'Decrypt integrity check failed'));
    }
    return { kind: 'complete', output: null };
  }

  private establish(reply: { subkey?: { keyValue: Uint8Array }; seqNumber?: number } | null): void {
    const sent = this.sent!;
    const acceptorSubkey = reply?.subkey?.keyValue;
    this.established = new GssSecurityContext({
      role: 'initiator',
      key: acceptorSubkey ?? sent.subkey,
      usesAcceptorSubkey: acceptorSubkey !== undefined,
      sendSequence: sent.sequence,
      receiveSequence: reply?.seqNumber ?? 0,
      sequenceChecking: reply?.seqNumber !== undefined,
      random: this.random,
    });
    this.state = 'established';
  }
}
