import { md4 } from '@/crypto/hash/md4';
import { desEncryptBlock } from '@/crypto/cipher/des';
import {
  SASL_CU_AUTHID, SASL_CU_AUTHZID, SaslFeat, SaslRc, SaslSec,
  type ClientMechanism, type ClientMechanismSession, type SaslClientParams, type SaslInteract, type StepOutcome,
} from '../saslTypes';
import { getAuthid, isFatal, makePrompts } from '../pluginUtils';

const SIGNATURE = new Uint8Array([0x4e, 0x54, 0x4c, 0x4d, 0x53, 0x53, 0x50, 0x00]);
const TYPE_REQUEST = 1;
const TYPE_CHALLENGE = 2;
const TYPE_RESPONSE = 3;
const USE_UNICODE = 0x00001;
const USE_ASCII = 0x00002;
const ASK_TARGET = 0x00004;
const AUTH_NTLM = 0x00200;
const FLAGS_MASK = 0x0ffff;
const NONCE_LENGTH = 8;
const HASH_LENGTH = 21;
const RESP_LENGTH = 24;
const TYPE1_DOMAIN_OFFSET = 16;
const TYPE1_WORKSTN_OFFSET = 24;
const TYPE1_DATA_OFFSET = 32;
const TYPE1_FLAGS_OFFSET = 12;
const TYPE2_TARGET_OFFSET = 12;
const TYPE2_FLAGS_OFFSET = 20;
const TYPE2_CHALLENGE_OFFSET = 24;
const TYPE2_MINSIZE = 32;
const TYPE3_LMRESP_OFFSET = 12;
const TYPE3_NTRESP_OFFSET = 20;
const TYPE3_DOMAIN_OFFSET = 28;
const TYPE3_USER_OFFSET = 36;
const TYPE3_WORKSTN_OFFSET = 44;
const TYPE3_SESSIONKEY_OFFSET = 52;
const TYPE3_FLAGS_OFFSET = 60;
const TYPE3_DATA_OFFSET = 64;

function putShort(target: Uint8Array, offset: number, value: number): void {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >> 8) & 0xff;
}

function putLong(target: Uint8Array, offset: number, value: number): void {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
  target[offset + 2] = (value >>> 16) & 0xff;
  target[offset + 3] = (value >>> 24) & 0xff;
}

function getShort(source: Uint8Array, offset: number): number {
  return source[offset] | (source[offset + 1] << 8);
}

function getLong(source: Uint8Array, offset: number): number {
  return (source[offset] | (source[offset + 1] << 8) | (source[offset + 2] << 16) | (source[offset + 3] << 24)) >>> 0;
}

function toUnicode(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length * 2);
  bytes.forEach((byte, index) => { out[index * 2] = byte; });
  return out;
}

function upperCase(bytes: Uint8Array): Uint8Array {
  return bytes.map((byte) => (byte >= 0x61 && byte <= 0x7a ? byte - 0x20 : byte));
}

function setOddParity(key: Uint8Array): void {
  for (let index = 0; index < key.length; index++) {
    let ones = 0;
    for (let bit = 1; bit < 8; bit++) ones += (key[index] >> bit) & 1;
    key[index] = (key[index] & 0xfe) | (ones % 2 === 0 ? 1 : 0);
  }
}

function desEcb(key: Uint8Array, data: Uint8Array): Uint8Array {
  const sevenByteKeys = key.length / 7;
  const out = new Uint8Array(sevenByteKeys * data.length);
  for (let part = 0; part < sevenByteKeys; part++) {
    const k = key.subarray(part * 7, part * 7 + 7);
    const k64 = new Uint8Array([
      k[0],
      ((k[0] << 7) & 0xff) | (k[1] >> 1),
      ((k[1] << 6) & 0xff) | (k[2] >> 2),
      ((k[2] << 5) & 0xff) | (k[3] >> 3),
      ((k[3] << 4) & 0xff) | (k[4] >> 4),
      ((k[4] << 3) & 0xff) | (k[5] >> 5),
      ((k[5] << 2) & 0xff) | (k[6] >> 6),
      (k[6] << 1) & 0xff,
    ]);
    setOddParity(k64);
    for (let block = 0; block < data.length; block += 8) {
      out.set(desEncryptBlock(k64, data.subarray(block, block + 8)), part * data.length + block);
    }
  }
  return out;
}

