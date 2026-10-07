import { systemRandom, type RandomSource } from '@/crypto/random';
import { ApReplayCache, acceptApReq } from '../ApReqVerifier';
import { encodeApRep, encodeEncApRepPart } from '../codec';
import { AES256_CTS_HMAC_SHA1_96, KU_AP_REP_ENC_PART, encryptWithUsage } from '../crypto';
import { AP_OPT_MUTUAL_REQUIRED, KrbErrorCode } from '../types';
import type { GssClock } from './GssInitiator';
import { CHECKSUM_TYPE_GSSAPI } from './GssInitiator';
import { GssSecurityContext } from './GssSecurityContext';
import { GSS_C_SEQUENCE_FLAG, TOKEN_ID_AP_REP, TOKEN_ID_AP_REQ, frameInitialContextToken, parseInitialContextToken } from './GssToken';

const SESSION_KEY_BYTES = 32;
const SEQUENCE_MASK = 0x7fffffff;
const FLAGS_OFFSET = 4 + 16;

export interface GssAcceptorOptions {
  readonly serviceKey: Uint8Array;
  readonly clock: GssClock;
  readonly replayCache?: ApReplayCache;
  readonly random?: RandomSource;
}

export interface GssPeer {
  readonly name: readonly string[];
  readonly realm: string;
}

export type GssAcceptStep =
  | { readonly kind: 'complete'; readonly output: Uint8Array | null; readonly peer: GssPeer; readonly flags: number }
  | { readonly kind: 'error'; readonly errorCode: number; readonly message: string };

export class GssAcceptor {
  private established: GssSecurityContext | null = null;
  private readonly random: RandomSource;

  constructor(private readonly options: GssAcceptorOptions) {
    this.random = options.random ?? systemRandom;
  }

  get securityContext(): GssSecurityContext | null {
    return this.established;
  }

  step(input: Uint8Array): GssAcceptStep {
    const token = parseInitialContextToken(input);
    if (token === null || token.tokenId !== TOKEN_ID_AP_REQ) {
      return { kind: 'error', errorCode: KrbErrorCode.KRB_AP_ERR_BAD_INTEGRITY, message: 'the token is not an AP-REQ token' };
    }
    const nowSeconds = Math.floor(this.options.clock.nowMicroseconds() / 1_000_000);
    const outcome = acceptApReq(token.body, this.options.serviceKey, nowSeconds, this.options.replayCache);
    if (outcome.ok === false) return { kind: 'error', errorCode: outcome.errorCode, message: 'the AP-REQ is refused' };
    const { authenticator, ticketPart, apReq } = outcome.accepted;
    const checksum = authenticator.cksum;
    if (checksum === undefined || checksum.type !== CHECKSUM_TYPE_GSSAPI || checksum.checksum.length < FLAGS_OFFSET + 4) {
      return { kind: 'error', errorCode: KrbErrorCode.KRB_AP_ERR_BAD_INTEGRITY, message: 'the authenticator carries no GSS-API checksum' };
    }
    const flags = new DataView(checksum.checksum.buffer, checksum.checksum.byteOffset, checksum.checksum.length).getUint32(FLAGS_OFFSET, true);
    const mutual = (apReq.apOptions & AP_OPT_MUTUAL_REQUIRED) !== 0;
    const peer = { name: ticketPart.cname.nameString, realm: ticketPart.crealm };
    const initiatorSequence = authenticator.seqNumber;
    let acceptorSubkey: Uint8Array | undefined;
    let acceptorSequence = 0;
    let output: Uint8Array | null = null;
    if (mutual) {
      acceptorSubkey = this.random(SESSION_KEY_BYTES);
      acceptorSequence = new DataView(this.random(4).buffer).getUint32(0, false) & SEQUENCE_MASK;
      const part = encodeEncApRepPart({
        ctime: authenticator.ctime,
        cusec: authenticator.cusec,
        subkey: { keyType: AES256_CTS_HMAC_SHA1_96, keyValue: acceptorSubkey },
        seqNumber: acceptorSequence,
      });
      const cipher = encryptWithUsage(outcome.accepted.sessionKey, KU_AP_REP_ENC_PART, part, this.random);
      output = frameInitialContextToken(TOKEN_ID_AP_REP, encodeApRep({ encPart: { etype: AES256_CTS_HMAC_SHA1_96, cipher } }));
    }
    this.established = new GssSecurityContext({
      role: 'acceptor',
      key: acceptorSubkey ?? authenticator.subkey?.keyValue ?? outcome.accepted.sessionKey,
      usesAcceptorSubkey: acceptorSubkey !== undefined,
      sendSequence: acceptorSequence,
      receiveSequence: initiatorSequence ?? 0,
      sequenceChecking: (flags & GSS_C_SEQUENCE_FLAG) !== 0 && initiatorSequence !== undefined,
      random: this.random,
    });
    return { kind: 'complete', output, peer, flags };
  }
}
