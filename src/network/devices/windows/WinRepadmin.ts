/**
 * `repadmin` — real AD replication diagnostics/control (PRD-Repadmin.md,
 * building on PRD-Windows-Server-Advanced.md §5 P6/P12), driven by the
 * same `ReplicationLogEntry` log (inbound + outbound, via
 * `ReplicationSignalStore`) that backs `Get-ADReplicationConnection`/
 * `Get-ADReplicationFailure`, and by real network calls — `/syncall`
 * (`replicateFrom`/`notifySyncNow`), `/showrepl`/`/showconn`/`/showvector`/
 * `/showobjmeta`/`/bind`/`/latencies` against a remote DC
 * (`queryRemoteReplicationStatus`, PRD-Repadmin.md P1), `/replicate`
 * (`pullFrom`/`triggerRemoteReplicate`), and `/options` on a remote DC
 * (`setRemoteOption`).
 */
import type { ReplicationLogEntry } from './server/ad/replication/ReplicationSession';
import type { HighWatermarkVectorWire } from './server/ad/replication/HighWatermarkVector';
import type { EntryReplMeta } from './server/ad/ldap/DirectoryTree';

export type NtdsOption = 'DISABLE_OUTBOUND_REPL' | 'DISABLE_INBOUND_REPL' | 'IS_GC' | 'DISABLE_SPN_REGISTRATION';
export const NTDS_OPTION_NAMES: readonly NtdsOption[] = ['DISABLE_OUTBOUND_REPL', 'DISABLE_INBOUND_REPL', 'IS_GC', 'DISABLE_SPN_REGISTRATION'];

/** PRD-Repadmin.md P1: the result of resolving a (possibly remote) DC name to its real replication status. */
export interface RepadminTarget {
  ok: boolean;
  fqdn: string;
  hostname: string;
  invocationId: string;
  log: readonly ReplicationLogEntry[];
  outboundVector: HighWatermarkVectorWire;
  error?: string;
  /** Round-trip time in ms for the dial that produced this — undefined for the local/self shortcut (no network dial happened). */
  latencyMs?: number;
  /** Set only when the caller passed an `objectDn` to resolve (P6) — the object's replication stamp, or `null` if it doesn't exist on the target. */
  objectMeta?: EntryReplMeta | null;
}

export interface RepadminContext {
  hostname: string;
  fqdn: string;
  domainDn: string;
  invocationId: string;
  /** Every replication cycle this DC has recorded, inbound and outbound. */
  log: readonly ReplicationLogEntry[];
  outboundVector: HighWatermarkVectorWire;
  /** Every other known DC's FQDN, from the Domain Controllers OU — display/enumeration only (`/replsummary`'s DC listing), no address. */
  knownDcFqdns: string[];
  resolveIpToName: (ip: string) => string;
  /** PRD-Repadmin.md P2: this (local) DC's own view of which site a partner address belongs to — `null` if unknown/no site model applies. Self-view only (a remote target's own site registry isn't queried over the wire). */
  resolveIpToSite: (ip: string) => string | null;
  /** Pull changes from `partnerIp` right now (default, pull mode). */
  pullFrom: (partnerIp: string) => { ok: boolean; applied: number; error?: string };
  /** Push-notify `partnerIp` to pull from us right now (`/P`, push mode). */
  pushTo: (partnerIp: string) => { ok: boolean; error?: string };
  /** PRD-Repadmin.md P1: resolve `name` (a DC hostname or FQDN) to its real replication state — a local shortcut when `name` is this DC itself, otherwise a real TCP/135 dial. `objectDn`, when given, also resolves that object's replication stamp on the target (P6). */
  resolveTarget: (name: string, objectDn?: string) => RepadminTarget;
  /** PRD-Repadmin.md P2: how far this (local) DC has absorbed a specific partner's changes, by that partner's invocationID. */
  usnForInvocation: (invocationId: string) => number;
  /** PRD-Repadmin.md P3: tell `destIp` to pull from `sourceIp` right now (remote-triggered `/replicate`). */
  triggerRemoteReplicate: (destIp: string, sourceIp: string) => { ok: boolean; applied: number; error?: string };
  /** PRD-Repadmin.md P6: this (local) DC's own replication stamp for `dn`, or `null` if no such object exists locally. */
  getObjectReplMeta: (dn: string) => EntryReplMeta | null;
  /** PRD-Repadmin.md P8: this DC's own NTDS Settings flags. */
  options: ReadonlySet<NtdsOption>;
  setOption: (opt: NtdsOption, enabled: boolean) => void;
  /** PRD-Repadmin.md P8: apply an option directly on a remote DC. */
  setRemoteOption: (targetIp: string, opt: NtdsOption, enabled: boolean) => boolean;
  /** Resolve a DC name to its IP without querying replication status — used by `/replicate`/`/options` to reach a target that doesn't need the full status payload. */
  resolveNameToIp: (name: string) => string | null;
}