function lmHash(password: Uint8Array): Uint8Array {
  const p14 = new Uint8Array(14);
  p14.set(upperCase(password.subarray(0, 14)));
  return desEcb(p14, new Uint8Array([0x4b, 0x47, 0x53, 0x21, 0x40, 0x23, 0x24, 0x25]));
}

function ntHash(password: Uint8Array): Uint8Array {
  return md4(toUnicode(password));
}

function response(hash16: Uint8Array, challenge: Uint8Array): Uint8Array {
  const p21 = new Uint8Array(HASH_LENGTH);
  p21.set(hash16);
  return desEcb(p21, challenge);
}

function loadBuffer(
  message: Uint8Array, slot: number, content: Uint8Array | null, unicode: boolean, cursor: { offset: number },
): void {
  let bytes = content ?? new Uint8Array(0);
  if (bytes.length > 0) {
    if (unicode) bytes = toUnicode(bytes);
    message.set(bytes, cursor.offset);
  }
  putShort(message, slot, bytes.length);
  putShort(message, slot + 2, bytes.length);
  putLong(message, slot + 4, cursor.offset);
  cursor.offset += bytes.length;
}

function createRequest(): Uint8Array {
  const message = new Uint8Array(TYPE1_DATA_OFFSET);
  message.set(SIGNATURE, 0);
  putLong(message, 8, TYPE_REQUEST);
  putLong(message, TYPE1_FLAGS_OFFSET, USE_UNICODE | USE_ASCII | ASK_TARGET | AUTH_NTLM);
  const cursor = { offset: TYPE1_DATA_OFFSET };
  loadBuffer(message, TYPE1_DOMAIN_OFFSET, null, false, cursor);
  loadBuffer(message, TYPE1_WORKSTN_OFFSET, null, false, cursor);
  return message;
}

function createResponse(
  lmResp: Uint8Array | null, ntResp: Uint8Array | null, domain: Uint8Array | null, user: Uint8Array, flags: number,
): Uint8Array {
  const unicodeFactor = (flags & USE_UNICODE) !== 0 ? 2 : 1;
  const length = TYPE3_DATA_OFFSET + unicodeFactor * ((domain?.length ?? 0) + user.length)
    + (lmResp === null ? 0 : RESP_LENGTH) + (ntResp === null ? 0 : RESP_LENGTH);
  const message = new Uint8Array(length);
  message.set(SIGNATURE, 0);
  putLong(message, 8, TYPE_RESPONSE);
  const cursor = { offset: TYPE3_DATA_OFFSET };
  loadBuffer(message, TYPE3_LMRESP_OFFSET, lmResp, false, cursor);
  loadBuffer(message, TYPE3_NTRESP_OFFSET, ntResp, false, cursor);
  loadBuffer(message, TYPE3_DOMAIN_OFFSET, domain === null ? null : upperCase(domain), (flags & USE_UNICODE) !== 0, cursor);
  loadBuffer(message, TYPE3_USER_OFFSET, user, (flags & USE_UNICODE) !== 0, cursor);
  loadBuffer(message, TYPE3_WORKSTN_OFFSET, null, (flags & USE_UNICODE) !== 0, cursor);
  loadBuffer(message, TYPE3_SESSIONKEY_OFFSET, null, false, cursor);
  putLong(message, TYPE3_FLAGS_OFFSET, flags);
  return message;
}

function unloadBuffer(
  slot: number, unicode: boolean, message: Uint8Array,
): { rc: number; text: Uint8Array | null } {
  let length = getShort(message, slot);
  if (length === 0) return { rc: SaslRc.OK, text: null };
  const offset = getLong(message, slot + 4);
  if (offset > message.length || length > message.length - offset) return { rc: SaslRc.BADPROT, text: null };
  if (unicode) {
    length = length >> 1;
    const text = new Uint8Array(length);
    for (let index = 0; index < length; index++) text[index] = message[offset + index * 2] & 0x7f;
    return { rc: SaslRc.OK, text };
  }
  return { rc: SaslRc.OK, text: message.slice(offset, offset + length) };
}

