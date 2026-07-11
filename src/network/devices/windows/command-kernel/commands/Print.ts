import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

export class PrintCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'print',
    summary: 'Soumet un fichier à l\'impression',
    usage: 'print [/D:device] [[lecteur:][chemin]fichier[...]]',
    args: [{ name: 'targets', type: 'string', required: false, variadic: true, description: 'options et fichiers' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'système',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const args = ctx.args.has('targets') ? ctx.args.get<string[]>('targets') : [];
    if (!ctx.machine.printing) {
      await ctx.io.stdout.write('PRINT: not supported on this device\n');
      return 1;
    }
    if (!ctx.machine.printing.isSpoolerRunning()) {
      await ctx.io.stdout.write("Print Spooler service is not running. Use 'net start spooler' to start it.\n");
      return 1;
    }

    if (args.length === 0) {
      await ctx.io.stdout.write('Usage: PRINT [/D:device] [[drive:][path]filename[...]]\n');
      return 1;
    }
    const deviceArg = args.find((a) => /^\/D:/i.test(a));
    const printer = deviceArg ? deviceArg.slice(3) : 'Microsoft Print to PDF';
    const files = args.filter((a) => !a.startsWith('/'));
    if (files.length === 0) {
      await ctx.io.stdout.write('Usage: PRINT [/D:device] [[drive:][path]filename[...]]\n');
      return 1;
    }

    const lines: string[] = [];
    for (const f of files) {
      ctx.machine.printing.submit(f, printer, ctx.session.user.name);
      lines.push(`${f} is currently being printed on ${printer}.`);
    }
    await ctx.io.stdout.write(lines.join('\n') + '\n');
    return EXIT_OK;
  }
}
