import { hmac } from '@/crypto/mac/hmac';
import { pbkdf2 } from '@/crypto/kdf/pbkdf2';
import { SHA1, SHA224, SHA256, SHA384, SHA512, type HashAlgorithm } from '@/crypto/hash';
import { b64Ntop } from '../../base64';
import {
  SASL_CU_AUTHID, SASL_CU_AUTHZID, SaslFeat, SaslRc, SaslSec, hashStrengthBits,
  type ClientMechanism, type ClientMechanismSession, type SaslClientParams, type SaslInteract, type StepOutcome,
} from '../saslTypes';
import { getAuthid, getUserid, isFatal, makePrompts, saslDecode64 } from '../pluginUtils';

const NONCE_SIZE = 32;
const MAX_ITERATION_COUNTER = 0x10000;
const MAX_SERVERIN_LEN = 2048;
const CLIENT_KEY_CONSTANT = 'Client Key';
const SERVER_KEY_CONSTANT = 'Server Key';

const encoder = new TextEncoder();

interface ScramVariant {
  readonly name: string;
  readonly hash: HashAlgorithm;
  readonly bits: number;
}

const VARIANTS: readonly ScramVariant[] = [
  { name: 'SCRAM-SHA-512', hash: SHA512, bits: 512 },
  { name: 'SCRAM-SHA-384', hash: SHA384, bits: 384 },
  { name: 'SCRAM-SHA-256', hash: SHA256, bits: 256 },
  { name: 'SCRAM-SHA-224', hash: SHA224, bits: 224 },
  { name: 'SCRAM-SHA-1', hash: SHA1, bits: 160 },
];

function latin1(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('latin1');
}

function latin1Bytes(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'latin1'));
}

function encodeSaslname(name: string): string {
  return name.replace(/=/g, '=3D').replace(/,/g, '=2C');
}

function strtoulDecimal(text: string): number | null {
  const match = /^[ \t\n\v\f\r]*[+]?([0-9]+)/.exec(text);
  if (match === null || match[0].length !== text.length) return null;
  const value = Number(match[1]);
  return value > 0xffffffff ? null : value;
}

