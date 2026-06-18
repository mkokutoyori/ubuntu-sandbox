/**
 * Audit-subsystem commands — `ausearch`, `aureport`, `auditctl`.
 *
 * These are the user-facing query/control tools of the Linux audit trail.
 * They read the {@link LinuxAuditLog} the {@link AuditTrailProjection} keeps
 * coherent and the {@link LinuxAuditRules} set, so the CLI view and the
 * on-disk `/var/log/audit/audit.log` always agree.
 */

import type { LinuxAuditLog, AuditQuery } from './LinuxAuditLog';
import type { LinuxAuditRules } from './LinuxAuditRules';

/** Event separator `ausearch` prints between records. */
const EVENT_SEPARATOR = '----';

export function cmdAusearch(auditLog: LinuxAuditLog, args: string[]): string {
  const filter: AuditQuery = {};
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '-m': case '--message': filter.type = args[++i]; break;
      case '-ui': case '--uid': filter.key = 'uid'; filter.value = args[++i]; break;
      case '-ua': case '--acct': filter.key = 'acct'; filter.value = args[++i]; break;
      case '-k': case '--key': filter.key = 'key'; filter.value = args[++i]; break;
      case '-f': case '--file': filter.key = 'name'; filter.value = args[++i]; break;
      case '--success': filter.success = /^(yes|true|1)$/i.test(args[++i] ?? ''); break;
      case '-ts': case '--start': case '-te': case '--end':
      case '-p': case '--pid': case '-b': case '--boot': i++; break;
    }
  }

  const records = auditLog.query(filter);
  if (records.length === 0) return '<no matches>';
  return records.map((r) => r.render()).join(`\n${EVENT_SEPARATOR}\n`);
}

export function cmdAureport(auditLog: LinuxAuditLog, args: string[]): string {
  if (args.includes('-l') || args.includes('--login')) {
    return ['Login Summary Report', '============================',
      'Number of logins: 0', 'Number of failed logins: 0'].join('\n');
  }
  if (args.includes('-x') || args.includes('--executable')) {
    return ['Executable Summary Report', '=================================',
      'total  file', '0'].join('\n');
  }
  if (args.includes('-c') || args.includes('--config')) {
    return ['Config Summary Report', '=============================',
      'Number of changes in configuration: 0'].join('\n');
  }

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
    `Number of events: ${total}`,
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

/** `auditctl` — query / control the audit subsystem (status, rules). */
export function cmdAuditctl(rules: LinuxAuditRules, args: string[]): string {
  if (args[0] === '-s' || args[0] === '--status') return rules.status();
  if (args[0] === '-l' || args[0] === '--list') return rules.list();
  if (args[0] === '-D' || args[0] === '--delete-all') { rules.deleteAll(); return 'No rules'; }

  if (args[0] === '-e') {
    const v = parseInt(args[1] ?? '', 10);
    if (v !== 0 && v !== 1) return 'auditctl: invalid enable value';
    rules.setEnabled(v);
    return `enabled ${v}`;
  }

  // -w <path> -p <perms> -k <key>   (add)  /  -W ... (remove)
  if (args[0] === '-w' || args[0] === '-W') {
    const path = args[1];
    if (!path) return 'auditctl: watch path required';
    let perms = 'wa';
    let key: string | undefined;
    for (let i = 2; i < args.length; i++) {
      if (args[i] === '-p') perms = args[++i] ?? perms;
      else if (args[i] === '-k') key = args[++i];
    }
    if (args[0] === '-W') { rules.removeWatch(path); return ''; }
    const err = rules.addWatch(path, perms, key);
    return err ?? '';
  }

  // -a <action,filter> -S <syscall> -k <key>   (syscall rule)
  if (args[0] === '-a' || args[0] === '-A') {
    const spec = (args[1] ?? '').split(',');
    const action = spec[0] ?? 'always';
    const filter = spec[1] ?? 'exit';
    const syscalls: string[] = [];
    let key: string | undefined;
    for (let i = 2; i < args.length; i++) {
      if (args[i] === '-S') syscalls.push(args[++i]);
      else if (args[i] === '-k') key = args[++i];
    }
    if (syscalls.length === 0) return 'auditctl: syscall (-S) required';
    rules.addSyscallRule({ action, filter, syscalls, key });
    return '';
  }

  return 'usage: auditctl [options]';
}
