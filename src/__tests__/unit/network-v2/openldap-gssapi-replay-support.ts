import { parseAll, parseTLV } from '@/network/devices/windows/server/ad/ldap/Ber';
import { decodeApRep, decodeApReq, decodeAuthenticator, decodeEncApRepPart, decodeKdcReq } from '@/network/kerberos/codec';
import { KerberosClient } from '@/network/kerberos/KerberosClient';
import { decodeCcache } from '@/network/kerberos/ccache/FileCcache';
import { AES256_PROFILE, decryptWithConfounder } from '@/network/kerberos/enctype/aesCtsHmacSha1';
import { KG_USAGE_INITIATOR_SEAL } from '@/network/kerberos/gssapi/GssSecurityContext';
import { frameInitialContextToken } from '@/network/kerberos/gssapi/GssToken';
import { decodeSpnegoToken } from '@/network/kerberos/gssapi/spnego/SpnegoToken';
import { Krb5Context } from '@/network/devices/linux/kerberos/Krb5Context';
import { Krb5GssClient } from '@/network/devices/linux/kerberos/Krb5GssClient';
import type { Krb5Host } from '@/network/devices/linux/kerberos/Krb5Host';
import { compareWithRecording, replay, splitPdus, type RecordedConnection, type Scenario } from './openldap-replay-support';

export interface GssapiScenario {
  readonly name: string;
  readonly args: readonly string[];
  readonly cache: string | null;
  readonly cacheEnv: string;
  readonly config: string;
  readonly connections: readonly RecordedConnection[];
  readonly kdcReplies: readonly (readonly string[])[];
  readonly kdcRequests: readonly (readonly string[])[];
  readonly clockMicroseconds: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly debugLevel?: number;
  readonly cacheAfter?: string;
}

export interface GssapiCorpus {
  readonly files: Readonly<Record<string, string>>;
  readonly caches: Readonly<Record<string, string>>;
  readonly scenarios: readonly GssapiScenario[];
}

const KU_AP_REQ_AUTHENTICATOR = 11;
const KU_AP_REP_ENC_PART = 12;
const WRAP_TOKEN_ID = 0x0504;
const SEALED_FLAG = 0x02;
const WRAP_HEADER_BYTES = 16;
const INITIAL_TOKEN_HEADER_BYTES = 2;

const bytesOfHex = (text: string): Uint8Array => Uint8Array.from(Buffer.from(text, 'hex'));

function tokenBody(token: Uint8Array): Uint8Array {
  const framed = parseTLV(token, 0);
  const oid = parseTLV(framed.content, 0);
  return framed.content.subarray(oid.nextOffset + INITIAL_TOKEN_HEADER_BYTES);
}

const GS2_HEADER_FLAGS = /^(F,)?[pny]/;
const TOKEN_ID_BYTES = 2;

function withoutGs2Header(credentials: Uint8Array): Uint8Array | null {
  const text = Buffer.from(credentials).toString('latin1');
  if (credentials[0] === 0x60 || !GS2_HEADER_FLAGS.test(text)) return null;
  let commas = 0;
  let offset = 0;
  for (; offset < text.length && commas < 2; offset++) if (text[offset] === ',') commas++;
  const unframed = credentials.subarray(offset);
  return frameInitialContextToken((unframed[0] << 8) | unframed[1], unframed.subarray(TOKEN_ID_BYTES));
}

function mechanismToken(credentials: Uint8Array): Uint8Array {
  const gs2 = withoutGs2Header(credentials);
  if (gs2 !== null) return gs2;
  const spnego = decodeSpnegoToken(credentials);
  if (spnego === null) return credentials;
  return (spnego.kind === 'init' ? spnego.mechToken : spnego.responseToken) ?? new Uint8Array(0);
}

function saslCredentials(message: Uint8Array): Uint8Array | null {
  const bindRequest = parseAll(parseTLV(message, 0).content)[1];
  if (bindRequest === undefined || bindRequest.tagNumber !== 0) return null;
  const sasl = parseAll(bindRequest.content)[2];
  const fields = parseAll(sasl.content);
  return fields[1] === undefined ? null : fields[1].content;
}

function serverCredentials(message: Uint8Array): Uint8Array | null {
  const bindResponse = parseAll(parseTLV(message, 0).content)[1];
  const field = parseAll(bindResponse.content).find((candidate) => candidate.tagClass === 'context' && candidate.tagNumber === 7);
  return field === undefined ? null : field.content;
}

function sequenceBytes(sequence: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, sequence, false);
  return out;
}

export interface RecordedGssRandom {
  readonly chunks: Uint8Array[];
  readonly clockMicroseconds: number;
}

