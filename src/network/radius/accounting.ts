/**
 * RADIUS Accounting (RFC 2866) — value enums and attribute-set builders
 * shared by `RadiusAccountingClient` (NAS side) and `RadiusServerAgent`'s
 * accounting handling (collector side).
 */
import { attr, type RadiusAttribute } from './types';

export type AcctStatusType = 'start' | 'interim-update' | 'stop' | 'accounting-on' | 'accounting-off';

/** RFC 2866 §5.1 Acct-Status-Type values. */
export const ACCT_STATUS_TYPE: Record<AcctStatusType, number> = {
  start: 1,
  stop: 2,
  'interim-update': 3,
  'accounting-on': 7,
  'accounting-off': 8,
};

export type AcctTerminateCause =
  | 'user-request' | 'lost-carrier' | 'lost-service' | 'idle-timeout'
  | 'session-timeout' | 'admin-reset' | 'nas-reboot' | 'nas-error' | 'port-error';

/** RFC 2866 §5.10 Acct-Terminate-Cause values (subset the simulator produces). */
export const ACCT_TERMINATE_CAUSE: Record<AcctTerminateCause, number> = {
  'user-request': 1,
  'lost-carrier': 2,
  'lost-service': 3,
  'idle-timeout': 4,
  'session-timeout': 5,
  'admin-reset': 6,
  'nas-reboot': 7,
  'nas-error': 9,
  'port-error': 10,
};

/** RFC 2866 §5.6 Acct-Authentic values. */
export const ACCT_AUTHENTIC = { radius: 1, local: 2, remote: 3 } as const;

export interface AcctRecord {
  sessionId: string;
  username: string;
  nasIp: string;
  status: AcctStatusType;
  delaySec: number;
  sessionTimeSec: number;
  inputOctets: number;
  outputOctets: number;
  terminateCause?: AcctTerminateCause;
}

/** Build the RFC 2866 attribute set for an Accounting-Request from a record snapshot. */
export function acctAttributesFor(record: AcctRecord): RadiusAttribute[] {
  const attrs: RadiusAttribute[] = [
    attr('user-name', record.username),
    attr('acct-session-id', record.sessionId),
    attr('acct-status-type', ACCT_STATUS_TYPE[record.status]),
    attr('acct-authentic', ACCT_AUTHENTIC.radius),
    attr('acct-delay-time', record.delaySec),
    attr('nas-ip-address', record.nasIp),
  ];
  if (record.status !== 'start') {
    attrs.push(attr('acct-session-time', record.sessionTimeSec));
    attrs.push(attr('acct-input-octets', record.inputOctets));
    attrs.push(attr('acct-output-octets', record.outputOctets));
  }
  if (record.status === 'stop' && record.terminateCause) {
    attrs.push(attr('acct-terminate-cause', ACCT_TERMINATE_CAUSE[record.terminateCause]));
  }
  return attrs;
}

let acctSessionCounter = 0;

/** Generate a locally-unique accounting session id (NAS-side identifier, RFC 2866 §5.5). */
export function generateAcctSessionId(): string {
  acctSessionCounter += 1;
  return `${Date.now().toString(16)}-${acctSessionCounter.toString(16).padStart(4, '0')}`;
}
