import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

const ROOT = new DefaultPrivilegePolicy(PrivilegeLevel.ROOT);

/**
 * `faillock [--user LOGIN] [--reset]` — rapport ou remise à zéro des
 * compteurs d'échec d'authentification, via `machine.accountLockout`
 * (partagé avec le legacy `LinuxUserManager.getFaillockReport`/`resetFaillock`).
 */
export class FaillockCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'faillock',
    summary: 'Affiche ou réinitialise les compteurs d\'échec d\'authentification',
    usage: 'faillock [--user LOGIN] [--reset]',
    args: [
      { name: 'rest', type: 'string', required: false, variadic: true, description: '--user LOGIN, --reset' },
    ],
    options: [],
    privileges: ROOT,
    category: 'linux',
    lenientOptions: true,
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const args = ctx.args.get<string[] | undefined>('rest') ?? [];
    const oracle = ctx.machine.accountLockout!;

    let user: string | undefined;
    let reset = false;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--user' || args[i] === '-u') { user = args[++i]; continue; }
      if (args[i] === '--reset') { reset = true; continue; }
    }

    if (reset) {
      if (user) {
        oracle.reset(user);
      } else {
        for (const report of oracle.report()) oracle.reset(report.username);
      }
      return EXIT_OK;
    }

    const reports = oracle.report(user);
    if (reports.length === 0) {
      if (user) {
        await ctx.io.stdout.write(`${user}:\nWhen                Type  Source                                           Valid\n`);
      }
      return EXIT_OK;
    }

    const blocks = reports.map((r) => {
      const header = `${r.username}:\nWhen                Type  Source                                           Valid`;
      const rows = Array.from({ length: r.failures }, () =>
        '                    TTY   localhost                                        V');
      const note = r.lockedOut ? '\n(account is locked — too many authentication failures)' : '';
      return [header, ...rows].join('\n') + note;
    });
    await ctx.io.stdout.write(blocks.join('\n\n') + '\n');
    return EXIT_OK;
  }
}
