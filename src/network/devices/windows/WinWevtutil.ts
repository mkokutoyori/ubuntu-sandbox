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

import type { WinCommandContext } from './WinCommandExecutor';
import { requireWindowsService } from './WinFeatureGate';
import { parseEventXPath, levelOf, type XPathEvent } from './WinEventXPath';

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

/{e | enabled}:VALUE    Enable or disable a log.
/{ms | maxsize}:VALUE   Maximum log size, in bytes.
/{r | retention}:VALUE  Log retention mode.

Export options:

/{ow | overwrite}:VALUE Overwrite the export file if it exists.`;

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
 * Les options que ce `wevtutil` ne sait pas honorer, et qu'il refuse
 * plutôt que d'accepter en silence.
 *
 * `/r:` en particulier : l'exécution distante passe par RPC/DCOM, que
 * rien ne modélise ici. WinRM existe, mais ce n'est pas le même
 * transport, et s'en servir serait un raccourci qu'on présenterait pour
 * l'original. Attention à l'ambiguïté : `/r:` est *aussi* la rétention
 * de `sl`, d'où le filtrage par verbe.
 */
const REMOTE_OPTIONS = new Set(['r', 'remote', 'u', 'username', 'p', 'password', 'a', 'authentication']);

interface ParsedCommand {
  verb: string;
  positional: string[];
  options: Map<string, string>;
}

/**
 * L'analyseur unique. Chaque verbe lit ensuite un objet, pas un tableau
 * de chaînes — sans quoi ils re-découpent chacun à leur façon et
 * finissent par diverger, ce qui était le cas.
 */
export function parseWevtutilArgs(args: string[]): ParsedCommand {
  const [raw = '', ...rest] = args;
  const lower = raw.toLowerCase();
  const verb = VERBS[lower] ?? (SHORT_VERBS.has(lower) ? lower : lower);
  const positional: string[] = [];
  const options = new Map<string, string>();
  for (const a of rest) {
    if (!a.startsWith('/')) { positional.push(a); continue; }
    const body = a.slice(1);
    const colon = body.indexOf(':');
    const name = (colon < 0 ? body : body.slice(0, colon)).toLowerCase();
    const value = colon < 0 ? 'true' : body.slice(colon + 1).replace(/^"(.*)"$/, '$1');
    options.set(name, value);
  }
  return { verb, positional, options };
}

const truthy = (v: string | undefined): boolean =>
  v !== undefined && v.toLowerCase() !== 'false' && v !== '0';

/** `/lf` ou `/logfile`, `/c` ou `/count`… — une option, deux écritures. */
function opt(cmd: ParsedCommand, ...names: string[]): string | undefined {
  for (const n of names) {
    const v = cmd.options.get(n);
    if (v !== undefined) return v;
  }
  return undefined;
}

export function cmdWevtutil(ctx: WinCommandContext, args: string[]): string {
  if (args.includes('/?') || args.includes('/help') || args.length === 0) {
    return WEVTUTIL_HELP;
  }

  // La porte de service reste en tête, avant l'analyse du verbe : sans le
  // service, aucune commande n'a de sens, pas même une commande inconnue.
  const gate = requireWindowsService(ctx, 'EventLog');
  if (!gate.ok) return gate.error;

  const cmd = parseWevtutilArgs(args);

  // Les options d'exécution distante sont refusées partout sauf là où
  // `/r:` désigne autre chose (la rétention de `set-log`).
  for (const name of cmd.options.keys()) {
    if (!REMOTE_OPTIONS.has(name)) continue;
    if (cmd.verb === 'sl' && (name === 'r' || name === 'remote')) continue;
    return ERR.unknownOption(`/${name}`);
  }

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

// ─── el ─────────────────────────────────────────────────────────────

/**
 * La liste vient du registre réel des journaux, pas d'un tableau écrit
 * dans le code : `wevtutil el` et `Get-WinEvent -ListLog` doivent voir
 * le même ensemble, sinon toute création de canal creuse l'écart entre
 * eux.
 */
function enumLogs(ctx: WinCommandContext): string {
  const logs = ctx.eventLog?.getAllLogsStructured?.() ?? [];
  return logs.map((l) => l.logName).join('\n');
}

// ─── gl / gli ───────────────────────────────────────────────────────

function getLog(ctx: WinCommandContext, cmd: ParsedCommand): string {
  const name = cmd.positional[0];
  if (!name) return 'Usage: wevtutil gl <log>';
  const st = ctx.eventLog?.getLogStatus?.(name);
  if (!st) return ERR.noChannel(name);
  return [
    `name: ${st.logName}`,
    `enabled: ${st.enabled}`,
    'type: Admin',
    'owningPublisher:',
    'isolation: Application',
    'channelAccess:',
    'logging:',
    `  logFileName: %SystemRoot%\\System32\\Winevt\\Logs\\${st.logName.replace(/\//g, '%4')}.evtx`,
    `  retention: ${st.overflow === 'DoNotOverwrite'}`,
    // Toujours faux : rien n'archive un journal plein dans ce
    // simulateur, et `sl /ab:` est refusée pour la même raison.
    '  autoBackup: false',
    `  maxSize: ${st.maxSizeKB * 1024}`,
    'publishing:',
  ].join('\n');
}

