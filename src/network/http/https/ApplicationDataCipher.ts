/**
 * RFC 8446 §5.2/§5.3 — protection des données applicatives, en
 * AES-128-GCM RÉEL depuis l'étage 2.
 *
 * Ce que c'était : le XOR de flux de `SimulatedTls.ts`. Réversible sans
 * clé pour qui connaît deux textes clairs, et surtout SANS
 * AUTHENTIFICATION — un enregistrement modifié en vol se déchiffrait en
 * silence, ce qu'aucun AEAD ne permet. `openRecord` peut désormais
 * échouer, et c'est l'apport principal : une altération est DÉTECTÉE.
 *
 * Le cadrage, les numéros de séquence par enregistrement et la remorque
 * de type du §5.2 n'ont pas bougé ; seule la primitive change. Les clés
 * viennent du secret de trafic par `HKDF-Expand-Label` (§7.3), ce qui
 * n'était possible qu'une fois l'étage 1 en place.
 */
import {
  deriveRecordKeys, sealRecord, openRecord, type RecordKeys,
} from '@/network/tls/recordProtection';
import { fragmentAsRecords, fragmentPlaintext, reassembleRecords, reassembleFragments, type TlsRecord } from '@/network/tls/recordLayer';
import type { TrafficProtection } from '@/network/tls/trafficProtection';
import type { Tls13Traffic } from '@/network/tls/suite13';

function isLegacy(traffic: TrafficProtection): traffic is Exclude<TrafficProtection, string | Tls13Traffic> {
  return typeof traffic !== 'string' && 'kind' in traffic && traffic.kind === 'legacy';
}

export interface EncryptedApplicationData {
  readonly records: TlsRecord[];
  /** Sequence number the peer must start decrypting from for its next receive. */
  readonly nextSeq: number;
}

/**
 * Les clés d'enregistrement sont dérivées à chaque appel plutôt que
 * gardées : les appelants passent un secret, et le mémoriser ici ferait
 * servir l'ancien après un `KeyUpdate`. Le coût est une expansion HKDF
 * par lot, pas par octet.
 */
function keys(traffic: string | Tls13Traffic): RecordKeys {
  return typeof traffic === 'string' ? deriveRecordKeys(traffic) : deriveRecordKeys(traffic.secret, traffic.suite);
}

/**
 * Wraps `plaintext` per §5.2 (content-type trailer via `fragmentAsRecords`'s
 * protected mode) then encrypts each resulting fragment independently,
 * consuming one sequence number per record.
 */
export function encryptApplicationData(
  traffic: TrafficProtection, startSeq: number, plaintext: Uint8Array,
): EncryptedApplicationData {
  if (isLegacy(traffic)) {
    let legacySeq = startSeq;
    const sealed = fragmentPlaintext('application_data', plaintext, traffic.maxFragment).map((record): TlsRecord => traffic.seal(legacySeq++, record));
    return { records: sealed, nextSeq: legacySeq };
  }
  const k = keys(traffic);
  const limit = typeof traffic === 'string' ? undefined : traffic.maxFragment;
  const base = typeof traffic === 'string' ? 0 : traffic.sequenceBase ?? 0;
  const records = fragmentAsRecords('application_data', plaintext, true, limit);
  let seq = startSeq;
  const encrypted = records.map((record): TlsRecord => sealRecord(k, base + seq++, record));
  return { records: encrypted, nextSeq: seq };
}

export interface DecryptedApplicationData {
  readonly plaintext: Uint8Array;
  readonly nextSeq: number;
}

/**
 * L'échec d'authentification d'un enregistrement — mauvaise clé, mauvais
 * numéro de séquence, ou octets modifiés en vol.
 *
 * C'est une exception et non un retour vide parce que le §5.2 en fait une
 * alerte FATALE (`bad_record_mac`) : un appelant qui recevrait un texte
 * clair vide pourrait le confondre avec « rien à lire », c'est-à-dire
 * exactement ce qu'un attaquant voudrait. Le comportement observable ne
 * change d'ailleurs pas pour les appelants existants : avant l'étage 2,
 * du XOR mal déchiffré faisait déjà lever `reassembleRecords`, faute de
 * remorque de type valide.
 */
export class RecordOverflowError extends Error {
  constructor() { super('record_overflow'); this.name = 'RecordOverflowError'; }
}

export class BadRecordMacError extends Error {
  constructor() { super('bad_record_mac'); this.name = 'BadRecordMacError'; }
}

/** L'inverse d'`encryptApplicationData`. */
export function decryptApplicationData(
  traffic: TrafficProtection, startSeq: number, records: readonly TlsRecord[],
): DecryptedApplicationData {
  if (isLegacy(traffic)) {
    let legacySeq = startSeq;
    const opened: TlsRecord[] = [];
    for (const record of records) {
      const plain = traffic.open(legacySeq++, record);
      if (plain === null) throw new BadRecordMacError();
      if (plain.fragment.length > traffic.maxFragment) throw new RecordOverflowError();
      opened.push(plain);
    }
    return { plaintext: reassembleFragments(opened).plaintext, nextSeq: legacySeq };
  }
  const k = keys(traffic);
  const base = typeof traffic === 'string' ? 0 : traffic.sequenceBase ?? 0;
  let seq = startSeq;
  const decrypted: TlsRecord[] = [];
  for (const record of records) {
    const clair = openRecord(k, base + seq++, record);
    // Refuser le lot entier plutôt que d'en livrer la moitié : c'est ce
    // que fait un vrai TLS, qui ferme la connexion.
    if (clair === null) throw new BadRecordMacError();
    if (typeof traffic !== 'string' && traffic.maxFragment !== undefined && clair.fragment.length > traffic.maxFragment + 1) {
      throw new RecordOverflowError();
    }
    decrypted.push(clair);
  }
  const parts: Uint8Array[] = [];
  for (const record of decrypted) {
    const inner = reassembleRecords([record], true);
    if (inner.contentType === 'application_data') parts.push(inner.plaintext);
  }
  const plaintext = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { plaintext.set(part, offset); offset += part.length; }
  return { plaintext, nextSeq: seq };
}
