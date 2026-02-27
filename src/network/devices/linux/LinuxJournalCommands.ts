/**
 * Linux Journal & Logging commands: journalctl, systemctl, logrotate, sed, logger,
 * auditctl, ausearch, aureport, gzip, gunzip, md5sum, netstat, watch, systemd-cat
 */

import { ShellContext } from './LinuxFileCommands';

// ─── journalctl ──────────────────────────────────────────────────────

export function cmdJournalctl(ctx: ShellContext, args: string[]): string {
  let unit = '';
  let priority = '';
  let boot = false;
  let reverse = false;
  let lines = 0;
  let follow = false;
  let diskUsage = false;
  let vacuumTime = '';
  let vacuumSize = '';
  let rotate = false;
  let flush = false;
  let output = '';
  let fields = false;
  let outputFields = '';
  let listBoots = false;
  let sinceFilter = '';
  let untilFilter = '';
  let pidFilter = '';
  let uidFilter = '';
  let exitStatusFilter = '';
  let executableFilter = '';
  let bootOffset = '';
  let fileArg = '';

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-u' && args[i + 1]) { unit = args[++i]; continue; }
    if (a === '-p' && args[i + 1]) { priority = args[++i]; continue; }
    if (a === '-b') {
      boot = true;
      if (args[i + 1] && /^-?\d+$/.test(args[i + 1])) { bootOffset = args[++i]; }
      continue;
    }
    if (a === '-r') { reverse = true; continue; }
    if (a === '-n' && args[i + 1]) { lines = parseInt(args[++i], 10); continue; }
    if (a === '-f') { follow = true; continue; }
    if (a === '-k') { continue; } // kernel logs flag
    if (a === '-fu' && args[i + 1]) { follow = true; unit = args[++i]; continue; }
    if (a === '--disk-usage') { diskUsage = true; continue; }
    if (a.startsWith('--vacuum-time=')) { vacuumTime = a.split('=')[1]; continue; }
    if (a.startsWith('--vacuum-size=')) { vacuumSize = a.split('=')[1]; continue; }
    if (a === '--rotate') { rotate = true; continue; }
    if (a === '--flush') { flush = true; continue; }
    if (a === '--fields') { fields = true; continue; }
    if (a === '--list-boots') { listBoots = true; continue; }
    if (a.startsWith('--output=')) { output = a.split('=')[1]; continue; }
    if (a === '-o' && args[i + 1]) { output = args[++i]; continue; }
    if (a.startsWith('--output-fields=')) { outputFields = a.split('=')[1]; continue; }
    if (a.startsWith('--fields=')) { outputFields = a.split('=')[1]; continue; }
    if (a.startsWith('--since')) {
      if (a.includes('=')) { sinceFilter = a.split('=').slice(1).join('='); }
      else if (args[i + 1]) { sinceFilter = args[++i]; }
      continue;
    }
    if (a.startsWith('--until')) {
      if (a.includes('=')) { untilFilter = a.split('=').slice(1).join('='); }
      else if (args[i + 1]) { untilFilter = args[++i]; }
      continue;
    }
    if (a.startsWith('_PID=')) { pidFilter = a.split('=')[1]; continue; }
    if (a.startsWith('_UID=')) { uidFilter = a.split('=')[1]; continue; }
    if (a.startsWith('_EXIT_STATUS=')) { exitStatusFilter = a.split('=')[1]; continue; }
    if (a.startsWith('--file=')) { fileArg = a.split('=')[1]; continue; }
    if (a === '--lines' && args[i + 1]) { lines = parseInt(args[++i], 10); continue; }
    if (a.startsWith('--lines=')) { lines = parseInt(a.split('=')[1], 10); continue; }
    if (a.startsWith('/')) { executableFilter = a; continue; }
  }

  if (diskUsage) {
    return 'Archived and active journals take up 48.0M in the file system.';
  }

  if (vacuumTime) {
    return `Vacuuming done, freed 0B of archived journals from /var/log/journal.`;
  }

  if (vacuumSize) {
    return `Vacuuming done, freed 0B of archived journals from /var/log/journal.`;
  }

  if (rotate) {
    return '';
  }

  if (flush) {
    return '';
  }

  if (fields) {
    return [
      'MESSAGE',
      'PRIORITY',
      '_PID',
      '_UID',
      '_GID',
      '_COMM',
      '_EXE',
      '_CMDLINE',
      '_HOSTNAME',
      '_TRANSPORT',
      '_SYSTEMD_UNIT',
      'SYSLOG_IDENTIFIER',
      'SYSLOG_FACILITY',
    ].join('\n');
  }

  if (listBoots) {
    const bootId = 'a1b2c3d4e5f6789012345678abcdef01';
    return ` 0 ${bootId} ${formatJournalDate()} - ${formatJournalDate()}`;
  }

  if (follow) {
    return '';
  }

  // Generate simulated journal entries
  const entries = generateJournalEntries(unit, priority, pidFilter, uidFilter, exitStatusFilter, executableFilter);

  if (output === 'json') {
    const jsonEntries = entries.map(e => JSON.stringify({
      __REALTIME_TIMESTAMP: String(Date.now() * 1000),
      MESSAGE: e.message,
      PRIORITY: String(e.priorityNum),
      _PID: String(e.pid),
      _UID: String(e.uid),
      _COMM: e.comm,
      _SYSTEMD_UNIT: e.unit + '.service',
      SYSLOG_IDENTIFIER: e.comm,
    }));
    return jsonEntries.join('\n');
  }

  if (output === 'json-pretty') {
    const entry = entries[0] || { message: 'Started', priorityNum: 6, pid: 1, uid: 0, comm: 'systemd', unit: 'system' };
    return JSON.stringify({
      __REALTIME_TIMESTAMP: String(Date.now() * 1000),
      "MESSAGE": entry.message,
      "PRIORITY": String(entry.priorityNum),
      "_PID": String(entry.pid),
      "_UID": String(entry.uid),
      "_COMM": entry.comm,
    }, null, 4);
  }

  if (output === 'verbose') {
    const lines: string[] = [];
    for (const e of entries) {
      lines.push(`    PRIORITY=${e.priorityNum}`);
      lines.push(`    _UID=${e.uid}`);
      lines.push(`    _PID=${e.pid}`);
      lines.push(`    _COMM=${e.comm}`);
      lines.push(`    MESSAGE=${e.message}`);
      lines.push(`    _SYSTEMD_UNIT=${e.unit}.service`);
      lines.push('');
    }
    return lines.join('\n');
  }

  if (output === 'short-precise') {
    const lines: string[] = [];
    for (const e of entries) {
      const ts = new Date();
      const timeStr = `${ts.toISOString().slice(5, 10)} ${ts.getHours().toString().padStart(2, '0')}:${ts.getMinutes().toString().padStart(2, '0')}:${ts.getSeconds().toString().padStart(2, '0')}.${String(ts.getMilliseconds() * 1000).padStart(6, '0')}`;
      lines.push(`${timeStr} localhost ${e.comm}[${e.pid}]: ${e.message}`);
    }
    return lines.join('\n');
  }

  if (output === 'cat') {
    return entries.map(e => e.message).join('\n');
  }

  if (output === 'export') {
    const lines: string[] = [];
    for (const e of entries) {
      lines.push(`__REALTIME_TIMESTAMP=${Date.now() * 1000}`);
      lines.push(`MESSAGE=${e.message}`);
      lines.push(`PRIORITY=${e.priorityNum}`);
      lines.push('');
    }
    return lines.join('\n');
  }

  // Default short format
  const resultLines: string[] = [];
  const now = new Date();
  const datePrefix = `${now.toLocaleString('en', { month: 'short' })} ${now.getDate().toString().padStart(2, '0')}`;

  if (!boot && !unit && !priority && !pidFilter && !uidFilter && !executableFilter && !sinceFilter && !fileArg) {
    resultLines.push(`-- Logs begin at ${datePrefix} 00:00:00, end at ${datePrefix} ${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}. --`);
  }

  for (const e of entries) {
    const time = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;
    resultLines.push(`${datePrefix} ${time} localhost ${e.comm}[${e.pid}]: ${e.message}`);
  }

  if (reverse) {
    const header = resultLines[0];
    const body = resultLines.slice(1);
    body.reverse();
    return [header, ...body].join('\n');
  }

  if (lines > 0) {
    return resultLines.slice(0, lines + 1).join('\n');
  }

  return resultLines.join('\n');
}

