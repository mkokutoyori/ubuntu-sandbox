import type { LinuxAuditRules, AuditEnabled, AuditFailureMode } from './LinuxAuditRules';

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
