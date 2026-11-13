/**
 * EventLogCmdlets — Get / Write / Clear / New / Limit-EventLog,
 * plus a thin Get-WinEvent shim that piggybacks on the same provider.
 *
 * Provider: ctx.providers.eventLog (IEventLogProvider). The WindowsPC
 * shares its single PSEventLogProvider instance across the legacy
 * executor and the interpreter so log state stays coherent.
 */

import { simulationNowMs } from '@/network/core/SystemClock';

import type { ICmdlet } from '../ICmdlet';
import type { CmdletContext } from '../CmdletContext';
import { PSRuntimeError } from '@/powershell/runtime/PSRuntime';
import type { PSValue } from '@/powershell/runtime/PSEnvironment';
import type { IEventLogProvider, EventLogEntryInfo } from '@/powershell/providers/PSProviders';
import { psValueToString, registerPSDisplayFormatter } from '@/powershell/runtime/PSExpansion';
import { wildcardMatches } from '@/powershell/runtime/PSWildcard';
import { channelType, isolationOf } from '@/network/devices/windows/eventlog/ChannelFacts';
import { parseEventHashtable } from '@/network/devices/windows/eventlog/WinEventHashFilter';
import { describeEvent } from '@/network/devices/windows/eventlog/EventDescriptor';
import { renderEventXml } from '@/network/devices/windows/eventlog/EventXml';
import {
  parseEventXPath, parseEventQueryList, type XPathPredicate,
} from '@/network/devices/windows/WinEventXPath';

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

function winEventObject(e: EventLogEntryInfo, logName: string, machine: string): Record<string, PSValue> {
  const descriptor = describeEvent(e);
  const xml = renderEventXml(e, { channel: logName, computer: machine });
  return {
    LogName: logName,
    Id: e.eventId,
    Version: descriptor.version,
    Level: descriptor.level,
    LevelDisplayName: descriptor.levelName,
    Task: descriptor.taskId,
    TaskDisplayName: descriptor.taskName,
    Opcode: descriptor.opcode,
    OpcodeDisplayName: descriptor.opcodeName,
    Keywords: BigInt(descriptor.keywords).toString(),
    KeywordsDisplayNames: [...descriptor.keywordNames] as PSValue,
    ProviderName: e.source,
    ProviderId: descriptor.providerGuid,
    TimeCreated: e.timeGenerated,
    Message: e.message,
    RecordId: e.index,
    UserId: e.userSid === undefined ? null : { Value: e.userSid } as unknown as PSValue,
    MachineName: e.data?.MachineName ?? machine,
    Properties: Object.values(e.data ?? {}) as PSValue,
    ToXml: () => xml,
  } as Record<string, PSValue>;
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
  readonly parameters = ['EntryType', 'List', 'LogName', 'Newest', 'Source'] as const;

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
  readonly parameters = ['EntryType', 'EventId', 'LogName', 'Message', 'Source'] as const;

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
    const refusal = log.writeEntry(logName, source, eventId, entryType, message);
    if (refusal !== '') ctx.emitError(refusal);
    return null;
  }
}

// ── Clear-EventLog ────────────────────────────────────────────────────────

