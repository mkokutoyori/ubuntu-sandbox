import type { SshSessionTable } from './SshSessionTable';
import type { SshSession } from './SshSession';
import type { UtmpSync, UtmpRecord } from './UtmpSync';

export interface LoginctlContext {
  table: SshSessionTable;
  utmp: UtmpSync | null;
  bootDate: Date | null;
  now: Date;
}

function activeSessions(ctx: LoginctlContext): SshSession[] {
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
    shellPid: r.shellPid ?? 0, sshdPid: r.sshdPid ?? 0,
    uid: r.uid ?? 0,
  } as unknown as SshSession;
}

function pad(s: string, w: number): string { return s.padEnd(w); }
function padLeft(s: string, w: number): string { return s.padStart(w); }

function sessionId(s: SshSession, index: number): string {
  const pid = (s as { shellPid?: number }).shellPid ?? s.sshdPid ?? 0;
  if (pid > 0) return String(pid);
  return String(index + 1);
}

function seatOf(s: SshSession): string {
  return s.tty.startsWith('pts/') ? '' : 'seat0';
}

function classOf(s: SshSession): string {
  return s.tty.startsWith('pts/') ? 'user' : 'user';
}

function typeOf(s: SshSession): string {
  return s.tty.startsWith('pts/') ? 'tty' : 'tty';
}

function fmtTimestamp(d: Date): string {
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const dow = DAYS[d.getDay()];
  const y = d.getFullYear();
  const mon = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  void dow; void mon; void MONTHS;
  return `${DAYS[d.getDay()]} ${y}-${mon}-${day} ${hh}:${mm}:${ss} UTC`;
}

function renderListSessions(ctx: LoginctlContext): string {
  const sessions = activeSessions(ctx);
  const header = `${pad('SESSION', 10)} ${pad('UID', 6)} ${pad('USER', 16)} ${pad('SEAT', 8)} TTY`;
  const lines: string[] = [header];
  sessions.forEach((s, i) => {
    const sid = sessionId(s, i);
    lines.push([
      padLeft(sid, 10),
      padLeft(String(s.uid), 6),
      pad(s.user, 16),
      pad(seatOf(s), 8),
      s.tty,
    ].join(' '));
  });
  lines.push('');
  lines.push(`${sessions.length} sessions listed.`);
  return lines.join('\n');
}

function renderListUsers(ctx: LoginctlContext): string {
  const sessions = activeSessions(ctx);
  const byUser = new Map<string, SshSession>();
  for (const s of sessions) if (!byUser.has(s.user)) byUser.set(s.user, s);
  const lines: string[] = [`${pad('UID', 6)} ${pad('USER', 16)} ${pad('LINGER', 6)} STATE`];
  for (const [user, s] of byUser) {
    lines.push([
      padLeft(String(s.uid), 6),
      pad(user, 16),
      pad('no', 6),
      'active',
    ].join(' '));
  }
  lines.push('');
  lines.push(`${byUser.size} users listed.`);
  return lines.join('\n');
}

function renderShowSession(ctx: LoginctlContext, id: string): string {
  const sessions = activeSessions(ctx);
  const idx = sessions.findIndex((s, i) => sessionId(s, i) === id);
  if (idx < 0) {
    return `Failed to get session: No session '${id}' known`;
  }
  const s = sessions[idx];
  const sid = sessionId(s, idx);
  const leader = (s as { shellPid?: number }).shellPid ?? s.sshdPid ?? 0;
  const lines = [
    `Id=${sid}`,
    `User=${s.uid}`,
    `Name=${s.user}`,
    `Timestamp=${fmtTimestamp(s.loginAt)}`,
    `TimestampMonotonic=${s.loginAt.getTime() * 1000}`,
    `VTNr=0`,
    `Seat=${seatOf(s)}`,
    `TTY=${s.tty}`,
    `Remote=${s.fromIp && s.fromIp !== ':0' ? 'yes' : 'no'}`,
    `RemoteHost=${s.fromIp || ''}`,
    `Service=sshd`,
    `Scope=session-${sid}.scope`,
    `Leader=${leader}`,
    `Audit=${sid}`,
    `Type=${typeOf(s)}`,
    `Class=${classOf(s)}`,
    `Active=yes`,
    `State=active`,
    `IdleHint=no`,
    `IdleSinceHint=0`,
    `IdleSinceHintMonotonic=0`,
    `LockedHint=no`,
  ];
  return lines.join('\n');
}

function renderShowUser(ctx: LoginctlContext, id: string): string {
  const sessions = activeSessions(ctx);
  const match = sessions.find((s) => s.user === id || String(s.uid) === id);
  if (!match) {
    return `Failed to get user: No user '${id}' known`;
  }
  return [
    `UID=${match.uid}`,
    `GID=${match.uid}`,
    `Name=${match.user}`,
    `Timestamp=${fmtTimestamp(match.loginAt)}`,
    `RuntimePath=/run/user/${match.uid}`,
    `Service=user@${match.uid}.service`,
    `Slice=user-${match.uid}.slice`,
    `Display=`,
    `State=active`,
    `Sessions=${sessions.filter((s) => s.user === match.user).map((s, i) => sessionId(s, i)).join(' ')}`,
    `IdleHint=no`,
    `IdleSinceHint=0`,
    `IdleSinceHintMonotonic=0`,
    `Linger=no`,
  ].join('\n');
}