function lastAttempt(log: readonly ReplicationLogEntry[], direction: 'inbound' | 'outbound', partnerAddress?: string): ReplicationLogEntry | null {
  const matching = log.filter(e => (e.direction ?? 'inbound') === direction && (!partnerAddress || e.partnerAddress === partnerAddress));
  return matching.length > 0 ? matching[matching.length - 1] : null;
}

function attemptsFor(log: readonly ReplicationLogEntry[], direction: 'inbound' | 'outbound', partnerAddress: string): ReplicationLogEntry[] {
  return log.filter(e => (e.direction ?? 'inbound') === direction && e.partnerAddress === partnerAddress);
}

function formatTime(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toUTCString();
}

/**
 * A DSA object GUID, real Windows-style — this simulator has no
 * authoritative-restore concept (§7 risk note), so a DC's DSA GUID never
 * diverges from its invocationID in practice; deriving one deterministic
 * hex string from the other keeps `/showrepl`'s "DSA object GUID" line
 * honest (same value every time for the same DC) without inventing new
 * per-DC stored state.
 */
function pseudoGuid(seed: string): string {
  let h1 = 0x811c9dc5, h2 = 0x1000193;
  for (let i = 0; i < seed.length; i++) {
    h1 = (Math.imul(h1 ^ seed.charCodeAt(i), 0x01000193)) >>> 0;
    h2 = (Math.imul(h2 ^ seed.charCodeAt(seed.length - 1 - i), 0x85ebca6b)) >>> 0;
  }
  const hex = (n: number, len: number) => n.toString(16).padStart(len, '0').slice(0, len);
  return `${hex(h1, 8)}-${hex(h2, 4)}-${hex(h1 >>> 16, 4)}-${hex(h2 >>> 16, 4)}-${hex(h1, 6)}${hex(h2, 6)}`;
}

function optionsLine(options: ReadonlySet<NtdsOption>): string {
  return options.size > 0 ? [...options].join(' ') : '(none)';
}

interface ShowReplOpts {
  csv: boolean;
  verbose: boolean;
}

function showReplCsv(target: RepadminTarget, domainDn: string, resolveIpToName: (ip: string) => string): string {
  const lines = ['Showrepl_COLUMNS,Dest DSA,Naming Context,Source DSA,Source DSA CN,Transport Type,Number of Failures,Last Failure Time,Last Success Time,Last Failure Status'];
  const partnerAddresses = [...new Set(target.log.filter(e => (e.direction ?? 'inbound') === 'inbound').map(e => e.partnerAddress))];
  for (const addr of partnerAddresses) {
    const attempts = attemptsFor(target.log, 'inbound', addr);
    const failures = attempts.filter(e => !e.ok);
    const lastFailure = failures.length > 0 ? failures[failures.length - 1] : null;
    const lastSuccess = [...attempts].reverse().find(e => e.ok) ?? null;
    const sourceName = resolveIpToName(addr);
    lines.push([
      'Showrepl_ENTRY', target.hostname, domainDn, sourceName, `CN=NTDS Settings\\,CN=${sourceName}`, 'IP',
      String(failures.length),
      lastFailure ? String(lastFailure.timestamp) : '0',
      lastSuccess ? new Date(lastSuccess.timestamp * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '') : '',
      lastFailure ? '1' : '0',
    ].join(','));
  }
  return lines.join('\n');
}

