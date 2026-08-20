/**
 * TLS 1.3 (RFC 8446 §6) alert protocol — the `AlertDescription` values
 * relevant to this project's scope, plus a systematic mapping from
 * `CertificateVerifier.VerificationReason` so a rejected certificate
 * produces the RFC-correct alert instead of a bare boolean failure.
 */
import type { VerificationReason } from '@/network/pki/CertificateVerifier';
import type { AlertLevel } from './types';

export type AlertDescription =
  | 'close_notify'
  | 'unexpected_message'
  | 'bad_record_mac'
  | 'handshake_failure'
  | 'bad_certificate'
  | 'certificate_revoked'
  | 'certificate_expired'
  | 'certificate_unknown'
  | 'illegal_parameter'
  | 'unknown_ca'
  | 'decode_error'
  | 'decrypt_error'
  | 'protocol_version'
  | 'missing_extension'
  | 'unsupported_extension'
  | 'no_application_protocol';

/** RFC 8446 §6 registry — numeric codes for the alerts above. */
export const ALERT_DESCRIPTION_CODE: Record<AlertDescription, number> = {
  close_notify: 0,
  unexpected_message: 10,
  bad_record_mac: 20,
  handshake_failure: 40,
  bad_certificate: 42,
  certificate_revoked: 44,
  certificate_expired: 45,
  certificate_unknown: 46,
  // Émise par les deux sessions quand l'échange de clés ne rend aucun
  // secret (§7.4.2). Elle partait déjà sur le fil, hors du type et hors
  // du registre : son code numérique était `undefined`.
  illegal_parameter: 47,
  unknown_ca: 48,
  decode_error: 50,
  decrypt_error: 51,
  protocol_version: 70,
  missing_extension: 109,
  unsupported_extension: 110,
  no_application_protocol: 120,
};

export interface TlsAlert {
  readonly level: AlertLevel;
  readonly description: AlertDescription;
}

/**
 * Maps a `CertificateVerifier` rejection reason to the RFC 8446 alert a
 * real implementation would raise. RFC 8446 has no dedicated code for
 * "not yet valid" (only `certificate_expired` covers the validity-window
 * class of failure), and no dedicated code distinguishing "couldn't reach
 * revocation status" from "some other certificate processing issue" — both
 * map to `certificate_unknown`, the RFC's catch-all for that class.
 */
export function alertForVerificationReason(reason: VerificationReason): AlertDescription {
  switch (reason) {
    case 'unknown': return 'unknown_ca';
    case 'expired': return 'certificate_expired';
    case 'not-yet-valid': return 'certificate_expired';
    case 'bad-signature': return 'bad_certificate';
    case 'revoked': return 'certificate_revoked';
    case 'crl-stale': return 'certificate_unknown';
    case 'crl-untrusted': return 'certificate_unknown';
    case 'hostname-mismatch': return 'bad_certificate';
  }
}

export function certificateAlert(reason: VerificationReason): TlsAlert {
  return { level: 'fatal', description: alertForVerificationReason(reason) };
}

export function fatalAlert(description: AlertDescription): TlsAlert {
  return { level: 'fatal', description };
}
