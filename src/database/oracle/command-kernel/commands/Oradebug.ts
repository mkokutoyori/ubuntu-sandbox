import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

/**
 * `ORADEBUG <sous-commande>` — diagnostic simulé : `TRACEFILE_NAME` calcule
 * un chemin de trace plausible à partir du SID d'instance, `SETOSPID`/
 * `SETORAPID` renvoient un pid factice ; tout le reste (SETMYPID, DUMP,
 * EVENT, SESSION_EVENT, SHORT_STACK, UNLIMIT, SUSPEND, RESUME…) répond
 * invariablement `Statement processed.`, comme le legacy.
 */
export class SqlPlusOradebugCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'ORADEBUG',
    summary: 'Commandes de diagnostic ORADEBUG (simulées)',
    usage: 'ORADEBUG <sous-commande>',
    args: [
      { name: 'rest', type: 'string', required: false, variadic: true, description: 'sous-commande ORADEBUG (TRACEFILE_NAME, SETMYPID, DUMP…)' },
    ],
    options: [],
    privileges: ANY,
    category: 'sqlplus',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const oracle = ctx.machine.oracle!;
    const parts = ctx.args.get<string[] | undefined>('rest') ?? [];
    const upper = parts.join(' ').replace(/;\s*$/, '').trim().toUpperCase();

    if (upper === 'TRACEFILE_NAME') {
      const sid = oracle.instanceSid();
      const path = `/u01/app/oracle/diag/rdbms/${sid.toLowerCase()}/${sid}/trace/${sid.toLowerCase()}_ora_${process.pid ?? 1000}.trc`;
      await ctx.io.stdout.write(`${path}\n`);
      return EXIT_OK;
    }

    if (upper.startsWith('SETOSPID') || upper.startsWith('SETORAPID')) {
      await ctx.io.stdout.write('Oracle pid: 1, Unix process pid: 1000, image: oracle@localhost\n');
      return EXIT_OK;
    }

    await ctx.io.stdout.write('Statement processed.\n');
    return EXIT_OK;
  }
}
