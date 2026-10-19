import { SYSTEM_LOGON_ID, SYSTEM_SID } from './AuditIdentity';
import { renderSecurityMessage } from './SecurityEventTemplates';

export interface BootEvent {
  eventId: number;
  message: string;
  data?: Record<string, string>;
}

function systemSubject(machine: string): Record<string, string> {
  return {
    SubjectUserSid: SYSTEM_SID, SubjectUserName: `${machine}$`,
    SubjectDomainName: 'WORKGROUP', SubjectLogonId: SYSTEM_LOGON_ID,
  };
}

function serviceLogon(machine: string, account: 'SYSTEM' | 'LOCAL SERVICE'): Record<string, string> {
  const local = account === 'LOCAL SERVICE';
  return {
    ...systemSubject(machine),
    TargetUserSid: local ? 'S-1-5-19' : SYSTEM_SID, TargetUserName: account, TargetDomainName: 'NT AUTHORITY',
    TargetLogonId: local ? '0x3E5' : SYSTEM_LOGON_ID, LogonType: '5',
    LogonProcessName: 'Advapi', AuthenticationPackageName: 'Negotiate', WorkstationName: '-',
    LogonGuid: '{00000000-0000-0000-0000-000000000000}', TransmittedServices: '-', LmPackageName: '-', KeyLength: '0',
    ProcessId: '0x2a4', ProcessName: 'C:\\Windows\\System32\\services.exe', IpAddress: '-', IpPort: '-',
    ImpersonationLevel: '%%1833', RestrictedAdminMode: '-', TargetOutboundUserName: '-',
    TargetOutboundDomainName: '-', VirtualAccount: '%%1843', TargetLinkedLogonId: '0x0', ElevatedToken: '%%1842',
  };
}

export function bootSecurityEvents(machine: string): BootEvent[] {
  const failed = {
    ...systemSubject(machine),
    TargetUserSid: 'S-1-0-0', TargetUserName: 'Administrator', TargetDomainName: machine,
    Status: '0xC000006D', FailureReason: '%%2313', SubStatus: '0xC000006A', LogonType: '2',
    LogonProcessName: 'User32', AuthenticationPackageName: 'Negotiate', WorkstationName: machine,
    TransmittedServices: '-', LmPackageName: '-', KeyLength: '0', ProcessId: '0x3c0',
    ProcessName: 'C:\\Windows\\System32\\winlogon.exe', IpAddress: '127.0.0.1', IpPort: '0',
  };
  const events: Array<[number, Record<string, string>]> = [
    [4624, serviceLogon(machine, 'SYSTEM')],
    [4624, serviceLogon(machine, 'LOCAL SERVICE')],
    [4625, failed],
    [4672, {
      ...systemSubject(machine),
      PrivilegeList: ['SeAssignPrimaryTokenPrivilege', 'SeTcbPrivilege', 'SeSecurityPrivilege', 'SeTakeOwnershipPrivilege',
        'SeLoadDriverPrivilege', 'SeBackupPrivilege', 'SeRestorePrivilege', 'SeDebugPrivilege', 'SeAuditPrivilege',
        'SeSystemEnvironmentPrivilege', 'SeImpersonatePrivilege'].join('\n\t\t\t'),
    }],
  ];
  return events.map(([eventId, data]) => ({ eventId, message: renderSecurityMessage(eventId, data) ?? '', data }));
}
