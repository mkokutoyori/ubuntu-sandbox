/**
 * WindowsSecurityAudit — the Windows Security event-log audit trail.
 *
 * On real Windows the Security log is the audit record of every
 * security-relevant operation, each tagged with a well-known Event ID from
 * the `Microsoft-Windows-Security-Auditing` source. This class turns the
 * account / group / logon operations the simulator performs into those
 * faithful entries, so `Get-EventLog Security`, `wevtutil` and Event Viewer
 * all see a coherent trail.
 *
 * It is a thin, intention-revealing façade over the event-log provider:
 * callers say *what happened* (`accountCreated`), not *which Event ID*.
 */

/** The slice of the event-log provider the security audit writes through. */
export interface SecurityEventSink {
  writeEventLog(
    logName: string, source: string, eventId: number,
    entryType: 'Information' | 'Warning' | 'Error' | 'SuccessAudit' | 'FailureAudit',
    message: string,
  ): string;
}

/** Well-known Windows Security-log Event IDs (see Microsoft documentation). */
export const SECURITY_EVENT = {
  LOGON_SUCCESS: 4624,
  LOGON_FAILURE: 4625,
  LOGOFF: 4634,
  SPECIAL_PRIVILEGES: 4672,
  ACCOUNT_CREATED: 4720,
  ACCOUNT_ENABLED: 4722,
  PASSWORD_RESET: 4724,
  ACCOUNT_DISABLED: 4725,
  ACCOUNT_DELETED: 4726,
  ACCOUNT_CHANGED: 4738,
  ACCOUNT_LOCKED_OUT: 4740,
  GROUP_MEMBER_ADDED: 4732,
  GROUP_MEMBER_REMOVED: 4733,
  GROUP_CREATED: 4731,
  GROUP_DELETED: 4734,
} as const;

const SECURITY_LOG = 'Security';
const AUDIT_SOURCE = 'Microsoft-Windows-Security-Auditing';
const SUBJECT = 'Subject:\n\tSecurity ID:\t\tS-1-5-21\n\tAccount Name:\t\tAdministrator';

export class WindowsSecurityAudit {
  constructor(private readonly sink: SecurityEventSink) {}

  // ─── Account lifecycle ─────────────────────────────────────────────────

  accountCreated(name: string): void {
    this.success(SECURITY_EVENT.ACCOUNT_CREATED, `A user account was created.\n\nNew Account:\n\tAccount Name:\t${name}`);
  }

  accountDeleted(name: string): void {
    this.success(SECURITY_EVENT.ACCOUNT_DELETED, `A user account was deleted.\n\nTarget Account:\n\tAccount Name:\t${name}`);
  }

  accountEnabled(name: string): void {
    this.success(SECURITY_EVENT.ACCOUNT_ENABLED, `A user account was enabled.\n\nTarget Account:\n\tAccount Name:\t${name}`);
  }

  accountDisabled(name: string): void {
    this.success(SECURITY_EVENT.ACCOUNT_DISABLED, `A user account was disabled.\n\nTarget Account:\n\tAccount Name:\t${name}`);
  }

  passwordReset(name: string): void {
    this.success(SECURITY_EVENT.PASSWORD_RESET, `An attempt was made to reset an account's password.\n\nTarget Account:\n\tAccount Name:\t${name}`);
  }

  accountChanged(name: string): void {
    this.success(SECURITY_EVENT.ACCOUNT_CHANGED, `A user account was changed.\n\nTarget Account:\n\tAccount Name:\t${name}`);
  }

  // ─── Group lifecycle ───────────────────────────────────────────────────

  groupCreated(group: string): void {
    this.success(SECURITY_EVENT.GROUP_CREATED, `A security-enabled local group was created.\n\nGroup:\n\tGroup Name:\t${group}`);
  }

  groupDeleted(group: string): void {
    this.success(SECURITY_EVENT.GROUP_DELETED, `A security-enabled local group was deleted.\n\nGroup:\n\tGroup Name:\t${group}`);
  }

  groupMemberAdded(group: string, member: string): void {
    this.success(SECURITY_EVENT.GROUP_MEMBER_ADDED, `A member was added to a security-enabled local group.\n\nMember:\t${member}\nGroup:\t${group}`);
  }

  groupMemberRemoved(group: string, member: string): void {
    this.success(SECURITY_EVENT.GROUP_MEMBER_REMOVED, `A member was removed from a security-enabled local group.\n\nMember:\t${member}\nGroup:\t${group}`);
  }

  // ─── Logon / logoff ────────────────────────────────────────────────────

  logonSuccess(name: string, logonType = 2): void {
    this.success(SECURITY_EVENT.LOGON_SUCCESS, `An account was successfully logged on.\n\nLogon Type:\t\t${logonType}\nAccount Name:\t${name}`);
  }

  logonFailure(name: string): void {
    this.failure(SECURITY_EVENT.LOGON_FAILURE, `An account failed to log on.\n\nAccount For Which Logon Failed:\n\tAccount Name:\t${name}`);
  }

  logoff(name: string): void {
    this.success(SECURITY_EVENT.LOGOFF, `An account was logged off.\n\nSubject:\n\tAccount Name:\t${name}`);
  }

  accountLockedOut(name: string): void {
    this.failure(SECURITY_EVENT.ACCOUNT_LOCKED_OUT, `A user account was locked out.\n\nAccount That Was Locked Out:\n\tAccount Name:\t${name}`);
  }

  // ─── Internals ─────────────────────────────────────────────────────────

  private success(eventId: number, message: string): void {
    this.sink.writeEventLog(SECURITY_LOG, AUDIT_SOURCE, eventId, 'SuccessAudit', `${message}\n\n${SUBJECT}`);
  }

  private failure(eventId: number, message: string): void {
    this.sink.writeEventLog(SECURITY_LOG, AUDIT_SOURCE, eventId, 'FailureAudit', `${message}\n\n${SUBJECT}`);
  }
}
