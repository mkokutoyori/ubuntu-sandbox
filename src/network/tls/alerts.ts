/**
 * TLS 1.3 (RFC 8446 §6) alert protocol — the `AlertDescription` values
 * relevant to this project's scope, plus a systematic mapping from
 * `CertificateVerifier.VerificationReason` so a rejected certificate
 * produces the RFC-correct alert instead of a bare boolean failure.
 */
import type { VerificationReason } from '@/network/pki/CertificateVerifier';
import type { AlertLevel } from './types';
import type { TlsRecord } from './recordLayer';

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
  | 'no_application_protocol'
  | 'record_overflow'
  | 'decompression_failure'
  | 'unsupported_certificate'
  | 'access_denied'
  | 'insufficient_security'
  | 'internal_error'
  | 'user_canceled'
  | 'no_renegotiation'
  | 'unrecognized_name'
  | 'bad_certificate_status_response'
  | 'unknown_psk_identity'
  | 'certificate_required';

/** RFC 8446 §6 registry — numeric codes for the alerts above. */
export const ALERT_DESCRIPTION_CODE: Record<AlertDescription, number> = {
  close_notify: 0,
  unexpected_message: 10,
  bad_record_mac: 20,
  record_overflow: 22,
  decompression_failure: 30,
  handshake_failure: 40,
  bad_certificate: 42,
  unsupported_certificate: 43,
  certificate_revoked: 44,
  certificate_expired: 45,
  certificate_unknown: 46,
  // Émise par les deux sessions quand l'échange de clés ne rend aucun
  // secret (§7.4.2). Elle partait déjà sur le fil, hors du type et hors
  // du registre : son code numérique était `undefined`.
  illegal_parameter: 47,
  unknown_ca: 48,
  access_denied: 49,
  decode_error: 50,
  decrypt_error: 51,
  protocol_version: 70,
  insufficient_security: 71,
  internal_error: 80,
  user_canceled: 90,
  no_renegotiation: 100,
  missing_extension: 109,
  unsupported_extension: 110,
  unrecognized_name: 112,
  bad_certificate_status_response: 113,
  unknown_psk_identity: 115,
  certificate_required: 116,
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
    case 'not-yet-valid': return 'bad_certificate';
    case 'bad-signature': return 'decrypt_error';
    case 'revoked': return 'certificate_revoked';
    case 'crl-stale': return 'unknown_ca';
    case 'crl-untrusted': return 'decrypt_error';
    case 'hostname-mismatch': return 'bad_certificate';
    case 'not-a-ca': return 'unknown_ca';
    case 'path-length': return 'unknown_ca';
    case 'chain-too-long': return 'unknown_ca';
    case 'key-usage': return 'certificate_unknown';
    case 'weak-key': return 'bad_certificate';
    case 'weak-ca-key': return 'bad_certificate';
    case 'purpose': return 'unsupported_certificate';
  }
}

export function certificateAlert(reason: VerificationReason): TlsAlert {
  return { level: 'fatal', description: alertForVerificationReason(reason) };
}

export function fatalAlert(description: AlertDescription): TlsAlert {
  return { level: 'fatal', description };
}

const ALERT_DESCRIPTION_BY_CODE = new Map<number, AlertDescription>(
  (Object.entries(ALERT_DESCRIPTION_CODE) as [AlertDescription, number][]).map(([name, code]) => [code, name]),
);

export function alertToRecord(alert: TlsAlert, legacyVersion = 0x0303): TlsRecord {
  return {
    contentType: 'alert', legacyVersion,
    fragment: Uint8Array.of(alert.level === 'fatal' ? 2 : 1, ALERT_DESCRIPTION_CODE[alert.description]),
  };
}

export function alertFromRecord(record: TlsRecord): TlsAlert | null {
  if (record.contentType !== 'alert' || record.fragment.length !== 2) return null;
  const description = ALERT_DESCRIPTION_BY_CODE.get(record.fragment[1]);
  if (!description) return null;
  return { level: record.fragment[0] === 2 ? 'fatal' : 'warning', description };
}

const OPENSSL_ALERT_REASON: Readonly<Partial<Record<AlertDescription, readonly [number, string]>>> = {
  unexpected_message: [1010, 'sslv3 alert unexpected message'],
  bad_record_mac: [1020, 'sslv3 alert bad record mac'],
  record_overflow: [1022, 'tlsv1 alert record overflow'],
  decompression_failure: [1030, 'sslv3 alert decompression failure'],
  handshake_failure: [1040, 'sslv3 alert handshake failure'],
  bad_certificate: [1042, 'sslv3 alert bad certificate'],
  unsupported_certificate: [1043, 'sslv3 alert unsupported certificate'],
  certificate_revoked: [1044, 'sslv3 alert certificate revoked'],
  certificate_expired: [1045, 'sslv3 alert certificate expired'],
  certificate_unknown: [1046, 'sslv3 alert certificate unknown'],
  illegal_parameter: [1047, 'sslv3 alert illegal parameter'],
  unknown_ca: [1048, 'tlsv1 alert unknown ca'],
  access_denied: [1049, 'tlsv1 alert access denied'],
  decode_error: [1050, 'tlsv1 alert decode error'],
  decrypt_error: [1051, 'tlsv1 alert decrypt error'],
  protocol_version: [1070, 'tlsv1 alert protocol version'],
  insufficient_security: [1071, 'tlsv1 alert insufficient security'],
  internal_error: [1080, 'tlsv1 alert internal error'],
  user_canceled: [1090, 'tlsv1 alert user cancelled'],
  no_renegotiation: [1100, 'tlsv1 alert no renegotiation'],
  missing_extension: [1109, 'tlsv13 alert missing extension'],
  certificate_required: [1116, 'tlsv13 alert certificate required'],
};

export function opensslErrorLine(reason: number, text: string): string {
  return `error:${(0x0a000000 + reason).toString(16).toUpperCase().padStart(8, '0')}:SSL routines::${text}`;
}

export function opensslAlertReason(description: AlertDescription): string | undefined {
  const entry = OPENSSL_ALERT_REASON[description];
  if (entry !== undefined) return opensslErrorLine(entry[0], entry[1]);
  const code = ALERT_DESCRIPTION_CODE[description];
  return opensslErrorLine(1000 + code, `reason(${1000 + code})`);
}
