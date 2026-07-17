import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

/**
 * `getent database [clé...]` — délègue à `machine.nssQuery.getent`, qui
 * appelle le moteur NSS réel (`runGetent`/`NameServiceSwitch`) : c'est la
 * commande `getent` elle-même, pas un formateur legacy à contourner.
 */
export class GetentCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'getent',
    summary: 'Interroge les bases NSS (passwd, group, hosts...)',
    usage: 'getent database [clé...]',
    args: [
      { name: 'rest', type: 'string', required: false, variadic: true, description: 'base NSS et clés' },
    ],
    options: [],
    privileges: ANY,
    category: 'linux',
    lenientOptions: true,
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const args = ctx.args.get<string[] | undefined>('rest') ?? [];
    const { output, exitCode } = ctx.machine.nssQuery!.getent(args);
    if (output) await ctx.io.stdout.write(output.endsWith('\n') ? output : `${output}\n`);
    return exitCode;
  }
}
