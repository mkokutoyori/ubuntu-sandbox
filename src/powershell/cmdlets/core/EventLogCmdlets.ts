/**
 * EventLogCmdlets — Get / Write / Clear / New / Limit-EventLog,
 * plus a thin Get-WinEvent shim that piggybacks on the same provider.
 *
 * Provider: ctx.providers.eventLog (IEventLogProvider). The WindowsPC
 * shares its single PSEventLogProvider instance across the legacy
 * executor and the interpreter so log state stays coherent.
 */

import type { ICmdlet } from '../ICmdlet';
import type { CmdletContext } from '../CmdletContext';
import { PSRuntimeError } from '@/powershell/runtime/PSRuntime';
import type { PSValue } from '@/powershell/runtime/PSEnvironment';
import type { IEventLogProvider, EventLogEntryInfo } from '@/powershell/providers/PSProviders';
import { psValueToString } from '@/powershell/runtime/PSExpansion';

function requireEventLog(ctx: CmdletContext): IEventLogProvider {
  if (!ctx.providers.eventLog) {
    throw new PSRuntimeError('EventLog cmdlets are not recognized in this provider context');
  }
  return ctx.providers.eventLog;
}

function shortEventTime(d: Date): string {
  const p2 = (n: number) => n.toString().padStart(2, '0');
  return `${p2(d.getMonth() + 1)}/${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Real Windows events surface their structured payload as `<EventData><Data Name="...">value</Data>...</EventData>` — this is what `[xml]$_.ToXml()` scripts (Get-ADSecurityReport-style correlation) parse. */
function buildEventXml(e: EventLogEntryInfo): string {
  const dataXml = Object.entries(e.data ?? {})
    .map(([k, v]) => `<Data Name="${xmlEscape(k)}">${xmlEscape(v)}</Data>`)
    .join('');
  return `<Event><System><EventID>${e.eventId}</EventID><TimeCreated SystemTime="${e.timeGenerated.toISOString()}"/><Provider Name="${xmlEscape(e.source)}"/></System><EventData>${dataXml}</EventData></Event>`;
}

function entryToPSObject(e: EventLogEntryInfo): Record<string, PSValue> {
  return {
    Index:         e.index,
    Time:          shortEventTime(e.timeGenerated),
    EntryType:     e.entryType,
    Source:        e.source,
    InstanceID:    e.eventId,
    EventID:       e.eventId,
    Category:      e.category,
    Message:       e.message,
    TimeGenerated: e.timeGenerated,
  };
}

// ── Get-EventLog ───────────────────────────────────────────────────────────

export class GetEventLogCmdlet implements ICmdlet {
  readonly name = 'get-eventlog';
  readonly displayName = 'Get-EventLog';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const log = requireEventLog(ctx);
    if (ctx.named['list'] === true) {
      return log.listLogs().map(l => ({
        Log:         l.logName,
        Entries:     l.entries,
        MaxSizeKB:   l.maxSizeKB,
        OverflowAction: 'OverwriteAsNeeded',
      } as Record<string, PSValue>)) as PSValue;
    }

    // Entry query — real Get-EventLog returns EventLogEntry objects (rendered
    // as a table by the default formatter, but with live properties like
    // EventID / EntryType / Message so scripts can filter and project them).
    const logName = psValueToString(ctx.named['logname'] ?? ctx.positional[0] ?? '');
    if (!logName) { ctx.emitError('Get-EventLog requires -LogName'); return null; }

    const known = log.listLogs().some(l => l.logName.toLowerCase() === logName.toLowerCase());
    if (!known) {
      ctx.emitError(`The event log '${logName}' on computer '.' does not exist.`);
      return null;
    }

    const opts: { newest?: number; entryType?: string; source?: string } = {};
    if (ctx.named['newest'] !== undefined) opts.newest = Number(ctx.named['newest']);
    if (ctx.named['entrytype'] !== undefined) opts.entryType = psValueToString(ctx.named['entrytype']);
    if (ctx.named['source'] !== undefined) opts.source = psValueToString(ctx.named['source']);

    return log.getEntries(logName, opts).map(entryToPSObject) as PSValue;
  }
}

// ── Write-EventLog ────────────────────────────────────────────────────────

export class WriteEventLogCmdlet implements ICmdlet {
  readonly name = 'write-eventlog';
  readonly displayName = 'Write-EventLog';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const log = requireEventLog(ctx);
    const logName   = psValueToString(ctx.named['logname']    ?? '');
    const source    = psValueToString(ctx.named['source']     ?? '');
    const eventId   = Number(ctx.named['eventid'] ?? 0);
    const entryType = psValueToString(ctx.named['entrytype']  ?? 'Information');
    const message   = psValueToString(ctx.named['message']    ?? '');
    if (!logName || !source) {
      ctx.emitError('Write-EventLog requires -LogName, -Source, -EventID, -Message');
      return null;
    }
    log.writeEntry(logName, source, eventId, entryType, message);
    return null;
  }
}

// ── Clear-EventLog ────────────────────────────────────────────────────────

export class ClearEventLogCmdlet implements ICmdlet {
  readonly name = 'clear-eventlog';
  readonly displayName = 'Clear-EventLog';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const log = requireEventLog(ctx);
    const logName = psValueToString(ctx.named['logname'] ?? ctx.positional[0] ?? '');
    if (!logName) { ctx.emitError('Clear-EventLog requires -LogName'); return null; }
    const msg = log.clearLog(logName);
    if (msg) ctx.emit(msg);
    return null;
  }
}

// ── New-EventLog ──────────────────────────────────────────────────────────

export class NewEventLogCmdlet implements ICmdlet {
  readonly name = 'new-eventlog';
  readonly displayName = 'New-EventLog';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const log = requireEventLog(ctx);
    const logName = psValueToString(ctx.named['logname'] ?? '');
    const source  = psValueToString(ctx.named['source']  ?? '');
    if (!logName || !source) {
      ctx.emitError('New-EventLog requires -LogName and -Source');
      return null;
    }
    const msg = log.newLog(logName, source);
    if (msg) ctx.emit(msg);
    return null;
  }
}

// ── Limit-EventLog ────────────────────────────────────────────────────────

export class LimitEventLogCmdlet implements ICmdlet {
  readonly name = 'limit-eventlog';
  readonly displayName = 'Limit-EventLog';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const log = requireEventLog(ctx);
    const logName  = psValueToString(ctx.named['logname'] ?? ctx.positional[0] ?? '');
    const maxKB    = Number(ctx.named['maximumsize'] ?? ctx.named['maxsize'] ?? 1024);
    if (!logName) { ctx.emitError('Limit-EventLog requires -LogName'); return null; }
    log.limitLog(logName, maxKB);
    return null;
  }
}

// ── Get-WinEvent (modern API — same data behind it for the simulator) ─────

function hashtableGet(h: Record<string, PSValue>, key: string): PSValue {
  if (key in h) return h[key];
  const found = Object.keys(h).find(k => k.toLowerCase() === key.toLowerCase());
  return found !== undefined ? h[found] : undefined;
}

export class GetWinEventCmdlet implements ICmdlet {
  readonly name = 'get-winevent';
  readonly displayName = 'Get-WinEvent';
  readonly aliases = [] as const;
  readonly parameters = ['LogName', 'FilterHashtable', 'MaxEvents', 'ListLog', 'ListProvider'] as const;

  execute(ctx: CmdletContext): PSValue {
    const log = requireEventLog(ctx);
    if (ctx.named['listlog'] !== undefined || ctx.named['listprovider'] !== undefined) {
      return log.listLogs().map(l => ({
        LogName:   l.logName,
        RecordCount: l.entries,
        MaximumSizeInBytes: l.maxSizeKB * 1024,
      } as Record<string, PSValue>)) as PSValue;
    }

    const filter = ctx.named['filterhashtable'];
    let logName: string;
    let ids: number[] | null = null;
    let startTime: Date | null = null;
    let endTime: Date | null = null;
    let filterMaxEvents: number | undefined;

    if (filter !== undefined && filter !== null && typeof filter === 'object' && !Array.isArray(filter) && !(filter instanceof Date)) {
      const f = filter as Record<string, PSValue>;
      logName = psValueToString(hashtableGet(f, 'LogName') ?? '');
      const idVal = hashtableGet(f, 'Id');
      if (idVal !== undefined) ids = (Array.isArray(idVal) ? idVal : [idVal]).map(v => Number(v));
      const st = hashtableGet(f, 'StartTime');
      if (st instanceof Date) startTime = st;
      const et = hashtableGet(f, 'EndTime');
      if (et instanceof Date) endTime = et;
      const me = hashtableGet(f, 'MaxEvents');
      if (me !== undefined) filterMaxEvents = Number(me);
    } else {
      logName = psValueToString(ctx.named['logname'] ?? ctx.positional[0] ?? '');
    }
    if (!logName) { ctx.emitError('Get-WinEvent requires -LogName, -FilterHashtable, or -ListLog'); return null; }

    const max = ctx.named['maxevents'] !== undefined ? Number(ctx.named['maxevents']) : filterMaxEvents;
    let entries = log.getEntries(logName, {});
    if (ids) entries = entries.filter(e => ids!.includes(e.eventId));
    if (startTime) entries = entries.filter(e => e.timeGenerated >= startTime!);
    if (endTime) entries = entries.filter(e => e.timeGenerated <= endTime!);
    if (max !== undefined) entries = entries.slice(0, max);

    if (entries.length === 0) {
      ctx.emitError('No events were found that match the specified selection criteria.');
      return [];
    }
    // MachineName (docs/PRD-Wecutil.md §2.1 P4): the real source machine
    // for an entry received via Windows Event Forwarding
    // (`data.MachineName`, set by `WindowsPC.receiveForwardedEvent`), or
    // this device's own hostname for every other (non-forwarded) log —
    // a real Get-WinEvent always exposes this property, not just on
    // ForwardedEvents.
    const localHostname = ctx.providers.network?.getHostname() ?? '';
    return entries.map(e => ({
      LogName:        logName,
      Id:             e.eventId,
      Level:          e.entryType,
      ProviderName:   e.source,
      TimeCreated:    e.timeGenerated,
      Message:        e.message,
      RecordId:       e.index,
      MachineName:    e.data?.MachineName ?? localHostname,
      ToXml:          () => buildEventXml(e),
    } as Record<string, PSValue>)) as PSValue;
  }
}
