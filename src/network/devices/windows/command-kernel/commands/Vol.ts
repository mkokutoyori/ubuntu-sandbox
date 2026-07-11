import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

export class VolCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'vol',
    summary: 'Affiche le numéro de série du volume',
    usage: 'vol [lecteur:]',
    args: [{ name: 'drive', type: 'string', required: false, description: 'lettre de lecteur' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'système',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const raw = (ctx.args.has('drive') ? ctx.args.get<string>('drive') : 'C:').toUpperCase().replace(/[:\\]+$/, '');
    const letter = raw.charAt(0) || 'C';
    const path = `${letter}:\\`;
    const vol = await ctx.machine.fs.volumeInfo?.(path);
    await ctx.io.stdout.write([
      ` Volume in drive ${letter} has no label.`,
      ` Volume Serial Number is ${vol?.serial ?? '0000-0000'}`,
    ].join('\n') + '\n');
    return EXIT_OK;
  }
}
