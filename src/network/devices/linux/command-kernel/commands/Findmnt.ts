import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

/** `findmnt [options] [target]` — délègue à `machine.mountTable.findmnt` (`handleFindmnt`, lecture seule). */
export class FindmntCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'findmnt',
    summary: 'Affiche l\'arbre des points de montage',
    usage: 'findmnt [options] [target]',
    args: [
      { name: 'rest', type: 'string', required: false, variadic: true, description: 'options, cible' },
    ],
    options: [],
    privileges: ANY,
    category: 'linux',
    lenientOptions: true,
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const args = ctx.args.get<string[] | undefined>('rest') ?? [];
    const { output, exitCode } = ctx.machine.mountTable!.findmnt(args);
    if (output) await ctx.io.stdout.write(output + '\n');
    return exitCode;
  }
}
