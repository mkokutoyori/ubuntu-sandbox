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

function entryToPSObject(e: EventLogEntryInfo): Record<string, PSValue> {
  return {
    Index:         e.index,
    Time:          e.timeGenerated,
    EntryType:     e.entryType,
    Source:        e.source,
    InstanceId:    e.eventId,
    Category:      e.category,
    Message:       e.message,
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
    // Entry queries — defer to the legacy executor whose formatted
    // column-table layout (Index / Time / EntryType / Source / Message)
    // is what the existing scripts and tests expect. We still own -List
    // because that variant is just a small structured table.
    throw new PSRuntimeError('Get-EventLog entry query is not recognized in this provider context');
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

export class GetWinEventCmdlet implements ICmdlet {
  readonly name = 'get-winevent';
  readonly displayName = 'Get-WinEvent';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const log = requireEventLog(ctx);
    if (ctx.named['listlog'] !== undefined || ctx.named['listprovider'] !== undefined) {
      return log.listLogs().map(l => ({
        LogName:   l.logName,
        RecordCount: l.entries,
        MaximumSizeInBytes: l.maxSizeKB * 1024,
      } as Record<string, PSValue>)) as PSValue;
    }
    const logName = psValueToString(ctx.named['logname'] ?? ctx.positional[0] ?? '');
    if (!logName) { ctx.emitError('Get-WinEvent requires -LogName or -ListLog'); return null; }
    const max = ctx.named['maxevents'] ? Number(ctx.named['maxevents']) : undefined;
    const entries = log.getEntries(logName, { newest: max });
    return entries.map(e => ({
      LogName:        logName,
      Id:             e.eventId,
      Level:          e.entryType,
      ProviderName:   e.source,
      TimeCreated:    e.timeGenerated,
      Message:        e.message,
      RecordId:       e.index,
    } as Record<string, PSValue>)) as PSValue;
  }
}