export class ClearEventLogCmdlet implements ICmdlet {
  readonly name = 'clear-eventlog';
  readonly displayName = 'Clear-EventLog';
  readonly aliases = [] as const;
  readonly parameters = ['LogName'] as const;

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
  readonly parameters = ['LogName', 'Source'] as const;

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
  readonly parameters = ['LogName', 'MaximumSize'] as const;

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

const LOCAL_COMPUTER = 'localhost';
const EVENT_LOG_LINK_TYPE = 'System.Diagnostics.Eventing.Reader.EventLogLink';
const CLASSIC_EXCLUDED = new Set(['setup', 'forwardedevents']);

registerPSDisplayFormatter(EVENT_LOG_LINK_TYPE, (record) => String(record.LogName ?? ''));

function patternsOf(value: PSValue): string[] {
  return (Array.isArray(value) ? value : [value]).map((item) => psValueToString(item));
}

function logConfiguration(status: NonNullable<ReturnType<NonNullable<IEventLogProvider['getLogStatus']>>>): Record<string, PSValue> {
  const type = channelType(status.logName);
  const written = status.lastWriteTime ?? status.created;
  return {
    FileSize: status.fileSize,
    IsLogFull: false,
    LastAccessTime: written,
    LastWriteTime: written,
    OldestRecordNumber: status.oldestRecordNumber,
    RecordCount: status.numberOfLogRecords,
    LogName: status.logName,
    LogType: type === 'Admin' ? 'Administrative' : type === 'Analytic' ? 'Analytical' : type,
    LogIsolation: isolationOf(status.logName, status.isolation),
    IsEnabled: status.enabled,
    IsClassicLog: !status.logName.includes('/') && !CLASSIC_EXCLUDED.has(status.logName.toLowerCase()),
    SecurityDescriptor: status.channelAccess,
    LogFilePath: status.fileName,
    MaximumSizeInBytes: status.maxSizeKB * 1024,
    LogMode: status.autoBackup ? 'AutoBackup' : status.overflow === 'DoNotOverwrite' ? 'Retain' : 'Circular',
    OwningProviderName: null,
    ProviderNames: [],
    ProviderLevel: status.levelFilter === null ? null : Number(status.levelFilter),
    ProviderKeywords: status.keywordsFilter === null ? null : status.keywordsFilter,
    ProviderBufferSize: 64,
    ProviderMinimumNumberOfBuffers: 0,
    ProviderMaximumNumberOfBuffers: 64,
    ProviderLatency: 1000,
    ProviderControlGuid: null,
  } as Record<string, PSValue>;
}

function providerMetadata(name: string, logNames: readonly string[]): Record<string, PSValue> {
  const guid = describeEvent({ source: name, eventId: 0, entryType: 'Information' }).providerGuid;
  return {
    Name: name,
    Id: guid === null ? null : guid.replace(/[{}]/g, '').toLowerCase(),
    MessageFilePath: null,
    ResourceFilePath: null,
    ParameterFilePath: null,
    HelpLink: null,
    DisplayName: name,
    LogLinks: logNames.map((logName) => ({ __type: EVENT_LOG_LINK_TYPE, LogName: logName, IsImported: false, DisplayName: logName })) as PSValue,
    Levels: [],
    Opcodes: [],
    Keywords: [],
    Tasks: [],
    Events: [],
  } as Record<string, PSValue>;
}

function matchingNames(ctx: CmdletContext, kind: 'log' | 'provider', patterns: readonly string[], names: readonly string[]): string[] | null {
  const selected: string[] = [];
  for (const pattern of patterns) {
    const matched = names.filter((name) => wildcardMatches(pattern, name));
    if (matched.length === 0) {
      ctx.emitError(`There is not an event ${kind} on the ${LOCAL_COMPUTER} computer that matches "${pattern}".`);
      continue;
    }
    for (const name of matched) if (!selected.includes(name)) selected.push(name);
  }
  return selected.length === 0 ? null : selected;
}

type QueryEvent = EventLogEntryInfo & { channel: string };

export class GetWinEventCmdlet implements ICmdlet {
  readonly name = 'get-winevent';
  readonly displayName = 'Get-WinEvent';
  readonly aliases = [] as const;
  readonly parameters = ['LogName', 'ListLog', 'ProviderName', 'ListProvider', 'Path', 'FilterXml', 'FilterXPath', 'FilterHashtable', 'ComputerName', 'MaxEvents', 'Oldest', 'Force'] as const;

  execute(ctx: CmdletContext): PSValue {
    const log = requireEventLog(ctx);
    const maxEvents = this.maxEvents(ctx);
    if (maxEvents === null) return null;

    if (ctx.named['listlog'] !== undefined) return this.listLogs(ctx, log, patternsOf(ctx.named['listlog']));
    if (ctx.named['listprovider'] !== undefined) return this.listProviders(ctx, log, patternsOf(ctx.named['listprovider']));

    const oldest = ctx.named['oldest'] === true;
    const xmlFilter = ctx.named['filterxml'];
    if (xmlFilter !== undefined && xmlFilter !== null) {
      const parsed = parseEventQueryList(psValueToString(xmlFilter));
      if (parsed.error) { ctx.emitError(parsed.error); return null; }
      return this.emitQueries(ctx, log, parsed.queries.map((q) => ({ channels: [q.path], predicate: q.predicate })), maxEvents, oldest);
    }
    const xpathFilter = ctx.named['filterxpath'];
    if (xpathFilter !== undefined && xpathFilter !== null) {
      const channel = psValueToString(ctx.named['logname'] ?? ctx.positional[0] ?? '');
      if (!channel) { ctx.emitError('-FilterXPath requires -LogName.'); return null; }
      const parsed = parseEventXPath(psValueToString(xpathFilter));
      if (!parsed.predicate) { ctx.emitError(parsed.error ?? 'The specified query is invalid.'); return null; }
      return this.emitQueries(ctx, log, [{ channels: patternsOf(channel), predicate: parsed.predicate }], maxEvents, oldest);
    }

    const filter = ctx.named['filterhashtable'];
    if (filter !== undefined && filter !== null) {
      const tables = (Array.isArray(filter) ? filter : [filter]).filter((item): item is Record<string, PSValue> => typeof item === 'object' && item !== null && !Array.isArray(item) && !(item instanceof Date));
      const queries: Array<{ channels: string[]; predicate: XPathPredicate; providers?: string[]; paths?: string[] }> = [];
      for (const table of tables) {
        const built = parseEventHashtable(table);
        if ('error' in built) { ctx.emitError(built.error); return null; }
        queries.push({ channels: [...built.query.logPatterns], predicate: built.query.predicate, providers: [...built.query.providerPatterns], paths: [...built.query.paths] });
      }
      return this.emitQueries(ctx, log, queries, maxEvents, oldest);
    }

    const paths = ctx.named['path'];
    if (paths !== undefined && paths !== null) {
      return this.emitQueries(ctx, log, [{ channels: [], predicate: () => true, paths: patternsOf(paths) }], maxEvents, oldest);
    }
    const providerNames = ctx.named['providername'];
    if (providerNames !== undefined && providerNames !== null) {
      return this.emitQueries(ctx, log, [{ channels: [], predicate: () => true, providers: patternsOf(providerNames) }], maxEvents, oldest);
    }
    const logName = ctx.named['logname'] ?? ctx.positional[0];
    if (logName === undefined || logName === null || psValueToString(logName) === '') {
      ctx.emitError('A valid log name must be specified: use -LogName, -ListLog, -ProviderName, -Path, -FilterHashtable, -FilterXPath or -FilterXml.');
      return null;
    }
    return this.emitQueries(ctx, log, [{ channels: patternsOf(logName), predicate: () => true }], maxEvents, oldest);
  }

