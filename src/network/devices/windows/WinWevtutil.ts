/**
 * `wevtutil` — l'utilitaire en ligne de commande du journal d'événements.
 *
 * C'est le seul outil qui parle aux journaux sans passer par PowerShell,
 * donc le seul disponible depuis `cmd.exe` ou une tâche planifiée
 * héritée — d'où sa présence dans à peu près toutes les procédures de
 * collecte.
 *
 * Le détail qui gouverne ce fichier : **une commande absente répond par
 * un refus, jamais par le texte d'aide**. L'implémentation précédente
 * annonçait douze commandes et en tenait quatre ; les huit autres
 * retombaient sur l'aide, si bien qu'un script ne pouvait pas
 * distinguer « je me suis trompé de syntaxe » de « cette commande n'est
 * pas là ». L'aide n'énumère donc plus que ce qui existe.
 *
 * Voir `docs/PRD-Wevtutil.md`.
 */

import { simulationDate, simulationNowMs } from '@/network/core/SystemClock';
import { ZonedDate } from '@/network/core/time/ZonedDate';
import { formatDotNetDate } from '@/powershell/runtime/dotnetDateFormat';

import type { WinCommandContext } from './WinCommandExecutor';
import { requireWindowsService } from './WinFeatureGate';
import { parseEventXPath, type XPathEvent } from './WinEventXPath';
import { describeEvent } from './eventlog/EventDescriptor';
import { renderEventXml, systemTime, xmlEscape } from './eventlog/EventXml';
import { LOG_SIZE_STEP_BYTES, MIN_LOG_BYTES } from './PSEventLogProvider';

/** Les verbes tenus, forme longue → forme courte. */
const VERBS: Record<string, string> = {
  'enum-logs': 'el',
  'get-log': 'gl',
  'set-log': 'sl',
  'get-log-info': 'gli',
  'query-events': 'qe',
  'export-log': 'epl',
  'archive-log': 'al',
  'clear-log': 'cl',
};

const SHORT_VERBS = new Set(Object.values(VERBS));

const WEVTUTIL_HELP = `Windows Events Command Line Utility.

Enables you to retrieve information about event logs, run queries, and
export, archive, and clear logs.

Usage:

You can use either the short (for example, el) or long (for example,
enum-logs) version of the command and option names. Commands, options and
option values are not case-sensitive.

Variables are noted in all upper-case.

wevtutil COMMAND [ARGUMENT [ARGUMENT] ...] [/OPTION:VALUE [/OPTION:VALUE] ...]

Commands:

el | enum-logs          List log names.
gl | get-log            Get log configuration information.
sl | set-log            Modify configuration of a log.
gli | get-log-info      Get log status information.
qe | query-events       Query events from a log or log file.
epl | export-log        Export a log.
al | archive-log        Archive an exported log.
cl | clear-log          Clear a log.

Query options:

/{lf | logfile}:VALUE   Read events from a log file instead of a channel.
/{q | query}:VALUE      XPath query to filter events.
/{c | count}:VALUE      Maximum number of events to read.
/{rd | reversedirection}:VALUE  Read the most recent events first.
/{f | format}:VALUE     Text, XML or RenderedXml.

Set-log options:

/{e | enabled}:VALUE        Enable or disable a log.
/{i | isolation}:VALUE      Log isolation: system, application or custom.
/{lfn | logfilename}:VALUE  Path of the log file.
/{rt | retention}:VALUE     Log retention mode.
/{ab | autobackup}:VALUE    Archive the log when it is full (needs retention).
/{ms | maxsize}:VALUE       Maximum log size, in bytes (at least 1048576).
/{l | level}:VALUE          Level filter of a log with a dedicated session.
/{k | keywords}:VALUE       Keywords filter of a log with a dedicated session.
/{ca | channelaccess}:VALUE Security descriptor (SDDL) of the channel.
/{c | config}:VALUE         Read the log properties from a configuration file.

Query options:

/{bm | bookmark}:VALUE      Resume after the bookmark stored in this file.
/{sbm | savebookmark}:VALUE Save a bookmark of this query in this file.
/{e | element}:VALUE        Wrap the XML output in this root element.

Export options:

/{ow | overwrite}:VALUE Overwrite the export file if it exists.

Clear options:

/{bu | backup}:VALUE    Save the cleared events in this .evtx file.`;

