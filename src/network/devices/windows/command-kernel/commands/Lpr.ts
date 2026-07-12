import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { toFileSystemActor } from '@/command-kernel/machine/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

const LPR_HELP = `Sends a print job to a network printer

Usage: lpr -S server -P printer [-C class] [-J job] [-o option] [-x] [-d] filename

Options:
    -S server    Name or ipaddress of the host providing lpd service
    -P printer   Name of the print queue
    -C class     Job classification for use on the burst page
    -J job       Job name to print on the burst page
    -o option    Indicates the type of the file (by default assumes a text file)
                 Use "-o l" for binary (e.g. postscript) files
    -x           Compatibility with SunOS 4.1.x and prior
    -d           Send data file first`;

/**
 * `lpr` — soumet un fichier à une file LPD distante (RFC 1179). Le parsing
 * et le formatage sont portés par la commande ; la lecture du fichier passe
 * par `machine.fs` et la soumission réseau par la primitive device
 * `machine.printClient.submitLpdJob` (le propriétaire et l'hôte d'origine
 * sont remplis par l'équipement).
 */
export class LprCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'lpr',
    summary: 'Soumet un travail à une imprimante réseau (LPD)',
    usage: LPR_HELP,
    args: [{ name: 'targets', type: 'string', required: false, variadic: true, description: '-S server -P printer filename' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'système',
    lenientOptions: true,
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const args = ctx.args.has('targets') ? ctx.args.get<string[]>('targets') : [];
    if (args.some((a) => a === '/?' || a === '-?')) {
      await ctx.io.stdout.write(LPR_HELP + '\n');
      return EXIT_OK;
    }
    const printClient = ctx.machine.printClient;
    if (!printClient) {
      await ctx.io.stdout.write('lpr : network printing is not supported on this device.\n');
      return 1;
    }

    let server: string | undefined;
    let queue: string | undefined;
    const files: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-S') { server = args[++i]; }
      else if (args[i] === '-P') { queue = args[++i]; }
      else if (args[i] === '-C' || args[i] === '-J' || args[i] === '-o') { i++; }
      else if (!args[i].startsWith('-')) { files.push(args[i]); }
    }
    if (!server || !queue || files.length === 0) {
      await ctx.io.stdout.write('Usage: lpr -S server -P printer filename\n');
      return 1;
    }

    const abs = ctx.machine.fs.resolve(ctx.session.cwd, files[0]);
    const actor = toFileSystemActor(ctx.session.user);
    let content: Uint8Array;
    try {
      content = new TextEncoder().encode(await ctx.machine.fs.readFile(abs, actor));
    } catch {
      await ctx.io.stdout.write(`lpr: cannot access '${files[0]}': No such file or directory\n`);
      return 1;
    }

    const res = printClient.submitLpdJob(server, queue, files[0], content);
    if (!res.ok) {
      await ctx.io.stdout.write((res.error ?? 'lpr: submission failed') + '\n');
      return 1;
    }
    return EXIT_OK;
  }
}