  private maxEvents(ctx: CmdletContext): number | undefined | null {
    const raw = ctx.named['maxevents'];
    if (raw === undefined) return undefined;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1) {
      ctx.emitError(`Cannot validate argument on parameter 'MaxEvents'. The ${psValueToString(raw)} argument is less than the minimum allowed range of 1. Supply an argument that is greater than or equal to 1 and then try the command again.`);
      return null;
    }
    return value;
  }

  private listLogs(ctx: CmdletContext, log: IEventLogProvider, patterns: string[]): PSValue {
    const names = matchingNames(ctx, 'log', patterns, log.listLogs().map((entry) => entry.logName));
    if (names === null) return null;
    const rows: Array<Record<string, PSValue>> = [];
    for (const name of names) {
      const status = log.getLogStatus?.(name);
      if (status) rows.push(logConfiguration(status));
    }
    return rows as PSValue;
  }

  private listProviders(ctx: CmdletContext, log: IEventLogProvider, patterns: string[]): PSValue {
    const providers = log.providers?.() ?? [];
    const names = matchingNames(ctx, 'provider', patterns, providers.map((provider) => provider.name));
    if (names === null) return null;
    return providers.filter((provider) => names.includes(provider.name)).map((provider) => providerMetadata(provider.name, provider.logNames)) as PSValue;
  }

  private emitQueries(
    ctx: CmdletContext, log: IEventLogProvider,
    queries: ReadonlyArray<{ channels: string[]; predicate: XPathPredicate; providers?: string[]; paths?: string[] }>,
    maxEvents: number | undefined, oldest: boolean,
  ): PSValue {
    const now = simulationNowMs();
    const machine = ctx.providers.network?.getHostname() ?? '';
    const logs = log.listLogs().map((entry) => entry.logName);
    const providerCatalog = log.providers?.() ?? [];
    const events: QueryEvent[] = [];
    let searched = false;

    for (const query of queries) {
      let channels: string[] = [];
      if (query.channels.length > 0) {
        channels = matchingNames(ctx, 'log', query.channels, logs) ?? [];
      }
      let providerPatterns = query.providers ?? [];
      if (providerPatterns.length > 0) {
        const matched = matchingNames(ctx, 'provider', providerPatterns, providerCatalog.map((provider) => provider.name));
        if (matched === null) continue;
        const writes = new Set(providerCatalog.filter((provider) => matched.includes(provider.name)).flatMap((provider) => provider.logNames));
        if (query.channels.length === 0) channels = logs.filter((name) => writes.has(name));
        else {
          channels = channels.filter((name) => writes.has(name));
          if (channels.length === 0) { ctx.emitError('The specified providers do not write events to any of the specified logs.'); continue; }
        }
        providerPatterns = matched;
      }
      const wanted = (entry: EventLogEntryInfo): boolean =>
        (providerPatterns.length === 0 || providerPatterns.some((pattern) => wildcardMatches(pattern, entry.source))) && query.predicate(entry, now);
      for (const name of channels) {
        searched = true;
        for (const entry of log.getEntries(name, {})) if (wanted(entry)) events.push({ ...entry, channel: name });
      }
      for (const path of query.paths ?? []) {
        const exported = log.readExportedEntries?.(path);
        if (exported) searched = true;
        if (!exported) { ctx.emitError(`The ${path} path does not appear to be a valid log file path. Specify a valid file system path.`); continue; }
        for (const entry of [...exported.entries].reverse()) if (wanted(entry)) events.push({ ...entry, channel: exported.channel });
      }
    }

    if (events.length === 0) {
      if (searched) ctx.emitError('No events were found that match the specified selection criteria.');
      return [];
    }
    const ordered = events.sort((left, right) => right.timeGenerated.getTime() - left.timeGenerated.getTime() || right.index - left.index);
    if (oldest) ordered.reverse();
    const limited = maxEvents === undefined ? ordered : ordered.slice(0, maxEvents);
    return limited.map((event) => winEventObject(event, event.channel, machine)) as PSValue;
  }
}
