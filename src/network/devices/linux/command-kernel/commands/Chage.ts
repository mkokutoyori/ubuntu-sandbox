import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { parseChageDate } from '@/network/devices/linux/LinuxUserCommands';
import { PASSWORD_NEVER_EXPIRES } from '@/network/devices/linux/iam/policy/PasswordAgingPolicy';

const ROOT = new DefaultPrivilegePolicy(PrivilegeLevel.ROOT);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function fmtDate(days: number): string {
  const d = new Date(days * 86400000);
  return `${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, '0')}, ${d.getUTCFullYear()}`;
}

/**
 * `chage [options] LOGIN` — vieillissement du mot de passe. `-l` affiche le
 * rapport (lecture pure via `machine.passwordAging.get`) ; sinon positionne
 * les champs (mutation via `machine.passwordAging.set`, partagée avec le
 * legacy `LinuxUserManager.chage`).
 */
export class ChageCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'chage',
    summary: 'Affiche ou modifie le vieillissement du mot de passe',
    usage: 'chage [options] LOGIN',
    args: [
      { name: 'rest', type: 'string', required: false, variadic: true, description: '-M/-m/-W/-I/-d/-E/-l LOGIN' },
    ],
    options: [],
    privileges: ROOT,
    category: 'linux',
    lenientOptions: true,
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const args = ctx.args.get<string[] | undefined>('rest') ?? [];
    const oracle = ctx.machine.passwordAging!;

    let username: string | undefined;
    let M: number | undefined, m: number | undefined, W: number | undefined;
    let I: number | undefined, d: number | undefined, E: number | undefined;
    let list = false;

    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-M' || a === '--maxdays') { M = parseInt(args[++i], 10); continue; }
      if (a === '-m' || a === '--mindays') { m = parseInt(args[++i], 10); continue; }
      if (a === '-W' || a === '--warndays') { W = parseInt(args[++i], 10); continue; }
      if (a === '-I' || a === '--inactive') { I = parseInt(args[++i], 10); continue; }
      if (a === '-d' || a === '--lastday') { d = parseChageDate(args[++i]); continue; }
      if (a === '-E' || a === '--expiredate') { E = parseChageDate(args[++i]); continue; }
      if (a === '-l' || a === '--list') { list = true; continue; }
      if (!username) username = a;
    }

    if (!username) {
      await ctx.io.stdout.write('Usage: chage [options] LOGIN\n');
      return EXIT_OK;
    }

    if (list) {
      const user = oracle.get(username);
      if (!user) {
        await ctx.io.stdout.write(`chage: user '${username}' does not exist\n`);
        return EXIT_OK;
      }
      const neverExpires = user.maxDays >= PASSWORD_NEVER_EXPIRES || user.maxDays < 0;
      const mustChange = user.lastChange === 0;
      const lastChange = mustChange ? 'password must be changed' : fmtDate(user.lastChange);
      const passwordExpires = mustChange ? 'password must be changed'
        : neverExpires ? 'never' : fmtDate(user.lastChange + user.maxDays);
      const passwordInactive = mustChange ? 'password must be changed'
        : (neverExpires || user.inactiveDays < 0) ? 'never' : fmtDate(user.lastChange + user.maxDays + user.inactiveDays);
      const accountExpires = user.expireDate < 0 ? 'never' : fmtDate(user.expireDate);

      await ctx.io.stdout.write([
        `Last password change\t\t\t\t\t: ${lastChange}`,
        `Password expires\t\t\t\t\t: ${passwordExpires}`,
        `Password inactive\t\t\t\t\t: ${passwordInactive}`,
        `Account expires\t\t\t\t\t\t: ${accountExpires}`,
        `Minimum number of days between password change\t\t: ${user.minDays}`,
        `Maximum number of days between password change\t\t: ${user.maxDays}`,
        `Number of days of warning before password expires\t: ${user.warnDays}`,
      ].join('\n') + '\n');
      return EXIT_OK;
    }

    if (oracle.get(username) === undefined) {
      await ctx.io.stdout.write(`chage: user '${username}' does not exist\n`);
      return EXIT_OK;
    }
    oracle.set(username, { maxDays: M, minDays: m, warnDays: W, lastChange: d, expireDate: E, inactiveDays: I });
    return EXIT_OK;
  }
}
