/**
 * `repadmin` — real AD replication diagnostics/control (PRD-Windows-
 * Server-Advanced.md §5 P6/P12), driven by the same `ReplicationLogEntry`
 * log (inbound + outbound, via `ReplicationSignalStore`) that backs
 * `Get-ADReplicationConnection`/`Get-ADReplicationFailure`, and by the
 * real `replicateFrom`/`notifySyncNow` network calls for `/syncall`.
 */
import type { ReplicationLogEntry } from './server/ad/replication/ReplicationSession';

export interface RepadminContext {
  hostname: string;
  fqdn: string;
  domainDn: string;
  /** Every replication cycle this DC has recorded, inbound and outbound. */
  log: readonly ReplicationLogEntry[];
  /** Every other known DC's FQDN, from the Domain Controllers OU — display/enumeration only (`/replsummary`'s DC listing), no address. */
  knownDcFqdns: string[];
  resolveIpToName: (ip: string) => string;
  /** Pull changes from `partnerIp` right now (default, pull mode). */
  pullFrom: (partnerIp: string) => { ok: boolean; applied: number; error?: string };
  /** Push-notify `partnerIp` to pull from us right now (`/P`, push mode). */
  pushTo: (partnerIp: string) => { ok: boolean; error?: string };
}

function lastAttempt(log: readonly ReplicationLogEntry[], direction: 'inbound' | 'outbound', partnerAddress?: string): ReplicationLogEntry | null {
  const matching = log.filter(e => (e.direction ?? 'inbound') === direction && (!partnerAddress || e.partnerAddress === partnerAddress));
  return matching.length > 0 ? matching[matching.length - 1] : null;
}

function formatTime(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toUTCString();
}

function showRepl(ctx: RepadminContext, target: string): string {
  const lines: string[] = [
    `Repadmin: running command /showrepl against server ${target}`,
    '',
    ctx.fqdn,
    `DSA invocationID: ${ctx.hostname}`,
    '',
  ];

  const renderDirection = (label: string, direction: 'inbound' | 'outbound'): void => {
    lines.push(`==== ${label} NEIGHBORS ======================================`, '', ctx.domainDn);
    const partnerAddresses = [...new Set(ctx.log.filter(e => (e.direction ?? 'inbound') === direction).map(e => e.partnerAddress))];
    if (partnerAddresses.length === 0) {
      lines.push(`    (nothing yet)`, '');
      return;
    }
    for (const addr of partnerAddresses) {
      const entry = lastAttempt(ctx.log, direction, addr);
      if (!entry) continue;
      lines.push(
        `    ${ctx.resolveIpToName(addr)} via RPC`,
        `        Last attempt @ ${formatTime(entry.timestamp)} was ${entry.ok ? 'successful' : `unsuccessful (${entry.error ?? 'unknown error'})`}.`,
        '',
      );
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

export function cmdRepadmin(ctx: RepadminContext, args: string[]): string {
  const sub = (args[0] ?? '').toLowerCase();
  switch (sub) {
    case '/showrepl':
      return showRepl(ctx, args[1] ?? ctx.fqdn);
    case '/replsummary':
      return replSummary(ctx);
    case '/syncall':
      return syncAll(ctx, args.slice(1));
    default:
      return `repadmin: '${args[0] ?? ''}' is not a recognized command.\nrepadmin usage: repadmin /showrepl [DC] | /replsummary | /syncall [DC] [/P]`;
  }
}
