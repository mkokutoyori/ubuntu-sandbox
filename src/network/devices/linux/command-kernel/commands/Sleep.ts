import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { runSleep } from '../../coreutils/Sleep';

/**
 * `sleep` — suspend l'exécution pendant une durée. Le simulateur étant
 * synchrone, la durée calculée est ignorée (comme le legacy) : seule la
 * validation des opérandes compte (`1`, `1s`, `2m`, `1h`, `1d`, `0.5`,
 * sommes multiples). Le parsing des durées reste porté par le module pur
 * partagé `runSleep`.
 */
export class SleepCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'sleep',
    summary: 'Suspend l\'exécution pendant une durée',
    usage: 'sleep NOMBRE[SUFFIXE]...',
    args: [{ name: 'operands', type: 'string', required: false, variadic: true, description: 'durées (NOMBRE[s|m|h|d])' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'système',
    lenientOptions: true,
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const operands = ctx.args.has('operands') ? ctx.args.get<string[]>('operands') : [];
    const result = runSleep(operands);
    const body = result.output === '' ? '' : (result.output.endsWith('\n') ? result.output : result.output + '\n');
    await ctx.io.stdout.write(body);
    return result.exitCode as ExitCode;
  }
}