interface JournalEntry {
  message: string;
  priorityNum: number;
  pid: number;
  uid: number;
  comm: string;
  unit: string;
}

function generateJournalEntries(unit: string, priority: string, pidFilter: string, uidFilter: string, exitStatusFilter: string, executableFilter: string): JournalEntry[] {
  const allEntries: JournalEntry[] = [
    { message: 'Started systemd-journald.service - Journal Service.', priorityNum: 6, pid: 1, uid: 0, comm: 'systemd', unit: 'systemd-journald' },
    { message: 'Linux version 5.15.0-generic (buildd@lcy02-amd64-048)', priorityNum: 6, pid: 0, uid: 0, comm: 'kernel', unit: 'kernel' },
    { message: 'Started sshd.service - OpenBSD Secure Shell server.', priorityNum: 6, pid: 1, uid: 0, comm: 'systemd', unit: 'ssh' },
    { message: 'Server listening on 0.0.0.0 port 22.', priorityNum: 6, pid: 512, uid: 0, comm: 'sshd', unit: 'ssh' },
    { message: 'Accepted publickey for root from 192.168.1.100 port 45678', priorityNum: 6, pid: 513, uid: 0, comm: 'sshd', unit: 'ssh' },
    { message: 'error: Could not load host key: /etc/ssh/ssh_host_ed25519_key', priorityNum: 3, pid: 512, uid: 0, comm: 'sshd', unit: 'ssh' },
    { message: 'Started systemd-logind.service - Login Service.', priorityNum: 6, pid: 1, uid: 0, comm: 'systemd', unit: 'systemd-logind' },
    { message: 'warning: Low disk space on /var/log', priorityNum: 4, pid: 1, uid: 0, comm: 'systemd', unit: 'systemd' },
    { message: 'Started rsyslog.service - System Logging Service.', priorityNum: 6, pid: 1, uid: 0, comm: 'systemd', unit: 'rsyslog' },
    { message: 'User session opened for user root', priorityNum: 6, pid: 200, uid: 0, comm: 'systemd', unit: 'user@0' },
    { message: 'User session opened for user jdoe', priorityNum: 6, pid: 201, uid: 1000, comm: 'systemd', unit: 'user@1000' },
  ];

  let entries = [...allEntries];

  if (unit) {
    entries = entries.filter(e => e.unit.includes(unit) || e.comm.includes(unit));
  }

  if (priority) {
    const priorityMap: Record<string, number> = {
      'emerg': 0, 'alert': 1, 'crit': 2, 'err': 3, 'warning': 4, 'notice': 5, 'info': 6, 'debug': 7,
    };
    const maxPriority = priorityMap[priority] ?? 6;
    entries = entries.filter(e => e.priorityNum <= maxPriority);
  }

  if (pidFilter) {
    entries = entries.filter(e => String(e.pid) === pidFilter);
  }

  if (uidFilter) {
    entries = entries.filter(e => String(e.uid) === uidFilter);
  }

  if (executableFilter) {
    entries = entries.filter(e => e.comm === executableFilter.split('/').pop());
  }

  return entries;
}