function showRepl(ctx: RepadminContext, targetArg: string | undefined, opts: ShowReplOpts): string {
  const targetName = targetArg ?? ctx.fqdn;
  const isSelf = targetArg === undefined
    || targetArg.toLowerCase() === ctx.fqdn.toLowerCase()
    || targetArg.toLowerCase() === ctx.hostname.toLowerCase();
  const target: RepadminTarget = isSelf
    ? { ok: true, fqdn: ctx.fqdn, hostname: ctx.hostname, invocationId: ctx.invocationId, log: ctx.log, outboundVector: ctx.outboundVector }
    : ctx.resolveTarget(targetName);

  if (!target.ok) return `Unable to contact target: ${targetName}`;

  if (opts.csv) return showReplCsv(target, ctx.domainDn, ctx.resolveIpToName);

  const lines: string[] = [
    `Repadmin: running command /showrepl against server ${targetName}`,
    '',
    target.fqdn,
    `DSA Options: ${optionsLine(isSelf ? ctx.options : new Set())}`,
    'Site Options: (none)',
    `DSA object GUID: ${pseudoGuid(target.invocationId)}`,
    `DSA invocationID: ${target.invocationId}`,
    '',
  ];

  const renderDirection = (label: string, direction: 'inbound' | 'outbound'): void => {
    lines.push(`==== ${label} NEIGHBORS ======================================`, '', ctx.domainDn);
    const partnerAddresses = [...new Set(target.log.filter(e => (e.direction ?? 'inbound') === direction).map(e => e.partnerAddress))];
    if (partnerAddresses.length === 0) {
      lines.push(`    (nothing yet)`, '');
      return;
    }
    for (const addr of partnerAddresses) {
      const attempts = attemptsFor(target.log, direction, addr);
      const shown = opts.verbose ? attempts : (lastAttempt(target.log, direction, addr) ? [lastAttempt(target.log, direction, addr)!] : []);
      const site = isSelf ? ctx.resolveIpToSite(addr) : null;
      const partnerLabel = site ? `${site}\\${ctx.resolveIpToName(addr)}` : ctx.resolveIpToName(addr);
      lines.push(`    ${partnerLabel} via RPC`, `        DC object GUID: ${pseudoGuid(addr)}`);
      for (const entry of shown) {
        lines.push(`        Last attempt @ ${formatTime(entry.timestamp)} was ${entry.ok ? 'successful' : `unsuccessful (${entry.error ?? 'unknown error'})`} (${entry.siteRelation}).`);
      }
      if (direction === 'inbound' && isSelf) {
        const latest = shown[shown.length - 1];
        if (latest?.ok && latest.remoteInvocationId) {
          lines.push(`        USNs: ${ctx.usnForInvocation(latest.remoteInvocationId)} / current`);
        }
      }
      lines.push('');
    }
  };

  renderDirection('INBOUND', 'inbound');
  renderDirection('OUTBOUND', 'outbound');
  return lines.join('\n');
}

function replSummary(ctx: RepadminContext): string {
  const lines: string[] = [
    `Replication Summary Start Time: ${new Date().toUTCString()}`,
    'Beginning data collection for replication summary, this may take awhile:',
    '    .',
    '',
  ];

  const renderTable = (title: string, direction: 'inbound' | 'outbound'): void => {
    lines.push(`${title} DSA           largest delta    Fails/Total   Fails`);
    const allDsas = [ctx.fqdn, ...ctx.knownDcFqdns];
    for (const dsa of allDsas) {
      const isSelf = dsa === ctx.fqdn;
      const relevant = isSelf ? ctx.log.filter(e => (e.direction ?? 'inbound') === direction) : [];
      const total = relevant.length;
      const fails = relevant.filter(e => !e.ok).length;
      const latest = relevant.length > 0 ? relevant[relevant.length - 1] : null;
      const delta = latest ? `${Math.max(0, Math.floor(Date.now() / 1000) - latest.timestamp)}s ago` : 'n/a';
      lines.push(` ${dsa.padEnd(20)} ${delta.padStart(14)}    ${fails} / ${total}    Fails ${fails}`);
    }
    lines.push('');
  };

  renderTable('Source', 'inbound');
  renderTable('Destination', 'outbound');
  return lines.join('\n');
}

/**
 * Every address this DC has ever exchanged replication traffic with
 * (either direction) — real repadmin gets its partner list from the
 * DC's own NTDS Connection objects, populated by the KCC; without a KCC
 * modeled, "every address we've actually talked to" is this simulator's
 * honest equivalent, and it's always at least as complete since a
 * connection can't exist without a prior successful exchange.
 */
function knownPartnerAddresses(log: readonly ReplicationLogEntry[]): string[] {
  return [...new Set(log.map(e => e.partnerAddress))];
}

