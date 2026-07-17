import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { toFileSystemActor } from '@/command-kernel/machine/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);
const VALID_SHORT = new Set(['a', 's', 'n', 'r', 'v', 'm', 'p', 'i', 'o']);
const VALID_LONG = new Set([
  'all', 'kernel-name', 'nodename', 'kernel-release', 'kernel-version',
  'machine', 'processor', 'hardware-platform', 'operating-system', 'help', 'version',
]);

/**
 * `uname [options]` — informations noyau/système via `machine.os` (champs
 * additifs Wave 5 : `kernelSysname`/`kernelBuildVersion`/`machine`/
 * `operatingSystem`). Le nom d'hôte (`-n`) provient de `/etc/hostname`
 * (même source que la commande `hostname`), pas de `machine.hostname`
 * (identité fixe distincte), à l'identique du legacy.
 */
export class UnameCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'uname',
    summary: 'Affiche les informations du noyau et du système',
    usage: 'uname [options]',
    args: [
      { name: 'rest', type: 'string', required: false, variadic: true, description: '-a/-s/-n/-r/-v/-m/-p/-i/-o (courtes ou combinées)' },
    ],
    options: [],
    privileges: ANY,
    category: 'linux',
    lenientOptions: true,
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const args = ctx.args.get<string[] | undefined>('rest') ?? [];
    const os = ctx.machine.os!;
    const kernel = {
      sysname: os.kernelSysname ?? 'Linux',
      release: os.kernelRelease,
      version: os.kernelBuildVersion ?? '',
      machine: os.machine ?? 'x86_64',
      operatingSystem: os.operatingSystem ?? 'GNU/Linux',
    };

    for (const a of args) {
      if (a === '-' || !a.startsWith('-')) continue;
      if (a.startsWith('--')) {
        const long = a.slice(2);
        if (!VALID_LONG.has(long)) {
          await ctx.io.stdout.write(`uname: unrecognized option '${a}'\n`);
          return EXIT_OK;
        }
        continue;
      }
      for (const ch of a.slice(1)) {
        if (!VALID_SHORT.has(ch)) {
          await ctx.io.stdout.write(`uname: invalid option -- '${ch}'\n`);
          return EXIT_OK;
        }
      }
    }

    const flags = args.filter((a) => a.startsWith('-')).join('').replace(/-/g, '');
    const all = flags.includes('a');
    const want = (f: string): boolean => all || flags.includes(f);

    const positional = args.filter((a) => !a.startsWith('-'));
    if (positional.length > 0) {
      await ctx.io.stdout.write(`uname: extra operand '${positional[0]}'\n`);
      return EXIT_OK;
    }
    if (args.length === 0 || flags === '') {
      await ctx.io.stdout.write(`${kernel.sysname}\n`);
      return EXIT_OK;
    }

    const readActor = toFileSystemActor(ctx.session.user);
    const hostname = ((await ctx.machine.fs.readFile('/etc/hostname', readActor).catch(() => '')) || 'localhost').trim();

    if (all) {
      await ctx.io.stdout.write(
        `${kernel.sysname} ${hostname} ${kernel.release} ${kernel.version} ${kernel.machine} ${kernel.machine} ${kernel.machine} ${kernel.operatingSystem}\n`,
      );
      return EXIT_OK;
    }

    const parts: string[] = [];
    if (want('s')) parts.push(kernel.sysname);
    if (want('n')) parts.push(hostname);
    if (want('r')) parts.push(kernel.release);
    if (want('v')) parts.push(kernel.version);
    if (want('m') || want('p') || want('i')) parts.push(kernel.machine);
    if (want('o')) parts.push(kernel.operatingSystem);
    await ctx.io.stdout.write(`${parts.length > 0 ? parts.join(' ') : kernel.sysname}\n`);
    return EXIT_OK;
  }
}
