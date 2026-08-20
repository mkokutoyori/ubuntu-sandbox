import type { PSEventLogProvider, EntryType } from './PSEventLogProvider';

export interface PSEventLogContext {
  eventLog: PSEventLogProvider;
}

export function psGetEventLog(ctx: PSEventLogContext, args: string[]): string {
  const listFlag = args.some(a => a === '-List' || a.toLowerCase() === '-list');
  if (listFlag) return ctx.eventLog.getEventLogList();

  let logName = '', newest: number | undefined, entryType = '', source = '';
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-LogName' && args[i + 1]) { logName = args[++i]; }
    else if (a === '-Newest' && args[i + 1]) { newest = parseInt(args[++i], 10); }
    else if (a === '-EntryType' && args[i + 1]) { entryType = args[++i]; }
    else if (a === '-Source' && args[i + 1]) { source = args[++i]; }
    else if (!a.startsWith('-') && !logName) { logName = a; }
  }
  if (!logName) return "Get-EventLog : Cannot bind argument to parameter 'LogName' because it is null.";
  return ctx.eventLog.getEventLog(logName, { newest, entryType: entryType || undefined, source: source || undefined });
}

export function psWriteEventLog(ctx: PSEventLogContext, args: string[]): string {
  let logName = '', source = '', message = '', entryType: EntryType = 'Information';
  let eventId = 0;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-LogName' && args[i + 1]) { logName = args[++i]; }
    else if (a === '-Source' && args[i + 1]) { source = args[++i].replace(/^['"]|['"]$/g, ''); }
    else if (a === '-Message' && args[i + 1]) { message = args[++i].replace(/^['"]|['"]$/g, ''); }
    else if (a === '-EventId' && args[i + 1]) { eventId = parseInt(args[++i], 10); }
    else if (a === '-EntryType' && args[i + 1]) { entryType = args[++i] as EntryType; }
  }
  if (!logName || !source || !eventId) {
    return "Write-EventLog : -LogName, -Source, and -EventId are required parameters.";
  }
  return ctx.eventLog.writeEventLog(logName, source, eventId, entryType, message);
}

export function psClearEventLog(ctx: PSEventLogContext, args: string[]): string {
  let logName = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-LogName' && args[i + 1]) { logName = args[++i]; }
    else if (!args[i].startsWith('-') && !logName) { logName = args[i]; }
  }
  if (!logName) return "Clear-EventLog : -LogName is required.";
  return ctx.eventLog.clearEventLog(logName);
}

export function psNewEventLog(ctx: PSEventLogContext, args: string[]): string {
  let logName = '', source = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-LogName' && args[i + 1]) { logName = args[++i]; }
    else if (args[i] === '-Source' && args[i + 1]) { source = args[++i].replace(/^['"]|['"]$/g, ''); }
  }
  if (!logName) return "New-EventLog : -LogName is required.";
  return ctx.eventLog.newEventLog(logName, source);
}

export function psLimitEventLog(ctx: PSEventLogContext, args: string[]): string {
  let logName = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-LogName' && args[i + 1]) { logName = args[++i]; }
    else if (!args[i].startsWith('-') && !logName) { logName = args[i]; }
  }
  if (!logName) return '';
  return ctx.eventLog.limitEventLog(logName);
}

export function psGetWinEvent(ctx: PSEventLogContext, args: string[]): string {
  const listLogFlag = args.some(a => a === '-ListLog');
  if (listLogFlag) return ctx.eventLog.getWinEventList();

  let logName = '', maxEvents: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-LogName' && args[i + 1]) { logName = args[++i]; }
    else if (a === '-MaxEvents' && args[i + 1]) { maxEvents = parseInt(args[++i], 10); }
    else if (!a.startsWith('-') && !logName) { logName = a; }
  }
  if (!logName) return "Get-WinEvent : -LogName is required.";
  return ctx.eventLog.getWinEvent(logName, maxEvents);
}

export const EVENT_LOG_CMDLETS: Record<string, (ctx: PSEventLogContext, args: string[]) => string> = {
  'get-eventlog': psGetEventLog,
  'write-eventlog': psWriteEventLog,
  'clear-eventlog': psClearEventLog,
  'new-eventlog': psNewEventLog,
  'limit-eventlog': psLimitEventLog,
  'get-winevent': psGetWinEvent,
};
