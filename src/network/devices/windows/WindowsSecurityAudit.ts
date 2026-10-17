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

import type { WindowsLogonDetails, WindowsLogonFailureCause } from './events';
import { createAuditIdentity, nextLogonId, type AuditIdentity } from './eventlog/AuditIdentity';
import { renderSecurityMessage, clearedChannelMessage, failureReasonOf } from './eventlog/SecurityEventTemplates';

export { nextLogonId };

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
  PASSWORD_CHANGED: 4723,
  PASSWORD_RESET: 4724,
  ACCOUNT_DISABLED: 4725,
  ACCOUNT_DELETED: 4726,
  ACCOUNT_CHANGED: 4738,
  ACCOUNT_LOCKED_OUT: 4740,
  ACCOUNT_UNLOCKED: 4767,
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
  PRIVILEGED_SERVICE_CALLED: 4673,
  SCHEDULED_TASK_CREATED: 4698,
  OBJECT_ACCESSED: 4663,
  SHARE_ACCESSED: 5140,
  SHARE_ADDED: 5142,
  AUDIT_LOG_CLEARED: 1102,
  AUDIT_POLICY_CHANGED: 4719,
  EVENT_LOG_CLEARED: 104,
  REGISTRY_VALUE_MODIFIED: 4657,
  PERMISSION_CHANGED: 4670,
  SERVICE_INSTALLED: 4697,
  WORKSTATION_LOCKED: 4800,
  WORKSTATION_UNLOCKED: 4801,
  SCREENSAVER_INVOKED: 4802,
  SCREENSAVER_DISMISSED: 4803,
  SESSION_RECONNECTED: 4778,
  SESSION_DISCONNECTED: 4779,
  EXPLICIT_CREDENTIALS_LOGON: 4648,
} as const;

/** Ce qu'un événement de suivi de processus sait de son sujet. */
export interface ProcessAuditDetails {
  ppid?: number;
  parentName?: string;
  owner?: string;
  commandLine?: string;
  /**
   * Contexte d'élévation UAC réel (PRD-Winlogon.md §2.1 P5), quand
   * l'appelant le connaît : `'full'` → runas explicite réussi (%%1937,
   * intégrité haute) ; `'default'` → session déjà ouverte directement en
   * administrateur, sans runas (%%1936) ; `'limited'` → membre du groupe
   * Administrators qui exécute SANS élever (%%1938, jeton filtré — le
   * cas UAC le plus fréquent, absent jusqu'ici). Absent (la majorité des
   * spawns) → repli sur `isElevatedAccount()`, comportement historique
   * inchangé.
   */
  elevation?: 'full' | 'default' | 'limited';
}

/**
 * `DOMAINE\compte` → les deux champs que Windows sépare. Un compte sans
 * domaine laisse `SubjectDomainName` vide plutôt que de lui inventer
 * une valeur.
 */
function splitAccount(account?: string): Record<string, string> {
  if (!account) return {};
  const at = account.indexOf('\\');
  if (at < 0) return { SubjectUserName: account };
  return {
    SubjectDomainName: account.slice(0, at),
    SubjectUserName: account.slice(at + 1),
  };
}

/** Les comptes dont le jeton est élevé — administrateurs et SYSTEM. */
function isElevatedAccount(account?: string): boolean {
  if (!account) return false;
  const leaf = account.slice(account.indexOf('\\') + 1).toLowerCase();
  return leaf === 'administrator' || leaf === 'system' || leaf.endsWith('admin');
}

/**
 * TokenElevationType/MandatoryLabel pour un 4688 (PRD-Winlogon.md §2.1
 * P5). `details.elevation`, quand fourni, porte la vérité — les trois
 * vraies valeurs Windows. Absent (aucun appelant ne connaît encore le
 * contexte réel), on retombe sur `isElevatedAccount()` : c'est le
 * comportement historique, préservé bit pour bit pour ne rien casser.
 */
