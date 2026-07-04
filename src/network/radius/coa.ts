/**
 * RFC 5176 — Dynamic Authorization Extensions to RADIUS (CoA/Disconnect).
 * Enums, Error-Cause and session-identifier extraction shared by
 * `CoaListener` (NAS side, receives) and `CoaClient` (server side, sends).
 */
import { getAttr, type RadiusAttribute, type RadiusPacket } from './types';

export type ErrorCause =
  | 'residual-session-context-removed'
  | 'invalid-eap-packet'
  | 'unsupported-attribute'
  | 'missing-attribute'
  | 'nas-identification-mismatch'
  | 'invalid-request'
  | 'unsupported-service'
  | 'unsupported-extension'
  | 'invalid-attribute-value'
  | 'administratively-prohibited'
  | 'request-not-routable'
  | 'session-context-not-found'
  | 'session-context-not-removable'
  | 'other-proxy-processing-error'
  | 'resources-unavailable'
  | 'request-initiated';

/** RFC 5176 §3.6 Error-Cause values. */
export const ERROR_CAUSE: Record<ErrorCause, number> = {
  'residual-session-context-removed': 201,
  'invalid-eap-packet': 202,
  'unsupported-attribute': 401,
  'missing-attribute': 402,
  'nas-identification-mismatch': 403,
  'invalid-request': 404,
  'unsupported-service': 405,
  'unsupported-extension': 406,
  'invalid-attribute-value': 407,
  'administratively-prohibited': 501,
  'request-not-routable': 502,
  'session-context-not-found': 503,
  'session-context-not-removable': 504,
  'other-proxy-processing-error': 505,
  'resources-unavailable': 506,
  'request-initiated': 507,
};

const ERROR_CAUSE_BY_NUMBER = new Map<number, ErrorCause>(
  (Object.keys(ERROR_CAUSE) as ErrorCause[]).map((k) => [ERROR_CAUSE[k], k]),
);

export function errorCauseAttr(cause: ErrorCause): RadiusAttribute {
  return { type: 'error-cause', value: ERROR_CAUSE[cause] };
}

export function readErrorCause(packet: RadiusPacket): ErrorCause | null {
  const a = getAttr(packet, 'error-cause');
  if (!a) return null;
  return ERROR_CAUSE_BY_NUMBER.get(Number(a.value)) ?? null;
}

/** Session-identifying attributes a Disconnect/CoA-Request can carry (RFC 5176 §3: at minimum enough to identify one session unambiguously). */
export interface CoaSessionIdentifiers {
  username: string | null;
  acctSessionId: string | null;
  callingStationId: string | null;
}

export function readSessionIdentifiers(packet: RadiusPacket): CoaSessionIdentifiers {
  return {
    username: getAttr(packet, 'user-name')?.value != null ? String(getAttr(packet, 'user-name')!.value) : null,
    acctSessionId: getAttr(packet, 'acct-session-id')?.value != null
      ? String(getAttr(packet, 'acct-session-id')!.value) : null,
    callingStationId: getAttr(packet, 'calling-station-id')?.value != null
      ? String(getAttr(packet, 'calling-station-id')!.value) : null,
  };
}
