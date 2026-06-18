import type { LinuxAuditLog, AuditQuery } from './LinuxAuditLog';
import type { LinuxAuditRules, AuditEnabled, AuditFailureMode } from './LinuxAuditRules';

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

  const matched = auditLog.query(filter);
  if (matched.length === 0) return '<no matches>';
  const serials = new Set(matched.map((r) => r.serial));
  const events = auditLog.all().filter((r) => serials.has(r.serial));
  const groups = new Map<number, typeof events>();
  for (const r of events) {
    const list = groups.get(r.serial) ?? [];
    list.push(r);
    groups.set(r.serial, list);
  }
  return [...groups.values()]
    .map((recs) => recs.map((r) => r.render()).join('\n'))
    .join(`\n${EVENT_SEPARATOR}\n`);
}

export function cmdAureport(auditLog: LinuxAuditLog, args: string[]): string {
  if (args.includes('-l') || args.includes('--login')) {
    return ['Login Summary Report', '============================',
      'Number of logins: 0', 'Number of failed logins: 0'].join('\n');
  }
  if (args.includes('-x') || args.includes('--executable')) {
    const counts = new Map<string, number>();
    for (const r of auditLog.all()) {
      const exe = String(r.get('exe') ?? '');
      if (!exe) continue;
      counts.set(exe, (counts.get(exe) ?? 0) + 1);
    }
    const lines = ['Executable Summary Report', '================================='];
    if (counts.size === 0) lines.push('total  file', '0');
    else {
      lines.push('total  file');
      for (const [exe, n] of counts) lines.push(`${String(n).padStart(5)}  ${exe}`);
    }
    return lines.join('\n');
  }
  if (args.includes('-p') || args.includes('--pid')) {
    const counts = new Map<string, number>();
    for (const r of auditLog.all()) {
      const exe = String(r.get('exe') ?? '');
      if (!exe) continue;
      counts.set(exe, (counts.get(exe) ?? 0) + 1);
    }
    const lines = ['Process ID Summary Report', '================================='];
    for (const [exe, n] of counts) lines.push(`${String(n).padStart(5)}  ${exe}`);
    return lines.join('\n');
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

const AUDITCTL_VERSION = 'auditctl version 3.0.7';

const AUDITCTL_HELP = [
  'usage: auditctl [options]',
  '    -a <l,a>                    Append rule to end of <l>ist',
  '    -A <l,a>                    Prepend rule at start of <l>ist',
  '    -b <backlog>                Set max number of outstanding audit buffers',
  '    -d <l,a>                    Delete rule from <l>ist',
  '    -D                          Delete all rules and watches',
  '    -e [0|1|2]                  Set enabled flag (0=off, 1=on, 2=locked until reboot)',
  '    -f [0|1|2]                  Set failure mode (0=silent, 1=printk, 2=panic)',
  '    -F f=v                      Build rule: field name, operator(=,!=,<,>,<=,>=), value',
  '    -h                          Show this help',
  '    --help                      Show this help',
  '    -k <key>                    Set filter key on audit rule',
  '    -l                          List all rules',
  '    -p [r|w|x|a]                Set permissions filter on watch',
  '    -q                          Suppress informational messages',
  '    -r <rate>                   Set limit in messages/sec (0=none)',
  '    -R <file>                   Read rules from file',
  '    -s                          Report status',
  '    -S syscall                  Build rule: syscall name or number',
  '    -v                          Print version',
  '    -w <path>                   Insert watch at <path>',
  '    -W <path>                   Remove watch at <path>',
].join('\n');

export interface AuditctlOutcome {
  output: string;
  exitCode: number;
}

export function cmdAuditctl(rules: LinuxAuditRules, args: string[]): AuditctlOutcome {
  const argv = args.length === 1 && args[0].trim() === '' ? [] : args;
  if (argv.length === 0) return out('usage: auditctl [options]', 1);

  let i = 0;
  if (argv[0] === '-q') i++;

  if (i >= argv.length) return out('usage: auditctl [options]', 1);

  const head = argv[i];
  switch (head) {
    case '-h': case '--help':
      return out(AUDITCTL_HELP, 0);
    case '-v': case '--version':
      return out(AUDITCTL_VERSION, 0);
    case '-s': case '--status':
      if (argv.length - i > 1) return err('invalid: extra arguments after -s');
      return out(rules.status(), 0);
    case '-l': case '--list':
      if (argv.length - i > 1) return err('invalid: extra arguments after -l');
      return out(rules.list(), 0);
    case '-D': case '--delete-all': {
      const r = rules.deleteAll();
      if (!r.ok) return err(r.error!);
      return out('No rules\nNo rules deleted', 0);
    }
    case '-e': {
      const v = parseInt(argv[i + 1] ?? '', 10);
      if (!(v === 0 || v === 1 || v === 2)) return err('invalid enable value (must be 0, 1, or 2)');
      const r = rules.setEnabled(v as AuditEnabled);
      if (!r.ok) return err(r.error!);
      return out('', 0);
    }
    case '-f': {
      const v = parseInt(argv[i + 1] ?? '', 10);
      if (!(v === 0 || v === 1 || v === 2)) return err('invalid failure flag (must be 0, 1, or 2)');
      const r = rules.setFailure(v as AuditFailureMode);
      if (!r.ok) return err(r.error!);
      return out('', 0);
    }
    case '-b': {
      const raw = argv[i + 1];
      const n = parseInt(raw ?? '', 10);
      if (raw === undefined || !/^-?\d+$/.test(raw) || Number.isNaN(n)) return err('invalid: backlog value must be a non-negative integer');
      const r = rules.setBacklogLimit(n);
      if (!r.ok) return err(r.error!);
      return out('', 0);
    }
    case '-r': {
      const raw = argv[i + 1];
      const n = parseInt(raw ?? '', 10);
      if (raw === undefined || !/^-?\d+$/.test(raw) || Number.isNaN(n)) return err('invalid: rate value must be a non-negative integer');
      const r = rules.setRateLimit(n);
      if (!r.ok) return err(r.error!);
      return out('', 0);
    }
    case '-w': case '-W': {
      const path = argv[i + 1];
      if (!path || path.startsWith('-')) return err('invalid: missing path argument for watch');
      let perms: string | undefined;
      let key: string | undefined;
      for (let j = i + 2; j < argv.length; j++) {
        if (argv[j] === '-p') {
          perms = argv[++j];
          if (perms === undefined) return err("option '-p' invalid: missing argument for option");
        } else if (argv[j] === '-k') {
          key = argv[++j];
          if (key === undefined) return err("option '-k' invalid: missing argument for option");
        } else return err(`unrecognized argument ${argv[j]}`);
      }
      const r = head === '-w' ? rules.addWatch(path, perms, key) : rules.removeWatch(path, perms);
      if (!r.ok) return err(r.error!);
      return out('', 0);
    }
    case '-a': case '-A': case '-d': {
      const spec = (argv[i + 1] ?? '').split(',');
      if (spec.length !== 2) return err('invalid: rule spec must be <action,filter> (e.g. always,exit)');
      const [action, filter] = spec;
      const syscalls: string[] = [];
      const fields: string[] = [];
      let key: string | undefined;
      for (let j = i + 2; j < argv.length; j++) {
        if (argv[j] === '-S') {
          const v = argv[++j];
          if (v === undefined || v.startsWith('-')) return err("option '-S' invalid: missing argument for option");
          syscalls.push(v);
        } else if (argv[j] === '-F') {
          const v = argv[++j];
          if (v === undefined || v.startsWith('-')) return err("option '-F' invalid: missing argument for option");
          fields.push(v);
        } else if (argv[j] === '-k') {
          key = argv[++j];
          if (key === undefined) return err("option '-k' invalid: missing argument for option");
        } else return err(`unrecognized argument ${argv[j]}`);
      }
      const r = head === '-d'
        ? rules.deleteSyscallRule(action, filter, syscalls, fields, key)
        : rules.addSyscallRule(action, filter, syscalls, fields, key, head === '-A' ? 'prepend' : 'append');
      if (!r.ok) return err(r.error!);
      return out('', 0);
    }
    case '-R': {
      const file = argv[i + 1];
      if (!file) return err("option '-R' invalid: missing file argument");
      return err(`Unable to read ${file}: No such file or directory`);
    }
    default:
      return err(`unrecognized option '${head}'`);
  }
}

function out(output: string, exitCode: number): AuditctlOutcome {
  return { output, exitCode };
}

function err(message: string): AuditctlOutcome {
  return { output: `auditctl: ${message}`, exitCode: 1 };
}
