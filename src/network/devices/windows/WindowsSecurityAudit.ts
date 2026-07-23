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
    data?: Record<string, string>,
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
  GROUP_MEMBER_ADDED_GLOBAL: 4728,
  GROUP_MEMBER_REMOVED_GLOBAL: 4729,
  GROUP_MEMBER_ADDED_UNIVERSAL: 4756,
  GROUP_MEMBER_REMOVED_UNIVERSAL: 4757,
  GROUP_CREATED: 4731,
  GROUP_DELETED: 4734,
  PROCESS_CREATED: 4688,
  PROCESS_TERMINATED: 4689,
  REGISTRY_VALUE_MODIFIED: 4657,
  PERMISSION_CHANGED: 4670,
  SERVICE_INSTALLED: 4697,
} as const;

const SECURITY_LOG = 'Security';
const AUDIT_SOURCE = 'Microsoft-Windows-Security-Auditing';
const SUBJECT = 'Subject:\n\tSecurity ID:\t\tS-1-5-21\n\tAccount Name:\t\tAdministrator';

export class WindowsSecurityAudit {
  constructor(private readonly sink: SecurityEventSink) {}

  // ─── Account lifecycle ─────────────────────────────────────────────────

  accountCreated(name: string, subjectUserName = 'Administrator'): void {
    this.success(SECURITY_EVENT.ACCOUNT_CREATED, `A user account was created.\n\nNew Account:\n\tAccount Name:\t${name}`,
      { TargetUserName: name, SubjectUserName: subjectUserName });
  }

  accountDeleted(name: string, subjectUserName = 'Administrator'): void {
    this.success(SECURITY_EVENT.ACCOUNT_DELETED, `A user account was deleted.\n\nTarget Account:\n\tAccount Name:\t${name}`,
      { TargetUserName: name, SubjectUserName: subjectUserName });
  }

  accountEnabled(name: string, subjectUserName = 'Administrator'): void {
    this.success(SECURITY_EVENT.ACCOUNT_ENABLED, `A user account was enabled.\n\nTarget Account:\n\tAccount Name:\t${name}`,
      { TargetUserName: name, SubjectUserName: subjectUserName });
  }

  accountDisabled(name: string, subjectUserName = 'Administrator'): void {
    this.success(SECURITY_EVENT.ACCOUNT_DISABLED, `A user account was disabled.\n\nTarget Account:\n\tAccount Name:\t${name}`,
      { TargetUserName: name, SubjectUserName: subjectUserName });
  }

  passwordReset(name: string, subjectUserName = 'Administrator'): void {
    this.success(SECURITY_EVENT.PASSWORD_RESET, `An attempt was made to reset an account's password.\n\nTarget Account:\n\tAccount Name:\t${name}`,
      { TargetUserName: name, SubjectUserName: subjectUserName });
  }

  accountChanged(name: string, subjectUserName = 'Administrator'): void {
    this.success(SECURITY_EVENT.ACCOUNT_CHANGED, `A user account was changed.\n\nTarget Account:\n\tAccount Name:\t${name}`,
      { TargetUserName: name, SubjectUserName: subjectUserName });
  }

  // ─── Group lifecycle ───────────────────────────────────────────────────

  groupCreated(group: string, subjectUserName = 'Administrator'): void {
    this.success(SECURITY_EVENT.GROUP_CREATED, `A security-enabled local group was created.\n\nGroup:\n\tGroup Name:\t${group}`,
      { TargetUserName: group, SubjectUserName: subjectUserName });
  }

  groupDeleted(group: string, subjectUserName = 'Administrator'): void {
    this.success(SECURITY_EVENT.GROUP_DELETED, `A security-enabled local group was deleted.\n\nGroup:\n\tGroup Name:\t${group}`,
      { TargetUserName: group, SubjectUserName: subjectUserName });
  }

  groupMemberAdded(group: string, member: string, scope: 'Local' | 'Global' | 'Universal' = 'Local', subjectUserName = 'Administrator'): void {
    const eventId = scope === 'Global' ? SECURITY_EVENT.GROUP_MEMBER_ADDED_GLOBAL
      : scope === 'Universal' ? SECURITY_EVENT.GROUP_MEMBER_ADDED_UNIVERSAL
      : SECURITY_EVENT.GROUP_MEMBER_ADDED;
    this.success(eventId, `A member was added to a security-enabled ${scope.toLowerCase()} group.\n\nMember:\t${member}\nGroup:\t${group}`,
      { TargetUserName: group, MemberName: member, SubjectUserName: subjectUserName });
  }

