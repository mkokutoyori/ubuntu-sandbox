import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

const ROOT = new DefaultPrivilegePolicy(PrivilegeLevel.ROOT);

/**
 * `chpasswd` — lit `username:password` sur stdin (une paire par ligne) et
 * applique chaque changement via `machine.users.posixChangePassword`, à
 * l'identique de `cmdChpasswd` (silencieux, toujours succès).
 */
export class ChpasswdCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'chpasswd',
    summary: 'Change en masse les mots de passe depuis l\'entrée standard',
    usage: 'chpasswd',
    args: [],
    options: [],
    privileges: ROOT,
    category: 'linux',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const stdin = await ctx.io.stdin.readAll();
    const lines = stdin.split('\n').filter((l) => l.includes(':'));
    for (const line of lines) {
      const [user, pass] = line.split(':');
      ctx.machine.users.posixChangePassword?.(user.trim(), pass.trim());
    }
    return EXIT_OK;
  }
}