/** Les refus réels de `wevtutil`, au mot près. */
const ERR = {
  unknownCommand: 'Failed to process command line. The specified command was not found.',
  unknownOption: (opt: string) =>
    `Failed to process command line. Option "${opt}" is not recognized.`,
  noChannel: (log: string) =>
    `Failed to read configuration for log ${log}. The specified channel could not be found.`,
  badQuery: (why: string) => `Failed to process query. ${why}`,
} as const;

/**
 * Les options d'exécution distante (`/r`, `/u`, `/p`, `/a`) passent par
 * RPC/DCOM, que rien ne modélise ici : elles sont refusées plutôt
 * qu'acceptées en silence. `/uni` ne change que l'encodage de la sortie,
 * que ce simulateur ne distingue pas ; elle est lue et sans effet.
 */
const REMOTE_OPTIONS = new Set(['r', 'remote', 'u', 'username', 'p', 'password', 'a', 'authentication']);

type OptionKey =
  | 'format' | 'enabled' | 'isolation' | 'logfilename' | 'retention' | 'autobackup' | 'maxsize'
  | 'level' | 'keywords' | 'channelaccess' | 'config' | 'logfile' | 'structuredquery' | 'query'
  | 'bookmark' | 'savebookmark' | 'reversedirection' | 'locale' | 'count' | 'element'
  | 'overwrite' | 'backup' | 'unicode';

const ALIASES: Record<OptionKey, readonly string[]> = {
  format: ['f', 'format'], enabled: ['e', 'enabled'], isolation: ['i', 'isolation'],
  logfilename: ['lfn', 'logfilename'], retention: ['rt', 'retention'], autobackup: ['ab', 'autobackup'],
  maxsize: ['ms', 'maxsize'], level: ['l', 'level'], keywords: ['k', 'keywords'],
  channelaccess: ['ca', 'channelaccess'], config: ['c', 'config'], logfile: ['lf', 'logfile'],
  structuredquery: ['sq', 'structuredquery'], query: ['q', 'query'], bookmark: ['bm', 'bookmark'],
  savebookmark: ['sbm', 'savebookmark'], reversedirection: ['rd', 'reversedirection'],
  locale: ['l', 'locale'], count: ['c', 'count'], element: ['e', 'element'],
  overwrite: ['ow', 'overwrite'], backup: ['bu', 'backup'], unicode: ['uni', 'unicode'],
};

const VERB_OPTIONS: Record<string, readonly OptionKey[]> = {
  el: ['unicode'],
  gl: ['format', 'unicode'],
  sl: ['enabled', 'isolation', 'logfilename', 'retention', 'autobackup', 'maxsize', 'level', 'keywords',
    'channelaccess', 'config', 'unicode'],
  gli: ['logfile', 'unicode'],
  qe: ['logfile', 'structuredquery', 'query', 'bookmark', 'savebookmark', 'reversedirection', 'format',
    'locale', 'count', 'element', 'unicode'],
  epl: ['logfile', 'structuredquery', 'query', 'overwrite', 'unicode'],
  al: ['locale', 'unicode'],
  cl: ['backup', 'unicode'],
};

interface ParsedCommand {
  verb: string;
  positional: string[];
  options: Map<OptionKey, string>;
  unknown: string | null;
  remote: string | null;
}

/**
 * L'analyseur unique. Chaque verbe lit ensuite un objet, pas un tableau
 * de chaînes — sans quoi ils re-découpent chacun à leur façon et
 * finissent par diverger. Les noms d'options sont résolus PAR VERBE :
 * `/e` est l'activation pour `sl` et l'élément racine pour `qe`.
 */
export function parseWevtutilArgs(args: string[]): ParsedCommand {
  const [raw = '', ...rest] = args;
  const lower = raw.toLowerCase();
  const verb = VERBS[lower] ?? lower;
  const allowed = VERB_OPTIONS[verb] ?? [];
  const positional: string[] = [];
  const options = new Map<OptionKey, string>();
  let unknown: string | null = null;
  let remote: string | null = null;
  for (const a of rest) {
    if (!a.startsWith('/')) { positional.push(a); continue; }
    const body = a.slice(1);
    const colon = body.indexOf(':');
    const name = (colon < 0 ? body : body.slice(0, colon)).toLowerCase();
    const value = colon < 0 ? 'true' : body.slice(colon + 1).replace(/^"(.*)"$/, '$1');
    const key = allowed.find((candidate) => ALIASES[candidate].includes(name));
    if (key !== undefined) { options.set(key, value); continue; }
    if (REMOTE_OPTIONS.has(name)) remote ??= name;
    else unknown ??= name;
  }
  return { verb, positional, options, unknown, remote };
}

