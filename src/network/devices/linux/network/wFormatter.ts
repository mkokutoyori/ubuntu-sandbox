import type { SshSessionTable } from './SshSessionTable';
import type { SshSession } from './SshSession';
import type { UtmpSync, UtmpRecord } from './UtmpSync';
import { uptimeHeader } from '../system/SystemInfo';

export interface WOptions {
  noHeader: boolean;
  short: boolean;
  from: boolean;
  ip: boolean;
  oldStyle: boolean;
  help: boolean;
  version: boolean;
}

const SHORT_FLAGS: Record<string, keyof WOptions> = {
  h: 'noHeader', s: 'short', f: 'from', i: 'ip', o: 'oldStyle',
  u: 'oldStyle',
};

const LONG_FLAGS: Record<string, keyof WOptions> = {
  'no-header': 'noHeader', short: 'short', from: 'from',
  'ip-addr': 'ip', 'old-style': 'oldStyle',
  help: 'help', version: 'version',
};

export interface ParsedWArgs {
  opts: WOptions;
  user: string | null;
  error: string | null;
}

function empty(): WOptions {
  return {
    noHeader: false, short: false, from: true, ip: false, oldStyle: false,
    help: false, version: false,
  };
}

export function parseWArgs(args: string[]): ParsedWArgs {
  const opts = empty();
  let user: string | null = null;
  let fromToggled = false;
  for (const a of args) {
    if (a === '--') continue;
    if (a.startsWith('--')) {
      const name = a.slice(2);
      if (!(name in LONG_FLAGS)) {
        return { opts, user: null, error: `w: unrecognized option '${a}'` };
      }
      const key = LONG_FLAGS[name];
      if (key === 'from') { opts.from = !opts.from; fromToggled = true; }
      else opts[key] = true;
      continue;
    }
    if (a.startsWith('-') && a.length > 1) {
      for (const ch of a.slice(1)) {
        if (!(ch in SHORT_FLAGS)) {
          return { opts, user: null, error: `w: invalid option -- '${ch}'` };
        }
        const key = SHORT_FLAGS[ch];
        if (key === 'from') { opts.from = !opts.from; fromToggled = true; }
        else opts[key] = true;
      }
      continue;
    }
    if (!user) user = a;
  }
  void fromToggled;
  return { opts, user, error: null };
}

export interface WContext {
  table: SshSessionTable;
  utmp: UtmpSync | null;
  uptimeSeconds: number;
  now: Date;
}

function activeSessions(ctx: WContext): SshSession[] {
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

function pad(s: string, w: number): string { return s.padEnd(w); }

function fmtLogin(d: Date): string {
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function fmtIdle(last: Date, now: Date): string {
  const diff = Math.max(0, Math.floor((now.getTime() - last.getTime()) / 1000));
  if (diff < 60) return `${diff}.00s`;
  const mins = Math.floor(diff / 60);
  if (mins < 60) return `${mins}:${String(diff % 60).padStart(2, '0')}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}:${String(mins % 60).padStart(2, '0')}`;
  const days = Math.floor(hours / 24);
  return `${days}days`;
}

function renderHeader(opts: WOptions): string {
  const cols: string[] = ['USER', 'TTY'];
  if (opts.from) cols.push('FROM');
  if (!opts.short) cols.push('LOGIN@');
  cols.push('IDLE');
  if (!opts.short) cols.push('JCPU', 'PCPU');
  cols.push('WHAT');
  const widths: Record<string, number> = {
    USER: 8, TTY: 8, FROM: 16, 'LOGIN@': 8, IDLE: 6, JCPU: 6, PCPU: 6,
  };
  return cols.map((c) => widths[c] ? pad(c, widths[c]) : c).join(' ');
}

function renderRow(s: SshSession, opts: WOptions): string {
  const cols: string[] = [pad(s.user, 8), pad(s.tty, 8)];
  if (opts.from) cols.push(pad(s.fromIp, 16));
  if (!opts.short) cols.push(pad(fmtLogin(s.loginAt), 8));
  const last = s.lastActivityAt ?? s.loginAt;
  cols.push(pad(fmtIdle(last, new Date()), 6));
  if (!opts.short) {
    cols.push(pad('0.00s', 6));
    cols.push(pad('0.00s', 6));
  }
  cols.push('-bash');
  return cols.join(' ');
}

export function renderW(ctx: WContext, args: string[]): string {
  const { opts, user, error } = parseWArgs(args);
  if (error) return `${error}\nUsage:\n w [options] [user]`;
  if (opts.help) return helpText();
  if (opts.version) return versionText();

  const all = activeSessions(ctx);
  const sessions = all.filter((s) => user === null || s.user === user);

  const lines: string[] = [];
  if (!opts.noHeader) {
    const header = uptimeHeader(all.length, ctx.uptimeSeconds);
    lines.push(header);
    lines.push(renderHeader(opts));
  }
  for (const s of sessions) lines.push(renderRow(s, opts));
  return lines.join('\n');
}

function helpText(): string {
  return [
    'Usage:',
    ' w [options] [user]',
    '',
    'Options:',
    ' -h, --no-header     do not print header',
    ' -u, --no-current    ignore current process username',
    ' -s, --short         short format',
    ' -f, --from          show remote hostname field',
    ' -o, --old-style     old style output',
    ' -i, --ip-addr       display IP address instead of hostname (if possible)',
    '',
    '     --help     display this help and exit',
    ' -V, --version  output version information and exit',
    '',
    'For more details see w(1).',
  ].join('\n');
}

function versionText(): string {
  return 'w from procps-ng 3.3.17';
}
