import type { SshSessionTable } from './SshSessionTable';
import type { SshSession } from './SshSession';
import type { UtmpSync, UtmpRecord } from './UtmpSync';

export interface WhoOptions {
  all: boolean;
  boot: boolean;
  count: boolean;
  heading: boolean;
  mine: boolean;
  runlevel: boolean;
  shortFmt: boolean;
  status: boolean;
  users: boolean;
  help: boolean;
  version: boolean;
}

export interface ParsedWhoArgs {
  opts: WhoOptions;
  error: { flag: string; message: string } | null;
}

const SHORT_FLAGS: Record<string, keyof WhoOptions> = {
  a: 'all', b: 'boot', q: 'count', H: 'heading', m: 'mine',
  r: 'runlevel', s: 'shortFmt', T: 'status', u: 'users',
  w: 'status', d: 'all', l: 'all', p: 'all', t: 'all',
};

const LONG_FLAGS: Record<string, keyof WhoOptions> = {
  all: 'all', boot: 'boot', count: 'count', heading: 'heading',
  runlevel: 'runlevel', short: 'shortFmt', mesg: 'status',
  users: 'users', help: 'help', version: 'version',
  message: 'status', writable: 'status', deadprocs: 'all',
  'login': 'all', process: 'all', 'time-since-system-boot': 'all',
};

function emptyOpts(): WhoOptions {
  return {
    all: false, boot: false, count: false, heading: false, mine: false,
    runlevel: false, shortFmt: false, status: false, users: false,
    help: false, version: false,
  };
}

export function parseWhoArgs(args: string[]): ParsedWhoArgs {
  const opts = emptyOpts();
  const positional: string[] = [];
  for (const a of args) {
    if (a === '--') continue;
    if (a.startsWith('--')) {
      const name = a.slice(2);
      if (!(name in LONG_FLAGS)) {
        return { opts, error: { flag: a, message: `who: unrecognized option '${a}'` } };
      }
      opts[LONG_FLAGS[name]] = true;
      continue;
    }
    if (a.startsWith('-') && a.length > 1) {
      for (const ch of a.slice(1)) {
        if (!(ch in SHORT_FLAGS)) {
          return { opts, error: { flag: ch, message: `who: invalid option -- '${ch}'` } };
        }
        opts[SHORT_FLAGS[ch]] = true;
      }
      continue;
    }
    positional.push(a);
  }
  if (positional.length === 2 && positional[0].toLowerCase() === 'am'
      && (positional[1].toLowerCase() === 'i' || positional[1].toLowerCase() === 'mom')) {
    opts.mine = true;
  }
  if (opts.all) {
    opts.boot = true; opts.runlevel = true; opts.status = true; opts.users = true;
  }
  return { opts, error: null };
}

export interface WhoContext {
  table: SshSessionTable;
  utmp: UtmpSync | null;
  currentUser: string;
  currentTty: string;
  bootDate: Date | null;
  now: Date;
}

function pad(s: string, w: number): string { return s.padEnd(w); }

function activeSessions(ctx: WhoContext): SshSession[] {
  if (!ctx.utmp) return ctx.table.list();
  const records = ctx.utmp.readUtmp();
  const byKey = new Map<string, SshSession>();
  for (const s of ctx.table.list()) byKey.set(`${s.tty}@${s.user}`, s);
  const out: SshSession[] = [];
  for (const r of records) {
    if (r.user === 'reboot') continue;
    const live = byKey.get(`${r.tty}@${r.user}`);
    if (live) { out.push(live); continue; }
    out.push(synthSession(r));
  }
  return out;
}

function synthSession(r: UtmpRecord): SshSession {
  return {
    user: r.user, tty: r.tty, fromIp: r.fromIp, fromHost: r.fromHost ?? '',
    loginAt: new Date(r.loginAt),
    lastActivityAt: new Date(r.loginAt),
    shellPid: r.shellPid ?? 0, sshdPid: 0,
    uid: r.uid ?? 0,
  } as unknown as SshSession;
}

function fmtDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${day} ${hh}:${mm}`;
}

function idleStr(lastActivity: Date, now: Date): string {
  const diffSec = Math.max(0, Math.floor((now.getTime() - lastActivity.getTime()) / 1000));
  if (diffSec < 60) return '.';
  const hours = Math.floor(diffSec / 3600);
  const minutes = Math.floor((diffSec % 3600) / 60);
  if (hours === 0) return `00:${String(minutes).padStart(2, '0')}`;
  if (hours < 24) return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function renderSession(s: SshSession, opts: WhoOptions, now: Date): string {
  const parts: string[] = [];
  parts.push(pad(s.user, 8));
  if (opts.status) parts.push(s.tty === 'tty1' ? '+' : '+');
  parts.push(pad(s.tty, 12));
  parts.push(fmtDate(s.loginAt));
  if (opts.users) {
    const last = s.lastActivityAt ?? s.loginAt;
    parts.push(pad(idleStr(last, now), 5));
    parts.push(pad(String(s.shellPid ?? s.sshdPid ?? 0), 5));
  }
  parts.push(`(${s.fromIp})`);
  return parts.join(' ');
}

function renderHeading(opts: WhoOptions): string {
  const parts: string[] = [];
  parts.push(pad('NAME', 8));
  if (opts.status) parts.push(' ');
  parts.push(pad('LINE', 12));
  parts.push(pad('TIME', 16));
  if (opts.users) {
    parts.push(pad('IDLE', 5));
    parts.push(pad('PID', 5));
  }
  parts.push('COMMENT');
  return parts.join(' ');
}

export function renderWho(ctx: WhoContext, args: string[]): string {
  const { opts, error } = parseWhoArgs(args);
  if (error) {
    return `${error.message}\nTry 'who --help' for more information.`;
  }
  if (opts.help) return helpText();
  if (opts.version) return versionText();

  const allSessions = activeSessions(ctx);
  let sessions = allSessions;
  if (opts.mine) {
    sessions = allSessions.filter((s) => s.user === ctx.currentUser
      && (s.tty === ctx.currentTty || s.tty === 'tty1'));
    if (sessions.length === 0 && allSessions.length > 0) {
      sessions = [allSessions.find((s) => s.user === ctx.currentUser) ?? allSessions[0]];
    }
    sessions = sessions.slice(0, 1);
  }

  if (opts.count) {
    const users = allSessions.map((s) => s.user);
    return `${users.join(' ')}\n# users=${users.length}`;
  }

  const showSessions = opts.all || opts.users || opts.heading || opts.shortFmt || opts.mine
    || opts.status || (!opts.boot && !opts.runlevel);

  const lines: string[] = [];
  if (opts.heading) lines.push(renderHeading(opts));
  if (opts.boot && ctx.bootDate) lines.push(`system boot  ${fmtDate(ctx.bootDate)}`);
  if (opts.runlevel && ctx.bootDate) lines.push(`   run-level 5  ${fmtDate(ctx.bootDate)}`);
  if (showSessions) {
    for (const s of sessions) lines.push(renderSession(s, opts, ctx.now));
  }
  return lines.join('\n');
}

function helpText(): string {
  return [
    'Usage: who [OPTION]... [ FILE | ARG1 ARG2 ]',
    'Print information about users who are currently logged in.',
    '',
    '  -a, --all         same as -b -d --login -p -r -t -T -u',
    '  -b, --boot        time of last system boot',
    '  -d, --dead        print dead processes',
    '  -H, --heading     print line of column headings',
    '  -l, --login       print system login processes',
    '      --lookup      attempt to canonicalize hostnames via DNS',
    '  -m                only hostname and user associated with stdin',
    '  -p, --process     print active processes spawned by init',
    '  -q, --count       all login names and number of users logged on',
    '  -r, --runlevel    print current runlevel',
    '  -s, --short       print only name, line, and time (default)',
    '  -t, --time        print last system clock change',
    '  -T, -w, --mesg    add user\'s message status as +, - or ?',
    '  -u, --users       list users logged in',
    '      --message     same as -T',
    '      --writable    same as -T',
    '      --help        display this help and exit',
    '      --version     output version information and exit',
    '',
    'If FILE is not specified, use /var/run/utmp.  /var/log/wtmp as FILE is common.',
    'If ARG1 ARG2 given, -m presumed: "am i" or "mom likes" are usual.',
  ].join('\n');
}

function versionText(): string {
  return [
    'who (GNU coreutils) 8.32',
    'Copyright (C) 2020 Free Software Foundation, Inc.',
    'License GPLv3+: GNU GPL version 3 or later <https://gnu.org/licenses/gpl.html>.',
    'This is free software: you are free to change and redistribute it.',
    'There is NO WARRANTY, to the extent permitted by law.',
    '',
    'Written by Joseph Arceneaux, David MacKenzie, and Michael Stone.',
  ].join('\n');
}