const truthy = (v: string | undefined): boolean =>
  v !== undefined && v.toLowerCase() !== 'false' && v !== '0';

const isBoolean = (v: string): boolean => ['true', 'false'].includes(v.toLowerCase());

function opt(cmd: ParsedCommand, key: OptionKey): string | undefined {
  return cmd.options.get(key);
}

export function cmdWevtutil(ctx: WinCommandContext, args: string[]): string {
  if (args.includes('/?') || args.includes('/help') || args.length === 0) {
    return WEVTUTIL_HELP;
  }

  const gate = requireWindowsService(ctx, 'EventLog');
  if (!gate.ok) return gate.error;

  const cmd = parseWevtutilArgs(args);
  if (!SHORT_VERBS.has(cmd.verb)) return ERR.unknownCommand;
  if (cmd.remote !== null) return ERR.unknownOption(`/${cmd.remote}`);
  if (cmd.unknown !== null) return ERR.unknownOption(`/${cmd.unknown}`);

  switch (cmd.verb) {
    case 'el':  return enumLogs(ctx);
    case 'gl':  return getLog(ctx, cmd);
    case 'sl':  return setLog(ctx, cmd);
    case 'gli': return getLogInfo(ctx, cmd);
    case 'qe':  return queryEvents(ctx, cmd);
    case 'epl': return exportLog(ctx, cmd);
    case 'al':  return archiveLog(ctx, cmd);
    case 'cl':  return clearLog(ctx, cmd);
    default:    return ERR.unknownCommand;
  }
}

function enumLogs(ctx: WinCommandContext): string {
  const logs = ctx.eventLog?.getAllLogsStructured?.() ?? [];
  return logs.map((l) => l.logName).join('\n');
}

const SYSTEM_ISOLATED = new Map([['system', 'System'], ['security', 'Custom']]);

function channelType(logName: string): string {
  const leaf = logName.slice(logName.lastIndexOf('/') + 1).toLowerCase();
  return ['operational', 'analytic', 'debug'].includes(leaf) ? leaf[0].toUpperCase() + leaf.slice(1) : 'Admin';
}

function isolationOf(logName: string, configured: string): string {
  if (configured !== 'Application') return configured[0].toUpperCase() + configured.slice(1).toLowerCase();
  return SYSTEM_ISOLATED.get(logName.toLowerCase()) ?? 'Application';
}

function getLog(ctx: WinCommandContext, cmd: ParsedCommand): string {
  const name = cmd.positional[0];
  if (!name) return 'Usage: wevtutil gl <log>';
  const st = ctx.eventLog?.getLogStatus?.(name);
  if (!st) return ERR.noChannel(name);
  const maxBytes = st.maxSizeKB * 1024;
  const isolation = isolationOf(st.logName, st.isolation);
  const retention = st.overflow === 'DoNotOverwrite';
  const format = (opt(cmd, 'format') ?? 'text').toLowerCase();
  if (format === 'xml') {
    const publishing = `<fileMax>1</fileMax>${st.levelFilter === null ? '' : `<level>${xmlEscape(st.levelFilter)}</level>`}`
      + `${st.keywordsFilter === null ? '' : `<keywords>${xmlEscape(st.keywordsFilter)}</keywords>`}`;
    return `<channel name='${xmlEscape(st.logName)}' chid='${xmlEscape(st.logName)}' symbol='' type='${channelType(st.logName)}'`
      + ` enabled='${st.enabled}' isolation='${isolation}' xmlns='http://schemas.microsoft.com/win/2004/08/events'>`
      + `<logging><logFileName>${xmlEscape(st.fileName)}</logFileName><retention>${retention}</retention>`
      + `<autoBackup>${st.autoBackup}</autoBackup><maxSize>${maxBytes}</maxSize></logging>`
      + `<publishing>${publishing}</publishing></channel>`;
  }
  if (format !== 'text') return ERR.unknownOption(`/f:${format}`);
  return [
    `name: ${st.logName}`,
    `enabled: ${st.enabled}`,
    `type: ${channelType(st.logName)}`,
    'owningPublisher:',
    `isolation: ${isolation}`,
    `channelAccess: ${st.channelAccess}`,
    'logging:',
    `  logFileName: ${st.fileName}`,
    `  retention: ${retention}`,
    `  autoBackup: ${st.autoBackup}`,
    `  maxSize: ${maxBytes}`,
    'publishing:',
    '  fileMax: 1',
    ...(st.levelFilter === null ? [] : [`  level: ${st.levelFilter}`]),
    ...(st.keywordsFilter === null ? [] : [`  keywords: ${st.keywordsFilter}`]),
  ].join('\n');
}

