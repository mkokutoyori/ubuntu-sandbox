import type { SshSessionTable } from './SshSessionTable';
import type { SshSession } from './SshSession';
import type { UtmpSync, UtmpRecord } from './UtmpSync';

export interface LastOptions {
  limit: number | null;
  ip: boolean;
  fulltimes: boolean;
  hostlast: boolean;
  nohostname: boolean;
  showSystem: boolean;
  help: boolean;
  version: boolean;
}

const SHORT_FLAGS: Record<string, keyof LastOptions> = {
  i: 'ip', F: 'fulltimes', a: 'hostlast', R: 'nohostname',
  x: 'showSystem',
};

const LONG_FLAGS: Record<string, keyof LastOptions> = {
  ip: 'ip', fulltimes: 'fulltimes', hostlast: 'hostlast',
  nohostname: 'nohostname', system: 'showSystem',
  help: 'help', version: 'version',
};

export interface ParsedLastArgs {
  opts: LastOptions;
  filter: string | null;
  error: string | null;
}

function empty(): LastOptions {
  return {
    limit: null, ip: false, fulltimes: false, hostlast: false,
    nohostname: false, showSystem: false, help: false, version: false,
  };
}

export function parseLastArgs(args: string[]): ParsedLastArgs {
  const opts = empty();
  let filter: string | null = null;
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (a === '--') { i++; continue; }
    if (a === '-n' || a === '--limit') {
      const v = args[i + 1];
      const n = Number.parseInt(v ?? '', 10);
      if (Number.isFinite(n)) opts.limit = n;
      i += 2; continue;
    }
    if (a.startsWith('-') && /^-\d+$/.test(a)) {
      opts.limit = Number.parseInt(a.slice(1), 10);
      i++; continue;
    }
    if (a.startsWith('--')) {
      const name = a.slice(2);
      if (!(name in LONG_FLAGS)) {
        return { opts, filter: null, error: `last: unrecognized option '${a}'` };
      }
      opts[LONG_FLAGS[name]] = true as never;
      i++; continue;
    }
    if (a.startsWith('-') && a.length > 1) {
      for (const ch of a.slice(1)) {
        if (!(ch in SHORT_FLAGS)) {
          return { opts, filter: null, error: `last: invalid option -- '${ch}'` };
        }
        opts[SHORT_FLAGS[ch]] = true as never;
      }
      i++; continue;
    }
    if (!filter) filter = a;
    i++;
  }
  return { opts, filter, error: null };
}

export interface LastContext {
  table: SshSessionTable;
  utmp: UtmpSync | null;
  bootDate: Date | null;
  now: Date;
}

function readSessions(ctx: LastContext): SshSession[] {
  if (!ctx.utmp) return ctx.table.recent(10_000);
  const records = ctx.utmp.readWtmp();
  return records
    .filter((r) => r.user !== 'reboot')
    .map((r) => synthSession(r))
    .sort((a, b) => b.loginAt.getTime() - a.loginAt.getTime());
}

function synthSession(r: UtmpRecord): SshSession {
  return {
    user: r.user, tty: r.tty, fromIp: r.fromIp, fromHost: r.fromHost ?? '',
    loginAt: new Date(r.loginAt),
    closedAt: r.closedAt ? new Date(r.closedAt) : null,
    shellPid: r.shellPid ?? 0, sshdPid: 0,
    uid: r.uid ?? 0,
  } as unknown as SshSession;
}

