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
      case '-s': s = args[++i]; break;
      case '-d': d = args[++i]; break;
      case '-m': m = true; break;
      case '-aG': aG = args[++i]; break;
      case '-L': L = true; break;
      case '-U': U = true; break;
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

export function cmdPasswd(ctx: ShellContext, args: string[]): string {
  if (args[0] === '-S' && args[1]) {
    return ctx.userMgr.passwdStatus(args[1]);
  }
  return '';
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

export function cmdChage(ctx: ShellContext, args: string[]): string {
  let M: number | undefined, m: number | undefined, W: number | undefined;
  let d: number | undefined, l = false;
  let username = '';

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '-M': M = parseInt(args[++i], 10); break;
      case '-m': m = parseInt(args[++i], 10); break;
      case '-W': W = parseInt(args[++i], 10); break;
      case '-d': d = parseInt(args[++i], 10); break;
      case '-l': l = true; break;
      default:
        if (!args[i].startsWith('-')) username = args[i];
        break;
    }
  }

  if (!username) return 'chage: missing username';
  return ctx.userMgr.chage(username, { M, m, W, d, l });
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

export function cmdId(ctx: ShellContext, args: string[]): string {
  const username = args.find(a => !a.startsWith('-'));
  const flags = args.filter(a => a.startsWith('-') && a !== '--');
  const letters = flags.join('').replace(/-/g, '');
  const opts = {
    u: letters.includes('u'),
    g: letters.includes('g'),
    G: letters.includes('G'),
    n: letters.includes('n'),
    r: letters.includes('r'),
  };
  if (!opts.u && !opts.g && !opts.G && !opts.n && !opts.r) {
    return ctx.userMgr.id(username);
  }
  return ctx.userMgr.idWithFlags(username, opts);
}

export function cmdWhoami(ctx: ShellContext): string {
  return ctx.userMgr.whoami();
}

export function cmdGroups(ctx: ShellContext, args: string[]): string {
  const username = args.find(a => !a.startsWith('-'));
  return ctx.userMgr.groupsCmd(username);
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

export function cmdGetent(ctx: ShellContext, args: string[]): string {
  if (args.length < 2) return 'Usage: getent database key';
  return ctx.userMgr.getent(args[0], args[1]);
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