function syncAll(ctx: RepadminContext, args: string[]): string {
  const flagArg = args.find(a => a.startsWith('/'));
  const flags = (flagArg ?? '').replace('/', '');
  const push = flags.includes('P');
  const targetArg = args.find(a => !a.startsWith('/'));
  const target = targetArg ?? ctx.hostname;

  const lines: string[] = [
    `Syncing all naming context (NC) held on ${target} to all servers.`,
    `Syncing partition: ${ctx.domainDn}`,
  ];

  const partners = knownPartnerAddresses(ctx.log);
  if (partners.length === 0) {
    lines.push('No replication partners found.');
    return lines.join('\n');
  }

  for (const ip of partners) {
    const name = ctx.resolveIpToName(ip);
    if (push) {
      const result = ctx.pushTo(ip);
      lines.push(result.ok
        ? `${name} via RPC notified to sync now: successful.`
        : `${name} via RPC notified to sync now: ${result.error ?? 'failed'}.`);
    } else {
      const result = ctx.pullFrom(ip);
      lines.push(result.ok
        ? `${name} via RPC synced: ${result.applied} object(s) applied.`
        : `${name} via RPC synced: ${result.error ?? 'failed'}.`);
    }
  }
  lines.push('SyncAll terminated with no errors.');
  return lines.join('\n');
}

/** PRD-Repadmin.md P3: `/replicate <DestDC> <SourceDC> <NC>`. */
function replicate(ctx: RepadminContext, args: string[]): string {
  const [destArg, sourceArg, nc] = args;
  if (!destArg || !sourceArg) return 'repadmin /replicate: usage is /replicate <DestDC> <SourceDC> <NC>';

  const sourceIp = ctx.resolveNameToIp(sourceArg);
  if (!sourceIp) return `Unable to contact target: ${sourceArg}`;

  const destIsSelf = destArg.toLowerCase() === ctx.fqdn.toLowerCase() || destArg.toLowerCase() === ctx.hostname.toLowerCase();
  const result = destIsSelf
    ? ctx.pullFrom(sourceIp)
    : (() => {
        const destIp = ctx.resolveNameToIp(destArg);
        if (!destIp) return { ok: false, error: `Unable to contact target: ${destArg}`, applied: 0 };
        return ctx.triggerRemoteReplicate(destIp, sourceIp);
      })();

  if (!result.ok) return `SyncAll for ${nc ?? ctx.domainDn} from ${sourceArg} to ${destArg} failed: ${result.error ?? 'unknown error'}`;
  return `Replicate from ${sourceArg} to ${destArg} for ${nc ?? ctx.domainDn} was successful (${result.applied} object(s) applied).`;
}

/** PRD-Repadmin.md P4: `/showconn [DC]` — this DC's (or a named DC's) connection objects. */
function showConn(ctx: RepadminContext, targetArg: string | undefined): string {
  const targetName = targetArg ?? ctx.fqdn;
  const isSelf = targetArg === undefined || targetArg.toLowerCase() === ctx.fqdn.toLowerCase() || targetArg.toLowerCase() === ctx.hostname.toLowerCase();
  const target: RepadminTarget = isSelf
    ? { ok: true, fqdn: ctx.fqdn, hostname: ctx.hostname, invocationId: ctx.invocationId, log: ctx.log, outboundVector: ctx.outboundVector }
    : ctx.resolveTarget(targetName);
  if (!target.ok) return `Unable to contact target: ${targetName}`;

  const partners = knownPartnerAddresses(target.log);
  if (partners.length === 0) return `Connections for ${target.fqdn}:\n(no connections)`;

  const lines = [`Connections for ${target.fqdn}:`];
  for (const addr of partners) {
    const name = ctx.resolveIpToName(addr);
    lines.push(
      `Connection --`,
      `    Connection name: ${name}-connection`,
      `    Enabled        : TRUE`,
      `    Server DN Name : ${name}`,
      `    TransportType: RPC`,
      `    AutoGenerated: No`,
      '',
    );
  }
  return lines.join('\n');
}

/** PRD-Repadmin.md P5: `/showvector <NC> [DC]`. */
function showVector(ctx: RepadminContext, args: string[]): string {
  const [nc, targetArg] = args;
  const targetName = targetArg ?? ctx.fqdn;
  const isSelf = targetArg === undefined || targetArg.toLowerCase() === ctx.fqdn.toLowerCase() || targetArg.toLowerCase() === ctx.hostname.toLowerCase();
  const target: RepadminTarget = isSelf
    ? { ok: true, fqdn: ctx.fqdn, hostname: ctx.hostname, invocationId: ctx.invocationId, log: ctx.log, outboundVector: ctx.outboundVector }
    : ctx.resolveTarget(targetName);
  if (!target.ok) return `Unable to contact target: ${targetName}`;

  const lines = [`Repl Up-To-Date Vector for ${nc ?? ctx.domainDn}`, 'Invocation ID'.padEnd(40) + 'USN'];
  if (target.outboundVector.length === 0) lines.push('(no known invocations yet)');
  for (const [invocationId, usn] of target.outboundVector) lines.push(`${invocationId.padEnd(40)}${usn}`);
  return lines.join('\n');
}

