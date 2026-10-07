/**
 * TLS 1.3 (RFC 8446 §7.1) key schedule — the derivation tree from
 * PSK/(EC)DHE input keying material down to the traffic secrets each side
 * actually uses. Real derivation uses HKDF-Extract and
 * HKDF-Expand-Label("tls13 " + label, transcript-hash, length); this
 * module keeps the exact same tree shape and label names but derives
 * every secret via `simulatedDigest` (already the project's stand-in for
 * a keyed hash, used by `SimulatedTls.ts`/`EapTlsHandshake.ts`) rather
 * than a real HMAC-based HKDF. Two sessions with different transcripts or
 * different PSK/DHE input always diverge; the tree's internal separations
 * (early vs. handshake vs. master, handshake vs. application, client vs.
 * server) are exact structural properties, testable without any real
 * cryptography.
 */
import { bytesToHex, hexToBytes, utf8ToBytes } from '@/crypto/encoding';
import {
  extractHex, expandLabelHex, HASH_LEN, toBytes, hashFunction, hashLength, type Tls13Hash,
} from './hkdf';
import { hmac } from '@/crypto/mac';

/**
 * Le « 0 » du §7.1 : Hash.length octets nuls, soit 32 pour SHA-256 —
 * donc 64 caractères en hexadécimal. Il en portait 32, ce qui faisait
 * seize octets : sans conséquence tant que la dérivation était simulée,
 * faux dès qu'elle ne l'est plus.
 */
export const ZERO_IKM = '0'.repeat(HASH_LEN * 2);

export function zeroIkm(hash: Tls13Hash): string {
  return '0'.repeat(hashLength(hash) * 2);
}

function emptyTranscript(hash: Tls13Hash): string {
  return bytesToHex(hashFunction(hash).digest(new Uint8Array(0)));
}

/** `HKDF-Extract(salt, ikm)`, le vrai (RFC 5869 §2.2). */
export function extractSecret(salt: string, ikm: string, hash: Tls13Hash = 'sha256'): string {
  return extractHex(salt, ikm, hash);
}

/**
 * `Derive-Secret(secret, label, messages) = HKDF-Expand-Label(secret,
 * label, Transcript-Hash(messages), Hash.length)` (RFC 8446 §7.1).
 * `context` est le condensé de transcription (ou la chaîne vide, comme
 * la RFC l'autorise) que l'appelant a déjà calculé.
 */
export function expandLabel(secret: string, label: string, context: string, hash: Tls13Hash = 'sha256'): string {
  return expandLabelHex(secret, label, context, hashLength(hash), hash);
}

/** `Transcript-Hash(messages)` : le condensé de la suite négociée sur les messages concaténés. */
export function transcriptHash(messageBytesList: readonly Uint8Array[], hash: Tls13Hash = 'sha256'): string {
  let total = 0;
  for (const bytes of messageBytesList) total += bytes.length;
  const concat = new Uint8Array(total);
  let i = 0;
  for (const bytes of messageBytesList) { concat.set(bytes, i); i += bytes.length; }
  return bytesToHex(hashFunction(hash).digest(concat));
}

/**
 * The transcript-hash checkpoints §7.1's tree derives secrets from, named
 * after the last message each one includes (matching the RFC's own
 * figure): up through ClientHello (`+ HelloRetryRequest + second
 * ClientHello`, if any), through ServerHello, through the server's
 * Finished, and through the client's Finished.
 */
export interface KeyScheduleTranscripts {
  readonly clientHello: string;
  readonly serverHello: string;
  readonly serverFinished: string;
  readonly clientFinished: string;
}

export interface KeySchedule {
  readonly earlySecret: string;
  readonly binderKey: string;
  readonly clientEarlyTrafficSecret: string;
  readonly earlyExporterMasterSecret: string;
  readonly handshakeSecret: string;
  readonly clientHandshakeTrafficSecret: string;
  readonly serverHandshakeTrafficSecret: string;
  readonly masterSecret: string;
  readonly clientApplicationTrafficSecret: string;
  readonly serverApplicationTrafficSecret: string;
  readonly exporterMasterSecret: string;
  readonly resumptionMasterSecret: string;
}

/**
 * Runs the full §7.1 tree: Early Secret → (derived) → Handshake Secret →
 * (derived) → Master Secret, deriving every named traffic/exporter/
 * resumption secret along the way. `psk`/`dheSharedSecret` default to the
 * RFC's "0" placeholder (no PSK offered, DHE result unknown yet) — later
 * phases (P8 resumption, mTLS) pass real simulated PSK/DHE material
 * without changing this function's shape.
 */
