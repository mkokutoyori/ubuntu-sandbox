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
  PRIVILEGED_SERVICE_CALLED: 4673,
  SCHEDULED_TASK_CREATED: 4698,
  OBJECT_ACCESSED: 4663,
  SHARE_ACCESSED: 5140,
  SHARE_ADDED: 5142,
  AUDIT_LOG_CLEARED: 1102,
  REGISTRY_VALUE_MODIFIED: 4657,
  PERMISSION_CHANGED: 4670,
  SERVICE_INSTALLED: 4697,
  WORKSTATION_LOCKED: 4800,
  WORKSTATION_UNLOCKED: 4801,
  SCREENSAVER_INVOKED: 4802,
  SCREENSAVER_DISMISSED: 4803,
} as const;

/** Ce qu'un événement de suivi de processus sait de son sujet. */
export interface ProcessAuditDetails {
  ppid?: number;
  parentName?: string;
  owner?: string;
  commandLine?: string;
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

/**
 * Un identifiant de session, au format que Windows affiche : un LUID en
 * hexadécimal. Il est alloué en séquence à partir d'une base au-dessus
 * des sessions du noyau (0x3e7 est celle de SYSTEM), pour qu'une session
 * ouverte ici ne puisse jamais porter le même numéro qu'une autre.
 */
let logonIdCounter = 0x10000;
export function nextLogonId(): string {
  logonIdCounter += 1;
  return `0x${logonIdCounter.toString(16)}`;
}

/** Les comptes dont le jeton est élevé — administrateurs et SYSTEM. */
function isElevatedAccount(account?: string): boolean {
  if (!account) return false;
  const leaf = account.slice(account.indexOf('\\') + 1).toLowerCase();
  return leaf === 'administrator' || leaf === 'system' || leaf.endsWith('admin');
}

const SECURITY_LOG = 'Security';
const AUDIT_SOURCE = 'Microsoft-Windows-Security-Auditing';

/**
 * `Subject:` block for the free-text message. Real Windows Security
 * events report the identity of the process that *raised* the audit —
 * SYSTEM for anything the OS itself triggers (a fresh interactive
 * logon, a process exit, an account lockout) — not the account the
 * event is *about* (that's `TargetUserName`/`Account Name:` inside the
 * event's own body, already correct everywhere in this file). Callers
 * that know a real human/administrative actor performed the action
 * (account/group management, `runas`, a privileged service call) pass
 * it explicitly; PRD-Winlogon.md §1.2 point 2 documents the bug this
 * replaces — a single hardcoded "Administrator" Subject regardless of
 * who or what actually acted.
 */
function subjectBlock(actor: string): string {
  return actor === 'SYSTEM'
    ? 'Subject:\n\tSecurity ID:\t\tS-1-5-18\n\tAccount Name:\t\tSYSTEM'
    : `Subject:\n\tSecurity ID:\t\tS-1-5-21\n\tAccount Name:\t\t${actor}`;
}

export class WindowsSecurityAudit {
  constructor(private readonly sink: SecurityEventSink) {}

  // ─── Account lifecycle ─────────────────────────────────────────────────

  accountCreated(name: string, subjectUserName = 'Administrator'): void {
    this.success(SECURITY_EVENT.ACCOUNT_CREATED, `A user account was created.\n\nNew Account:\n\tAccount Name:\t${name}`,
      { TargetUserName: name, SubjectUserName: subjectUserName }, subjectUserName);
  }

  accountDeleted(name: string, subjectUserName = 'Administrator'): void {
    this.success(SECURITY_EVENT.ACCOUNT_DELETED, `A user account was deleted.\n\nTarget Account:\n\tAccount Name:\t${name}`,
      { TargetUserName: name, SubjectUserName: subjectUserName }, subjectUserName);
  }

  accountEnabled(name: string, subjectUserName = 'Administrator'): void {
    this.success(SECURITY_EVENT.ACCOUNT_ENABLED, `A user account was enabled.\n\nTarget Account:\n\tAccount Name:\t${name}`,
      { TargetUserName: name, SubjectUserName: subjectUserName }, subjectUserName);
  }

  accountDisabled(name: string, subjectUserName = 'Administrator'): void {
    this.success(SECURITY_EVENT.ACCOUNT_DISABLED, `A user account was disabled.\n\nTarget Account:\n\tAccount Name:\t${name}`,
      { TargetUserName: name, SubjectUserName: subjectUserName }, subjectUserName);
  }

  passwordReset(name: string, subjectUserName = 'Administrator'): void {
    this.success(SECURITY_EVENT.PASSWORD_RESET, `An attempt was made to reset an account's password.\n\nTarget Account:\n\tAccount Name:\t${name}`,
      { TargetUserName: name, SubjectUserName: subjectUserName }, subjectUserName);
  }

  accountChanged(name: string, subjectUserName = 'Administrator'): void {
    this.success(SECURITY_EVENT.ACCOUNT_CHANGED, `A user account was changed.\n\nTarget Account:\n\tAccount Name:\t${name}`,
      { TargetUserName: name, SubjectUserName: subjectUserName }, subjectUserName);
  }

  // ─── Group lifecycle ───────────────────────────────────────────────────

  groupCreated(group: string, subjectUserName = 'Administrator'): void {
    this.success(SECURITY_EVENT.GROUP_CREATED, `A security-enabled local group was created.\n\nGroup:\n\tGroup Name:\t${group}`,
      { TargetUserName: group, SubjectUserName: subjectUserName }, subjectUserName);
  }

  groupDeleted(group: string, subjectUserName = 'Administrator'): void {
    this.success(SECURITY_EVENT.GROUP_DELETED, `A security-enabled local group was deleted.\n\nGroup:\n\tGroup Name:\t${group}`,
      { TargetUserName: group, SubjectUserName: subjectUserName }, subjectUserName);
  }