function helpText(): string {
  return [
    'loginctl [OPTIONS...] {COMMAND} ...',
    '',
    'Send control commands to or query the login manager.',
    '',
    'Session Commands:',
    '  list-sessions            List sessions',
    '  session-status [ID...]   Show session status',
    '  show-session [ID...]     Show properties of sessions or the manager',
    '  activate [ID]            Activate a session',
    '  lock-session [ID...]     Screen lock one or more sessions',
    '  unlock-session [ID...]   Screen unlock one or more sessions',
    '  lock-sessions            Screen lock all current sessions',
    '  unlock-sessions          Screen unlock all current sessions',
    '  terminate-session ID...  Terminate one or more sessions',
    '  kill-session ID...       Send signal to processes of a session',
    '',
    'User Commands:',
    '  list-users               List users',
    '  user-status [USER...]    Show user status',
    '  show-user [USER...]      Show properties of users or the manager',
    '  enable-linger [USER...]  Enable linger state of one or more users',
    '  disable-linger [USER...] Disable linger state of one or more users',
    '  terminate-user USER...   Terminate all sessions of one or more users',
    '  kill-user USER...        Send signal to processes of a user',
    '',
    'Seat Commands:',
    '  list-seats               List seats',
    '  seat-status [NAME...]    Show seat status',
    '  show-seat [NAME...]      Show properties of seats or the manager',
    '',
    'Options:',
    '  -h --help                Show this help',
    '     --version             Show package version',
    '     --no-pager            Do not pipe output into a pager',
    '     --no-legend           Do not show the headers and footers',
    '     --no-ask-password     Don\'t prompt for password',
    '  -H --host=[USER@]HOST    Operate on remote host',
    '  -M --machine=CONTAINER   Operate on local container',
    '  -p --property=NAME       Show only properties by this name',
    '  -P NAME                  Equivalent to --value --property=NAME',
    '  -a --all                 Show all properties, including empty ones',
    '     --value               When showing properties, only print the value',
    '  -l --full                Do not ellipsize output',
    '     --kill-whom=WHOM      Whom to send signal to',
    '  -s --signal=SIGNAL       Which signal to send',
    '  -n --lines=INTEGER       Number of journal entries to show',
    '  -o --output=STRING       Change journal output mode (short, short-precise,',
    '                             short-iso, short-iso-precise, short-full,',
    '                             short-monotonic, short-unix, verbose, export,',
    '                             json, json-pretty, json-sse, json-seq, cat,',
    '                             with-unit)',
    '',
    'See the loginctl(1) man page for details.',
  ].join('\n');
}

function versionText(): string {
  return 'systemd 249 (249.11-0ubuntu3.12)\n+PAM +AUDIT +SELINUX +APPARMOR +IMA +SMACK +SECCOMP +GCRYPT +GNUTLS +OPENSSL +ACL +BLKID +CURL +ELFUTILS +FIDO2 +IDN2 -IDN +IPTC +KMOD +LIBCRYPTSETUP +LIBFDISK +PCRE2 -PWQUALITY +P11KIT +QRENCODE +BZIP2 +LZ4 +XZ +ZLIB +ZSTD -XKBCOMMON +UTMP +SYSVINIT default-hierarchy=unified';
}

export function renderLoginctl(ctx: LoginctlContext, args: string[]): string {
  let noLegend = false;
  const positional: string[] = [];
  for (const a of args) {
    if (a === '--help' || a === '-h') return helpText();
    if (a === '--version') return versionText();
    if (a === '--no-legend') { noLegend = true; continue; }
    if (a === '--no-pager' || a === '--no-ask-password' || a === '-a' || a === '--all' || a === '--value') continue;
    if (a.startsWith('-')) continue;
    positional.push(a);
  }
  const cmd = positional[0];
  if (!cmd) {
    return renderListSessionsWithLegend(ctx, noLegend);
  }
  switch (cmd) {
    case 'list-sessions': return renderListSessionsWithLegend(ctx, noLegend);
    case 'list-users': return renderListUsersWithLegend(ctx, noLegend);
    case 'show-session': {
      const id = positional[1] ?? '';
      if (!id) return renderShowSession(ctx, firstSessionId(ctx));
      return renderShowSession(ctx, id);
    }
    case 'show-user': {
      const id = positional[1] ?? '';
      if (!id) return renderShowUser(ctx, firstUserName(ctx));
      return renderShowUser(ctx, id);
    }
    case 'session-status': {
      const id = positional[1] ?? firstSessionId(ctx);
      return renderShowSession(ctx, id);
    }
    case 'user-status': {
      const id = positional[1] ?? firstUserName(ctx);
      return renderShowUser(ctx, id);
    }
    case 'list-seats':
      return renderListSeats(noLegend);
    default:
      return `Unknown command verb '${cmd}'.`;
  }
}

function renderListSessionsWithLegend(ctx: LoginctlContext, noLegend: boolean): string {
  const out = renderListSessions(ctx);
  if (!noLegend) return out;
  const lines = out.split('\n');
  return lines.slice(1, lines.length - 2).join('\n');
}

function renderListUsersWithLegend(ctx: LoginctlContext, noLegend: boolean): string {
  const out = renderListUsers(ctx);
  if (!noLegend) return out;
  const lines = out.split('\n');
  return lines.slice(1, lines.length - 2).join('\n');
}

function renderListSeats(noLegend: boolean): string {
  if (noLegend) return 'seat0';
  return ['SEAT', 'seat0', '', '1 seats listed.'].join('\n');
}

function firstSessionId(ctx: LoginctlContext): string {
  const sessions = activeSessions(ctx);
  return sessions.length > 0 ? sessionId(sessions[0], 0) : '';
}

function firstUserName(ctx: LoginctlContext): string {
  const sessions = activeSessions(ctx);
  return sessions[0]?.user ?? '';
}
