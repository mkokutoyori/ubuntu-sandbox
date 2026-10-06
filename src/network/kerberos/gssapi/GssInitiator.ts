import { systemRandom, type RandomSource } from '@/crypto/random';
import { decodeApRep, decodeEncApRepPart, encodeApReq, encodeAuthenticator } from '../codec';
import { AES256_CTS_HMAC_SHA1_96, KU_AP_REP_ENC_PART, KU_AP_REQ_AUTHENTICATOR, decryptWithUsage, encryptWithUsage } from '../crypto';
import { AP_OPT_MUTUAL_REQUIRED, type PrincipalName, type Ticket } from '../types';
import { GSS_C_MUTUAL_FLAG, GSS_C_TRANS_FLAG, TOKEN_ID_AP_REP, TOKEN_ID_AP_REQ, frameInitialContextToken, parseInitialContextToken } from './GssToken';
import { GssSecurityContext } from './GssSecurityContext';

export const CHECKSUM_TYPE_GSSAPI = 0x8003;

const BINDING_BYTES = 16;
const SEQUENCE_MASK = 0x7fffffff;
const SESSION_KEY_BYTES = 32;

export interface GssClock {
  nowMicroseconds(): number;
}

export interface GssCredential {
  readonly ticket: Ticket;
  readonly sessionKey: Uint8Array;
  readonly clientName: PrincipalName;
  readonly clientRealm: string;
}

export interface GssInitiatorOptions {
  readonly credential: GssCredential;
  readonly requestedFlags: number;
  readonly clock: GssClock;
  readonly random?: RandomSource;
}

export type GssStep =
  | { readonly kind: 'continue'; readonly output: Uint8Array }
  | { readonly kind: 'complete'; readonly output: Uint8Array | null }
  | { readonly kind: 'error'; readonly message: string };

function checksumValue(flags: number): Uint8Array {
  const value = new Uint8Array(4 + BINDING_BYTES + 4);
  const view = new DataView(value.buffer);
  view.setUint32(0, BINDING_BYTES, true);
  view.setUint32(4 + BINDING_BYTES, flags, true);
  return value;
}

export class GssInitiator {
  private state: 'start' | 'awaiting-reply' | 'established' | 'failed' = 'start';
  private sent: { ctime: number; cusec: number; subkey: Uint8Array; sequence: number } | null = null;
  private established: GssSecurityContext | null = null;
  private readonly random: RandomSource;

  constructor(private readonly options: GssInitiatorOptions) {
    this.random = options.random ?? systemRandom;
  }

  get flags(): number {
    return this.options.requestedFlags | GSS_C_TRANS_FLAG;
  }

  get securityContext(): GssSecurityContext | null {
    return this.established;
  }

  step(input: Uint8Array | null): GssStep {
    if (this.state === 'start') return this.start();
    if (this.state === 'awaiting-reply' && input !== null) return this.finish(input);
    return this.fail('the context is not in a state that accepts this token');
  }

  private fail(message: string): GssStep {
    this.state = 'failed';
    return { kind: 'error', message };
  }

  private start(): GssStep {
    const { credential } = this.options;
    const microseconds = this.options.clock.nowMicroseconds();
    const ctime = Math.floor(microseconds / 1_000_000);
    const cusec = microseconds % 1_000_000;
    const subkey = this.random(SESSION_KEY_BYTES);
    const sequence = new DataView(this.random(4).buffer).getUint32(0, false) & SEQUENCE_MASK;
    const authenticator = encodeAuthenticator({
      crealm: credential.clientRealm,
      cname: credential.clientName,
      cksum: { type: CHECKSUM_TYPE_GSSAPI, checksum: checksumValue(this.flags) },
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

  private finish(input: Uint8Array): GssStep {
    const token = parseInitialContextToken(input);
    if (token === null || token.tokenId !== TOKEN_ID_AP_REP) return this.fail('the reply is not an AP-REP token');
    try {
      const part = decodeEncApRepPart(
        decryptWithUsage(this.options.credential.sessionKey, KU_AP_REP_ENC_PART, decodeApRep(token.body).encPart.cipher),
      );
      if (part.ctime !== this.sent!.ctime || part.cusec !== this.sent!.cusec) {
        return this.fail('the AP-REP does not echo the time of the authenticator');
      }
      this.establish(part);
    } catch {
      return this.fail('the AP-REP cannot be decrypted');
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
