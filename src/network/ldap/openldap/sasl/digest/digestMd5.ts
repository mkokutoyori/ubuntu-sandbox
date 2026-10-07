import { md5 } from '@/crypto/hash/md5';
import { b64Ntop } from '../../base64';
import {
  SASL_CU_AUTHID, SASL_CU_AUTHZID, SaslFeat, SaslRc, SaslSec,
  type ClientMechanism, type ClientMechanismSession, type SaslClientParams, type SaslInteract, type StepOutcome,
} from '../saslTypes';
import { getAuthid, getUserid, isFatal, makePrompts } from '../pluginUtils';
import { CBuffer, getPair, quote, skipLws, skipRLws, str2ul32 } from './digestMd5Parse';
import { digestSecret, toHex } from './digestMd5Secret';
import {
  AVAILABLE_CIPHERS, DigestSecurityLayer, createLayerKeys, type DigestCipher,
} from './digestMd5Layer';

const NONCE_SIZE = 32;
const MAX_SASL_BUFSIZE = 0xffffff;
const DEFAULT_BUFSIZE = 0xffff;
const MAX_SERVERIN = 2048;
const REALM_CHAL_PREFIX = 'Available realms:';
const REAUTH_SLOTS = 10;

const DIGEST_NOLAYER = 1;
const DIGEST_INTEGRITY = 2;
const DIGEST_PRIVACY = 4;

const encoder = new TextEncoder();
const latin1 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('latin1');
const latin1Bytes = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'latin1'));

interface ReauthEntry {
  authid: string;
  realm: string;
  nonce: string;
  nonceCount: number;
  cnonce: string;
  serverFqdn: string;
  protection: number;
  cipher: DigestCipher | null;
  serverMaxbuf: number;
}

export class DigestReauthCache {
  readonly slots: (ReauthEntry | null)[] = new Array<ReauthEntry | null>(REAUTH_SLOTS).fill(null);

  static slotOf(serverFqdn: string): number {
    let value = 0;
    for (const byte of encoder.encode(serverFqdn)) {
      value = (value ^ (byte > 127 ? byte - 256 : byte)) | 0;
      value = (value << 1) | 0;
    }
    return (value >>> 0) % REAUTH_SLOTS;
  }
}

function digestHex(bytes: Uint8Array): string {
  return toHex(bytes);
}

function calcResponse(
  ha1Hex: string, nonce: string, nonceCount: number, cnonce: string, qop: string, digestUri: string,
  method: string | null,
): string {
  const entityHash = '0'.repeat(32);
  let a2 = `${method ?? ''}:${digestUri}`;
  if (qop.toLowerCase() !== 'auth') a2 += `:${entityHash}`;
  const ha2 = digestHex(md5(latin1Bytes(a2)));
  let response = `${ha1Hex}:${nonce}:`;
  if (qop !== '') response += `${nonceCount.toString(16).padStart(8, '0')}:${cnonce}:${qop}:`;
  response += ha2;
  return digestHex(md5(latin1Bytes(response)));
}

