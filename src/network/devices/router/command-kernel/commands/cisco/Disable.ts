import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { popMode, type CliSession } from '@/command-kernel/cli';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

/**
 * `disable` (Cisco IOS) — transition privileged → user (pop d'un cran).
 * Distincte de `exit` (qui pop UN mode quelconque) : `disable` n'a de
 * sens qu'en mode privileged et n'exécute rien d'autre.
 */
export class CiscoDisableCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'disable',
    summary: 'Turn off privileged mode',
    usage: 'disable',
    args: [],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'cli-mode',
  };
  readonly allowedModes = ['privileged'];

  async execute(ctx: CommandContext): Promise<ExitCode> {
    popMode(ctx.session as CliSession);
    return EXIT_OK;
  }
}