function getLogInfo(ctx: WinCommandContext, cmd: ParsedCommand): string {
  const name = cmd.positional[0];
  if (!name) return 'Usage: wevtutil gli <log>';
  const st = ctx.eventLog?.getLogStatus?.(name);
  if (!st) return ERR.noChannel(name);
  const stamp = st.lastWriteTime ? st.lastWriteTime.toISOString() : '';
  return [
    `creationTime: ${stamp}`,
    `lastAccessTime: ${stamp}`,
    `lastWriteTime: ${stamp}`,
    `fileSize: ${st.fileSize}`,
    'attributes: 32',
    `numberOfLogRecords: ${st.numberOfLogRecords}`,
    `oldestRecordNumber: ${st.oldestRecordNumber}`,
  ].join('\n');
}

// ─── sl ─────────────────────────────────────────────────────────────

function setLog(ctx: WinCommandContext, cmd: ParsedCommand): string {
  const name = cmd.positional[0];
  if (!name) return 'Usage: wevtutil sl <log> [/e:true|false] [/ms:BYTES]';
  if (!ctx.eventLog?.setLogConfig) return ERR.noChannel(name);

  const enabled = opt(cmd, 'e', 'enabled');
  const maxSize = opt(cmd, 'ms', 'maxsize');
  const retention = opt(cmd, 'r', 'retention');
  // `/ab:` n'est pas honorée : rien n'archive un journal plein ici, et
  // l'accepter en silence ferait croire à une sauvegarde automatique qui
  // n'aura pas lieu.
  if (opt(cmd, 'ab', 'autobackup') !== undefined) return ERR.unknownOption('/ab');

  const bytes = maxSize !== undefined ? Number(maxSize) : undefined;
  if (bytes !== undefined && (Number.isNaN(bytes) || bytes <= 0)) {
    return `Failed to modify configuration for log ${name}. The value "${maxSize}" is not a valid size.`;
  }

  const err = ctx.eventLog.setLogConfig(name, {
    ...(enabled !== undefined ? { enabled: truthy(enabled) } : {}),
    // La configuration se donne en octets et se garde en kilo-octets.
    ...(bytes !== undefined ? { maxSizeKB: Math.max(1, Math.round(bytes / 1024)) } : {}),
    ...(retention !== undefined ? { retention: truthy(retention) } : {}),
  });
  return err ?? '';
}

// ─── qe ─────────────────────────────────────────────────────────────

/**
 * Le rendu texte de `wevtutil qe /f:text`, dans la disposition réelle.
 *
 * L'implémentation précédente inventait son propre format
 * (`Event[0]:\n  Log Name: …`), qui ne correspondait à aucun des trois
 * de Windows — un script qui le dépouillait n'aurait pas fonctionné sur
 * une vraie machine, et réciproquement.
 */
