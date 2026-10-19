import { AUDIT_CATEGORIES } from '../WindowsAuditCategoryCatalog';

export interface EventClassified {
  readonly source: string;
  readonly eventId: number;
  readonly entryType: string;
}

export interface EventDescriptor {
  readonly level: number;
  readonly levelName: string;
  readonly taskId: number;
  readonly taskName: string | null;
  readonly opcode: number;
  readonly opcodeName: string;
  readonly keywords: string;
  readonly keywordNames: readonly string[];
  readonly version: number;
  readonly providerGuid: string | null;
}

const LEVELS: Record<string, { level: number; name: string }> = {
  critical: { level: 1, name: 'Critical' },
  error: { level: 2, name: 'Error' },
  warning: { level: 3, name: 'Warning' },
  information: { level: 4, name: 'Information' },
  successaudit: { level: 0, name: 'Information' },
  failureaudit: { level: 0, name: 'Information' },
};

const PROVIDER_GUIDS: Record<string, string> = {
  'microsoft-windows-security-auditing': '{54849625-5478-4994-A5BA-3E3B0328C30D}',
  'microsoft-windows-eventlog': '{FC65DDD8-D6EF-4962-83D5-6E5CFE9CE148}',
  'service control manager': '{555908D1-A6D7-4695-8E1E-26931D2012F4}',
  'microsoft-windows-kernel-general': '{A68CA8B7-004F-D7B6-A698-07E2DE0F1F5D}',
};

const TASK_IDS: Record<string, number> = {
  'Security State Change': 12288,
  'Security System Extension': 12289,
  Logon: 12544,
  Logoff: 12545,
  'Account Lockout': 12546,
  'Special Logon': 12548,
  'Other Logon/Logoff Events': 12551,
  'File System': 12800,
  Registry: 12801,
  'Other Object Access Events': 12804,
  'File Share': 12808,
  'Sensitive Privilege Use': 13056,
  'Process Creation': 13312,
  'Process Termination': 13313,
  'Audit Policy Change': 13568,
  'User Account Management': 13824,
  'Security Group Management': 13826,
};

const LOG_CLEAR_TASK = 104;

const ACCOUNT_MANAGEMENT_EXTRA = new Map<number, string>([
  [4723, 'User Account Management'],
  [4781, 'User Account Management'],
  [4767, 'User Account Management'],
  [4740, 'User Account Management'],
  [4719, 'Audit Policy Change'],
  [4697, 'Security System Extension'],
  [4698, 'Other Object Access Events'],
  [4670, 'Authorization Policy Change'],
  [4647, 'Logoff'],
  [4648, 'Logon'],
]);

const EVENTLOG_PROVIDER = 'microsoft-windows-eventlog';
const AUDITING_PROVIDER = 'microsoft-windows-security-auditing';

const EVENT_VERSIONS: Record<number, number> = { 4624: 2, 4625: 0, 4634: 0, 4672: 0, 4688: 2, 4689: 0 };

function auditTaskName(eventId: number): string | null {
  const explicit = ACCOUNT_MANAGEMENT_EXTRA.get(eventId);
  if (explicit !== undefined) return explicit;
  const owner = AUDIT_CATEGORIES.find((sub) => sub.governs.includes(eventId));
  return owner === undefined ? null : owner.name;
}

export function describeEvent(event: EventClassified): EventDescriptor {
  const entryType = event.entryType.toLowerCase();
  const level = LEVELS[entryType] ?? LEVELS.information;
  const provider = event.source.toLowerCase();
  const audit = entryType === 'successaudit' || entryType === 'failureaudit';

  let taskName: string | null = null;
  let taskId = 0;
  if (provider === AUDITING_PROVIDER) {
    if (event.eventId === 1102) {
      taskName = 'Log clear';
      taskId = LOG_CLEAR_TASK;
    } else {
      taskName = auditTaskName(event.eventId);
      taskId = taskName === null ? 0 : (TASK_IDS[taskName] ?? 0);
    }
  } else if (provider === EVENTLOG_PROVIDER && (event.eventId === 104 || event.eventId === 1102)) {
    taskName = 'Log clear';
    taskId = LOG_CLEAR_TASK;
  }

  let keywords = '0x8000000000000000';
  let keywordNames: string[] = [];
  if (entryType === 'successaudit') {
    keywords = '0x8020000000000000';
    keywordNames = ['Audit Success'];
  } else if (entryType === 'failureaudit') {
    keywords = '0x8010000000000000';
    keywordNames = ['Audit Failure'];
  } else if (!audit && !provider.startsWith('microsoft-windows-')) {
    keywords = '0x80000000000000';
    keywordNames = ['Classic'];
  }

  return {
    level: level.level,
    levelName: level.name,
    taskId,
    taskName,
    opcode: 0,
    opcodeName: 'Info',
    keywords,
    keywordNames,
    version: EVENT_VERSIONS[event.eventId] ?? 0,
    providerGuid: PROVIDER_GUIDS[provider] ?? null,
  };
}