export function recordedGssRandom(scenario: GssapiScenario, serviceKey: Uint8Array): RecordedGssRandom | null {
  const pdus: { direction: string; pdu: Uint8Array }[] = [];
  for (const [direction, chunk] of scenario.connections[0].transcript) {
    for (const pdu of splitPdus(bytesOfHex(chunk))) pdus.push({ direction, pdu });
  }
  const request = pdus.find((entry) => entry.direction === 'c' && entry.pdu[0] === 0x30 && saslCredentials(entry.pdu) !== null);
  const reply = pdus.find((entry) => entry.direction === 's' && entry.pdu[0] === 0x30 && serverCredentials(entry.pdu) !== null);
  if (request === undefined) return null;
  const apReq = decodeApReq(tokenBody(mechanismToken(saslCredentials(request.pdu)!)));
  const opened = decryptWithConfounder(AES256_PROFILE, serviceKey, KU_AP_REQ_AUTHENTICATOR, apReq.authenticator.cipher);
  const authenticator = decodeAuthenticator(opened.plaintext);
  const chunks = [authenticator.subkey!.keyValue, sequenceBytes(authenticator.seqNumber!), opened.confounder];
  let contextKey = authenticator.subkey!.keyValue;
  if (reply !== undefined) {
    const apRep = decodeApRep(tokenBody(mechanismToken(serverCredentials(reply.pdu)!)));
    const part = decodeEncApRepPart(decryptWithConfounder(AES256_PROFILE, serviceKey, KU_AP_REP_ENC_PART, apRep.encPart.cipher).plaintext);
    if (part.subkey !== undefined) contextKey = part.subkey.keyValue;
  }
  for (const entry of pdus) {
    if (entry.direction !== 'c' || entry.pdu[0] !== 0 || entry.pdu.length < 4 + WRAP_HEADER_BYTES) continue;
    const token = entry.pdu.subarray(4);
    if (((token[0] << 8) | token[1]) !== WRAP_TOKEN_ID || (token[2] & SEALED_FLAG) === 0) continue;
    chunks.push(decryptWithConfounder(AES256_PROFILE, contextKey, KG_USAGE_INITIATOR_SEAL, token.subarray(WRAP_HEADER_BYTES)).confounder);
  }
  return { chunks, clockMicroseconds: authenticator.ctime * 1_000_000 + authenticator.cusec };
}

function nonceBytes(nonce: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, nonce, false);
  return out;
}

export function recordedKdcNonces(scenario: GssapiScenario): Uint8Array[] {
  return scenario.kdcRequests.map((connection) => nonceBytes(decodeKdcReq(bytesOfHex(connection[0]).subarray(4)).reqBody.nonce));
}

export function serviceSessionKey(cache: Uint8Array, components: readonly string[]): Uint8Array | null {
  const decoded = decodeCcache(cache);
  if (decoded === null) return null;
  const credential = decoded.credentials.find((candidate) =>
    candidate.server.components.length === components.length && candidate.server.components.every((part, index) => part === components[index]));
  return credential === undefined ? null : credential.key;
}

export class RandomTape {
  private position = 0;

  constructor(private readonly chunks: readonly Uint8Array[], private readonly problems: string[]) {}

  take = (length: number): Uint8Array => {
    const next = this.chunks[this.position++];
    if (next === undefined || next.length !== length) {
      this.problems.push(`random(${length}) at draw ${this.position} does not match the recorded ${next === undefined ? 'end of tape' : `${next.length} bytes`}`);
      return new Uint8Array(length);
    }
    return next;
  };

  get remaining(): number {
    return this.chunks.length - this.position;
  }
}

export function kdcRequestSummary(framed: Uint8Array): string {
  const request = decodeKdcReq(framed.subarray(4));
  const body = request.reqBody;
  const initial = request.msgType === 'AS-REQ';
  return JSON.stringify({
    type: request.msgType, padata: initial ? request.padata.map((entry) => entry.type) : undefined, options: body.kdcOptions,
    cname: body.cname?.nameString, realm: body.realm, sname: body.sname?.nameString, etype: initial ? body.etype : undefined,
    renewable: body.rtime !== undefined,
  });
}

function scriptedKdc(
  replies: readonly (readonly string[])[], sent: Uint8Array[][], random: (length: number) => Uint8Array, clockMs: () => number,
) {
  let dialed = 0;
  return (): KerberosClient | null => {
    const reply = replies[dialed];
    if (reply === undefined) return null;
    const requests: Uint8Array[] = [];
    sent[dialed++] = requests;
    const socket = {
      listeners: [] as ((data: Uint8Array) => void)[],
      onData(callback: (data: Uint8Array) => void) {
        this.listeners.push(callback);
        return () => { this.listeners = this.listeners.filter((candidate) => candidate !== callback); };
      },
      send(bytes: Uint8Array) {
        requests.push(bytes);
        for (const chunk of reply) for (const listener of [...this.listeners]) listener(bytesOfHex(chunk));
        return true;
      },
    };
    return new KerberosClient(socket as never, clockMs, random);
  };
}