function resolveElevation(details: ProcessAuditDetails): { tokenElevationType: string; mandatoryLabel: string } {
  switch (details.elevation) {
    case 'full':    return { tokenElevationType: '%%1937', mandatoryLabel: 'S-1-16-12288' };
    case 'limited': return { tokenElevationType: '%%1938', mandatoryLabel: 'S-1-16-8192' };
    case 'default': return { tokenElevationType: '%%1936', mandatoryLabel: 'S-1-16-8192' };
    default: {
      const elevated = isElevatedAccount(details.owner);
      return elevated
        ? { tokenElevationType: '%%1937', mandatoryLabel: 'S-1-16-12288' }
        : { tokenElevationType: '%%1936', mandatoryLabel: 'S-1-16-8192' };
    }
  }
}

const SECURITY_LOG = 'Security';
const AUDIT_SOURCE = 'Microsoft-Windows-Security-Auditing';
const EVENTLOG_SOURCE = 'Microsoft-Windows-Eventlog';

export type LogonDetails = WindowsLogonDetails;
export type LogonFailureCause = WindowsLogonFailureCause;

const FAILURE_STATUS: Record<LogonFailureCause, { status: string; subStatus: string; reason: string }> = {
  'unknown-user': { status: '0xC000006D', subStatus: '0xC0000064', reason: '%%2313' },
  'bad-password': { status: '0xC000006D', subStatus: '0xC000006A', reason: '%%2313' },
  disabled: { status: '0xC0000072', subStatus: '0x0', reason: '%%2310' },
  expired: { status: '0xC0000193', subStatus: '0x0', reason: '%%2305' },
  locked: { status: '0xC0000234', subStatus: '0x0', reason: '%%2307' },
  'logon-hours': { status: '0xC000006F', subStatus: '0x0', reason: '%%2311' },
  workstation: { status: '0xC0000070', subStatus: '0x0', reason: '%%2312' },
  'password-expired': { status: '0xC0000071', subStatus: '0x0', reason: '%%2309' },
};

const DEFAULT_IDENTITY_MACHINE = 'WORKGROUP';

export class WindowsSecurityAudit {
  constructor(
    private readonly sink: SecurityEventSink,
    private readonly identity: AuditIdentity = createAuditIdentity(DEFAULT_IDENTITY_MACHINE),
  ) {}

  // ─── Account lifecycle ─────────────────────────────────────────────────

  private subjectFields(actor: string): Record<string, string> {
    const subject = this.identity.subjectOf(actor);
    return {
      SubjectUserSid: subject.sid, SubjectUserName: subject.name,
      SubjectDomainName: subject.domain, SubjectLogonId: subject.logonId,
    };
  }

  private targetFields(account: string): Record<string, string> {
    const leaf = account.slice(account.indexOf('\\') + 1);
    const domain = account.includes('\\') ? account.slice(0, account.indexOf('\\')) : this.identity.machine;
    return { TargetUserName: leaf, TargetDomainName: domain, TargetSid: this.identity.sidOf(account) };
  }

  private accountEvent(eventId: number, name: string, actor: string, extra: Record<string, string> = {}): void {
    this.record(eventId, 'SuccessAudit', { ...this.targetFields(name), ...this.subjectFields(actor), ...extra });
  }

  accountCreated(name: string, subjectUserName = 'Administrator'): void {
    this.accountEvent(SECURITY_EVENT.ACCOUNT_CREATED, name, subjectUserName, {
      PrivilegeList: '-', SamAccountName: name, DisplayName: '%%1793', UserPrincipalName: '-',
      HomeDirectory: '%%1793', HomePath: '%%1793', ScriptPath: '%%1793', ProfilePath: '%%1793',
      UserWorkstations: '%%1793', PasswordLastSet: '%%1794', AccountExpires: '%%1794',
      PrimaryGroupId: '513', AllowedToDelegateTo: '-', OldUacValue: '0x0', NewUacValue: '0x15',
      UserAccountControl: "Account Disabled\n'Password Not Required' - Enabled\n'Normal Account' - Enabled",
      UserParameters: '-', SidHistory: '-', LogonHours: '%%1797',
    });
  }