function renderText(logName: string, e: QueryEvent): string {
  return [
    `Event[${e.ordinal}]:`,
    `  Log Name: ${logName}`,
    `  Source: ${e.source}`,
    `  Date: ${e.timeGenerated.toISOString()}`,
    `  Event ID: ${e.eventId}`,
    `  Task: N/A`,
    `  Level: ${e.entryType}`,
    `  Opcode: Info`,
    `  Keyword: N/A`,
    `  User: N/A`,
    `  User Name: N/A`,
    `  Computer: ${e.computer}`,
    `  Description: `,
    e.message,
  ].join('\n');
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderXml(logName: string, e: QueryEvent, rendered: boolean): string {
  const data = Object.entries(e.data ?? {})
    .map(([k, v]) => `<Data Name='${xmlEscape(k)}'>${xmlEscape(v)}</Data>`).join('');
  const core =
    `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'>`
    + `<System><Provider Name='${xmlEscape(e.source)}'/>`
    + `<EventID>${e.eventId}</EventID><Level>${levelOf(e.entryType)}</Level>`
    + `<TimeCreated SystemTime='${e.timeGenerated.toISOString()}'/>`
    + `<EventRecordID>${e.index}</EventRecordID>`
    + `<Channel>${xmlEscape(logName)}</Channel>`
    + `<Computer>${xmlEscape(e.computer)}</Computer></System>`
    + `<EventData>${data}</EventData>`;
  if (!rendered) return `${core}</Event>`;
  // `RenderedXml` ajoute le message déjà mis en forme — c'est ce qui la
  // distingue de `XML`, qui ne rend que l'événement brut.
  return `${core}<RenderingInfo Culture='en-US'>`
    + `<Message>${xmlEscape(e.message)}</Message>`
    + `<Level>${xmlEscape(e.entryType)}</Level>`
    + `<Channel>${xmlEscape(logName)}</Channel>`
    + `</RenderingInfo></Event>`;
}

interface QueryEvent extends XPathEvent {
  index: number;
  message: string;
  computer: string;
  ordinal: number;
}

function queryEvents(ctx: WinCommandContext, cmd: ParsedCommand): string {
  const target = cmd.positional[0];
  if (!target) return 'Usage: wevtutil qe <log> [/q:XPATH] [/c:N] [/rd:true] [/f:Text|XML|RenderedXml]';

  const format = (opt(cmd, 'f', 'format') ?? 'text').toLowerCase();
  if (!['text', 'xml', 'renderedxml'].includes(format)) {
    return ERR.unknownOption(`/f:${format}`);
  }
  const reverse = truthy(opt(cmd, 'rd', 'reversedirection'));
  const countRaw = opt(cmd, 'c', 'count');
  const count = countRaw !== undefined ? Number(countRaw) : undefined;
  if (count !== undefined && (Number.isNaN(count) || count < 0)) {
    return ERR.unknownOption(`/c:${countRaw}`);
  }

  const query = opt(cmd, 'q', 'query');
  const parsed = parseEventXPath(query ?? '*');
  if (!parsed.predicate) return ERR.badQuery(parsed.error ?? 'The query is malformed.');

  const fromFile = truthy(opt(cmd, 'lf', 'logfile'));
  // Le client DHCP tient ses lignes à part et ne les verse qu'à la
  // demande ; les réconcilier avant toute lecture de canal évite de
  // rendre un journal en retard sur la machine. C'est une mise à jour,
  // pas une substitution de contenu : elle a lieu quelle que soit la
  // requête, à l'inverse du détournement par le mot « dhcp » d'avant.
  if (!fromFile) ctx.syncDHCPEvents();
  const source = fromFile ? readExportedLog(ctx, target) : readChannel(ctx, target);
  if (source === null) {
    return fromFile
      ? `Failed to read log file ${target}. The system cannot find the file specified.`
      : ERR.noChannel(target);
  }

  const now = ctx.eventLog?.now?.() ?? Date.now();
  let events = source.filter((e) => parsed.predicate!(e, now));
  // `getEntriesStructured` rend du plus récent au plus ancien ;
  // `wevtutil` sans `/rd:` fait l'inverse — c'est un piège classique, et
  // le défaut opposé de celui de `Get-WinEvent`.
  if (!reverse) events = events.reverse();
  if (count !== undefined) events = events.slice(0, count);
  if (events.length === 0) {
    return 'No events found that match the specified selection criteria.';
  }

  const logName = fromFile ? (source[0]?.channel ?? target) : target;
  return events.map((e, i) => {
    const ev = { ...e, ordinal: i };
    return format === 'text'
      ? renderText(logName, ev)
      : renderXml(logName, ev, format === 'renderedxml');
  }).join(format === 'text' ? '\n\n' : '\n');
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
    timeGenerated: e.timeGenerated ?? new Date(),
    data: e.data,
    message: e.message,
    computer,
    ordinal: i,
  }));
}

/**
 * Relit un fichier produit par `epl`. C'est ce qui referme la boucle :
 * on exporte, puis on relit ce qu'on a exporté, et les deux disent la
 * même chose.
 *
 * Le format lu est celui que le fournisseur écrit — du texte, pas le
 * binaire `.evtx` de Windows (voir `docs/PRD-Wevtutil.md` §7).
 */
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
  // Le fichier est écrit du plus ancien au plus récent ; le canal se lit
  // dans l'autre sens. On aligne la source sur la convention du canal,
  // pour que `/rd:` se comporte pareil des deux côtés.
  return out.reverse();
}

// ─── epl / al / cl ──────────────────────────────────────────────────

function exportLog(ctx: WinCommandContext, cmd: ParsedCommand): string {
  const [logName, destination] = cmd.positional;
  if (!logName || !destination) {
    return 'Usage: wevtutil epl <log> <exportFile> [/ow:true|false]';
  }
  if (!ctx.eventLog?.exportLog) {
    return `Failed to export log ${logName}. The system cannot find the path specified.`;
  }
  // `wevtutil epl` qui réussit n'écrit rien : le silence *est* le
  // succès, et c'est le fichier écrit qui en témoigne.
  return ctx.eventLog.exportLog(logName, destination, truthy(opt(cmd, 'ow', 'overwrite'))) ?? '';
}

/**
 * `al` — archive un journal exporté. Sur un vrai Windows, l'archivage
 * ajoute les ressources de localisation au fichier pour qu'il reste
 * lisible sur une machine qui n'a pas les éditeurs d'origine. Ici les
 * messages sont déjà rendus dans le fichier : l'archivage n'a donc rien
 * à ajouter, et se réduit à une copie. C'est déclaré plutôt que
 * maquillé.
 */
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
  const backup = opt(cmd, 'bu', 'backup');
  // La sauvegarde précède le vidage — après, il n'y a plus rien à
  // sauvegarder. Si elle échoue, le journal n'est pas vidé : c'est la
  // seule variante de `cl` qui rende l'effacement réversible, et la
  // vider quand même la rendrait mensongère.
  if (backup !== undefined) {
    const err = ctx.eventLog?.exportLog?.(name, backup, true);
    if (err) return err;
  }
  if (!ctx.eventLog?.clearEventLog) return ERR.noChannel(name);
  ctx.eventLog.clearEventLog(name);
  return '';
}