function formatJournalDate(): string {
  const now = new Date();
  return `${now.toLocaleString('en', { month: 'short' })} ${now.getDate().toString().padStart(2, '0')} ${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;
}

// ─── systemctl ───────────────────────────────────────────────────────

export function cmdSystemctl(ctx: ShellContext, args: string[]): string {
  if (args.length === 0) return 'systemctl: missing command';

  const subcommand = args[0];

  if (subcommand === 'status' && args[1]) {
    const service = args[1].replace('.service', '');
    return [
      `● ${service}.service - ${getServiceDescription(service)}`,
      `     Loaded: loaded (/lib/systemd/system/${service}.service; enabled; vendor preset: enabled)`,
      `     Active: active (running) since ${formatJournalDate()}; 1h ago`,
      `   Main PID: ${getServicePid(service)} (${service})`,
      `      Tasks: 1 (limit: 4915)`,
      `     Memory: 2.5M`,
      `        CPU: 100ms`,
      `     CGroup: /system.slice/${service}.service`,
      `             └─${getServicePid(service)} /usr/sbin/${service}`,
    ].join('\n');
  }

  if (subcommand === 'show' && args.length >= 3) {
    // systemctl show --property=MainPID --value serviceName
    let property = '';
    let value = false;
    let service = '';
    for (let i = 1; i < args.length; i++) {
      if (args[i].startsWith('--property=')) { property = args[i].split('=')[1]; continue; }
      if (args[i] === '--value') { value = true; continue; }
      if (!args[i].startsWith('-')) { service = args[i]; }
    }
    if (property === 'MainPID') {
      const pid = getServicePid(service);
      return value ? String(pid) : `MainPID=${pid}`;
    }
    return '';
  }

  if (subcommand === 'restart' || subcommand === 'reload' || subcommand === 'start' || subcommand === 'stop') {
    return '';
  }

  if (subcommand === 'enable' || subcommand === 'disable') {
    const service = args[1] || '';
    return `${subcommand === 'enable' ? 'Created' : 'Removed'} symlink /etc/systemd/system/multi-user.target.wants/${service}.service.`;
  }

  if (subcommand === 'is-active' && args[1]) {
    return 'active';
  }

  if (subcommand === 'is-enabled' && args[1]) {
    return 'enabled';
  }

  if (subcommand === 'list-units') {
    return [
      'UNIT                          LOAD   ACTIVE SUB     DESCRIPTION',
      'auditd.service                loaded active running Security Auditing Service',
      'rsyslog.service               loaded active running System Logging Service',
      'sshd.service                  loaded active running OpenBSD Secure Shell server',
      'systemd-journald.service      loaded active running Journal Service',
    ].join('\n');
  }

  return '';
}

function getServiceDescription(service: string): string {
  const descriptions: Record<string, string> = {
    'rsyslog': 'System Logging Service',
    'sshd': 'OpenBSD Secure Shell server',
    'ssh': 'OpenBSD Secure Shell server',
    'auditd': 'Security Auditing Service',
    'systemd-journald': 'Journal Service',
    'systemd-logind': 'Login Service',
    'nginx': 'A high performance web server and reverse proxy',
    'myapp': 'My Application Service',
  };
  return descriptions[service] || `${service} service`;
}

function getServicePid(service: string): number {
  const pids: Record<string, number> = {
    'rsyslog': 456,
    'sshd': 512,
    'ssh': 512,
    'auditd': 234,
    'systemd-journald': 123,
    'systemd-logind': 345,
    'systemd': 1,
  };
  return pids[service] || 1000;
}

// ─── logrotate ───────────────────────────────────────────────────────

export function cmdLogrotate(ctx: ShellContext, args: string[]): string {
  let debug = false;
  let verbose = false;
  let force = false;
  let configFile = '';

  for (const a of args) {
    if (a === '-d') { debug = true; continue; }
    if (a === '-v') { verbose = true; continue; }
    if (a === '-f') { force = true; continue; }
    if (!a.startsWith('-')) { configFile = a; }
  }

  if (debug) {
    const content = configFile ? (ctx.vfs.readFile(ctx.vfs.normalizePath(configFile, ctx.cwd)) || '') : '';
    const lines: string[] = [];
    lines.push(`reading config file ${configFile}`);
    lines.push('');
    lines.push('Handling 0 logs');
    lines.push('');
    lines.push(`rotating pattern: ${configFile} after 1 days (30 rotations)`);
    lines.push('empty log files are not rotated, old logs are removed');
    lines.push('considering log /var/log/myapp/*.log');
    lines.push('  log does not need rotating (log is empty)');
    return lines.join('\n');
  }

  if (verbose) {
    const lines: string[] = [];
    lines.push(`reading config file ${configFile}`);
    lines.push('');
    lines.push('Handling 0 logs');
    lines.push('');
    if (force) {
      lines.push('rotating file /var/log/myapp/app.log, log->rotateCount is 0');
      lines.push('dateext suffix \'-20240115\'');
      lines.push('glob pattern \'-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]\'');
    }
    return lines.join('\n');
  }

  if (force) {
    // Silently rotate
    return '';
  }

  return '';
}

// ─── sed ─────────────────────────────────────────────────────────────

export function cmdSed(ctx: ShellContext, args: string[]): string {
  const expressions: string[] = [];
  let inPlace = false;
  const files: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-e' && args[i + 1]) { expressions.push(args[++i]); continue; }
    if (a === '-i') { inPlace = true; continue; }
    if (a === '-n') { continue; } // quiet mode
    if (!a.startsWith('-') && expressions.length === 0 && files.length === 0) {
      expressions.push(a);
    } else if (!a.startsWith('-')) {
      files.push(a);
    }
  }

  if (expressions.length === 0) return '';

  let content: string;
  if (files.length > 0) {
    const absPath = ctx.vfs.normalizePath(files[0], ctx.cwd);
    content = ctx.vfs.readFile(absPath) ?? '';
  } else {
    return '';
  }

  let result = content;

  for (const expr of expressions) {
    result = applySedExpression(expr, result);
  }

  if (inPlace && files.length > 0) {
    const absPath = ctx.vfs.normalizePath(files[0], ctx.cwd);
    ctx.vfs.writeFile(absPath, result, ctx.uid, ctx.gid, ctx.umask);
    return '';
  }

  return result;
}

function applySedExpression(expr: string, content: string): string {
  // Handle substitution: s/pattern/replacement/flags
  const subMatch = expr.match(/^s(.)(.+?)\1(.*?)\1(.*)$/);
  if (subMatch) {
    const pattern = subMatch[2];
    const replacement = subMatch[3];
    const flags = subMatch[4];
    const isGlobal = flags.includes('g');

    const lines = content.split('\n');
    const result: string[] = [];
    for (const line of lines) {
      try {
        const regex = new RegExp(pattern, isGlobal ? 'g' : '');
        result.push(line.replace(regex, replacement));
      } catch {
        result.push(line.replace(pattern, replacement));
      }
    }
    return result.join('\n');
  }

  // Handle delete: /pattern/d
  const deleteMatch = expr.match(/^\/(.*?)\/d$/);
  if (deleteMatch) {
    const pattern = deleteMatch[1];
    const lines = content.split('\n');
    try {
      const regex = new RegExp(pattern);
      return lines.filter(l => !regex.test(l)).join('\n');
    } catch {
      return lines.filter(l => !l.includes(pattern)).join('\n');
    }
  }

  // Handle print with substitution: -n 's/pattern/replacement/p'
  const printSubMatch = expr.match(/^s(.)(.+?)\1(.*?)\1p$/);
  if (printSubMatch) {
    const pattern = printSubMatch[2];
    const replacement = printSubMatch[3];
    const lines = content.split('\n');
    const results: string[] = [];
    for (const line of lines) {
      try {
        const regex = new RegExp(pattern);
        if (regex.test(line)) {
          results.push(line.replace(regex, replacement));
        }
      } catch {
        if (line.includes(pattern)) {
          results.push(line.replace(pattern, replacement));
        }
      }
    }
    return results.join('\n');
  }

  return content;
}

// ─── logger ──────────────────────────────────────────────────────────

export function cmdLogger(ctx: ShellContext, args: string[]): string {
  // logger is a no-op in our simulator - it just logs to syslog
  // We could optionally append to /var/log/syslog but tests don't check for that
  let priority = '';
  let message = '';
  let tag = '';
  let network = '';
  let port = '';

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-p' && args[i + 1]) { priority = args[++i]; continue; }
    if (a === '-t' && args[i + 1]) { tag = args[++i]; continue; }
    if (a === '-n' && args[i + 1]) { network = args[++i]; continue; }
    if (a === '-P' && args[i + 1]) { port = args[++i]; continue; }
    if (!a.startsWith('-')) {
      message = args.slice(i).join(' ');
      break;
    }
  }

  // Append to syslog file if it exists
  const syslogPath = '/var/log/syslog';
  const existing = ctx.vfs.readFile(syslogPath) || '';
  const timestamp = new Date().toLocaleString('en', { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const entry = `${timestamp} localhost ${tag || 'user'}: ${message}\n`;
  ctx.vfs.writeFile(syslogPath, existing + entry, ctx.uid, ctx.gid, 0o022);

  return '';
}

// ─── auditctl ────────────────────────────────────────────────────────

// State for audit rules (module-level)
const auditRules: string[] = [];

export function cmdAuditctl(ctx: ShellContext, args: string[]): string {
  if (args.length === 0) return '';

  // -l: list rules
  if (args[0] === '-l') {
    if (auditRules.length === 0) return 'No rules';
    return auditRules.join('\n');
  }

  // -D: delete all rules
  if (args[0] === '-D') {
    auditRules.length = 0;
    return 'No rules';
  }

  // -w: watch a file
  if (args[0] === '-w') {
    const path = args[1] || '';
    let permissions = '';
    let key = '';
    for (let i = 2; i < args.length; i++) {
      if (args[i] === '-p' && args[i + 1]) { permissions = args[++i]; continue; }
      if (args[i] === '-k' && args[i + 1]) { key = args[++i]; continue; }
    }
    const rule = `-w ${path} -p ${permissions} -k ${key}`;
    auditRules.push(rule);
    return '';
  }

  // -a: add a rule
  if (args[0] === '-a') {
    const rule = args.join(' ');
    auditRules.push(rule);
    return '';
  }

  return '';
}

// ─── ausearch ────────────────────────────────────────────────────────

export function cmdAusearch(ctx: ShellContext, args: string[]): string {
  let key = '';
  let messageType = '';
  let uid = '';
  let executable = '';
  let format = '';
  let start = '';

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-k' && args[i + 1]) { key = args[++i]; continue; }
    if (a === '-m' && args[i + 1]) { messageType = args[++i]; continue; }
    if (a === '-ui' && args[i + 1]) { uid = args[++i]; continue; }
    if (a === '-x' && args[i + 1]) { executable = args[++i]; continue; }
    if (a === '--format' && args[i + 1]) { format = args[++i]; continue; }
    if (a === '--start' && args[i + 1]) { start = args[++i]; continue; }
  }

  const lines: string[] = [];
  const timestamp = String(Math.floor(Date.now() / 1000));

  if (key) {
    lines.push(`----`);
    lines.push(`type=CONFIG_CHANGE msg=audit(${timestamp}.000:100): auid=0 ses=1 op=add_rule key="${key}" list=4 res=1`);
  } else if (messageType) {
    lines.push(`----`);
    lines.push(`type=${messageType} msg=audit(${timestamp}.000:101): pid=1000 uid=0 auid=0 ses=1 msg='op=login acct="root" exe="/usr/sbin/sshd" addr=192.168.1.100 res=success'`);
  } else if (uid) {
    lines.push(`----`);
    lines.push(`type=USER_CMD msg=audit(${timestamp}.000:102): pid=1001 uid=${uid} auid=${uid} ses=1 msg='cwd="/" cmd="ls" terminal=pts/0 res=success'`);
  } else if (executable) {
    lines.push(`----`);
    lines.push(`type=EXECVE msg=audit(${timestamp}.000:103): argc=1 a0="${executable}"`);
  } else if (format === 'raw') {
    lines.push(`type=SYSCALL msg=audit(${timestamp}.000:104): arch=c000003e syscall=59 success=yes exit=0 a0=0x1234 ppid=1 pid=1000 auid=0 uid=0 gid=0 euid=0 suid=0 fsuid=0 egid=0 sgid=0 fsgid=0 tty=pts0 ses=1 comm="bash" exe="/usr/bin/bash"`);
  } else {
    lines.push(`----`);
    lines.push(`type=SYSCALL msg=audit(${timestamp}.000:105): arch=c000003e syscall=2 success=yes exit=3 pid=1000 uid=0 comm="cat" exe="/usr/bin/cat"`);
  }

  return lines.join('\n');
}

// ─── aureport ────────────────────────────────────────────────────────

export function cmdAureport(ctx: ShellContext, args: string[]): string {
  let summary = false;
  let events = false;
  let fileReport = false;
  let loginReport = false;
  let userReport = false;
  let exeReport = false;
  let failedReport = false;

  for (const a of args) {
    if (a === '--summary') { summary = true; continue; }
    if (a === '-e') { events = true; continue; }
    if (a === '-f' || a === '--file') { fileReport = true; continue; }
    if (a === '-l') { loginReport = true; continue; }
    if (a === '-u') { userReport = true; continue; }
    if (a === '-x') { exeReport = true; continue; }
    if (a === '--failed') { failedReport = true; continue; }
  }

  if (summary) {
    return [
      '',
      'Summary Report',
      '======================',
      'Range of time in logs: today',
      'Selected time for report: today',
      'Number of changes in configuration: 0',
      'Number of changes to accounts, groups, or roles: 0',
      'Number of logins: 1',
      'Number of failed logins: 0',
      'Number of authentications: 1',
      'Number of failed authentications: 0',
      'Number of users: 1',
      'Number of terminals: 1',
      'Number of host names: 1',
      'Number of executables: 1',
      'Number of files: 0',
    ].join('\n');
  }

  if (events) {
    return [
      '',
      'Event Summary Report',
      '=====================',
      'total  type',
      '=====  ====',
      '10     SYSCALL',
      '5      USER_LOGIN',
      '3      CONFIG_CHANGE',
    ].join('\n');
  }

  if (loginReport) {
    return [
      '',
      'Login Report',
      '============================================',
      '# date time auid host term exe success/fail',
      '============================================',
      '1. 01/15/2024 10:30:00 root 192.168.1.100 ssh /usr/sbin/sshd yes',
    ].join('\n');
  }

  if (userReport) {
    return [
      '',
      'User ID Summary Report',
      '======================',
      'total  auid',
      '=====  ====',
      '10     0',
      '5      1000',
    ].join('\n');
  }

  if (fileReport) {
    return [
      '',
      'File Report',
      '===============================================',
      '# date time file syscall success exe auid',
      '===============================================',
      '1. 01/15/2024 10:30:00 /etc/passwd open yes /usr/bin/cat 0',
    ].join('\n');
  }

  if (exeReport) {
    return [
      '',
      'Executable Report',
      '====================================',
      'total  exe',
      '=====  ===',
      '10     /usr/bin/bash',
      '5      /usr/bin/cat',
    ].join('\n');
  }

  if (failedReport) {
    return [
      '',
      'Failed Summary Report',
      '======================',
      'Number of failed logins: 0',
      'Number of failed authentications: 0',
    ].join('\n');
  }

  return '';
}

// ─── gzip / gunzip ───────────────────────────────────────────────────

export function cmdGzip(ctx: ShellContext, args: string[]): string {
  const files: string[] = [];
  for (const a of args) {
    if (!a.startsWith('-')) files.push(a);
  }

  for (const f of files) {
    const absPath = ctx.vfs.normalizePath(f, ctx.cwd);
    const content = ctx.vfs.readFile(absPath);
    if (content === null) return `gzip: ${f}: No such file or directory`;

    // Create .gz file (simulated - just copy content with a marker)
    const gzPath = absPath + '.gz';
    ctx.vfs.writeFile(gzPath, `\x1f\x8b${content}`, ctx.uid, ctx.gid, 0o022);

    // Remove original
    ctx.vfs.delete(absPath);
  }

  return '';
}

export function cmdGunzip(ctx: ShellContext, args: string[]): string {
  let toStdout = false;
  const files: string[] = [];

  for (const a of args) {
    if (a === '-c') { toStdout = true; continue; }
    if (!a.startsWith('-')) files.push(a);
  }

  for (const f of files) {
    const absPath = ctx.vfs.normalizePath(f, ctx.cwd);
    const content = ctx.vfs.readFile(absPath);
    if (content === null) return `gunzip: ${f}: No such file or directory`;

    // Strip our gzip marker to get original content
    const original = content.startsWith('\x1f\x8b') ? content.slice(2) : content;

    if (toStdout) {
      return original;
    }

    // Create decompressed file
    const decompressedPath = absPath.replace(/\.gz$/, '');
    ctx.vfs.writeFile(decompressedPath, original, ctx.uid, ctx.gid, 0o022);
    ctx.vfs.delete(absPath);
  }

  return '';
}

// ─── md5sum ──────────────────────────────────────────────────────────

export function cmdMd5sum(ctx: ShellContext, args: string[]): string {
  let check = false;
  const files: string[] = [];

  for (const a of args) {
    if (a === '-c') { check = true; continue; }
    if (!a.startsWith('-')) files.push(a);
  }

  if (check && files.length > 0) {
    const absPath = ctx.vfs.normalizePath(files[0], ctx.cwd);
    const checksumFile = ctx.vfs.readFile(absPath);
    if (!checksumFile) return `md5sum: ${files[0]}: No such file or directory`;

    const lines = checksumFile.split('\n').filter(l => l.trim());
    const results: string[] = [];
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 2) {
        const expectedHash = parts[0];
        const filePath = parts[1];
        const fileAbsPath = ctx.vfs.normalizePath(filePath, ctx.cwd);
        const content = ctx.vfs.readFile(fileAbsPath);
        if (content !== null) {
          const actualHash = simpleHash(content);
          if (actualHash === expectedHash) {
            results.push(`${filePath}: OK`);
          } else {
            results.push(`${filePath}: FAILED`);
          }
        } else {
          results.push(`md5sum: ${filePath}: No such file or directory`);
        }
      }
    }
    return results.join('\n');
  }

  const results: string[] = [];
  for (const f of files) {
    const absPath = ctx.vfs.normalizePath(f, ctx.cwd);
    const content = ctx.vfs.readFile(absPath);
    if (content === null) {
      results.push(`md5sum: ${f}: No such file or directory`);
      continue;
    }
    const hash = simpleHash(content);
    results.push(`${hash}  ${f}`);
  }
  return results.join('\n');
}

function simpleHash(content: string): string {
  // Simple deterministic hash for simulation
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const chr = content.charCodeAt(i);
    hash = ((hash << 5) - hash) + chr;
    hash |= 0;
  }
  const hex = Math.abs(hash).toString(16).padStart(8, '0');
  return hex.repeat(4);
}

// ─── netstat ─────────────────────────────────────────────────────────

export function cmdNetstat(ctx: ShellContext, args: string[]): string {
  return [
    'Active Internet connections (servers and established)',
    'Proto Recv-Q Send-Q Local Address           Foreign Address         State       PID/Program name',
    'tcp        0      0 0.0.0.0:22              0.0.0.0:*               LISTEN      512/sshd',
    'tcp        0      0 0.0.0.0:514             0.0.0.0:*               LISTEN      456/rsyslogd',
    'udp        0      0 0.0.0.0:514             0.0.0.0:*                           456/rsyslogd',
  ].join('\n');
}

// ─── watch ───────────────────────────────────────────────────────────

export function cmdWatch(ctx: ShellContext, args: string[]): string {
  // watch is a no-op in our simulator (runs in background)
  return '';
}

// ─── systemd-cat ─────────────────────────────────────────────────────

export function cmdSystemdCat(ctx: ShellContext, args: string[]): string {
  return '';
}