  groupMemberAdded(group: string, member: string, scope: 'Local' | 'Global' | 'Universal' = 'Local', subjectUserName = 'Administrator'): void {
    const eventId = scope === 'Global' ? SECURITY_EVENT.GROUP_MEMBER_ADDED_GLOBAL
      : scope === 'Universal' ? SECURITY_EVENT.GROUP_MEMBER_ADDED_UNIVERSAL
      : SECURITY_EVENT.GROUP_MEMBER_ADDED;
    this.success(eventId, `A member was added to a security-enabled ${scope.toLowerCase()} group.\n\nMember:\t${member}\nGroup:\t${group}`,
      { TargetUserName: group, MemberName: member, SubjectUserName: subjectUserName }, subjectUserName);
  }

  groupMemberRemoved(group: string, member: string, scope: 'Local' | 'Global' | 'Universal' = 'Local', subjectUserName = 'Administrator'): void {
    const eventId = scope === 'Global' ? SECURITY_EVENT.GROUP_MEMBER_REMOVED_GLOBAL
      : scope === 'Universal' ? SECURITY_EVENT.GROUP_MEMBER_REMOVED_UNIVERSAL
      : SECURITY_EVENT.GROUP_MEMBER_REMOVED;
    this.success(eventId, `A member was removed from a security-enabled ${scope.toLowerCase()} group.\n\nMember:\t${member}\nGroup:\t${group}`,
      { TargetUserName: group, MemberName: member, SubjectUserName: subjectUserName }, subjectUserName);
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
  logonSuccess(name: string, logonType = 2, ipAddress?: string, logonId?: string): void {
    this.success(SECURITY_EVENT.LOGON_SUCCESS, `An account was successfully logged on.\n\nLogon Type:\t\t${logonType}\nAccount Name:\t${name}`,
      {
        TargetUserName: name,
        LogonType: String(logonType),
        TargetLogonId: logonId ?? nextLogonId(),
        ...(ipAddress ? { IpAddress: ipAddress } : {}),
      });
  }

  /**
   * 4625 — échec d'authentification.
   *
   * `Status` dit qu'il y a eu échec, `SubStatus` dit *lequel* : mot de
   * passe faux (0xC000006A) et compte inexistant (0xC0000064) ne se
   * traitent pas de la même façon, et c'est SubStatus qui les sépare.
   */
  logonFailure(name: string, ipAddress?: string, subStatus = '0xC000006A'): void {
    this.failure(SECURITY_EVENT.LOGON_FAILURE, `An account failed to log on.\n\nAccount For Which Logon Failed:\n\tAccount Name:\t${name}\n\nFailure Information:\n\tStatus:\t\t0xC000006D\n\tSub Status:\t${subStatus}`,
      {
        TargetUserName: name,
        Status: '0xC000006D',
        SubStatus: subStatus,
        ...(ipAddress ? { IpAddress: ipAddress } : {}),
      });
  }

  logoff(name: string, logonType = 2, logonId?: string): void {
    this.success(SECURITY_EVENT.LOGOFF, `An account was logged off.\n\nSubject:\n\tAccount Name:\t${name}\n\tLogon Type:\t${logonType}`,
      {
        TargetUserName: name,
        LogonType: String(logonType),
        TargetLogonId: logonId ?? nextLogonId(),
      });
  }

  accountLockedOut(name: string): void {
    this.failure(SECURITY_EVENT.ACCOUNT_LOCKED_OUT, `A user account was locked out.\n\nAccount That Was Locked Out:\n\tAccount Name:\t${name}`);
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
    const elevated = isElevatedAccount(details.owner);
    this.success(SECURITY_EVENT.PROCESS_CREATED,
      `A new process has been created.\n\nProcess Information:\n\tNew Process ID:\t0x${pid.toString(16)}\n\tNew Process Name:\t${name}`,
      {
        NewProcessName: name,
        NewProcessId: `0x${pid.toString(16)}`,
        ProcessId: `0x${(details.ppid ?? 0).toString(16)}`,
        ParentProcessName: details.parentName ?? '',
        ...splitAccount(details.owner),
        // Un jeton d'administrateur est « complet » (%%1937) et porte
        // l'étiquette d'intégrité haute ; tout autre compte reçoit le
        // jeton par défaut. C'est ce couple qui distingue une élévation
        // UAC d'une session administrateur directe.
        TokenElevationType: elevated ? '%%1937' : '%%1936',
        MandatoryLabel: elevated ? 'S-1-16-12288' : 'S-1-16-8192',
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
  auditLogCleared(logName: string, clearedBy: string): void {
    this.sink.writeEventLog(SECURITY_LOG, 'Microsoft-Windows-Eventlog',
      SECURITY_EVENT.AUDIT_LOG_CLEARED, 'SuccessAudit',
      `The audit log was cleared.\n\nSubject:\n\tAccount Name:\t${clearedBy}\n\t` +
      `Log:\t${logName}`,
      { ...splitAccount(clearedBy), Channel: logName });
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

  private success(eventId: number, message: string, data?: Record<string, string>, actor = 'SYSTEM'): void {
    this.sink.writeEventLog(SECURITY_LOG, AUDIT_SOURCE, eventId, 'SuccessAudit', `${message}\n\n${subjectBlock(actor)}`, data);
  }

  private failure(eventId: number, message: string, data?: Record<string, string>, actor = 'SYSTEM'): void {
    this.sink.writeEventLog(SECURITY_LOG, AUDIT_SOURCE, eventId, 'FailureAudit', `${message}\n\n${subjectBlock(actor)}`, data);
  }
}
