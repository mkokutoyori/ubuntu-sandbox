export type EventFields = Readonly<Record<string, string | undefined>>;

const NOT_SET = '<value not set>';

const MESSAGE_PARAMETERS: Record<string, string> = {
  '%%1793': NOT_SET,
  '%%1794': '<never>',
  '%%1797': 'All',
  '%%1833': 'Impersonation',
  '%%1842': 'Yes',
  '%%1843': 'No',
};

function field(d: EventFields, key: string, fallback = '-'): string {
  const value = d[key];
  if (value === undefined || value === '') return fallback;
  return MESSAGE_PARAMETERS[value] ?? value;
}

function subject(d: EventFields): string {
  return `Subject:\n\tSecurity ID:\t\t${field(d, 'SubjectUserSid')}\n\tAccount Name:\t\t${field(d, 'SubjectUserName')}`
    + `\n\tAccount Domain:\t\t${field(d, 'SubjectDomainName')}\n\tLogon ID:\t\t${field(d, 'SubjectLogonId')}`;
}

function target(d: EventFields, title: string): string {
  return `${title}\n\tSecurity ID:\t\t${field(d, 'TargetSid')}\n\tAccount Name:\t\t${field(d, 'TargetUserName')}`
    + `\n\tAccount Domain:\t\t${field(d, 'TargetDomainName')}`;
}

function additionalPrivileges(d: EventFields): string {
  return `Additional Information:\n\tPrivileges\t\t${field(d, 'PrivilegeList')}`;
}

const FAILURE_REASONS: Record<string, string> = {
  '0xC000006A': 'Unknown user name or bad password.',
  '0xC0000064': 'Unknown user name or bad password.',
  '0xC0000072': 'Account currently disabled.',
  '0xC0000193': 'Account has expired.',
  '0xC0000234': 'Account locked out.',
  '0xC000006F': 'Account logon time restriction violation.',
  '0xC0000070': 'User not allowed to logon at this computer.',
  '0xC0000071': "The specified account's password has expired.",
  '0xC000015B': 'The user has not been granted the requested logon type at this machine.',
};

export function failureReasonOf(status: string, subStatus: string): string {
  return FAILURE_REASONS[subStatus] ?? FAILURE_REASONS[status] ?? 'Unknown user name or bad password.';
}

function logon(d: EventFields): string {
  return [
    'An account was successfully logged on.',
    subject(d),
    `Logon Information:\n\tLogon Type:\t\t${field(d, 'LogonType')}\n\tRestricted Admin Mode:\t${field(d, 'RestrictedAdminMode')}`
      + `\n\tVirtual Account:\t\t${field(d, 'VirtualAccount', 'No')}\n\tElevated Token:\t\t${field(d, 'ElevatedToken', 'No')}`,
    `Impersonation Level:\t\t${field(d, 'ImpersonationLevel', 'Impersonation')}`,
    `New Logon:\n\tSecurity ID:\t\t${field(d, 'TargetUserSid')}\n\tAccount Name:\t\t${field(d, 'TargetUserName')}`
      + `\n\tAccount Domain:\t\t${field(d, 'TargetDomainName')}\n\tLogon ID:\t\t${field(d, 'TargetLogonId')}`
      + `\n\tLinked Logon ID:\t\t${field(d, 'TargetLinkedLogonId', '0x0')}\n\tNetwork Account Name:\t${field(d, 'TargetOutboundUserName')}`
      + `\n\tNetwork Account Domain:\t${field(d, 'TargetOutboundDomainName')}\n\tLogon GUID:\t\t${field(d, 'LogonGuid', '{00000000-0000-0000-0000-000000000000}')}`,
    `Process Information:\n\tProcess ID:\t\t${field(d, 'ProcessId', '0x0')}\n\tProcess Name:\t\t${field(d, 'ProcessName')}`,
    `Network Information:\n\tWorkstation Name:\t${field(d, 'WorkstationName')}\n\tSource Network Address:\t${field(d, 'IpAddress')}`
      + `\n\tSource Port:\t\t${field(d, 'IpPort')}`,
    `Detailed Authentication Information:\n\tLogon Process:\t\t${field(d, 'LogonProcessName')}\n\tAuthentication Package:\t${field(d, 'AuthenticationPackageName')}`
      + `\n\tTransited Services:\t${field(d, 'TransmittedServices')}\n\tPackage Name (NTLM only):\t${field(d, 'LmPackageName')}`
      + `\n\tKey Length:\t\t${field(d, 'KeyLength', '0')}`,
  ].join('\n\n');
}