  accountDeleted(name: string, subjectUserName = 'Administrator'): void {
    this.accountEvent(SECURITY_EVENT.ACCOUNT_DELETED, name, subjectUserName, { PrivilegeList: '-' });
  }

  accountEnabled(name: string, subjectUserName = 'Administrator'): void {
    this.accountEvent(SECURITY_EVENT.ACCOUNT_ENABLED, name, subjectUserName);
  }

  accountDisabled(name: string, subjectUserName = 'Administrator'): void {
    this.accountEvent(SECURITY_EVENT.ACCOUNT_DISABLED, name, subjectUserName);
  }

  accountUnlocked(name: string, subjectUserName = 'Administrator'): void {
    this.accountEvent(SECURITY_EVENT.ACCOUNT_UNLOCKED, name, subjectUserName);
  }

  passwordReset(name: string, subjectUserName = 'Administrator'): void {
    this.accountEvent(SECURITY_EVENT.PASSWORD_RESET, name, subjectUserName);
  }

  passwordChanged(name: string, subjectUserName = name): void {
    this.accountEvent(SECURITY_EVENT.PASSWORD_CHANGED, name, subjectUserName);
  }

  accountChanged(name: string, subjectUserName = 'Administrator', changed: Record<string, string> = {}): void {
    this.accountEvent(SECURITY_EVENT.ACCOUNT_CHANGED, name, subjectUserName, { PrivilegeList: '-', ...changed });
  }

  // ─── Group lifecycle ───────────────────────────────────────────────────

  private groupFields(group: string): Record<string, string> {
    const identity = this.identity.groupSidOf(group);
    return { TargetUserName: group, TargetDomainName: identity.domain, TargetSid: identity.sid };
  }

  groupCreated(group: string, subjectUserName = 'Administrator'): void {
    this.record(SECURITY_EVENT.GROUP_CREATED, 'SuccessAudit', {
      ...this.groupFields(group), ...this.subjectFields(subjectUserName),
      PrivilegeList: '-', SamAccountName: group, SidHistory: '-',
    });
  }

  groupDeleted(group: string, subjectUserName = 'Administrator'): void {
    this.record(SECURITY_EVENT.GROUP_DELETED, 'SuccessAudit', {
      ...this.groupFields(group), ...this.subjectFields(subjectUserName), PrivilegeList: '-',
    });
  }

  groupMemberAdded(group: string, member: string, scope: 'Local' | 'Global' | 'Universal' = 'Local', subjectUserName = 'Administrator'): void {
    const eventId = scope === 'Global' ? SECURITY_EVENT.GROUP_MEMBER_ADDED_GLOBAL
      : scope === 'Universal' ? SECURITY_EVENT.GROUP_MEMBER_ADDED_UNIVERSAL
      : SECURITY_EVENT.GROUP_MEMBER_ADDED;
    this.membershipEvent(eventId, group, member, scope, subjectUserName, 'added');
  }

  groupMemberRemoved(group: string, member: string, scope: 'Local' | 'Global' | 'Universal' = 'Local', subjectUserName = 'Administrator'): void {
    const eventId = scope === 'Global' ? SECURITY_EVENT.GROUP_MEMBER_REMOVED_GLOBAL
      : scope === 'Universal' ? SECURITY_EVENT.GROUP_MEMBER_REMOVED_UNIVERSAL
      : SECURITY_EVENT.GROUP_MEMBER_REMOVED;
    this.membershipEvent(eventId, group, member, scope, subjectUserName, 'removed');
  }

  private membershipEvent(
    eventId: number, group: string, member: string, scope: 'Local' | 'Global' | 'Universal',
    actor: string, direction: 'added' | 'removed',
  ): void {
    const fields = {
      ...this.groupFields(group), ...this.subjectFields(actor),
      MemberName: scope === 'Local' ? '-' : member, MemberSid: this.identity.sidOf(member), PrivilegeList: '-',
    };
    const message = scope === 'Local' ? null
      : `A member was ${direction} ${direction === 'added' ? 'to' : 'from'} a security-enabled ${scope.toLowerCase()} group.\n\nMember:\t${member}\nGroup:\t${group}`;
    this.record(eventId, 'SuccessAudit', fields, message);
  }

