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
  powershellcore: '{F90714A8-5509-434A-BF6D-B1624C8A19A2}',
};

const TASK_IDS: Record<string, number> = {
  'Security State Change': 12288,
  'Security System Extension': 12289,
  Logon: 12544,
  Logoff: 12545,
  'Credential Validation': 14336,
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
  'MPSSVC Rule-Level Policy Change': 13571,
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
  [4699, 'Other Object Access Events'],
  [4700, 'Other Object Access Events'],
  [4701, 'Other Object Access Events'],
  [4670, 'Authorization Policy Change'],
  [4647, 'Logoff'],
  [4648, 'Logon'],
  [4702, 'Other Object Access Events'],
]);

const EVENTLOG_PROVIDER = 'microsoft-windows-eventlog';
const AUDITING_PROVIDER = 'microsoft-windows-security-auditing';
const TASK_SCHEDULER_PROVIDER = 'microsoft-windows-taskscheduler';
const TASK_SCHEDULER_EVENTS: Record<number, { task: string; opcode?: { id: number; name: string }; version?: number }> = {
  100: { task: 'Task Started', opcode: { id: 1, name: 'Start' } },
  102: { task: 'Task completed', opcode: { id: 2, name: 'Stop' } },
  106: { task: 'Task registered' },
  107: { task: 'Task triggered on scheduler' },
  108: { task: 'Task triggered on event' },
  110: { task: 'Task triggered by user' },
  111: { task: 'Task terminated', opcode: { id: 0, name: 'Termination' } },
  129: { task: 'Created Task Process' },
  140: { task: 'Task registration updated' },
  141: { task: 'Task registration deleted' },
  142: { task: 'Task disabled' },
  200: { task: 'Action started', opcode: { id: 1, name: 'Start' }, version: 1 },
  201: { task: 'Action completed', opcode: { id: 2, name: 'Stop' }, version: 2 },
};
const POWERSHELL_PROVIDER = 'powershellcore';
const SCRIPT_BLOCK_EVENT = 4104;
const PIPELINE_EXECUTION_DETAIL_EVENT = 4103;
const SCRIPT_BLOCK_INVOCATION: Record<number, { taskId: number; taskName: string }> = {
  4105: { taskId: 0x66, taskName: 'CommandStart' },
  4106: { taskId: 0x67, taskName: 'CommandStop' },
};

const EVENT_VERSIONS: Record<number, number> = { 4616: 1, 4624: 2, 4625: 0, 4776: 0, 4634: 0, 4672: 0, 4688: 2, 4689: 0 };

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

  const scheduled = provider === TASK_SCHEDULER_PROVIDER ? TASK_SCHEDULER_EVENTS[event.eventId] : undefined;
  if (scheduled !== undefined) {
    return {
      level: 4, levelName: 'Information', taskId: 0, taskName: scheduled.task,
      opcode: scheduled.opcode?.id ?? 0, opcodeName: scheduled.opcode?.name ?? 'Info',
      keywords: '0x8000000000000000', keywordNames: [], version: scheduled.version ?? 0, providerGuid: null,
    };
  }

  const invocation = provider === POWERSHELL_PROVIDER ? SCRIPT_BLOCK_INVOCATION[event.eventId] : undefined;
  if (invocation !== undefined) {
    return {
      level: 5, levelName: 'Verbose', taskId: invocation.taskId, taskName: invocation.taskName, opcode: 0xf, opcodeName: 'Create',
      keywords: '0x1', keywordNames: ['Runspace'], version: 0, providerGuid: PROVIDER_GUIDS[provider],
    };
  }

  if (provider === POWERSHELL_PROVIDER && event.eventId === PIPELINE_EXECUTION_DETAIL_EVENT) {
    return {
      level: 4, levelName: 'Information', taskId: 0x6a, taskName: 'Executing Pipeline', opcode: 0x14,
      opcodeName: 'To be used when operation is just executing a method',
      keywords: '0x0', keywordNames: [], version: 1, providerGuid: PROVIDER_GUIDS[provider],
    };
  }

  if (provider === POWERSHELL_PROVIDER && event.eventId === SCRIPT_BLOCK_EVENT) {
    return {
      level: 5, levelName: 'Verbose', taskId: 0x66, taskName: 'CommandStart', opcode: 0xf, opcodeName: 'Create',
      keywords: '0x1', keywordNames: ['Runspace'], version: 0, providerGuid: PROVIDER_GUIDS[provider],
    };
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
