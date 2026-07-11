/**
 * User/group management commands: useradd, usermod, userdel, passwd, chpasswd,
 * chage, groupadd, groupmod, groupdel, gpasswd, id, whoami, groups, who, w, last, getent, sudo
 */

import { ShellContext } from './LinuxFileCommands';
import { parseUseraddArgs } from './iam/useraddOptions';

export function cmdUseradd(ctx: ShellContext, args: string[]): string {
  const req = parseUseraddArgs(args);
  if (!req.username) return 'useradd: missing username';

  return ctx.userMgr.useradd(req.username, {
    m: req.createHome,
    M: req.noCreateHome,
    s: req.shell,
    G: req.supplementaryGroups.length > 0 ? req.supplementaryGroups.join(',') : undefined,
    d: req.home,
    g: req.primaryGroup,
    c: req.comment,
    u: req.uid,
    o: req.nonUnique,
    r: req.systemAccount,
    N: req.noUserGroup,
    p: req.passwordHash,
    e: parseExpireDays(req.expireDate),
    f: req.inactiveDays,
  });
}

/** Convert a `useradd -e` date string (YYYY-MM-DD) to days since the epoch. */
function parseExpireDays(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return undefined;
  return Math.floor(ms / 86_400_000);
}

export function cmdUsermod(ctx: ShellContext, args: string[]): string {
  let s: string | undefined, d: string | undefined, m = false;
  let aG: string | undefined, L = false, U = false;
  let username = '';

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '-s': case '--shell':   s = args[++i]; break;
      case '-d': case '--home':    d = args[++i]; break;
      case '-m': case '--move-home': m = true; break;
      case '-aG': aG = args[++i]; break;
      case '-G': case '--groups':  aG = args[++i]; break;
      case '-L': case '--lock':    L = true; break;
      case '-U': case '--unlock':  U = true; break;
      default:
        if (!args[i].startsWith('-')) username = args[i];
        break;
    }
  }

  if (!username) return 'usermod: missing username';
  return ctx.userMgr.usermod(username, { s, d, m, aG, L, U });
}

export function cmdUserdel(ctx: ShellContext, args: string[]): string {
  let removeHome = false;
  let username = '';

  for (const a of args) {
    if (a === '-r') { removeHome = true; continue; }
    if (!a.startsWith('-')) username = a;
  }

  if (!username) return 'userdel: missing username';
  return ctx.userMgr.userdel(username, removeHome);
}

/**
 * `passwd` — account-maintenance overloads (the password *change* itself is
 * driven by the interactive flow). Supports the status / lock / unlock /
 * expire / delete and aging flags a real `passwd` carries.
 */
export function cmdPasswd(ctx: ShellContext, args: string[]): string {
  if (args.length === 0) return '';

  let lock = false, unlock = false, expire = false, deletePw = false, status = false;
  let n: number | undefined, x: number | undefined, w: number | undefined;
  let username = '';

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '-S': case '--status': status = true; break;
      case '-l': case '--lock': lock = true; break;
      case '-u': case '--unlock': unlock = true; break;
      case '-e': case '--expire': expire = true; break;
      case '-d': case '--delete': deletePw = true; break;
      case '-n': case '--mindays': n = parseInt(args[++i], 10); break;
      case '-x': case '--maxdays': x = parseInt(args[++i], 10); break;
      case '-w': case '--warndays': w = parseInt(args[++i], 10); break;
      default:
        if (!args[i].startsWith('-')) username = args[i];
        break;
    }
  }

  // A bare `passwd` / `passwd <user>` is handled by the interactive flow.
  if (!lock && !unlock && !expire && !deletePw && !status &&
      n === undefined && x === undefined && w === undefined) {
    return '';
  }

  const target = username || ctx.userMgr.currentUser;
  if (status) return ctx.userMgr.passwdStatus(target);

  const messages: string[] = [];
  if (lock) push(messages, ctx.userMgr.usermod(target, { L: true }), `passwd: password expiry information changed.`);
  if (unlock) push(messages, ctx.userMgr.usermod(target, { U: true }), `passwd: password expiry information changed.`);
  if (expire) push(messages, ctx.userMgr.expirePassword(target), `passwd: password expiry information changed.`);
  if (deletePw) push(messages, ctx.userMgr.deletePassword(target), `passwd: password expiry information changed.`);
  if (n !== undefined || x !== undefined || w !== undefined) {
    push(messages, ctx.userMgr.chage(target, { m: n, M: x, W: w }), `passwd: password expiry information changed.`);
  }
  return messages.join('\n');
}

