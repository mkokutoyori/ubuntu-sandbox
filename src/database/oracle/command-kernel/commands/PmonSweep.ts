import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

/**
 * `PMON SWEEP` — force un balayage de `IdleSessionMonitor` (snipe les
 * sessions idle au-delà du profil de l'utilisateur). Le verbe reconnu par
 * `recognizeSqlPlusKernelVerb` est `PMON` (premier mot) ; ce descripteur
 * garde donc `name: 'PMON'` — seule la forme exacte `PMON SWEEP` est
 * reconnue (voir `VERB_FAMILIES.PMON` dans `createSqlPlusKernel.ts`), le
 * `SWEEP` restant est absorbé par l'argument variadique ignoré, à
 * l'identique du legacy qui ne matche que `PMON SWEEP` exactement.
 */
export class SqlPlusPmonSweepCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'PMON',
    summary: 'Force un balayage PMON des sessions idle',
    usage: 'PMON SWEEP',
    args: [
      { name: 'rest', type: 'string', required: false, variadic: true, description: 'toujours "SWEEP" (parité vendeur)' },
    ],
    options: [],
    privileges: ANY,
    category: 'sqlplus',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const oracle = ctx.machine.oracle!;
    const n = oracle.sweepIdleSessions();
    await ctx.io.stdout.write(`PMON sweep complete — ${n} session(s) sniped.\n`);
    return EXIT_OK;
  }
}
