import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

/**
 * `passwd [options] [LOGIN]` — la modification effective (forme nue) est
 * pilotée par le flux interactif du terminal ; cette commande couvre les
 * surcharges `-S`/`-l`/`-u`/`-e`/`-d`/`-n`/`-x`/`-w` ainsi que le stub de
 * la forme nue, à l'identique de `handlePasswd`/`cmdPasswd` legacy — y
 * compris la règle de privilège déclarative (`passwd USER` par un non-root
 * est refusé, même pour son propre nom).
 */
export class PasswdCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'passwd',
    summary: 'Affiche ou modifie le mot de passe et le vieillissement d\'un compte',
    usage: 'passwd [options] [LOGIN]',
    args: [
      { name: 'rest', type: 'string', required: false, variadic: true, description: '-S/-l/-u/-e/-d/-n/-x/-w [LOGIN]' },
    ],
    options: [],
    privileges: ANY,
    category: 'linux',
    lenientOptions: true,
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const args = ctx.args.get<string[] | undefined>('rest') ?? [];
    const users = ctx.machine.users;
    const aging = ctx.machine.passwordAging;

    if (args.length > 0 && !args[0].startsWith('-') && !ctx.session.user.isRoot()) {
      await ctx.io.stdout.write(`passwd: You may not view or modify password information for ${args[0]}.\n`);
      return 1;
    }

    const hasFlag = args.some((a) => a.startsWith('-'));
    if (!hasFlag) {
      if (args.length > 0 && !users.posixAccountStatus?.(args[0])) {
        await ctx.io.stdout.write(`passwd: user '${args[0]}' does not exist\n`);
        return 1;
      }
      await ctx.io.stdout.write('passwd: password updated successfully\n');
      return EXIT_OK;
    }

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

    if (!lock && !unlock && !expire && !deletePw && !status &&
        n === undefined && x === undefined && w === undefined) {
      return EXIT_OK;
    }

    const target = username || ctx.session.user.name;

    if (status) {
      const acct = users.posixAccountStatus?.(target);
      if (!acct) {
        await ctx.io.stdout.write(`passwd: user '${target}' does not exist\n`);
        return 1;
      }
      const record = aging?.get(target);
      const st = acct.locked ? 'L' : (acct.hasPassword ? 'P' : 'NP');
      const lastChange = new Date((record?.lastChange ?? 0) * 86400000)
        .toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
      await ctx.io.stdout.write(
        `${target} ${st} ${lastChange} ${record?.minDays ?? 0} ${record?.maxDays ?? 0} ${record?.warnDays ?? 0} ${record?.inactiveDays ?? 0}\n`,
      );
      return EXIT_OK;
    }

    const messages: string[] = [];
    const push = (result: string, successLine: string): void => {
      messages.push(result === '' ? successLine : result);
    };

    if (lock) push(users.posixUsermod?.(target, { lock: true }) ?? '', 'passwd: password expiry information changed.');
    if (unlock) push(users.posixUsermod?.(target, { unlock: true }) ?? '', 'passwd: password expiry information changed.');
    if (expire) push(users.posixExpirePassword?.(target) ?? '', 'passwd: password expiry information changed.');
    if (deletePw) push(users.posixDeletePassword?.(target) ?? '', 'passwd: password expiry information changed.');
    if (n !== undefined || x !== undefined || w !== undefined) {
      if (!aging?.get(target)) {
        messages.push(`chage: user '${target}' does not exist`);
      } else {
        aging.set(target, { minDays: n, maxDays: x, warnDays: w });
        messages.push('passwd: password expiry information changed.');
      }
    }

    const output = messages.join('\n');
    const exitCode = output.includes('does not exist') ? 1 : 0;
    if (output) await ctx.io.stdout.write(output + '\n');
    return exitCode;
  }
}