function ntlmSession(): ClientMechanismSession {
  let state = 1;

  function step1(params: SaslClientParams): StepOutcome {
    if (params.props.minSsf > params.externalSsf) {
      params.seterror('SSF requested of NTLM plugin');
      return { rc: SaslRc.TOOWEAK };
    }
    state = 2;
    return { rc: SaslRc.CONTINUE, out: createRequest() };
  }

  function step2(params: SaslClientParams, serverIn: Uint8Array | null, prompts: SaslInteract[] | null): StepOutcome {
    if (serverIn === null || serverIn.length < TYPE2_MINSIZE
      || !SIGNATURE.every((byte, index) => serverIn[index] === byte) || getLong(serverIn, 8) !== TYPE_CHALLENGE) {
      params.seterror("server didn't issue valid NTLM challenge");
      return { rc: SaslRc.BADPROT };
    }
    let authResult: number = SaslRc.OK;
    let passResult: number = SaslRc.OK;
    let authid: string | null = null;
    if (params.oparams.authid === null) {
      const got = getAuthid(params, prompts);
      authResult = got.rc;
      authid = got.value;
      if (isFatal(authResult)) return { rc: authResult };
    }
    const gotPassword = params.getPassword(prompts);
    passResult = gotPassword.rc;
    if (isFatal(passResult)) return { rc: passResult };
    if (authResult === SaslRc.INTERACT || passResult === SaslRc.INTERACT) {
      return {
        rc: SaslRc.INTERACT,
        prompts: makePrompts({
          authPrompt: authResult === SaslRc.INTERACT ? 'Please enter your authentication name' : undefined,
          passPrompt: passResult === SaslRc.INTERACT ? 'Please enter your password' : undefined,
        }),
      };
    }
    const canon = params.canonUser(authid ?? '', SASL_CU_AUTHID | SASL_CU_AUTHZID);
    if (canon !== SaslRc.OK) return { rc: canon };
    const flags = getLong(serverIn, TYPE2_FLAGS_OFFSET) & FLAGS_MASK;
    const domain = unloadBuffer(TYPE2_TARGET_OFFSET, (flags & USE_UNICODE) !== 0, serverIn);
    if (domain.rc !== SaslRc.OK) return { rc: domain.rc };
    const password = gotPassword.value ?? new Uint8Array(0);
    const challenge = serverIn.subarray(TYPE2_CHALLENGE_OFFSET, TYPE2_CHALLENGE_OFFSET + NONCE_LENGTH);
    let lmResp: Uint8Array | null = null;
    let ntResp: Uint8Array | null = null;
    if ((flags & AUTH_NTLM) !== 0) ntResp = response(ntHash(password), challenge);
    else lmResp = response(lmHash(password), challenge);
    const out = createResponse(lmResp, ntResp, domain.text, new TextEncoder().encode(params.oparams.authid ?? ''), flags);
    params.oparams.done = true;
    params.oparams.mechSsf = 0;
    params.oparams.maxOutbuf = 0;
    params.oparams.encode = null;
    params.oparams.decode = null;
    return { rc: SaslRc.OK, out };
  }

  return {
    step(params, serverIn, prompts): StepOutcome {
      switch (state) {
        case 1: return step1(params);
        case 2: return step2(params, serverIn, prompts);
        default: return { rc: SaslRc.FAIL };
      }
    },
  };
}

export const ntlmMechanism: ClientMechanism = {
  name: 'NTLM',
  maxSsf: 0,
  securityFlags: SaslSec.NOPLAINTEXT | SaslSec.NOANONYMOUS,
  features: SaslFeat.WANT_CLIENT_FIRST | SaslFeat.SUPPORTS_HTTP,
  requiredPrompts: null,
  create: () => ntlmSession(),
};