export function deriveKeySchedule(
  transcripts: KeyScheduleTranscripts,
  psk: string = ZERO_IKM,
  dheSharedSecret: string = ZERO_IKM,
  hash: Tls13Hash = 'sha256',
): KeySchedule {
  const zero = zeroIkm(hash);
  const pskInput = psk === ZERO_IKM ? zero : psk;
  const dheInput = dheSharedSecret === ZERO_IKM ? zero : dheSharedSecret;
  const empty = emptyTranscript(hash);
  const expand = (secret: string, label: string, context: string): string => expandLabel(secret, label, context, hash);

  const earlySecret = extractSecret('', pskInput, hash);
  const binderKey = expand(earlySecret, 'ext binder', empty);
  const clientEarlyTrafficSecret = expand(earlySecret, 'c e traffic', transcripts.clientHello);
  const earlyExporterMasterSecret = expand(earlySecret, 'e exp master', transcripts.clientHello);

  const derivedFromEarly = expand(earlySecret, 'derived', empty);
  const handshakeSecret = extractSecret(derivedFromEarly, dheInput, hash);
  const clientHandshakeTrafficSecret = expand(handshakeSecret, 'c hs traffic', transcripts.serverHello);
  const serverHandshakeTrafficSecret = expand(handshakeSecret, 's hs traffic', transcripts.serverHello);

  const derivedFromHandshake = expand(handshakeSecret, 'derived', empty);
  const masterSecret = extractSecret(derivedFromHandshake, zero, hash);
  const clientApplicationTrafficSecret = expand(masterSecret, 'c ap traffic', transcripts.serverFinished);
  const serverApplicationTrafficSecret = expand(masterSecret, 's ap traffic', transcripts.serverFinished);
  const exporterMasterSecret = expand(masterSecret, 'exp master', transcripts.serverFinished);
  const resumptionMasterSecret = expand(masterSecret, 'res master', transcripts.clientFinished);

  return {
    earlySecret, binderKey, clientEarlyTrafficSecret, earlyExporterMasterSecret,
    handshakeSecret, clientHandshakeTrafficSecret, serverHandshakeTrafficSecret,
    masterSecret, clientApplicationTrafficSecret, serverApplicationTrafficSecret,
    exporterMasterSecret, resumptionMasterSecret,
  };
}

/**
 * RFC 8446 §4.2.11.2 — the PSK binder: a Finished-style HMAC, under
 * `binder_key = Derive-Secret(Early Secret, "res binder" | "ext binder", "")`,
 * over the transcript through the ClientHello truncated before its binders list.
 */
export function computePskBinder(
  psk: string, partialTranscriptHash: string, hash: Tls13Hash = 'sha256', kind: 'res' | 'ext' = 'res',
): string {
  const earlySecret = extractSecret('', psk, hash);
  const binderKey = expandLabel(earlySecret, kind === 'res' ? 'res binder' : 'ext binder', emptyTranscript(hash), hash);
  return computeFinished(binderKey, partialTranscriptHash, hash);
}

/**
 * Le `verify_data` d'un message Finished, tel que le §4.4.4 le définit :
 * `HMAC(finished_key, Transcript-Hash(...))` avec `finished_key =
 * HKDF-Expand-Label(BaseKey, "finished", "", Hash.length)`. L'étape
 * intermédiaire n'était pas modélisée ; elle l'est, puisque le HMAC et
 * l'expansion sont maintenant réels tous les deux.
 */
export function computeFinished(trafficSecret: string, transcript: string, hash: Tls13Hash = 'sha256'): string {
  const finishedKey = toBytes(expandLabelHex(trafficSecret, 'finished', '', hashLength(hash), hash));
  return bytesToHex(hmac(hashFunction(hash), finishedKey, toBytes(transcript)));
}

/**
 * RFC 8446 §7.2 `KeyUpdate` — `application_traffic_secret_N+1 =
 * HKDF-Expand-Label(application_traffic_secret_N, "traffic upd", "",
 * Hash.length)`. Each direction (client-to-server, server-to-client) is
 * ratcheted independently by calling this on that direction's current
 * secret alone (§4.6.3).
 */
export function nextTrafficSecret(secret: string, hash: Tls13Hash = 'sha256'): string {
  return expandLabel(secret, 'traffic upd', '', hash);
}

/**
 * RFC 8446 §4.4.3 — le contenu signé par CertificateVerify : 64 espaces,
 * la chaîne de contexte, un octet nul, puis le condensé de transcription.
 * Sans ce préfixe, une signature produite ailleurs sur le même condensé
 * (autre protocole, autre côté) serait rejouable ici.
 */
export function certificateVerifyContent(role: 'server' | 'client', transcript: string): Uint8Array {
  const context = utf8ToBytes(`TLS 1.3, ${role} CertificateVerify`);
  const hash = hexToBytes(transcript);
  const out = new Uint8Array(64 + context.length + 1 + hash.length);
  out.fill(0x20, 0, 64);
  out.set(context, 64);
  out.set(hash, 64 + context.length + 1);
  return out;
}

const MESSAGE_HASH_HANDSHAKE_TYPE = 254;

export function collapseFirstClientHello(transcript: Uint8Array[], hash: Tls13Hash): void {
  const digest = hashFunction(hash).digest(transcript[0]);
  const replacement = new Uint8Array(4 + digest.length);
  replacement[0] = MESSAGE_HASH_HANDSHAKE_TYPE;
  replacement[1] = (digest.length >> 16) & 0xff;
  replacement[2] = (digest.length >> 8) & 0xff;
  replacement[3] = digest.length & 0xff;
  replacement.set(digest, 4);
  transcript[0] = replacement;
}
