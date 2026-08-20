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
import { sha256Hex } from '@/crypto/hash';
import { bytesToHex } from '@/crypto/encoding';
import { extractHex, expandLabelHex, HASH_LEN, toBytes } from './hkdf';
import { hmac } from '@/crypto/mac';
import { SHA256 } from '@/crypto/hash';

/**
 * Le « 0 » du §7.1 : Hash.length octets nuls, soit 32 pour SHA-256 —
 * donc 64 caractères en hexadécimal. Il en portait 32, ce qui faisait
 * seize octets : sans conséquence tant que la dérivation était simulée,
 * faux dès qu'elle ne l'est plus.
 */
export const ZERO_IKM = '0'.repeat(HASH_LEN * 2);

/** `HKDF-Extract(salt, ikm)`, le vrai (RFC 5869 §2.2). */
export function extractSecret(salt: string, ikm: string): string {
  return extractHex(salt, ikm);
}

/**
 * `Derive-Secret(secret, label, messages) = HKDF-Expand-Label(secret,
 * label, Transcript-Hash(messages), Hash.length)` (RFC 8446 §7.1).
 * `context` est le condensé de transcription (ou la chaîne vide, comme
 * la RFC l'autorise) que l'appelant a déjà calculé.
 */
export function expandLabel(secret: string, label: string, context: string): string {
  return expandLabelHex(secret, label, context);
}

/** `Transcript-Hash(messages)` : un vrai SHA-256 sur les messages concaténés. */
export function transcriptHash(messageBytesList: readonly Uint8Array[]): string {
  let total = 0;
  for (const bytes of messageBytesList) total += bytes.length;
  const concat = new Uint8Array(total);
  let i = 0;
  for (const bytes of messageBytesList) { concat.set(bytes, i); i += bytes.length; }
  return sha256Hex(String.fromCharCode(...concat));
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
): KeySchedule {
  const earlySecret = extractSecret('', psk);
  const binderKey = expandLabel(earlySecret, 'ext binder', '');
  const clientEarlyTrafficSecret = expandLabel(earlySecret, 'c e traffic', transcripts.clientHello);
  const earlyExporterMasterSecret = expandLabel(earlySecret, 'e exp master', transcripts.clientHello);

  const derivedFromEarly = expandLabel(earlySecret, 'derived', '');
  const handshakeSecret = extractSecret(derivedFromEarly, dheSharedSecret);
  const clientHandshakeTrafficSecret = expandLabel(handshakeSecret, 'c hs traffic', transcripts.serverHello);
  const serverHandshakeTrafficSecret = expandLabel(handshakeSecret, 's hs traffic', transcripts.serverHello);

  const derivedFromHandshake = expandLabel(handshakeSecret, 'derived', '');
  const masterSecret = extractSecret(derivedFromHandshake, ZERO_IKM);
  const clientApplicationTrafficSecret = expandLabel(masterSecret, 'c ap traffic', transcripts.serverFinished);
  const serverApplicationTrafficSecret = expandLabel(masterSecret, 's ap traffic', transcripts.serverFinished);
  const exporterMasterSecret = expandLabel(masterSecret, 'exp master', transcripts.serverFinished);
  const resumptionMasterSecret = expandLabel(masterSecret, 'res master', transcripts.clientFinished);

  return {
    earlySecret, binderKey, clientEarlyTrafficSecret, earlyExporterMasterSecret,
    handshakeSecret, clientHandshakeTrafficSecret, serverHandshakeTrafficSecret,
    masterSecret, clientApplicationTrafficSecret, serverApplicationTrafficSecret,
    exporterMasterSecret, resumptionMasterSecret,
  };
}

/**
 * Le `verify_data` d'un message Finished, tel que le §4.4.4 le définit :
 * `HMAC(finished_key, Transcript-Hash(...))` avec `finished_key =
 * HKDF-Expand-Label(BaseKey, "finished", "", Hash.length)`. L'étape
 * intermédiaire n'était pas modélisée ; elle l'est, puisque le HMAC et
 * l'expansion sont maintenant réels tous les deux.
 */
export function computeFinished(trafficSecret: string, transcript: string): string {
  const finishedKey = toBytes(expandLabelHex(trafficSecret, 'finished', '', HASH_LEN));
  return bytesToHex(hmac(SHA256, finishedKey, toBytes(transcript)));
}

/**
 * RFC 8446 §7.2 `KeyUpdate` — `application_traffic_secret_N+1 =
 * HKDF-Expand-Label(application_traffic_secret_N, "traffic upd", "",
 * Hash.length)`. Each direction (client-to-server, server-to-client) is
 * ratcheted independently by calling this on that direction's current
 * secret alone (§4.6.3).
 */
export function nextTrafficSecret(secret: string): string {
  return expandLabel(secret, 'traffic upd', '');
}