function xor(left: Uint8Array, right: Uint8Array): Uint8Array {
  return left.map((byte, index) => byte ^ right[index]);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function scramSession(variant: ScramVariant): ClientMechanismSession {
  let state = 0;
  let password: Uint8Array | null = null;
  let nonce = '';
  let gs2Header = '';
  let authMessage = '';
  let saltedPassword: Uint8Array = new Uint8Array(0);

  function step1(params: SaslClientParams, prompts: SaslInteract[] | null): StepOutcome {
    if (params.props.minSsf > params.externalSsf) {
      params.seterror(`SSF requested of ${variant.name} plugin`);
      return { rc: SaslRc.TOOWEAK };
    }
    let authResult: number = SaslRc.OK;
    let userResult: number = SaslRc.OK;
    let passResult: number = SaslRc.OK;
    let authid: string | null = null;
    let userid: string | null = null;
    if (params.oparams.authid === null) {
      const got = getAuthid(params, prompts);
      authResult = got.rc;
      authid = got.value;
      if (isFatal(authResult)) return { rc: authResult };
    }
    if (params.oparams.user === null) {
      const got = getUserid(params, prompts);
      userResult = got.rc;
      userid = got.value;
      if (isFatal(userResult)) return { rc: userResult };
    }
    if (password === null) {
      const got = params.getPassword(prompts);
      passResult = got.rc;
      password = got.value;
      if (isFatal(passResult)) return { rc: passResult };
    }
    if (authResult === SaslRc.INTERACT || userResult === SaslRc.INTERACT || passResult === SaslRc.INTERACT) {
      return {
        rc: SaslRc.INTERACT,
        prompts: makePrompts({
          userPrompt: userResult === SaslRc.INTERACT ? 'Please enter your authorization name' : undefined,
          authPrompt: authResult === SaslRc.INTERACT ? 'Please enter your authentication name' : undefined,
          passPrompt: passResult === SaslRc.INTERACT ? 'Please enter your password' : undefined,
        }),
      };
    }
    if (password === null) {
      params.seterror('Parameter error in scram.c');
      return { rc: SaslRc.BADPARAM };
    }
    if (params.oparams.authid === null) {
      let result: number;
      if (userid === null || userid === '') {
        result = params.canonUser(authid ?? '', SASL_CU_AUTHID | SASL_CU_AUTHZID);
      } else {
        result = params.canonUser(authid ?? '', SASL_CU_AUTHID);
        if (result !== SaslRc.OK) return { rc: result };
        result = params.canonUser(userid, SASL_CU_AUTHZID);
      }
      if (result !== SaslRc.OK) return { rc: result };
    }
    nonce = b64Ntop(params.random((NONCE_SIZE / 4) * 3));
    const authorization = userid !== null && userid !== '' ? `a=${encodeSaslname(params.oparams.user ?? '')}` : '';
    gs2Header = `n,${authorization},`;
    authMessage = `n=${encodeSaslname(params.oparams.authid ?? '')},r=${nonce}`;
    return { rc: SaslRc.CONTINUE, out: latin1Bytes(gs2Header + authMessage) };
  }

  function step2(params: SaslClientParams, serverIn: Uint8Array): StepOutcome {
    if (serverIn.length === 0) {
      params.seterror(`${variant.name} input expected`);
      return { rc: SaslRc.BADPROT };
    }
    const input = latin1(serverIn);
    if (serverIn.length < 3 || input[1] !== '=') {
      params.seterror(`Invalid ${variant.name} input`);
      return { rc: SaslRc.BADPROT };
    }
    if (input[0] === 'm') {
      params.seterror(`Unsupported mandatory extension to ${variant.name}`);
      return { rc: SaslRc.BADPROT };
    }
    if (input[0] !== 'r') {
      params.seterror(`Nonce (r=) expected in ${variant.name} input`);
      return { rc: SaslRc.BADPROT };
    }
    if (input.includes('\0')) {
      params.seterror(`NULs found in ${variant.name} input`);
      return { rc: SaslRc.BADPROT };
    }
    const nonceEnd = input.indexOf(',', 2);
    if (nonceEnd < 0) {
      params.seterror(`Salt expected after the nonce in ${variant.name} input`);
      return { rc: SaslRc.BADPROT };
    }
    const serverNonce = input.slice(2, nonceEnd);
    const afterNonce = input.slice(nonceEnd + 1);
    if (!afterNonce.startsWith('s=')) {
      params.seterror(`Salt expected after the nonce in ${variant.name} input`);
      return { rc: SaslRc.BADPROT };
    }
    const saltEnd = afterNonce.indexOf(',', 2);
    if (saltEnd < 0) {
      params.seterror(`iteration-count expected after the salt in ${variant.name} input`);
      return { rc: SaslRc.BADPROT };
    }
    const base64Salt = afterNonce.slice(2, saltEnd);
    const afterSalt = afterNonce.slice(saltEnd + 1);
    if (!afterSalt.startsWith('i=')) {
      params.seterror(`iteration-count expected after the salt in ${variant.name} input`);
      return { rc: SaslRc.BADPROT };
    }
    const counterEnd = afterSalt.indexOf(',', 2);
    const counterText = afterSalt.slice(2, counterEnd < 0 ? undefined : counterEnd);
    const iterations = strtoulDecimal(counterText);
    if (iterations === null) {
      params.seterror(`Invalid iteration-count in ${variant.name} input`);
      return { rc: SaslRc.BADPROT };
    }
    if (iterations > MAX_ITERATION_COUNTER) {
      params.seterror('iteration-count is too big, refusing to compute');
      return { rc: SaslRc.BADPROT };
    }
    if (serverNonce.length <= NONCE_SIZE || serverNonce.slice(0, NONCE_SIZE) !== nonce.slice(0, NONCE_SIZE)) {
      params.seterror("The nonce received from the server doesn't start from the nonce sent by the client");
      return { rc: SaslRc.BADPROT };
    }
    nonce = serverNonce;
    if (base64Salt.length === 0) {
      params.seterror("The salt can't be empty");
      return { rc: SaslRc.BADPROT };
    }
    if (base64Salt.length % 4 !== 0) {
      params.seterror('Invalid base64 encoding of the salt');
      return { rc: SaslRc.BADPROT };
    }
    const salt = saslDecode64(base64Salt, (base64Salt.length / 4) * 3 + 1);
    if (salt.rc !== SaslRc.OK || salt.bytes === null) {
      params.seterror(`Invalid base64 encoding of the salt in ${variant.name} input`);
      return { rc: SaslRc.BADPROT };
    }
    const channelBinding = b64Ntop(latin1Bytes(gs2Header));
    const clientFinalNoProof = `c=${channelBinding},r=${nonce}`;
    authMessage = `${authMessage},${input},${clientFinalNoProof}`;
    saltedPassword = pbkdf2(variant.hash, password ?? new Uint8Array(0), salt.bytes, iterations, variant.hash.digestSize);
    const clientKey = hmac(variant.hash, saltedPassword, encoder.encode(CLIENT_KEY_CONSTANT));
    const storedKey = variant.hash.digest(clientKey);
    const clientSignature = hmac(variant.hash, storedKey, latin1Bytes(authMessage));
    const clientProof = xor(clientKey, clientSignature);
    return { rc: SaslRc.CONTINUE, out: latin1Bytes(`${clientFinalNoProof},p=${b64Ntop(clientProof)}`) };
  }

  function step3(params: SaslClientParams, serverIn: Uint8Array): StepOutcome {
    if (serverIn.length < 3) {
      params.seterror(`Invalid ${variant.name} input expected`);
      return { rc: SaslRc.BADPROT };
    }
    const input = latin1(serverIn);
    if (!input.startsWith('v=')) {
      params.seterror(`ServerSignature expected in ${variant.name} input`);
      return { rc: SaslRc.BADPROT };
    }
    const comma = input.indexOf(',', 2);
    const proofLength = comma >= 0 ? comma - 2 - 1 : input.length - 2;
    const proof = saslDecode64(input.slice(2, 2 + proofLength), variant.hash.digestSize + 1);
    if (proof.rc !== SaslRc.OK || proof.bytes === null) {
      params.seterror(`Invalid base64 encoding of the server proof in ${variant.name} input`);
      return { rc: SaslRc.BADPROT };
    }
    if (proof.bytes.length !== variant.hash.digestSize) {
      params.seterror(`Invalid server proof (truncated) in ${variant.name} input`);
      return { rc: SaslRc.BADPROT };
    }
    const serverKey = hmac(variant.hash, saltedPassword, encoder.encode(SERVER_KEY_CONSTANT));
    const serverSignature = hmac(variant.hash, serverKey, latin1Bytes(authMessage));
    if (!sameBytes(proof.bytes, serverSignature)) {
      params.seterror('ServerSignature mismatch');
      return { rc: SaslRc.BADAUTH };
    }
    params.oparams.done = true;
    params.oparams.mechSsf = 0;
    params.oparams.maxOutbuf = 0;
    params.oparams.encode = null;
    params.oparams.decode = null;
    return { rc: SaslRc.OK };
  }

  return {
    step(params, serverIn, prompts): StepOutcome {
      if (serverIn !== null && serverIn.length > MAX_SERVERIN_LEN) {
        params.seterror(`${variant.name} input longer than ${MAX_SERVERIN_LEN} bytes`);
        return { rc: SaslRc.BADPROT };
      }
      const input = serverIn ?? new Uint8Array(0);
      let outcome: StepOutcome;
      switch (state) {
        case 0:
          outcome = step1(params, prompts);
          break;
        case 1:
          outcome = step2(params, input);
          break;
        case 2:
          outcome = step3(params, input);
          break;
        default:
          return { rc: SaslRc.FAIL };
      }
      if (outcome.rc !== SaslRc.INTERACT) state++;
      return outcome;
    },
  };
}

export const scramMechanisms: readonly ClientMechanism[] = VARIANTS.map((variant) => ({
  name: variant.name,
  maxSsf: 0,
  securityFlags: hashStrengthBits(variant.bits) | SaslSec.NOPLAINTEXT | SaslSec.NOANONYMOUS | SaslSec.NOACTIVE | SaslSec.MUTUAL_AUTH,
  features: SaslFeat.ALLOWS_PROXY | SaslFeat.SUPPORTS_HTTP | SaslFeat.CHANNEL_BINDING,
  requiredPrompts: null,
  create: () => scramSession(variant),
}));