  // ─── Logon / logoff ────────────────────────────────────────────────────

  /**
   * 4624 — ouverture de session réussie.
   *
   * `TargetLogonId` est l'identifiant de la session ouverte. C'est le
   * seul lien entre ce 4624 et le 4634 qui le clôturera : sans lui, on
   * voit des connexions et des déconnexions sans pouvoir dire lesquelles
   * vont ensemble, donc sans pouvoir mesurer la durée d'une session.
   */
  logonSuccess(name: string, logonType = 2, logonId?: string, details: LogonDetails = {}): void {
    const id = logonId ?? nextLogonId();
    this.identity.openSession(name, id);
    const target = this.targetFields(name);
    this.record(SECURITY_EVENT.LOGON_SUCCESS, 'SuccessAudit', {
      ...this.subjectFields('SYSTEM'),
      TargetUserSid: target.TargetSid, TargetUserName: target.TargetUserName,
      TargetDomainName: target.TargetDomainName, TargetLogonId: id,
      LogonType: String(logonType),
      LogonProcessName: details.logonProcess ?? 'User32',
      AuthenticationPackageName: details.authenticationPackage ?? 'Negotiate',
      WorkstationName: details.workstation ?? this.identity.machine,
      LogonGuid: '{00000000-0000-0000-0000-000000000000}',
      TransmittedServices: '-', LmPackageName: '-', KeyLength: '0',
      ProcessId: details.processId ?? '0x0', ProcessName: details.processName ?? '-',
      IpAddress: details.ipAddress ?? '-', IpPort: details.ipPort ?? '-',
      ImpersonationLevel: '%%1833', RestrictedAdminMode: '-',
      TargetOutboundUserName: '-', TargetOutboundDomainName: '-', VirtualAccount: '%%1843',
      TargetLinkedLogonId: '0x0', ElevatedToken: details.elevated ? '%%1842' : '%%1843',
    });
  }

  /**
   * 4625 — échec d'authentification.
   *
   * `Status` dit qu'il y a eu échec, `SubStatus` dit *lequel* : mot de
   * passe faux (0xC000006A) et compte inexistant (0xC0000064) ne se
   * traitent pas de la même façon, et c'est SubStatus qui les sépare.
   * Un compte désactivé, expiré ou verrouillé a son propre `Status` et
   * un `SubStatus` à zéro.
   */
  logonFailure(name: string, logonType = 2, cause: LogonFailureCause = 'bad-password', details: LogonDetails = {}): void {
    const codes = FAILURE_STATUS[cause];
    const target = this.targetFields(name);
    this.record(SECURITY_EVENT.LOGON_FAILURE, 'FailureAudit', {
      ...this.subjectFields('SYSTEM'),
      TargetUserSid: cause === 'unknown-user' ? 'S-1-0-0' : target.TargetSid,
      TargetUserName: target.TargetUserName, TargetDomainName: target.TargetDomainName,
      Status: codes.status, FailureReason: codes.reason, SubStatus: codes.subStatus,
      LogonType: String(logonType),
      LogonProcessName: details.logonProcess ?? 'User32',
      AuthenticationPackageName: details.authenticationPackage ?? 'Negotiate',
      WorkstationName: details.workstation ?? this.identity.machine,
      TransmittedServices: '-', LmPackageName: '-', KeyLength: '0',
      ProcessId: details.processId ?? '0x0', ProcessName: details.processName ?? '-',
      IpAddress: details.ipAddress ?? '-', IpPort: details.ipPort ?? '-',
    }, undefined, failureReasonOf(codes.status, codes.subStatus));
  }