function digestSession(cache: DigestReauthCache): ClientMechanismSession {
  let state = 1;
  let password: Uint8Array | null = null;
  let realm: string | null = null;
  let nonce: string | null = null;
  let nonceCount = 0;
  let cnonce: string | null = null;
  let realms: string[] | null = null;
  let responseValue = '';
  let protection = 0;
  let cipher: DigestCipher | null = null;
  let serverMaxbuf = 65536;
  let ha1: Uint8Array = new Uint8Array(16);
  let reauthFqdn = '';

  function askUserInfo(
    params: SaslClientParams, availableRealms: string[] | null, prompts: SaslInteract[] | null,
  ): { rc: number; prompts?: SaslInteract[] } {
    let authResult: number = SaslRc.OK;
    let userResult: number = SaslRc.OK;
    let passResult: number = SaslRc.OK;
    let realmResult: number = SaslRc.FAIL;
    let authid: string | null = null;
    let userid: string | null = null;
    let chosenRealm: string | null = null;
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
    if (realm === null) {
      if (availableRealms !== null) {
        if (availableRealms.length === 1) {
          chosenRealm = availableRealms[0];
          realmResult = SaslRc.OK;
        } else {
          const got = params.getRealm(prompts);
          realmResult = got.rc;
          chosenRealm = got.value;
        }
      }
      if (realmResult !== SaslRc.OK && realmResult !== SaslRc.INTERACT) {
        if (params.serverFqdn !== null) chosenRealm = params.serverFqdn;
        else return { rc: realmResult };
      }
    }
    if (userResult === SaslRc.INTERACT || authResult === SaslRc.INTERACT
      || passResult === SaslRc.INTERACT || realmResult === SaslRc.INTERACT) {
      let realmChallenge: string | null = null;
      if (realmResult === SaslRc.INTERACT) {
        if (availableRealms !== null) {
          realmChallenge = `${REALM_CHAL_PREFIX}${availableRealms.map((name) => ` {${name}},`).join('')}`;
          realmChallenge = `${realmChallenge.slice(0, -1)}.`;
        } else if (params.serverFqdn !== null) {
          realmChallenge = `{${params.serverFqdn}}`;
        }
      }
      return {
        rc: SaslRc.INTERACT,
        prompts: makePrompts({
          userPrompt: userResult === SaslRc.INTERACT ? 'Please enter your authorization name' : undefined,
          authPrompt: authResult === SaslRc.INTERACT ? 'Please enter your authentication name' : undefined,
          passPrompt: passResult === SaslRc.INTERACT ? 'Please enter your password' : undefined,
          realmChallenge: realmChallenge ?? '{}',
          realmPrompt: realmResult === SaslRc.INTERACT ? 'Please enter your realm' : undefined,
          realmDefault: params.serverFqdn,
        }),
      };
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
    if (chosenRealm !== null && realm === null) realm = chosenRealm;
    return { rc: SaslRc.OK };
  }

  function makeClientResponse(params: SaslClientParams): StepOutcome {
    let qop: string;
    let keyBytes = 0;
    switch (protection) {
      case DIGEST_PRIVACY:
        qop = 'auth-conf';
        params.oparams.mechSsf = cipher === null ? 0 : cipher.ssf;
        keyBytes = cipher === null ? 0 : cipher.keyBytes;
        break;
      case DIGEST_INTEGRITY:
        qop = 'auth-int';
        params.oparams.mechSsf = 1;
        break;
      default:
        qop = 'auth';
        params.oparams.mechSsf = 0;
    }
    const authid = params.oparams.authid ?? '';
    const user = params.oparams.user ?? '';
    const digestUri = `${params.service}/${params.serverFqdn ?? ''}`;
    const effectiveRealm = realm ?? '';
    const secret = digestSecret(
      encoder.encode(authid), encoder.encode(effectiveRealm), password ?? new Uint8Array(0),
    );
    const sessionInput: number[] = [...secret, 0x3a, ...encoder.encode(nonce ?? ''), 0x3a, ...encoder.encode(cnonce ?? '')];
    if (user !== authid) sessionInput.push(0x3a, ...encoder.encode(user));
    ha1 = md5(Uint8Array.from(sessionInput));
    const ha1Hex = digestHex(ha1);
    const response = calcResponse(ha1Hex, nonce ?? '', nonceCount, cnonce ?? '', qop, digestUri, 'AUTHENTICATE');
    responseValue = calcResponse(ha1Hex, nonce ?? '', nonceCount, cnonce ?? '', qop, digestUri, null);
    const parts: string[] = [];
    const quoted = (name: string, value: string): void => { parts.push(`${name}="${quote(value)}"`); };
    quoted('username', authid);
    quoted('realm', effectiveRealm);
    if (user !== authid) quoted('authzid', user);
    quoted('nonce', nonce ?? '');
    quoted('cnonce', cnonce ?? '');
    parts.push(`nc=${nonceCount.toString(16).padStart(8, '0')}`);
    parts.push(`qop=${qop}`);
    if (cipher !== null) parts.push(`cipher=${cipher.name}`);
    if (params.props.maxBufsize !== 0) parts.push(`maxbuf=${params.props.maxBufsize}`);
    quoted('digest-uri', digestUri);
    parts.push(`response=${response}`);
    const out = parts.join(',');
    if (out.length > 2048) return { rc: SaslRc.FAIL };
    params.oparams.maxOutbuf = serverMaxbuf;
    if (params.oparams.mechSsf > 1) params.oparams.maxOutbuf -= 25;
    else if (params.oparams.mechSsf === 1) params.oparams.maxOutbuf -= 16;
    if (params.oparams.mechSsf > 0) {
      const keys = createLayerKeys('client', ha1, keyBytes);
      const pair = protection === DIGEST_PRIVACY && cipher !== null
        ? cipher.create(keys.encryptionKey, keys.decryptionKey)
        : null;
      if (protection === DIGEST_PRIVACY && cipher !== null && pair === null) {
        params.seterror(`internal error: failed to init cipher '${cipher.name}'`);
        return { rc: SaslRc.FAIL };
      }
      const layer = new DigestSecurityLayer(
        keys, pair, params.props.maxBufsize !== 0 ? params.props.maxBufsize : DEFAULT_BUFSIZE,
        (message) => params.seterror(message),
      );
      params.oparams.encode = layer.encode;
      params.oparams.decode = layer.decode;
    } else {
      params.oparams.encode = null;
      params.oparams.decode = null;
    }
    return { rc: SaslRc.OK, out: latin1Bytes(out) };
  }

  function parseServerChallenge(
    params: SaslClientParams, serverIn: Uint8Array,
  ): { rc: number; realms: string[] } {
    const failed = (rc: number, message?: string): { rc: number; realms: string[] } => {
      if (message !== undefined) params.seterror(message);
      return { rc, realms: [] };
    };
    if (serverIn.length === 0) return failed(SaslRc.FAIL, 'no server challenge');
    const buffer = new CBuffer(serverIn);
    serverMaxbuf = 65536;
    cnonce = b64Ntop(params.random(NONCE_SIZE));
    const found: string[] = [];
    let sawQop = false;
    let ciphers = 0;
    let maxbufCount = 0;
    let algorithmCount = 0;
    let protectionSeen = 0;
    let position = 0;
    while (buffer.at(position) !== 0) {
      const pair = getPair(buffer, position);
      if (pair.name === null) return failed(SaslRc.BADAUTH, 'Parse error');
      if (pair.name === '') break;
      position = pair.next;
      const name = pair.name.toLowerCase();
      const value = pair.value;
      if (name === 'realm') {
        found.push(value);
      } else if (name === 'nonce') {
        nonce = value;
        nonceCount = 1;
      } else if (name === 'qop') {
        sawQop = true;
        for (const item of splitList(value)) {
          const lowered = item.toLowerCase();
          if (lowered === 'auth-conf') protectionSeen |= DIGEST_PRIVACY;
          else if (lowered === 'auth-int') protectionSeen |= DIGEST_INTEGRITY;
          else if (lowered === 'auth') protectionSeen |= DIGEST_NOLAYER;
        }
      } else if (name === 'cipher') {
        for (const item of splitList(value)) {
          const known = AVAILABLE_CIPHERS.find((candidate) => candidate.name === item.toLowerCase());
          if (known !== undefined) ciphers |= known.flag;
        }
      } else if (name === 'stale' && password !== null) {
        password = null;
      } else if (name === 'maxbuf') {
        maxbufCount++;
        if (maxbufCount !== 1) return failed(SaslRc.BADAUTH, 'At least two maxbuf directives found. Authentication aborted');
        const parsed = str2ul32(value);
        if (parsed === null) return failed(SaslRc.BADAUTH, `Invalid maxbuf parameter received from server (${value})`);
        serverMaxbuf = parsed;
        if (serverMaxbuf <= 16) return failed(SaslRc.BADAUTH, `Invalid maxbuf parameter received from server (too small: ${value})`);
        if (serverMaxbuf > MAX_SASL_BUFSIZE) return failed(SaslRc.BADAUTH, `Invalid maxbuf parameter received from server (too big: ${value})`);
      } else if (name === 'charset') {
        if (value.toLowerCase() !== 'utf-8') return failed(SaslRc.BADAUTH, 'Charset must be UTF-8');
      } else if (name === 'algorithm') {
        if (value.toLowerCase() !== 'md5-sess') return failed(SaslRc.FAIL, "'algorithm' isn't 'md5-sess'");
        algorithmCount++;
        if (algorithmCount > 1) return failed(SaslRc.FAIL, "Must see 'algorithm' only once");
      }
    }
    if (protectionSeen === 0) {
      if (!sawQop) protectionSeen = DIGEST_NOLAYER;
      else return failed(SaslRc.BADAUTH, "Server doesn't support any known qop level");
    }
    if (algorithmCount !== 1) return failed(SaslRc.FAIL, "Must see 'algorithm' once. Didn't see at all");
    if (nonce === null) return failed(SaslRc.FAIL, "Don't have nonce.");
    const external = params.externalSsf;
    let musthave = 0;
    let limit = 0;
    if (params.props.maxBufsize !== 0) {
      limit = params.props.maxSsf > external ? params.props.maxSsf - external : 0;
      musthave = params.props.minSsf > external ? params.props.minSsf - external : 0;
    }
    if (limit > 1 && (protectionSeen & DIGEST_PRIVACY) !== 0) {
      for (const candidate of AVAILABLE_CIPHERS) {
        if (limit >= candidate.ssf && musthave <= candidate.ssf && (ciphers & candidate.flag) !== 0
          && (cipher === null || candidate.ssf > cipher.ssf)) {
          cipher = candidate;
        }
      }
      if (cipher !== null) protection = DIGEST_PRIVACY;
      else params.seterror('No good privacy layers');
    }
    if (cipher === null) {
      if (limit >= 1 && musthave <= 1 && (protectionSeen & DIGEST_INTEGRITY) !== 0) {
        protection = DIGEST_INTEGRITY;
      } else if (musthave <= 0) {
        protection = DIGEST_NOLAYER;
        if ((protectionSeen & DIGEST_NOLAYER) !== DIGEST_NOLAYER) {
          return failed(SaslRc.FAIL, 'Server doesn\'t support "no layer"');
        }
      } else {
        return failed(SaslRc.TOOWEAK, "Can't find an acceptable layer");
      }
    }
    return { rc: SaslRc.OK, realms: found };
  }

  function splitList(value: string): string[] {
    const buffer = new CBuffer(latin1Bytes(value));
    const items: string[] = [];
    let current = 0;
    while (buffer.at(current) !== 0) {
      current = skipLws(buffer, current);
      if (buffer.at(current) === 0) break;
      if (buffer.at(current) === 0x2c) {
        current++;
        continue;
      }
      let end = current;
      while (buffer.at(end) !== 0 && buffer.at(end) !== 0x2c) end++;
      const comma = buffer.at(end) === 0x2c;
      if (comma) buffer.set(end, 0);
      const trimmed = skipRLws(buffer, current);
      if (trimmed !== null) {
        buffer.set(trimmed, 0);
        items.push(buffer.text(current));
      }
      if (!comma) break;
      current = end + 1;
    }
    return items;
  }

  function step1(params: SaslClientParams, prompts: SaslInteract[] | null): StepOutcome {
    const asked = askUserInfo(params, null, prompts);
    if (asked.rc !== SaslRc.OK) return asked.rc === SaslRc.INTERACT ? { rc: asked.rc, prompts: asked.prompts } : { rc: asked.rc };
    const slot = DigestReauthCache.slotOf(reauthFqdn);
    const entry = cache.slots[slot];
    if (entry !== null && entry.serverFqdn.toLowerCase() === reauthFqdn.toLowerCase()
      && entry.authid === (params.oparams.authid ?? '')) {
      realm = entry.realm;
      nonce = entry.nonce;
      entry.nonceCount++;
      nonceCount = entry.nonceCount;
      cnonce = entry.cnonce;
      protection = entry.protection;
      cipher = entry.cipher;
      serverMaxbuf = entry.serverMaxbuf;
    }
    if (nonce === null) {
      state = 2;
      return { rc: SaslRc.CONTINUE };
    }
    const response = makeClientResponse(params);
    if (response.rc !== SaslRc.OK) return response;
    return { rc: SaslRc.CONTINUE, out: response.out };
  }

  function step2(params: SaslClientParams, serverIn: Uint8Array, prompts: SaslInteract[] | null): StepOutcome {
    if (params.props.minSsf > params.props.maxSsf) return { rc: SaslRc.BADPARAM };
    if (nonce === null) {
      const parsed = parseServerChallenge(params, serverIn);
      if (parsed.rc !== SaslRc.OK) return { rc: parsed.rc };
      if (parsed.realms.length === 1) {
        realm = parsed.realms[0];
        realms = null;
      } else {
        realms = parsed.realms.length === 0 ? null : parsed.realms;
      }
    }
    const availableRealms = realms;
    const asked = askUserInfo(params, availableRealms, prompts);
    if (asked.rc !== SaslRc.OK) return asked.rc === SaslRc.INTERACT ? { rc: asked.rc, prompts: asked.prompts } : { rc: asked.rc };
    const response = makeClientResponse(params);
    if (response.rc !== SaslRc.OK) return response;
    state = 3;
    return { rc: SaslRc.CONTINUE, out: response.out };
  }

  function step3(params: SaslClientParams, serverIn: Uint8Array): StepOutcome {
    const buffer = new CBuffer(serverIn);
    let result: number = SaslRc.FAIL;
    let position = 0;
    while (buffer.at(position) !== 0) {
      const pair = getPair(buffer, position);
      if (pair.name === null) {
        params.seterror('DIGEST-MD5 Received Garbage');
        result = SaslRc.BADAUTH;
        break;
      }
      if (pair.name === '') break;
      position = pair.next;
      if (pair.name.toLowerCase() === 'rspauth') {
        if (responseValue !== pair.value) {
          params.seterror('DIGEST-MD5: This server wants us to believe that he knows shared secret');
          result = SaslRc.BADSERV;
        } else {
          params.oparams.done = true;
          result = SaslRc.OK;
        }
        break;
      }
    }
    const slot = DigestReauthCache.slotOf(reauthFqdn);
    if (result === SaslRc.OK) {
      if (nonceCount === 1) {
        cache.slots[slot] = {
          authid: params.oparams.authid ?? '', realm: realm ?? '', nonce: nonce ?? '', nonceCount,
          cnonce: cnonce ?? '', serverFqdn: reauthFqdn, protection, cipher, serverMaxbuf,
        };
      }
    } else if (nonceCount > 1) {
      cache.slots[slot] = null;
    }
    return { rc: result };
  }

  return {
    step(params, serverIn, prompts): StepOutcome {
      reauthFqdn = params.serverFqdn ?? '';
      if (serverIn !== null && serverIn.length > MAX_SERVERIN) return { rc: SaslRc.BADPROT };
      let outcome: StepOutcome;
      switch (state) {
        case 1: {
          if (serverIn === null) {
            const slot = cache.slots[DigestReauthCache.slotOf(reauthFqdn)];
            if (slot !== null && slot.serverFqdn.toLowerCase() === reauthFqdn.toLowerCase()) {
              return step1(params, prompts);
            }
            state = 2;
            return { rc: SaslRc.CONTINUE };
          }
          if (latin1(serverIn.subarray(0, 8)).toLowerCase() === 'rspauth=') {
            state = 3;
            return step3(params, serverIn);
          }
          state = 2;
          cache.slots[DigestReauthCache.slotOf(reauthFqdn)] = null;
          realm = null;
          nonce = null;
          cnonce = null;
          cipher = null;
          outcome = step2(params, serverIn, prompts);
          return outcome;
        }
        case 2:
          return step2(params, serverIn ?? new Uint8Array(0), prompts);
        case 3:
          return step3(params, serverIn ?? new Uint8Array(0));
        default:
          return { rc: SaslRc.FAIL };
      }
    },
  };
}

export function createDigestMd5Mechanisms(): readonly ClientMechanism[] {
  const cache = new DigestReauthCache();
  return [{
    name: 'DIGEST-MD5',
    maxSsf: 128,
    securityFlags: SaslSec.NOPLAINTEXT | SaslSec.NOANONYMOUS | SaslSec.MUTUAL_AUTH,
    features: SaslFeat.NEEDSERVERFQDN | SaslFeat.ALLOWS_PROXY | SaslFeat.SUPPORTS_HTTP,
    requiredPrompts: null,
    create: () => digestSession(cache),
  }];
}
