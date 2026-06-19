import type { LinuxAuditLog, AuditQuery } from './LinuxAuditLog';
import type { LinuxAuditRules, AuditEnabled, AuditFailureMode } from './LinuxAuditRules';

const EVENT_SEPARATOR = '----';

export function cmdAusearch(auditLog: LinuxAuditLog, args: string[]): string {
  const filter: AuditQuery = {};
  let interpret = false;
  let successFilter: 'yes' | 'no' | null = null;
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '-m': case '--message': filter.type = args[++i]; break;
      case '-ui': case '--uid': filter.key = 'uid'; filter.value = args[++i]; break;
      case '-ua': case '--loginuid': filter.key = 'auid'; filter.value = args[++i]; break;
      case '-u': case '--user': filter.key = 'uid'; filter.value = args[++i]; break;
      case '-x': case '--exe': filter.key = 'exe'; filter.value = args[++i]; break;
      case '-c': case '--comm': filter.key = 'comm'; filter.value = args[++i]; break;
      case '-k': case '--key': filter.key = 'key'; filter.value = args[++i]; break;
      case '-f': case '--file': filter.key = 'name'; filter.value = args[++i]; break;
      case '-i': case '--interpret': interpret = true; break;
      case '--success': {
        const v = (args[++i] ?? '').toLowerCase();
        successFilter = (v === 'yes' || v === 'no') ? v : null;
        filter.success = v === 'yes';
        break;
      }
      case '-ts': case '--start': case '-te': case '--end':
      case '-p': case '--pid': case '-b': case '--boot': i++; break;
    }
  }
  if (successFilter === null) delete filter.success;
  else filter.success = successFilter === 'yes';

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
    .map((recs) => recs.map((r) => interpret ? interpretRender(r) : r.render()).join('\n'))
    .join(`\n${EVENT_SEPARATOR}\n`);
}

function interpretRender(r: import('./LinuxAuditLog').LinuxAuditRecord): string {
  let text = r.render();
  const replacements: Array<[RegExp, string]> = [
    [/\b(uid|euid|auid|suid|fsuid|ouid)=0\b/g, '$1=root'],
    [/\b(gid|egid|sgid|fsgid|ogid)=0\b/g, '$1=root'],
    [/\b(uid|euid|auid|suid|fsuid|ouid)=1000\b/g, '$1=user'],
    [/\b(gid|egid|sgid|fsgid|ogid)=1000\b/g, '$1=user'],
  ];
  for (const [re, sub] of replacements) text = text.replace(re, sub);
  return text;
}

export function cmdAureport(auditLog: LinuxAuditLog, args: string[]): string {
  const interpret = args.includes('--interpret');

  for (const [flagShort, flagLong, fieldName, header] of AUREPORT_FIELD_REPORTS) {
    if (args.includes(flagShort) || args.includes(flagLong)) {
      return renderFieldSummary(auditLog, fieldName, header, interpret);
    }
  }

  if (args.includes('-l') || args.includes('--login')) {
    return ['Login Summary Report', '============================',
      'Number of logins: 0', 'Number of failed logins: 0'].join('\n');
  }
  if (args.includes('-a') || args.includes('--anomaly')) {
    return renderTypeSummary(auditLog, 'Anomaly Summary Report',
      ['ANOM_LOGIN_FAILURES', 'ANOM_ABEND', 'ANOM_PROMISCUOUS']);
  }
  if (args.includes('-e') || args.includes('--event')) {
    return renderTypeSummary(auditLog, 'Event Summary Report',
      [...auditLog.countByType().keys()]);
  }
  if (args.includes('-m') || args.includes('--mods')) {
    return renderTypeSummary(auditLog, 'MAC Summary Report',
      ['MAC_POLICY_LOAD', 'MAC_STATUS', 'MAC_CONFIG_CHANGE']);
  }
  if (args.includes('-i') || args.includes('--integrity')) {
    return ['Interpreter Summary Report', '=================================',
      'Number of integrity events: 0'].join('\n');
  }
  if (args.includes('-h') || args.includes('--host')) {
    return ['Host Summary Report', '============================', 'Number of hosts: 1', '    1  localhost'].join('\n');
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
        } else return err(`invalid: unrecognized argument ${argv[j]}`);
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
        } else return err(`invalid: unrecognized argument ${argv[j]}`);
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

type AureportField = [shortFlag: string, longFlag: string, fieldName: string, header: string];

const AUREPORT_FIELD_REPORTS: ReadonlyArray<AureportField> = [
  ['-x', '--executable', 'exe', 'Executable Summary Report'],
  ['-p', '--pid', 'exe', 'PID Summary Report'],
  ['-u', '--user', 'uid', 'User ID Summary Report'],
  ['-g', '--group', 'gid', 'Group ID Summary Report'],
  ['-f', '--file', 'name', 'File Summary Report'],
  ['-s', '--syscall', 'syscall', 'Syscall Summary Report'],
  ['-t', '--terminal', 'tty', 'Terminal Summary Report'],
  ['-k', '--key', 'key', 'Key Summary Report'],
];

function renderFieldSummary(
  auditLog: LinuxAuditLog,
  fieldName: string,
  header: string,
  interpret: boolean,
): string {
  const counts = new Map<string, number>();
  for (const r of auditLog.all()) {
    const v = r.get(fieldName);
    if (v === undefined) continue;
    const display = interpret ? interpretValue(fieldName, v) : String(v);
    counts.set(display, (counts.get(display) ?? 0) + 1);
  }
  const lines: string[] = [header, '================================='];
  if (counts.size === 0) {
    lines.push(`total  ${fieldName}`);
    lines.push('0');
    return lines.join('\n');
  }
  lines.push(`total  ${fieldName}`);
  for (const [v, n] of [...counts.entries()].sort()) {
    lines.push(`${String(n).padStart(5)}  ${v}`);
  }
  return lines.join('\n');
}

function renderTypeSummary(
  auditLog: LinuxAuditLog,
  header: string,
  types: string[],
): string {
  const counts = auditLog.countByType();
  const lines: string[] = [header, '================================='];
  let total = 0;
  for (const t of types) {
    const n = counts.get(t) ?? 0;
    if (n > 0) lines.push(`${String(n).padStart(5)}  ${t}`);
    total += n;
  }
  if (total === 0) lines.push('<no events of interest>');
  return lines.join('\n');
}

function interpretValue(fieldName: string, value: string | number): string {
  if (fieldName === 'uid' || fieldName === 'euid' || fieldName === 'auid' || fieldName === 'ouid') {
    const n = typeof value === 'number' ? value : parseInt(String(value), 10);
    if (n === 0) return 'root';
    if (n === 1000) return 'user';
    if (n === 65534) return 'nobody';
  }
  if (fieldName === 'gid' || fieldName === 'egid' || fieldName === 'ogid') {
    const n = typeof value === 'number' ? value : parseInt(String(value), 10);
    if (n === 0) return 'root';
    if (n === 1000) return 'user';
  }
  return String(value);
}