function getLogInfo(ctx: WinCommandContext, cmd: ParsedCommand): string {
  const name = cmd.positional[0];
  if (!name) return 'Usage: wevtutil gli <log>';
  const st = ctx.eventLog?.getLogStatus?.(name);
  if (!st) return ERR.noChannel(name);
  const written = systemTime(st.lastWriteTime ?? st.created);
  return [
    `creationTime: ${systemTime(st.created)}`,
    `lastAccessTime: ${written}`,
    `lastWriteTime: ${written}`,
    `fileSize: ${st.fileSize}`,
    'attributes: 32',
    `numberOfLogRecords: ${st.numberOfLogRecords}`,
    `oldestRecordNumber: ${st.oldestRecordNumber}`,
  ].join('\n');
}

interface ChannelConfig {
  name: string | null;
  isolation?: string;
  retention?: string;
  autoBackup?: string;
  maxSize?: string;
}

function configFromXml(xml: string): ChannelConfig | null {
  const channel = /<channel\b([^>]*)>/i.exec(xml);
  if (channel === null) return null;
  const attribute = (name: string): string | undefined =>
    new RegExp(`\\b${name}\\s*=\\s*['"]?([^'"\\s>]+)`, 'i').exec(channel[1])?.[1];
  const element = (name: string): string | undefined =>
    new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`, 'i').exec(xml)?.[1];
  return {
    name: attribute('name') ?? null, isolation: attribute('isolation'),
    retention: element('retention'), autoBackup: element('autoBackup'), maxSize: element('maxSize'),
  };
}

function roundedLogBytes(bytes: number): number {
  const stepped = Math.round(bytes / LOG_SIZE_STEP_BYTES) * LOG_SIZE_STEP_BYTES;
  return Math.max(MIN_LOG_BYTES, stepped);
}

function setLog(ctx: WinCommandContext, cmd: ParsedCommand): string {
  if (!ctx.eventLog?.setLogConfig) return ERR.noChannel(cmd.positional[0] ?? '');

  const configPath = opt(cmd, 'config');
  let name = cmd.positional[0];
  const values = new Map<OptionKey, string>(cmd.options);
  if (configPath !== undefined) {
    if (name) return ERR.unknownOption(`/c:${configPath}`);
    const content = ctx.eventLog.readExportedLog?.(configPath);
    if (content === null || content === undefined) {
      return `Failed to open configuration file ${configPath}. The system cannot find the file specified.`;
    }
    const parsed = configFromXml(content);
    if (parsed === null || parsed.name === null) {
      return `Failed to read configuration file ${configPath}. The file is not a channel configuration.`;
    }
    name = parsed.name;
    if (parsed.isolation !== undefined) values.set('isolation', parsed.isolation);
    if (parsed.retention !== undefined) values.set('retention', parsed.retention);
    if (parsed.autoBackup !== undefined) values.set('autobackup', parsed.autoBackup);
    if (parsed.maxSize !== undefined) values.set('maxsize', parsed.maxSize);
  }
  if (!name) return 'Usage: wevtutil sl <log> [/e:true|false] [/ms:BYTES]';

  const invalid = (): string => `Failed to modify configuration for log ${name}. The parameter is incorrect.`;
  for (const key of ['enabled', 'retention', 'autobackup'] as const) {
    const value = values.get(key);
    if (value !== undefined && !isBoolean(value)) return invalid();
  }
  const isolation = values.get('isolation');
  if (isolation !== undefined && !['system', 'application', 'custom'].includes(isolation.toLowerCase())) return invalid();
  if (isolation?.toLowerCase() === 'custom' && values.get('channelaccess') === undefined) return invalid();

  const maxSize = values.get('maxsize');
  const bytes = maxSize !== undefined ? Number(maxSize) : undefined;
  if (bytes !== undefined && (!Number.isInteger(bytes) || bytes <= 0)) {
    return `Failed to modify configuration for log ${name}. The value "${maxSize}" is not a valid size.`;
  }

  const enabled = values.get('enabled');
  const retention = values.get('retention');
  const autoBackup = values.get('autobackup');
  const err = ctx.eventLog.setLogConfig(name, {
    ...(enabled !== undefined ? { enabled: truthy(enabled) } : {}),
    ...(bytes !== undefined ? { maxSizeKB: roundedLogBytes(bytes) / 1024 } : {}),
    ...(retention !== undefined ? { retention: truthy(retention) } : {}),
    ...(autoBackup !== undefined ? { autoBackup: truthy(autoBackup) } : {}),
    ...(isolation !== undefined ? { isolation: isolation.toLowerCase() } : {}),
    ...(values.get('channelaccess') !== undefined ? { channelAccess: values.get('channelaccess') } : {}),
    ...(values.get('logfilename') !== undefined ? { fileName: values.get('logfilename') } : {}),
    ...(values.get('level') !== undefined ? { levelFilter: values.get('level') } : {}),
    ...(values.get('keywords') !== undefined ? { keywordsFilter: values.get('keywords') } : {}),
  });
  return err ?? '';
}

function localDate(ctx: WinCommandContext, date: Date): string {
  return formatDotNetDate(ZonedDate.in(date.getTime(), ctx.timezone), "yyyy-MM-dd'T'HH:mm:ss.fff");
}

function renderText(ctx: WinCommandContext, logName: string, e: QueryEvent): string {
  const descriptor = describeEvent(e);
  return [
    `Event[${e.ordinal}]:`,
    `  Log Name: ${logName}`,
    `  Source: ${e.source}`,
    `  Date: ${localDate(ctx, e.timeGenerated)}`,
    `  Event ID: ${e.eventId}`,
    `  Task: ${descriptor.taskName ?? 'N/A'}`,
    `  Level: ${descriptor.levelName}`,
    `  Opcode: ${descriptor.opcodeName}`,
    `  Keyword: ${descriptor.keywordNames.length === 0 ? 'N/A' : descriptor.keywordNames.join(', ')}`,
    `  User: N/A`,
    `  User Name: N/A`,
    `  Computer: ${e.computer}`,
    `  Description: `,
    e.message,
  ].join('\n');
}

interface QueryEvent extends XPathEvent {
  index: number;
  message: string;
  computer: string;
  ordinal: number;
}

function bookmarkRecordId(content: string): number | null {
  const id = /RecordId=['"](\d+)['"]/i.exec(content)?.[1];
  return id === undefined ? null : Number(id);
}

function bookmarkXml(channel: string, recordId: number): string {
  return `<BookmarkList>\n  <Bookmark Channel='${xmlEscape(channel)}' RecordId='${recordId}' IsCurrent='true'/>\n</BookmarkList>`;
}

function queryEvents(ctx: WinCommandContext, cmd: ParsedCommand): string {
  const target = cmd.positional[0];
  if (!target) return 'Usage: wevtutil qe <log> [/q:XPATH] [/c:N] [/rd:true] [/f:Text|XML|RenderedXml]';

  const format = (opt(cmd, 'format') ?? 'text').toLowerCase();
  if (!['text', 'xml', 'renderedxml'].includes(format)) {
    return ERR.unknownOption(`/f:${format}`);
  }
  const reverse = truthy(opt(cmd, 'reversedirection'));
  const countRaw = opt(cmd, 'count');
  const count = countRaw !== undefined ? Number(countRaw) : undefined;
  if (count !== undefined && (Number.isNaN(count) || count < 0)) {
    return ERR.unknownOption(`/c:${countRaw}`);
  }

  const query = opt(cmd, 'query');
  const parsed = parseEventXPath(query ?? '*');
  if (!parsed.predicate) return ERR.badQuery(parsed.error ?? 'The query is malformed.');

  const fromFile = truthy(opt(cmd, 'logfile'));
  if (!fromFile) ctx.syncDHCPEvents();
  const source = fromFile ? readExportedLog(ctx, target) : readChannel(ctx, target);
  if (source === null) {
    return fromFile
      ? `Failed to read log file ${target}. The system cannot find the file specified.`
      : ERR.noChannel(target);
  }

  const bookmarkPath = opt(cmd, 'bookmark');
  let after: number | null = null;
  if (bookmarkPath !== undefined) {
    const content = ctx.eventLog?.readExportedLog?.(bookmarkPath);
    if (content === null || content === undefined) {
      return `Failed to read bookmark ${bookmarkPath}. The system cannot find the file specified.`;
    }
    after = bookmarkRecordId(content);
    if (after === null) return `Failed to read bookmark ${bookmarkPath}. The bookmark is not valid.`;
  }

  const now = ctx.eventLog?.now?.() ?? simulationNowMs();
  let events = source.filter((e) => parsed.predicate!(e, now) && (after === null || e.index > after));
  if (!reverse) events = events.reverse();
  if (count !== undefined) events = events.slice(0, count);

  const logName = fromFile ? (source[0]?.channel ?? target) : target;
  const savePath = opt(cmd, 'savebookmark');
  if (savePath !== undefined && events.length > 0) {
    const newest = events.reduce((highest, e) => Math.max(highest, e.index), 0);
    const err = ctx.eventLog?.writeTextFile?.(savePath, bookmarkXml(logName, newest));
    if (err) return err;
  }
  if (events.length === 0) {
    return 'No events found that match the specified selection criteria.';
  }

  const rendered = events.map((e, i) => {
    const ev = { ...e, ordinal: i };
    return format === 'text'
      ? renderText(ctx, logName, ev)
      : renderEventXml(ev, { channel: logName, computer: ev.computer }, format === 'renderedxml');
  }).join(format === 'text' ? '\n\n' : '\n');
  const root = opt(cmd, 'element');
  return format !== 'text' && root !== undefined ? `<${root}>\n${rendered}\n</${root}>` : rendered;
}

interface SourceEvent extends QueryEvent { channel?: string }

function readChannel(ctx: WinCommandContext, logName: string): SourceEvent[] | null {
  const entries = ctx.eventLog?.getEntriesStructured(logName, {});
  if (!entries) return null;
  const computer = ctx.hostname.toUpperCase();
  return entries.map((e, i) => ({
    index: e.index ?? 0,
    eventId: e.eventId,
    source: e.source,
    entryType: e.entryType ?? 'Information',
    timeGenerated: e.timeGenerated ?? simulationDate(),
    data: e.data,
    message: e.message,
    computer,
    ordinal: i,
  }));
}

function readExportedLog(ctx: WinCommandContext, path: string): SourceEvent[] | null {
  const content = ctx.eventLog?.readExportedLog?.(path);
  if (content === null || content === undefined) return null;
  const lines = content.split('\n');
  const channel = /^# Windows Event Log: (.+)$/.exec(lines[0] ?? '')?.[1] ?? path;
  const out: SourceEvent[] = [];
  const computer = ctx.hostname.toUpperCase();
  for (let i = 0; i < lines.length; i++) {
    const head = /^Record #(\d+)\s+(\S+)\s+\[(\w+)\]$/.exec(lines[i]);
    if (!head) continue;
    const meta = /^\s+Source: (.+?)\s+Event ID: (\d+)\s+Category: (.*)$/.exec(lines[i + 1] ?? '');
    if (!meta) continue;
    out.push({
      index: Number(head[1]),
      timeGenerated: new Date(head[2]),
      entryType: head[3],
      source: meta[1],
      eventId: Number(meta[2]),
      message: (lines[i + 2] ?? '').trim(),
      computer,
      channel,
      ordinal: 0,
    });
  }
  return out.reverse();
}

function exportLog(ctx: WinCommandContext, cmd: ParsedCommand): string {
  const [logName, destination] = cmd.positional;
  if (!logName || !destination) {
    return 'Usage: wevtutil epl <log> <exportFile> [/ow:true|false]';
  }
  if (!ctx.eventLog?.exportLog) {
    return `Failed to export log ${logName}. The system cannot find the path specified.`;
  }
  return ctx.eventLog.exportLog(logName, destination, truthy(opt(cmd, 'overwrite'))) ?? '';
}

function archiveLog(ctx: WinCommandContext, cmd: ParsedCommand): string {
  const source = cmd.positional[0];
  if (!source) return 'Usage: wevtutil al <logFile>';
  if (!ctx.eventLog?.archiveExportedLog) {
    return `Failed to archive log file ${source}. The system cannot find the file specified.`;
  }
  return ctx.eventLog.archiveExportedLog(source) ?? '';
}

function clearLog(ctx: WinCommandContext, cmd: ParsedCommand): string {
  const name = cmd.positional[0];
  if (!name) return 'Usage: wevtutil cl <log> [/bu:BACKUPFILE]';
  const backup = opt(cmd, 'backup');
  if (backup !== undefined) {
    const err = ctx.eventLog?.exportLog?.(name, backup, true);
    if (err) return err;
  }
  if (!ctx.eventLog?.clearEventLog) return ERR.noChannel(name);
  ctx.eventLog.clearEventLog(name, backup ?? null);
  return '';
}
