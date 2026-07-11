import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

export class WmicCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'wmic',
    summary: 'Interroge le WMI (sous-ensemble)',
    usage: 'wmic <alias> get <propriété>',
    args: [{ name: 'targets', type: 'string', required: false, variadic: true, description: 'requête wmic' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'système',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const args = ctx.args.has('targets') ? ctx.args.get<string[]>('targets') : [];
    if (args.length === 0) {
      await ctx.io.stdout.write('wmic:root\\cli>\n');
      return EXIT_OK;
    }
    const joined = args.join(' ').toLowerCase();

    if (joined.includes('logicaldisk') && joined.includes('get name')) {
      const drives = (await ctx.machine.fs.listDrives?.()) ?? [];
      await ctx.io.stdout.write(['Name  ', ...drives.map((d) => d.padEnd(6))].join('\n') + '\n');
      return EXIT_OK;
    }
    if (joined.includes('os get caption')) {
      const caption = ctx.machine.os?.prettyName ?? 'Microsoft Windows';
      await ctx.io.stdout.write(`Caption                              \n${caption.padEnd(38)}\n`);
      return EXIT_OK;
    }
    if (joined.includes('cpu get name')) {
      const cpu = ctx.machine.hardware?.cpu;
      const name = cpu ? `Intel(R) Core(TM) i7 CPU @ ${(cpu.clockMhz / 1000).toFixed(2)}GHz` : 'Intel(R) Core(TM) i7 CPU';
      await ctx.io.stdout.write(`Name                                              \n${name.padEnd(50)}\n`);
      return EXIT_OK;
    }
    return EXIT_OK;
  }
}
