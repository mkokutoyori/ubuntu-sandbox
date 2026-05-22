/**
 * Audit-subsystem commands — `ausearch`, `aureport`, `auditctl`.
 *
 * These are the user-facing query tools of the Linux audit trail. They read
 * the {@link LinuxAuditLog} the {@link AuditTrailProjection} keeps coherent,
 * so the CLI view and the on-disk `/var/log/audit/audit.log` always agree.
 */

import type { LinuxAuditLog, AuditQuery } from './LinuxAuditLog';

/** Event separator `ausearch` prints between records. */
const EVENT_SEPARATOR = '----';

/**
 * `ausearch` — query the audit trail. Supports `-m <type>` (message type),
 * `-ui <uid>`, `-ua <acct>` and `--success yes|no`.
 */
export function cmdAusearch(auditLog: LinuxAuditLog, args: string[]): string {
  const filter: AuditQuery = {};

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '-m': case '--message': filter.type = args[++i]; break;
      case '-ui': case '--uid': filter.key = 'uid'; filter.value = args[++i]; break;
      case '-ua': case '--acct': filter.key = 'acct'; filter.value = args[++i]; break;
      case '--success': filter.success = /^(yes|true|1)$/i.test(args[++i] ?? ''); break;
    }
  }

  const records = auditLog.query(filter);
  if (records.length === 0) return '<no matches>';
  return records.map((r) => r.render()).join(`\n${EVENT_SEPARATOR}\n`);
}

/** `aureport` — a summary of the audit trail, grouped by record type. */
export function cmdAureport(auditLog: LinuxAuditLog, _args: string[]): string {
  const counts = auditLog.countByType();
  const total = auditLog.all().length;

  const accountTypes = new Set(['ADD_USER', 'DEL_USER', 'USER_MGMT', 'ADD_GROUP', 'DEL_GROUP']);
  let accountChanges = 0;
  let authEvents = 0;
  for (const [type, n] of counts) {
    if (accountTypes.has(type)) accountChanges += n;
    if (type === 'USER_CHAUTHTOK' || type === 'USER_AUTH' || type === 'ANOM_LOGIN_FAILURES') authEvents += n;
  }

  const lines = [
    'Summary Report',
    '======================',
    `Number of audit events: ${total}`,
    `Number of changes to accounts, groups, or roles: ${accountChanges}`,
    `Number of authentication events: ${authEvents}`,
    '',
    'Events by type',
    '======================',
  ];
  for (const [type, n] of [...counts.entries()].sort()) {
    lines.push(`${String(n).padStart(6)}  ${type}`);
  }
  return lines.join('\n');
}

/** `auditctl` — query / control the audit subsystem (status & rule list). */
export function cmdAuditctl(auditLog: LinuxAuditLog, args: string[]): string {
  if (args.includes('-s') || args.includes('--status')) {
    return [
      'enabled 1',
      'failure 1',
      'pid 612',
      'rate_limit 0',
      'backlog_limit 8192',
      'lost 0',
      `backlog ${auditLog.all().length}`,
    ].join('\n');
  }
  if (args.includes('-l') || args.includes('--list')) {
    return 'No rules';
  }
  return 'usage: auditctl [options]';
}