  logoff(name: string, logonType = 2, logonId?: string): void {
    const target = this.targetFields(name);
    this.record(SECURITY_EVENT.LOGOFF, 'SuccessAudit', {
      TargetUserSid: target.TargetSid, TargetUserName: target.TargetUserName,
      TargetDomainName: target.TargetDomainName,
      TargetLogonId: logonId ?? this.identity.subjectOf(name).logonId,
      LogonType: String(logonType),
    });
  }

  accountLockedOut(name: string): void {
    this.record(SECURITY_EVENT.ACCOUNT_LOCKED_OUT, 'SuccessAudit', {
      ...this.targetFields(name), ...this.subjectFields('SYSTEM'),
      TargetDomainName: this.identity.machine,
    });
  }

  /**
   * 4648 — ouverture de session avec des identifiants explicites
   * (PRD-Winlogon.md §2.1 P5). `runas` en est l'exemple réel : `subject`
   * est le compte *appelant* (déjà connecté), `target` le compte
   * impersonné — c'est ce couple qui distingue 4648 d'un 4624 normal, où
   * Subject et TargetUserName seraient le même compte.
   */
  explicitCredentialsLogon(subject: string, target: string, targetServer = 'localhost'): void {
    this.success(SECURITY_EVENT.EXPLICIT_CREDENTIALS_LOGON,
      `A logon was attempted using explicit credentials.\n\nAccount Whose Credentials Were Used:\n\tAccount Name:\t${target}\n\nTarget Server:\n\tTarget Server Name:\t${targetServer}`,
      { ...splitAccount(subject), TargetUserName: target, TargetServerName: targetServer }, subject);
  }

  /**
   * 4800/4802 — le poste (ou son écran de veille) a été verrouillé.
   * PRD-Winlogon.md §2.1 P2/P3 : même mécanisme de verrouillage, seul
   * l'EventID change selon l'origine (`origin`).
   */
  workstationLocked(name: string, origin: 'user' | 'screensaver' = 'user'): void {
    const eventId = origin === 'screensaver' ? SECURITY_EVENT.SCREENSAVER_INVOKED : SECURITY_EVENT.WORKSTATION_LOCKED;
    const label = origin === 'screensaver' ? 'The screen saver was invoked.' : 'The workstation was locked.';
    this.success(eventId, `${label}\n\nSubject:\n\tAccount Name:\t${name}`,
      { TargetUserName: name }, name);
  }

  /** 4801/4803 — le poste (ou son écran de veille) a été déverrouillé. */
  workstationUnlocked(name: string, origin: 'user' | 'screensaver' = 'user'): void {
    const eventId = origin === 'screensaver' ? SECURITY_EVENT.SCREENSAVER_DISMISSED : SECURITY_EVENT.WORKSTATION_UNLOCKED;
    const label = origin === 'screensaver' ? 'The screen saver was dismissed.' : 'The workstation was unlocked.';
    this.success(eventId, `${label}\n\nSubject:\n\tAccount Name:\t${name}`,
      { TargetUserName: name }, name);
  }

  /**
   * 4778 — une session Terminal Services existante (`Disconnected`) a été
   * reconnectée par le même utilisateur (PRD-Winlogon.md §2.1 P4). Réel
   * Windows n'émet pas de nouveau 4624 pour ce cas : `logonId` porte donc
   * l'identifiant de la session déjà ouverte, jamais un nouveau.
   */
  sessionReconnected(name: string, logonType = 10, logonId?: string): void {
    this.success(SECURITY_EVENT.SESSION_RECONNECTED, `A session was reconnected to a Window Station.\n\nAccount Name:\t${name}\nLogon Type:\t\t${logonType}`,
      {
        TargetUserName: name,
        LogonType: String(logonType),
        TargetLogonId: logonId ?? nextLogonId(),
      });
  }

  /**
   * 4779 — une session Terminal Services a été déconnectée sans logoff
   * explicite (câble coupé, client fermé) — la session reste ouverte
   * côté serveur (contrairement à 4634), d'où `logonId` réutilisant celui
   * du 4624 d'origine plutôt que d'en émettre un nouveau.
   */
  sessionDisconnected(name: string, logonType = 10, logonId?: string): void {
    this.success(SECURITY_EVENT.SESSION_DISCONNECTED, `A session was disconnected from a Window Station.\n\nAccount Name:\t${name}\nLogon Type:\t\t${logonType}`,
      {
        TargetUserName: name,
        LogonType: String(logonType),
        TargetLogonId: logonId ?? nextLogonId(),
      });
  }

