import type { CommandContext, CommandDescriptor } from '@/command-kernel/command/types';
import { PushModeCommand } from '@/command-kernel/cli';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

/**
 * `enable` (Cisco IOS) — transition user → privileged. Identique sur
 * routeur et switch, d'où son emplacement vendeur (partagé). Le vrai
 * IOS vérifie le `enable secret` quand un est configuré ; ce port
 * initial ne le fait pas — sera ajouté quand la commande `enable
 * secret …` sera migrée.
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