function readRebootEntries(ctx: LastContext): Date[] {
  if (!ctx.utmp) return ctx.bootDate ? [ctx.bootDate] : [];
  return ctx.utmp.readWtmp()
    .filter((r) => r.user === 'reboot')
    .map((r) => new Date(r.loginAt))
    .sort((a, b) => b.getTime() - a.getTime());
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function fmtTimestamp(d: Date, full: boolean): string {
  const dow = DAYS[d.getDay()];
  const mon = MONTHS[d.getMonth()];
  const day = String(d.getDate()).padStart(2, ' ');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (full) {
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${dow} ${mon} ${day} ${hh}:${mm}:${ss} ${d.getFullYear()}`;
  }
  return `${dow} ${mon} ${day} ${hh}:${mm}`;
}

function fmtDuration(secs: number): string {
  if (secs < 60) return `(00:00)`;
  const days = Math.floor(secs / 86400);
  const hours = Math.floor((secs % 86400) / 3600);
  const minutes = Math.floor((secs % 3600) / 60);
  const hm = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  return days > 0 ? `(${days}+${hm})` : `(${hm})`;
}

function pad(s: string, w: number): string { return s.padEnd(w); }

function renderRow(s: SshSession, opts: LastOptions, now: Date): string {
  const cols: string[] = [pad(s.user, 8), pad(s.tty, 12)];
  if (!opts.nohostname) {
    cols.push(pad(s.fromIp, 16));
  }
  cols.push(fmtTimestamp(s.loginAt, opts.fulltimes));
  const closed = (s as unknown as { closedAt?: Date | null }).closedAt;
  if (closed) {
    const dur = Math.floor((closed.getTime() - s.loginAt.getTime()) / 1000);
    cols.push(`- ${String(closed.getHours()).padStart(2, '0')}:${String(closed.getMinutes()).padStart(2, '0')}`);
    cols.push(fmtDuration(dur));
  } else {
    cols.push('  still logged in');
  }
  return cols.join(' ');
}

function rebootRow(boot: Date, opts: LastOptions, now: Date): string {
  const cols: string[] = [pad('reboot', 8), pad('system boot', 12)];
  if (!opts.nohostname) cols.push(pad('5.15.0-91-generic', 16));
  cols.push(fmtTimestamp(boot, opts.fulltimes));
  const dur = Math.floor((now.getTime() - boot.getTime()) / 1000);
  cols.push('  still running');
  void dur;
  return cols.join(' ');
}

export function renderLast(ctx: LastContext, args: string[]): string {
  const { opts, filter, error } = parseLastArgs(args);
  if (error) return `${error}\nTry 'last --help' for more information.`;
  if (opts.help) return helpText();
  if (opts.version) return versionText();

  let sessions = readSessions(ctx);
  const reboots = readRebootEntries(ctx);
  if (filter && filter === 'reboot') {
    const lines: string[] = [];
    for (const r of reboots) lines.push(rebootRow(r, opts, ctx.now));
    lines.push('', wtmpFooter(ctx));
    return lines.join('\n');
  }
  if (filter) sessions = sessions.filter((s) => s.user === filter || s.tty === filter);

  const limit = opts.limit ?? 10_000;
  sessions = sessions.slice(0, limit);

  const lines: string[] = sessions.map((s) => renderRow(s, opts, ctx.now));
  if (!filter && reboots.length > 0) {
    if (limit === 10_000 || sessions.length < limit) {
      for (const r of reboots) lines.push(rebootRow(r, opts, ctx.now));
    }
  }
  lines.push('', wtmpFooter(ctx));
  return lines.join('\n');
}

function wtmpFooter(ctx: LastContext): string {
  let when: Date | null = null;
  if (ctx.utmp) {
    const recs = ctx.utmp.readWtmp();
    if (recs.length > 0) {
      const earliest = recs.reduce((m, r) => (r.loginAt < m ? r.loginAt : m), recs[0].loginAt);
      when = new Date(earliest);
    }
  }
  if (!when) when = ctx.bootDate ?? ctx.now;
  const dow = DAYS[when.getDay()];
  const mon = MONTHS[when.getMonth()];
  const day = String(when.getDate()).padStart(2, ' ');
  const hh = String(when.getHours()).padStart(2, '0');
  const mm = String(when.getMinutes()).padStart(2, '0');
  const ss = String(when.getSeconds()).padStart(2, '0');
  return `wtmp begins ${dow} ${mon} ${day} ${hh}:${mm}:${ss} ${when.getFullYear()}`;
}

function helpText(): string {
  return [
    'Usage:',
    ' last [options] [<username>...] [<tty>...]',
    '',
    'Show a listing of last logged in users.',
    '',
    'Options:',
    ' -<number>            how many lines to show',
    ' -a, --hostlast       display hostnames in the last column',
    ' -d, --dns            translate the IP number back into a hostname',
    ' -f, --file <file>    use a specific file instead of /var/log/wtmp',
    ' -F, --fulltimes      print full login and logout times and dates',
    ' -i, --ip             display IP numbers in numbers-and-dots notation',
    ' -n, --limit <number> how many lines to show',
    ' -p, --present <time> display who was present at the specified time',
    ' -R, --nohostname     do not display the hostname field',
    ' -s, --since <time>   display the lines since the specified time',
    ' -t, --until <time>   display the lines until the specified time',
    ' -w, --fullnames      display full user and domain names',
    ' -x, --system         display system shutdown entries and run level changes',
    ' --time-format <format> show timestamps in the specified <format>:',
    '                          notime|short|full|iso',
    '',
    ' -h, --help     display this help',
    ' -V, --version  display version',
    '',
    'For more details see last(1).',
  ].join('\n');
}

function versionText(): string {
  return 'last from util-linux 2.37.2';
}

export function renderLastb(ctx: LastContext, args: string[]): string {
  const { opts, filter, error } = parseLastArgs(args);
  if (error) return `${error.replace(/^last:/, 'lastb:')}\nTry 'lastb --help' for more information.`;
  if (opts.help) return helpText().replace(/last\b/g, 'lastb');
  if (opts.version) return 'lastb from util-linux 2.37.2';

  const records = ctx.utmp?.readBtmp() ?? [];
  let rows = records
    .map((r) => ({ user: r.user, tty: r.tty, fromIp: r.fromIp, at: r.at }))
    .sort((a, b) => b.at - a.at);
  if (filter) rows = rows.filter((r) => r.user === filter || r.tty === filter);
  const limit = opts.limit ?? 10_000;
  rows = rows.slice(0, limit);

  const lines: string[] = [];
  for (const r of rows) {
    const cols = [
      pad(r.user, 8),
      pad(r.tty, 12),
    ];
    if (!opts.nohostname) cols.push(pad(r.fromIp, 16));
    const at = new Date(r.at);
    cols.push(fmtTimestamp(at, opts.fulltimes));
    cols.push(`- ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')} (00:00)`);
    lines.push(cols.join(' '));
  }
  lines.push('', btmpFooter(ctx));
  return lines.join('\n');
}

function btmpFooter(ctx: LastContext): string {
  let when: Date | null = null;
  if (ctx.utmp) {
    const recs = ctx.utmp.readBtmp();
    if (recs.length > 0) {
      const earliest = recs.reduce((m, r) => (r.at < m ? r.at : m), recs[0].at);
      when = new Date(earliest);
    }
  }
  if (!when) when = ctx.bootDate ?? ctx.now;
  const dow = DAYS[when.getDay()];
  const mon = MONTHS[when.getMonth()];
  const day = String(when.getDate()).padStart(2, ' ');
  const hh = String(when.getHours()).padStart(2, '0');
  const mm = String(when.getMinutes()).padStart(2, '0');
  const ss = String(when.getSeconds()).padStart(2, '0');
  return `btmp begins ${dow} ${mon} ${day} ${hh}:${mm}:${ss} ${when.getFullYear()}`;
}