  // ─── Process tracking ──────────────────────────────────────────────────

  /**
   * 4688 — création de processus.
   *
   * Les champs sont ceux que Windows nomme, et la distinction compte :
   * `NewProcessId` est le processus créé, `ProcessId` son *parent*. Sans
   * eux dans l'EventData, une chaîne parent → enfant ne se reconstruit
   * pas, et c'est précisément ce qu'on cherche dans une investigation.
   *
   * `CommandLine` n'apparaît que si l'appelant l'a fourni : Windows ne
   * la journalise que sous `ProcessCreationIncludeCmdLine_Enabled`, et
   * l'inventer ici ferait croire à un réglage qui n'a pas été posé.
   */
  processCreated(name: string, pid: number, details: ProcessAuditDetails = {}): void {
    const { tokenElevationType, mandatoryLabel } = resolveElevation(details);
    this.success(SECURITY_EVENT.PROCESS_CREATED,
      `A new process has been created.\n\nProcess Information:\n\tNew Process ID:\t0x${pid.toString(16)}\n\tNew Process Name:\t${name}`,
      {
        NewProcessName: name,
        NewProcessId: `0x${pid.toString(16)}`,
        ProcessId: `0x${(details.ppid ?? 0).toString(16)}`,
        ParentProcessName: details.parentName ?? '',
        ...splitAccount(details.owner),
        TokenElevationType: tokenElevationType,
        MandatoryLabel: mandatoryLabel,
        ...(details.commandLine ? { CommandLine: details.commandLine } : {}),
      }, details.owner ?? 'SYSTEM');
  }

  processTerminated(name: string, pid: number, details: ProcessAuditDetails = {}): void {
    this.success(SECURITY_EVENT.PROCESS_TERMINATED,
      `A process has exited.\n\nProcess Information:\n\tProcess ID:\t0x${pid.toString(16)}\n\tProcess Name:\t${name}`,
      {
        ProcessName: name,
        ProcessId: `0x${pid.toString(16)}`,
        ...splitAccount(details.owner),
      }, details.owner ?? 'SYSTEM');
  }

  /** 4673 — un appel de service privilégié. */
  privilegedServiceCalled(
    service: string, privilege: string, processName: string, account: string,
  ): void {
    this.success(SECURITY_EVENT.PRIVILEGED_SERVICE_CALLED,
      `A privileged service was called.\n\nService:\n\tServer:\t${service}\n\t` +
      `Service Name:\t${privilege}\n\nProcess:\n\tProcess Name:\t${processName}`,
      {
        ...splitAccount(account),
        Service: service, PrivilegeList: privilege, ProcessName: processName,
      }, account);
  }

  /** 4672 — les privilèges d'un jeton à l'ouverture de session. */
  specialPrivileges(account: string, privileges: readonly string[], logonId: string): void {
    this.success(SECURITY_EVENT.SPECIAL_PRIVILEGES,
      `Special privileges assigned to new logon.\n\nSubject:\n\tAccount Name:\t${account}\n\n` +
      `Privileges:\t\t${privileges.join('\n\t\t\t')}`,
      {
        ...splitAccount(account),
        SubjectLogonId: logonId,
        PrivilegeList: privileges.join('\n\t\t\t'),
      }, account);
  }

  // ─── Object access (registry / filesystem, requires auditpol + SACL) ───

