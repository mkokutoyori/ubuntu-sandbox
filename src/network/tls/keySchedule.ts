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
import { simulatedDigest } from '@/network/dns/dnssec/Digest';

const TLS13_LABEL_PREFIX = 'tls13 ';

/** Placeholder input keying material RFC 8446 §7.1 calls "0" — used when no PSK/(EC)DHE applies. */
export const ZERO_IKM = '0'.repeat(32);

/** Simulated stand-in for `HKDF-Extract(salt, ikm)`. */
export function extractSecret(salt: string, ikm: string): string {
  return simulatedDigest(`hkdf-extract|${salt}|${ikm}`);
}

/**
 * Simulated stand-in for `Derive-Secret(secret, label, messages) =
 * HKDF-Expand-Label(secret, label, Transcript-Hash(messages), Hash.length)`.
 * `context` is whatever transcript-hash (or empty string, per the RFC) the
 * caller has already computed.
 */
export function expandLabel(secret: string, label: string, context: string): string {
  return simulatedDigest(`hkdf-expand-label|${secret}|${TLS13_LABEL_PREFIX}${label}|${context}`);
}

/** Simulated stand-in for `Transcript-Hash(messages)` — order-sensitive, content-sensitive. */
export function transcriptHash(messageBytesList: readonly Uint8Array[]): string {
  return simulatedDigest(messageBytesList.map((bytes) => Array.from(bytes).join(',')).join('|'));
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
 * Simulated stand-in for computing a Finished message's `verify_data`
 * (real RFC 8446 §4.4.4: `HMAC(finished_key, Transcript-Hash(...))`, where
 * `finished_key = HKDF-Expand-Label(BaseKey, "finished", "", Hash.length)`).
 * Binding the traffic secret directly into the digest still catches both a
 * wrong role/secret (impersonation) and a tampered transcript (integrity),
 * without needing to model the intermediate `finished_key` derivation step.
 */
export function computeFinished(trafficSecret: string, transcript: string): string {
  return simulatedDigest(`finished|${trafficSecret}|${transcript}`);
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
