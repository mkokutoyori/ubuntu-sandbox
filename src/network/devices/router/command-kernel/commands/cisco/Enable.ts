import type { CommandContext, CommandDescriptor } from '@/command-kernel/command/types';
import { PushModeCommand } from '@/command-kernel/cli';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

/**
 * `enable` (Cisco IOS) — transition user → privileged. Le vrai IOS
 * demande un mot de passe (enable secret / enable password) quand un
 * est configuré ; ce port initial ne le vérifie pas — à ajouter le jour
 * où la commande `enable secret ...` sera migrée.
 */
export class CiscoEnableCommand extends PushModeCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'enable',
    aliases: ['en'],
    summary: 'Turn on privileged mode',
    usage: 'enable',
    args: [],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'cli-mode',
  };
  readonly allowedModes = ['user'];

  protected targetMode(_ctx: CommandContext): string {
    return 'privileged';
  }
}