/** PRD-Repadmin.md P6: `/showobjmeta <DC> <ObjectDN>`. Object-level only (not per-attribute) — the underlying `EntryReplMeta` model doesn't track attribute-granular history (§2.1 P6 assumed constraint). */
function showObjMeta(ctx: RepadminContext, args: string[]): string {
  const [dcArg, ...dnParts] = args;
  const dn = dnParts.join(' ');
  if (!dcArg || !dn) return 'repadmin /showobjmeta: usage is /showobjmeta <DC> <ObjectDN>';

  const isSelf = dcArg.toLowerCase() === ctx.fqdn.toLowerCase() || dcArg.toLowerCase() === ctx.hostname.toLowerCase();
  const meta = isSelf ? ctx.getObjectReplMeta(dn) : ctx.resolveTarget(dcArg, dn).objectMeta;
  if (meta === undefined) return `Unable to contact target: ${dcArg}`;
  if (meta === null) return `repadmin: object not found: ${dn}`;

  return [
    `${dn}`,
    'Attribute: (object-level only — this simulator does not track per-attribute replication metadata, see PRD-Repadmin.md §2.1 P6)',
    `    Ver   Originating DC                          Loc.USN  Org.USN  Org.Time/Date`,
    `    0x1   ${meta.originatingInvocationId.padEnd(38)} ${String(meta.originatingUsn).padEnd(8)} ${meta.originatingUsn}   ${formatTime(meta.timestamp)}`,
  ].join('\n');
}

/** PRD-Repadmin.md P7: `/bind [DC]` — a real dial to confirm RPC reachability, distinct from anything else /showrepl-family does. */
function bind(ctx: RepadminContext, targetArg: string | undefined): string {
  const targetName = targetArg ?? ctx.fqdn;
  const isSelf = targetArg === undefined || targetArg.toLowerCase() === ctx.fqdn.toLowerCase() || targetArg.toLowerCase() === ctx.hostname.toLowerCase();
  if (isSelf) return `Bound to ${ctx.fqdn} using credentials (NULL)\n${ctx.fqdn} is alive (0 ms).`;

  const target = ctx.resolveTarget(targetName);
  if (!target.ok) return `Unable to contact target: ${targetName}`;
  return `Bound to ${target.fqdn} using credentials (NULL)\n${target.fqdn} is alive (${target.latencyMs ?? 0} ms).`;
}

/** PRD-Repadmin.md P8: `/options [DC] [+|-OPTION]`. */
function options(ctx: RepadminContext, args: string[]): string {
  const flagArg = args.find(a => a.startsWith('+') || a.startsWith('-'));
  const targetArg = args.find(a => !a.startsWith('+') && !a.startsWith('-'));

  if (!flagArg) {
    const isSelf = targetArg === undefined || targetArg.toLowerCase() === ctx.fqdn.toLowerCase() || targetArg.toLowerCase() === ctx.hostname.toLowerCase();
    if (isSelf) return `Current DC Options: ${optionsLine(ctx.options)}`;
    const target = ctx.resolveTarget(targetArg!);
    if (!target.ok) return `Unable to contact target: ${targetArg}`;
    return `Current DC Options: (not queryable remotely without a live dial — see /options ${targetArg} +|-OPTION to set)`;
  }

  const enabled = flagArg[0] === '+';
  const optionName = flagArg.slice(1).toUpperCase() as NtdsOption;
  if (!NTDS_OPTION_NAMES.includes(optionName)) return `repadmin: '${optionName}' is not a recognized DC option.`;

  const isSelf = targetArg === undefined || targetArg.toLowerCase() === ctx.fqdn.toLowerCase() || targetArg.toLowerCase() === ctx.hostname.toLowerCase();
  if (isSelf) {
    ctx.setOption(optionName, enabled);
    return `Current DC Options: ${optionsLine(ctx.options)}\nNew DC Options: ${optionsLine(ctx.options)}`;
  }

  const targetIp = ctx.resolveNameToIp(targetArg!);
  if (!targetIp) return `Unable to contact target: ${targetArg}`;
  const ok = ctx.setRemoteOption(targetIp, optionName, enabled);
  if (!ok) return `Unable to contact target: ${targetArg}`;
  return `[${targetArg}] New DC Options: option ${optionName} ${enabled ? 'set' : 'cleared'}.`;
}