  groupMemberRemoved(group: string, member: string, scope: 'Local' | 'Global' | 'Universal' = 'Local', subjectUserName = 'Administrator'): void {
    const eventId = scope === 'Global' ? SECURITY_EVENT.GROUP_MEMBER_REMOVED_GLOBAL
      : scope === 'Universal' ? SECURITY_EVENT.GROUP_MEMBER_REMOVED_UNIVERSAL
      : SECURITY_EVENT.GROUP_MEMBER_REMOVED;
    this.success(eventId, `A member was removed from a security-enabled ${scope.toLowerCase()} group.\n\nMember:\t${member}\nGroup:\t${group}`,
      { TargetUserName: group, MemberName: member, SubjectUserName: subjectUserName });
  }

  // ─── Logon / logoff ────────────────────────────────────────────────────

  logonSuccess(name: string, logonType = 2, ipAddress?: string): void {
    this.success(SECURITY_EVENT.LOGON_SUCCESS, `An account was successfully logged on.\n\nLogon Type:\t\t${logonType}\nAccount Name:\t${name}`,
      { TargetUserName: name, ...(ipAddress ? { IpAddress: ipAddress } : {}) });
  }

  logonFailure(name: string, ipAddress?: string): void {
    this.failure(SECURITY_EVENT.LOGON_FAILURE, `An account failed to log on.\n\nAccount For Which Logon Failed:\n\tAccount Name:\t${name}`,
      { TargetUserName: name, ...(ipAddress ? { IpAddress: ipAddress } : {}) });
  }

  logoff(name: string): void {
    this.success(SECURITY_EVENT.LOGOFF, `An account was logged off.\n\nSubject:\n\tAccount Name:\t${name}`);
  }

  accountLockedOut(name: string): void {
    this.failure(SECURITY_EVENT.ACCOUNT_LOCKED_OUT, `A user account was locked out.\n\nAccount That Was Locked Out:\n\tAccount Name:\t${name}`);
  }

  // ─── Process tracking ──────────────────────────────────────────────────

  processCreated(name: string, pid: number): void {
    this.success(SECURITY_EVENT.PROCESS_CREATED, `A new process has been created.\n\nProcess Information:\n\tNew Process ID:\t0x${pid.toString(16)}\n\tNew Process Name:\t${name}`);
  }

  processTerminated(name: string, pid: number): void {
    this.success(SECURITY_EVENT.PROCESS_TERMINATED, `A process has exited.\n\nProcess Information:\n\tProcess ID:\t0x${pid.toString(16)}\n\tProcess Name:\t${name}`);
  }

  // ─── Object access (registry / filesystem, requires auditpol + SACL) ───

  registryValueModified(objectPath: string, previousValue: string, newValue: string, changedBy: string): void {
    this.success(SECURITY_EVENT.REGISTRY_VALUE_MODIFIED,
      `A registry value was modified.\n\nObject:\n\tObject Name:\t${objectPath}\n\t` +
      `Old Value:\t${previousValue}\n\tNew Value:\t${newValue}\n\nSubject:\n\tAccount Name:\t${changedBy}`);
  }

  permissionChanged(objectPath: string, identity: string, permissions: string, changedBy: string): void {
    this.success(SECURITY_EVENT.PERMISSION_CHANGED,
      `Permissions on an object were changed.\n\nObject:\n\tObject Name:\t${objectPath}\n\t` +
      `New Access:\t${identity}: ${permissions}\n\nSubject:\n\tAccount Name:\t${changedBy}`);
  }

  serviceInstalled(serviceName: string, binaryPath: string, account: string, installedBy: string): void {
    this.success(SECURITY_EVENT.SERVICE_INSTALLED,
      `A service was installed in the system.\n\nService Information:\n\tService Name:\t${serviceName}\n\t` +
      `Service File Name:\t${binaryPath}\n\tService Account:\t${account}\n\nSubject:\n\tAccount Name:\t${installedBy}`);
  }

  // ─── Internals ─────────────────────────────────────────────────────────

  private success(eventId: number, message: string, data?: Record<string, string>): void {
    this.sink.writeEventLog(SECURITY_LOG, AUDIT_SOURCE, eventId, 'SuccessAudit', `${message}\n\n${SUBJECT}`, data);
  }

  private failure(eventId: number, message: string, data?: Record<string, string>): void {
    this.sink.writeEventLog(SECURITY_LOG, AUDIT_SOURCE, eventId, 'FailureAudit', `${message}\n\n${SUBJECT}`, data);
  }
}
