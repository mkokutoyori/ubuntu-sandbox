import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { hhmmss, prettyUptime, two, uptimeHeader } from '@/network/devices/linux/system/SystemInfo';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);
const VALID_FLAGS = new Set(['-p', '--pretty', '-s', '--since', '-h', '--help', '-V', '--version']);

/** `uptime [options]` — lit `machine.metrics.uptimeSeconds()`, formatage inline (`-p`/`-s`/défaut). */
export class UptimeCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'uptime',
    summary: 'Affiche depuis combien de temps le système tourne',
    usage: 'uptime [options]',
    args: [
      { name: 'rest', type: 'string', required: false, variadic: true, description: '-p/--pretty, -s/--since' },
    ],
    options: [],
    privileges: ANY,
    category: 'linux',
    lenientOptions: true,
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const args = ctx.args.get<string[] | undefined>('rest') ?? [];
    const seconds = ctx.machine.metrics!.uptimeSeconds();

    for (const a of args) {
      if (a.startsWith('-') && !VALID_FLAGS.has(a)) {
        await ctx.io.stdout.write(`uptime: unrecognized option '${a}'\n`);
        return EXIT_OK;
      }
    }
    if (args.includes('-p') || args.includes('--pretty')) {
      await ctx.io.stdout.write(`${prettyUptime(Math.floor(seconds / 60))}\n`);
      return EXIT_OK;
    }
    if (args.includes('-s') || args.includes('--since')) {
      const boot = new Date(Date.now() - seconds * 1000);
      await ctx.io.stdout.write(
        `${boot.getUTCFullYear()}-${two(boot.getUTCMonth() + 1)}-${two(boot.getUTCDate())} ${hhmmss(boot)}\n`,
      );
      return EXIT_OK;
    }
    await ctx.io.stdout.write(`${uptimeHeader(1, seconds)}\n`);
    return EXIT_OK;
  }
}