export interface ReplayedKrb5 {
  readonly gss: Krb5GssClient;
  readonly files: Map<string, Uint8Array>;
  readonly sentRequests: Uint8Array[][];
}

export function replayedKrb5(
  corpus: GssapiCorpus, scenario: GssapiScenario, random: (length: number) => Uint8Array, clockMicroseconds: () => number,
): ReplayedKrb5 {
  const files = new Map<string, Uint8Array>();
  const cachePath = scenario.cacheEnv.replace(/^FILE:/, '');
  if (scenario.cache !== null) files.set(cachePath, bytesOfHex(corpus.caches[scenario.cache]));
  files.set('/etc/krb5.conf', new TextEncoder().encode(corpus.files[scenario.config]));
  const sentRequests: Uint8Array[][] = [];
  const dial = scriptedKdc(scenario.kdcReplies, sentRequests, random, () => Math.floor(clockMicroseconds() / 1000));
  const host: Krb5Host = {
    environment: (name) => (name === 'KRB5CCNAME' ? scenario.cacheEnv : null),
    readText: (path) => (files.has(path) ? Buffer.from(files.get(path)!).toString('latin1') : null),
    readBytes: (path) => files.get(path) ?? null,
    writeBytes: (path, bytes) => { files.set(path, bytes); return true; },
    removeFile: (path) => files.delete(path),
    fileExists: (path) => files.has(path),
    listDirectory: () => null,
    uid: () => 0,
    userName: () => 'root',
    nowMicroseconds: clockMicroseconds,
    resolve: async (name) => (name === 'localhost' ? '127.0.0.1' : null),
    forward: async () => null,
    reverse: async () => null,
    querySrv: async () => [],
    dialKdc: () => dial(),
  };
  return { gss: new Krb5GssClient(host, new Krb5Context(host)), files, sentRequests };
}

const GSSAPI_PLUGINS = ['libgs2.so', 'libgssapiv2.so', 'libplain.so', 'libdigestmd5.so', 'libcrammd5.so'];

export async function replayGssapiScenario(corpus: GssapiCorpus, scenario: GssapiScenario, args: readonly string[]): Promise<string[]> {
  const problems: string[] = [];
  const cacheBytes = scenario.cache === null ? null : bytesOfHex(corpus.caches[scenario.cache]);
  const key = cacheBytes === null ? null : serviceSessionKey(cacheBytes, ['ldap', 'vm']);
  const recorded = key === null || scenario.connections[0].transcript.length === 0 ? null : recordedGssRandom(scenario, key);
  const tape = new RandomTape([...recordedKdcNonces(scenario), ...(recorded?.chunks ?? [])], problems);
  const clock = recorded?.clockMicroseconds ?? scenario.clockMicroseconds;
  const krb5 = replayedKrb5(corpus, scenario, tape.take, () => clock);
  const asScenario: Scenario = {
    name: scenario.name, args, stdin: '', connections: scenario.connections,
    stdout: scenario.stdout, stderr: scenario.stderr, exitCode: scenario.exitCode,
  };
  const outcome = await replay(asScenario, {
    args, files: {}, saslPlugins: GSSAPI_PLUGINS, random: tape.take, gss: krb5.gss, debugLevel: scenario.debugLevel,
  });
  const found = compareWithRecording({ ...outcome, problems: [...problems, ...outcome.problems] }, scenario, scenario.debugLevel !== undefined);
  if (scenario.cacheAfter !== undefined) {
    const written = krb5.files.get(scenario.cacheEnv.replace(/^FILE:/, ''));
    const writtenHex = written === undefined ? '' : Buffer.from(written).toString('hex');
    if (writtenHex !== scenario.cacheAfter) {
      let offset = 0;
      while (offset < writtenHex.length && writtenHex[offset] === scenario.cacheAfter[offset]) offset++;
      found.push(`the credentials cache differs after the run at hex offset ${offset}: real ...${scenario.cacheAfter.slice(Math.max(0, offset - 20), offset + 60)} simulated ...${writtenHex.slice(Math.max(0, offset - 20), offset + 60)}`);
    }
  }
  if (tape.remaining !== 0) found.push(`${tape.remaining} recorded random draws were never consumed`);
  scenario.kdcRequests.forEach((connection, index) => {
    connection.forEach((chunk, position) => {
      const sent = krb5.sentRequests[index]?.[position];
      const recordedSummary = kdcRequestSummary(bytesOfHex(chunk));
      if (sent === undefined) found.push(`KDC request ${index}.${position} was never sent: ${recordedSummary}`);
      else if (kdcRequestSummary(sent) !== recordedSummary) found.push(`KDC request ${index}.${position} differs:\n--- real ${recordedSummary}\n--- simulated ${kdcRequestSummary(sent)}`);
    });
  });
  return found;
}