/** Collect a manager result: its error string, or the success line on ''. */
function push(into: string[], result: string, successLine: string): void {
  into.push(result === '' ? successLine : result);
}

export function cmdChpasswd(ctx: ShellContext, stdin: string): string {
  // Format: username:password
  const lines = stdin.split('\n').filter(l => l.includes(':'));
  for (const line of lines) {
    const [user, pass] = line.split(':');
    ctx.userMgr.setPassword(user.trim(), pass.trim());
  }
  return '';
}

/**
 * `faillock` — display or reset the `pam_faillock` consecutive-failure tally.
 *
 *   faillock                       show every account that has failures
 *   faillock --user LOGIN          show one account
 *   faillock --reset               clear the tally for every account
 *   faillock --user LOGIN --reset  clear the tally for one account
 */
export function cmdFaillock(ctx: ShellContext, args: string[]): string {
  let user: string | undefined;
  let reset = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--user' || args[i] === '-u') { user = args[++i]; continue; }
    if (args[i] === '--reset') { reset = true; continue; }
  }

  if (reset) {
    if (user) return ctx.userMgr.resetFaillock(user);
    for (const report of ctx.userMgr.getFaillockReport()) {
      ctx.userMgr.resetFaillock(report.username);
    }
    return '';
  }

  const reports = ctx.userMgr.getFaillockReport(user);
  if (reports.length === 0) {
    return user ? `${user}:\nWhen                Type  Source                                           Valid` : '';
  }

  const blocks = reports.map((r) => {
    const header = `${r.username}:\nWhen                Type  Source                                           Valid`;
    const rows = Array.from({ length: r.failures }, () =>
      '                    TTY   localhost                                        V');
    const note = r.lockedOut ? '\n(account is locked — too many authentication failures)' : '';
    return [header, ...rows].join('\n') + note;
  });
  return blocks.join('\n\n');
}

/**
 * Parse a `chage` date argument. Accepts a `YYYY-MM-DD` calendar date, a plain
 * day count (days since the epoch), or `-1` / `''` meaning "disabled" — all
 * resolved to the shadow-file day unit.
 */
export function parseChageDate(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed === '-1') return -1;
  if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  const ms = Date.parse(trimmed);
  if (Number.isNaN(ms)) return undefined;
  return Math.floor(ms / 86_400_000);
}

export function cmdGroupadd(ctx: ShellContext, args: string[]): string {
  let gid: number | undefined;
  let name = '';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-g') { gid = parseInt(args[++i], 10); continue; }
    if (!args[i].startsWith('-')) name = args[i];
  }

  if (!name) return 'groupadd: missing group name';
  return ctx.userMgr.groupadd(name, { g: gid });
}

export function cmdGroupmod(ctx: ShellContext, args: string[]): string {
  let g: number | undefined, n: string | undefined;
  let name = '';

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '-g': g = parseInt(args[++i], 10); break;
      case '-n': n = args[++i]; break;
      default:
        if (!args[i].startsWith('-')) name = args[i];
        break;
    }
  }

  if (!name) return 'groupmod: missing group name';
  return ctx.userMgr.groupmod(name, { g, n });
}

export function cmdGroupdel(ctx: ShellContext, args: string[]): string {
  const name = args.find(a => !a.startsWith('-'));
  if (!name) return 'groupdel: missing group name';
  return ctx.userMgr.groupdel(name);
}

export function cmdGpasswd(ctx: ShellContext, args: string[]): string {
  return ctx.userMgr.gpasswd(args);
}


export function cmdWho(ctx: ShellContext): string {
  return ctx.userMgr.who();
}

export function cmdW(ctx: ShellContext, uptimeSeconds = 0): string {
  return ctx.userMgr.w(uptimeSeconds);
}

export function cmdLast(ctx: ShellContext, args: string[]): string {
  return ctx.userMgr.last(args);
}

export function cmdLastb(ctx: ShellContext, args: string[]): string {
  return ctx.userMgr.lastb(args);
}

export function cmdSudoCheck(ctx: ShellContext, args: string[]): string {
  // sudo -l -U username
  if (args[0] === '-l' && args[1] === '-U' && args[2]) {
    return ctx.userMgr.sudoList(args[2]);
  }
  // sudo -u user cmd...
  // For our simulator, we just allow it
  return '';
}