  /**
   * 4657 — modification d'une valeur du registre.
   *
   * L'ancienne et la nouvelle valeur sont tout l'intérêt de cet
   * événement : savoir qu'une clé a changé sans savoir de quoi vers quoi
   * ne dit rien. C'est ce qui distingue une écriture ordinaire d'une
   * persistance posée sous `...\CurrentVersion\Run`.
   */
  registryValueModified(objectPath: string, previousValue: string, newValue: string, changedBy: string): void {
    const at = objectPath.lastIndexOf('\\');
    this.success(SECURITY_EVENT.REGISTRY_VALUE_MODIFIED,
      `A registry value was modified.\n\nObject:\n\tObject Name:\t${objectPath}\n\t` +
      `Old Value:\t${previousValue}\n\tNew Value:\t${newValue}\n\nSubject:\n\tAccount Name:\t${changedBy}`,
      {
        ObjectName: at > 0 ? objectPath.slice(0, at) : objectPath,
        ObjectValueName: at > 0 ? objectPath.slice(at + 1) : '',
        OldValue: previousValue,
        NewValue: newValue,
        ...splitAccount(changedBy),
      }, changedBy);
  }

  /** 4698 — une tâche planifiée a été créée. */
  scheduledTaskCreated(taskName: string, command: string, createdBy: string): void {
    this.success(SECURITY_EVENT.SCHEDULED_TASK_CREATED,
      `A scheduled task was created.\n\nTask Information:\n\tTask Name:\t${taskName}\n\t` +
      `Task Content:\t${command}\n\nSubject:\n\tAccount Name:\t${createdBy}`,
      {
        TaskName: taskName, TaskContent: command, ...splitAccount(createdBy),
      }, createdBy);
  }

  /**
   * 1102 — le journal d'audit a été effacé.
   *
   * Windows l'écrit dans le journal Security *après* l'avoir vidé : c'est
   * la première entrée du journal neuf, et souvent la seule trace qu'un
   * effacement a eu lieu. Un effacement qui ne laisse rien serait un
   * effacement parfait, ce que Windows refuse précisément de permettre.
   */
  auditLogCleared(logName: string, clearedBy: string, backupPath: string | null = null): void {
    const subject = this.subjectFields(clearedBy);
    if (logName.toLowerCase() === 'security') {
      const data = { ...subject };
      this.sink.writeEventLog(SECURITY_LOG, EVENTLOG_SOURCE, SECURITY_EVENT.AUDIT_LOG_CLEARED, 'SuccessAudit',
        renderSecurityMessage(SECURITY_EVENT.AUDIT_LOG_CLEARED, data) ?? '', data);
      return;
    }
    const data = {
      SubjectUserName: subject.SubjectUserName, SubjectDomainName: subject.SubjectDomainName,
      Channel: logName, BackupPath: backupPath ?? '',
    };
    this.sink.writeEventLog('System', EVENTLOG_SOURCE, SECURITY_EVENT.EVENT_LOG_CLEARED, 'Information',
      clearedChannelMessage(logName), data);
  }

  auditPolicyChanged(
    subcategory: { name: string; guid: string; category: string },
    changes: string, actor: string,
  ): void {
    this.record(SECURITY_EVENT.AUDIT_POLICY_CHANGED, 'SuccessAudit', {
      ...this.subjectFields(actor),
      CategoryId: subcategory.category, SubcategoryId: subcategory.guid,
      SubcategoryName: subcategory.name, SubcategoryGuid: subcategory.guid,
      AuditPolicyChanges: changes,
    });
  }

  /**
   * 4663 — « An attempt was made to access an object ».
   *
   * `AccessMask` est le code que Windows affiche pour l'opération :
   * `%%4416` pour une lecture de données, `%%1537` pour une
   * suppression. Ce sont ces codes que lit un script d'analyse, pas le
   * texte du message.
   */
  objectAccessed(objectPath: string, access: string, accessMask: string, subject: string): void {
    this.success(SECURITY_EVENT.OBJECT_ACCESSED,
      `An attempt was made to access an object.\n\nObject:\n\tObject Type:\tFile\n\t` +
      `Object Name:\t${objectPath}\n\nAccess Request Information:\n\tAccesses:\t${access}\n\t` +
      `Access Mask:\t${accessMask}\n\nSubject:\n\tAccount Name:\t${subject}`,
      {
        ObjectServer: 'Security', ObjectType: 'File', ObjectName: objectPath,
        AccessList: accessMask, AccessMask: accessMask, Accesses: access,
        ...splitAccount(subject),
      }, subject);
  }