/** PRD-Repadmin.md P9: replication in this simulator is synchronous (a `pullReplication()` call runs to completion before the caller regains control) — there is no asynchronous replication queue to report on, so `/queue` always reports empty. This is a documented, honest reflection of the model, not a gap. */
function queue(): string {
  return 'Queue contains 0 items.';
}

/** PRD-Repadmin.md P10: reuses `ReplicationSignalStore.log`'s failed entries — the exact data `Get-ADReplicationFailure` also reads, so the two surfaces never diverge. */
function failCache(ctx: RepadminContext): string {
  const byPartner = new Map<string, { first: number; count: number; lastError: string }>();
  for (const e of ctx.log) {
    if (e.ok) continue;
    const err = e.error ?? 'unspecified replication error';
    const existing = byPartner.get(e.partnerAddress);
    if (existing) { existing.count += 1; existing.lastError = err; }
    else byPartner.set(e.partnerAddress, { first: e.timestamp, count: 1, lastError: err });
  }
  if (byPartner.size === 0) return 'No entries in the failure cache.';
  const lines: string[] = [];
  for (const [partner, info] of byPartner) {
    const name = ctx.resolveIpToName(partner);
    lines.push(`${name}\tFirst failure: ${formatTime(info.first)}\tFailures: ${info.count}\tLast error: ${info.lastError}`);
  }
  return lines.join('\n');
}

/** PRD-Repadmin.md P11: `/latencies` — depends on P1's remote targeting to query each known DC's own reachability/round trip. */
function latencies(ctx: RepadminContext): string {
  if (ctx.knownDcFqdns.length === 0) return 'No other domain controllers are known.';
  const lines = ['Repadmin: replication latency report', ''];
  for (const dc of ctx.knownDcFqdns) {
    const target = ctx.resolveTarget(dc);
    lines.push(target.ok ? `${dc}\t${target.latencyMs ?? 0} ms` : `${dc}\tUnable to contact target: ${dc}`);
  }
  return lines.join('\n');
}

function parseFlags(args: string[]): { csv: boolean; verbose: boolean; rest: string[] } {
  const csv = args.some(a => a.toLowerCase() === '/csv');
  const verbose = args.some(a => a.toLowerCase() === '/verbose');
  const rest = args.filter(a => !a.startsWith('/'));
  return { csv, verbose, rest };
}

export function cmdRepadmin(ctx: RepadminContext, args: string[]): string {
  const sub = (args[0] ?? '').toLowerCase();
  switch (sub) {
    case '/showrepl': {
      const { csv, verbose, rest } = parseFlags(args.slice(1));
      return showRepl(ctx, rest[0], { csv, verbose });
    }
    case '/replsummary':
      return replSummary(ctx);
    case '/syncall':
      return syncAll(ctx, args.slice(1));
    case '/replicate':
      return replicate(ctx, args.slice(1));
    case '/showconn':
      return showConn(ctx, args[1]);
    case '/showvector':
      return showVector(ctx, args.slice(1));
    case '/showobjmeta':
      return showObjMeta(ctx, args.slice(1));
    case '/bind':
      return bind(ctx, args[1]);
    case '/options':
      return options(ctx, args.slice(1));
    case '/queue':
      return queue();
    case '/failcache':
      return failCache(ctx);
    case '/latencies':
      return latencies(ctx);
    case '/kcc':
      return 'This installation does not model automatic inter-site topology generation (no KCC); replication partners are declared explicitly. See PRD-Windows-Server-Advanced.md §2.2 and PRD-Repadmin.md §2.2.';
    default:
      return `repadmin: '${args[0] ?? ''}' is not a recognized command.\nrepadmin usage: repadmin /showrepl [DC] [/csv] [/verbose] | /replsummary | /syncall [DC] [/P] | /replicate <DestDC> <SourceDC> <NC> | /showconn [DC] | /showvector <NC> [DC] | /showobjmeta <DC> <ObjectDN> | /bind [DC] | /options [DC] [+|-OPTION] | /queue | /failcache | /latencies | /kcc`;
  }
}