function logonFailed(d: EventFields): string {
  const status = field(d, 'Status', '0xC000006D');
  const subStatus = field(d, 'SubStatus', '0x0');
  return [
    'An account failed to log on.',
    subject(d),
    `Logon Type:\t\t\t${field(d, 'LogonType')}`,
    `Account For Which Logon Failed:\n\tSecurity ID:\t\t${field(d, 'TargetUserSid', 'S-1-0-0')}\n\tAccount Name:\t\t${field(d, 'TargetUserName')}`
      + `\n\tAccount Domain:\t\t${field(d, 'TargetDomainName')}`,
    `Failure Information:\n\tFailure Reason:\t\t${field(d, 'FailureReason', failureReasonOf(status, subStatus))}`
      + `\n\tStatus:\t\t\t${status}\n\tSub Status:\t\t${subStatus}`,
    `Process Information:\n\tCaller Process ID:\t${field(d, 'ProcessId', '0x0')}\n\tCaller Process Name:\t${field(d, 'ProcessName')}`,
    `Network Information:\n\tWorkstation Name:\t${field(d, 'WorkstationName')}\n\tSource Network Address:\t${field(d, 'IpAddress')}`
      + `\n\tSource Port:\t\t${field(d, 'IpPort')}`,
    `Detailed Authentication Information:\n\tLogon Process:\t\t${field(d, 'LogonProcessName')}\n\tAuthentication Package:\t${field(d, 'AuthenticationPackageName')}`
      + `\n\tTransited Services:\t${field(d, 'TransmittedServices')}\n\tPackage Name (NTLM only):\t${field(d, 'LmPackageName')}`
      + `\n\tKey Length:\t\t${field(d, 'KeyLength', '0')}`,
  ].join('\n\n');
}

function logoff(d: EventFields): string {
  return [
    'An account was logged off.',
    `Subject:\n\tSecurity ID:\t\t${field(d, 'TargetUserSid')}\n\tAccount Name:\t\t${field(d, 'TargetUserName')}`
      + `\n\tAccount Domain:\t\t${field(d, 'TargetDomainName')}\n\tLogon ID:\t\t${field(d, 'TargetLogonId')}`,
    `Logon Type:\t\t\t${field(d, 'LogonType')}`,
    'This event is generated when a logon session is destroyed. It may be positively correlated with a logon event using the Logon ID value. Logon IDs are only unique between reboots on the same computer.',
  ].join('\n\n');
}

function specialPrivileges(d: EventFields): string {
  const privileges = field(d, 'PrivilegeList').split('\n').map((line) => line.trim()).join('\n\t\t\t');
  return ['Special privileges assigned to new logon.', subject(d), `Privileges:\t\t${privileges}`].join('\n\n');
}

function accountChange(title: string, extra: (d: EventFields) => string[] = () => []) {
  return (d: EventFields): string => [title, subject(d), target(d, 'Target Account:'), ...extra(d)].join('\n\n');
}

function attributes(d: EventFields, changed: boolean): string {
  const unset = changed ? '-' : NOT_SET;
  const uac = field(d, 'UserAccountControl', '');
  return [
    `\tSAM Account Name:\t${field(d, 'SamAccountName', unset)}`,
    `\tDisplay Name:\t\t${field(d, 'DisplayName', unset)}`,
    `\tUser Principal Name:\t${field(d, 'UserPrincipalName', '-')}`,
    `\tHome Directory:\t\t${field(d, 'HomeDirectory', unset)}`,
    `\tHome Drive:\t\t${field(d, 'HomePath', unset)}`,
    `\tScript Path:\t\t${field(d, 'ScriptPath', unset)}`,
    `\tProfile Path:\t\t${field(d, 'ProfilePath', unset)}`,
    `\tUser Workstations:\t${field(d, 'UserWorkstations', unset)}`,
    `\tPassword Last Set:\t${field(d, 'PasswordLastSet', changed ? '-' : '<never>')}`,
    `\tAccount Expires:\t\t${field(d, 'AccountExpires', changed ? '-' : '<never>')}`,
    `\tPrimary Group ID:\t${field(d, 'PrimaryGroupId', changed ? '-' : '513')}`,
    `\tAllowed To Delegate To:\t${field(d, 'AllowedToDelegateTo', '-')}`,
    `\tOld UAC Value:\t\t${field(d, 'OldUacValue', changed ? '-' : '0x0')}`,
    `\tNew UAC Value:\t\t${field(d, 'NewUacValue', changed ? '-' : '0x15')}`,
    `\tUser Account Control:\t${uac === '' ? '-' : `\n\t\t${uac.split('\n').join('\n\t\t')}`}`,
    `\tUser Parameters:\t${field(d, 'UserParameters', '-')}`,
    `\tSID History:\t\t${field(d, 'SidHistory', '-')}`,
    `\tLogon Hours:\t\t${field(d, 'LogonHours', changed ? '-' : 'All')}`,
  ].join('\n');
}