  /** 5142 — un partage réseau a été ajouté. */
  shareAdded(shareName: string, path: string, addedBy: string): void {
    this.success(SECURITY_EVENT.SHARE_ADDED,
      `A network share object was added.\n\nShare Information:\n\tShare Name:\t\\\\*\\${shareName}\n\t` +
      `Share Path:\t${path}\n\nSubject:\n\tAccount Name:\t${addedBy}`,
      { ShareName: `\\\\*\\${shareName}`, ShareLocalPath: path, ...splitAccount(addedBy) }, addedBy);
  }

  /** 5140 — un partage réseau a été atteint par un client. */
  shareAccessed(shareName: string, path: string, subject: string, sourceAddress: string): void {
    this.success(SECURITY_EVENT.SHARE_ACCESSED,
      `A network share object was accessed.\n\nShare Information:\n\tShare Name:\t\\\\*\\${shareName}\n\t` +
      `Share Path:\t${path}\n\nNetwork Information:\n\tSource Address:\t${sourceAddress}\n\n` +
      `Subject:\n\tAccount Name:\t${subject}`,
      {
        ShareName: `\\\\*\\${shareName}`, ShareLocalPath: path,
        IpAddress: sourceAddress, ...splitAccount(subject),
      }, subject);
  }

  permissionChanged(objectPath: string, identity: string, permissions: string, changedBy: string): void {
    this.success(SECURITY_EVENT.PERMISSION_CHANGED,
      `Permissions on an object were changed.\n\nObject:\n\tObject Name:\t${objectPath}\n\t` +
      `New Access:\t${identity}: ${permissions}\n\nSubject:\n\tAccount Name:\t${changedBy}`,
      undefined, changedBy);
  }

  serviceInstalled(serviceName: string, binaryPath: string, account: string, installedBy: string): void {
    this.success(SECURITY_EVENT.SERVICE_INSTALLED,
      `A service was installed in the system.\n\nService Information:\n\tService Name:\t${serviceName}\n\t` +
      `Service File Name:\t${binaryPath}\n\tService Account:\t${account}\n\nSubject:\n\tAccount Name:\t${installedBy}`,
      undefined, installedBy);
  }

  // ─── Internals ─────────────────────────────────────────────────────────

  private subjectText(actor: string): string {
    const subject = this.identity.subjectOf(actor);
    return `Subject:\n\tSecurity ID:\t\t${subject.sid}\n\tAccount Name:\t\t${subject.name}`
      + `\n\tAccount Domain:\t\t${subject.domain}\n\tLogon ID:\t\t${subject.logonId}`;
  }

  private record(
    eventId: number, entryType: 'SuccessAudit' | 'FailureAudit', data: Record<string, string>,
    legacyMessage?: string | null, failureReason?: string,
  ): void {
    const complete = failureReason === undefined ? data : { ...data, FailureReason: failureReason };
    const message = (legacyMessage === undefined || legacyMessage === null ? renderSecurityMessage(eventId, complete) : null)
      ?? legacyMessage ?? `Event ${eventId}`;
    this.sink.writeEventLog(SECURITY_LOG, AUDIT_SOURCE, eventId, entryType, message, data);
  }

  private success(eventId: number, message: string, data?: Record<string, string>, actor = 'SYSTEM'): void {
    this.sink.writeEventLog(SECURITY_LOG, AUDIT_SOURCE, eventId, 'SuccessAudit', `${message}\n\n${this.subjectText(actor)}`, data);
  }

  private failure(eventId: number, message: string, data?: Record<string, string>, actor = 'SYSTEM'): void {
    this.sink.writeEventLog(SECURITY_LOG, AUDIT_SOURCE, eventId, 'FailureAudit', `${message}\n\n${this.subjectText(actor)}`, data);
  }
}