function accountCreated(d: EventFields): string {
  return [
    'A user account was created.',
    subject(d),
    target(d, 'New Account:'),
    `Attributes:\n${attributes(d, false)}`,
    additionalPrivileges(d),
  ].join('\n\n');
}

function accountChanged(d: EventFields): string {
  return [
    'A user account was changed.',
    subject(d),
    target(d, 'Target Account:'),
    `Changed Attributes:\n${attributes(d, true)}`,
    additionalPrivileges(d),
  ].join('\n\n');
}

function accountLockedOut(d: EventFields): string {
  return [
    'A user account was locked out.',
    subject(d),
    `Account That Was Locked Out:\n\tSecurity ID:\t\t${field(d, 'TargetSid')}\n\tAccount Name:\t\t${field(d, 'TargetUserName')}`,
    `Additional Information:\n\tCaller Computer Name:\t${field(d, 'TargetDomainName')}`,
  ].join('\n\n');
}

function member(d: EventFields): string {
  return `Member:\n\tSecurity ID:\t\t${field(d, 'MemberSid')}\n\tAccount Name:\t\t${field(d, 'MemberName')}`;
}

function groupOf(d: EventFields): string {
  return `Group:\n\tSecurity ID:\t\t${field(d, 'TargetSid')}\n\tGroup Name:\t\t${field(d, 'TargetUserName')}\n\tGroup Domain:\t\t${field(d, 'TargetDomainName')}`;
}

function membership(title: string) {
  return (d: EventFields): string => [title, subject(d), member(d), groupOf(d), additionalPrivileges(d)].join('\n\n');
}

function groupLifecycle(title: string, heading: string) {
  return (d: EventFields): string => [
    title,
    subject(d),
    `${heading}\n\tSecurity ID:\t\t${field(d, 'TargetSid')}\n\tGroup Name:\t\t${field(d, 'TargetUserName')}\n\tGroup Domain:\t\t${field(d, 'TargetDomainName')}`,
    `Attributes:\n\tSAM Account Name:\t${field(d, 'SamAccountName', field(d, 'TargetUserName'))}\n\tSID History:\t\t${field(d, 'SidHistory')}`,
    additionalPrivileges(d),
  ].join('\n\n');
}

function auditCleared(d: EventFields): string {
  return `The audit log was cleared.\nSubject:\n\tSecurity ID:\t${field(d, 'SubjectUserSid')}\n\tAccount Name:\t${field(d, 'SubjectUserName')}`
    + `\n\tDomain Name:\t${field(d, 'SubjectDomainName')}\n\tLogon ID:\t${field(d, 'SubjectLogonId')}`;
}

function auditPolicyChanged(d: EventFields): string {
  return [
    'System audit policy was changed.',
    subject(d),
    `Audit Policy Change:\n\tCategory:\t\t${field(d, 'CategoryId')}\n\tSubcategory:\t\t${field(d, 'SubcategoryName')}`
      + `\n\tSubcategory GUID:\t${field(d, 'SubcategoryGuid')}\n\tChanges:\t\t${field(d, 'AuditPolicyChanges')}`,
  ].join('\n\n');
}

const TEMPLATES: Record<number, (d: EventFields) => string> = {
  4624: logon,
  4625: logonFailed,
  4634: logoff,
  4672: specialPrivileges,
  4719: auditPolicyChanged,
  4720: accountCreated,
  4722: accountChange('A user account was enabled.'),
  4723: accountChange('An attempt was made to change an account\'s password.'),
  4724: accountChange('An attempt was made to reset an account\'s password.'),
  4725: accountChange('A user account was disabled.'),
  4726: accountChange('A user account was deleted.', (d) => [additionalPrivileges(d)]),
  4731: groupLifecycle('A security-enabled local group was created.', 'New Group:'),
  4732: membership('A member was added to a security-enabled local group.'),
  4733: membership('A member was removed from a security-enabled local group.'),
  4734: groupLifecycle('A security-enabled local group was deleted.', 'Deleted Group:'),
  4738: accountChanged,
  4740: accountLockedOut,
  4767: accountChange('A user account was unlocked.'),
  1102: auditCleared,
};

export function hasSecurityTemplate(eventId: number): boolean {
  return TEMPLATES[eventId] !== undefined;
}

export function renderSecurityMessage(eventId: number, data: EventFields): string | null {
  const template = TEMPLATES[eventId];
  return template === undefined ? null : template(data);
}

export function clearedChannelMessage(channel: string): string {
  return `The ${channel} log file was cleared.`;
}
