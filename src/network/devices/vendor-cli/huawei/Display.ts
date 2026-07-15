import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import type { CommandRegistry } from '@/command-kernel/registry/command-registry';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

/**
 * `display` (Huawei VRP) — commande racine composite. Sémantique
 * commune à tous les équipements Huawei. Chaque équipement fournit son
 * sous-registre : `version`, `ip routing-table`, `current-configuration`
 * pour un routeur ; `version`, `vlan`, `mac-address`, `stp` pour un
 * switch.
 */
export function createHuaweiDisplayCommand(subRegistry: CommandRegistry): HuaweiDisplayCommand {
  return new HuaweiDisplayCommand(subRegistry);
}

export class HuaweiDisplayCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'display',
    aliases: ['dis'],
    summary: 'Display running system information',
    usage: 'display <subcommand>',
    args: [],
    options: [],
    privileges: ANY,
    category: 'router',
  };
  readonly allowedModes = ['user-view', 'system-view'];

  constructor(public readonly subRegistry: CommandRegistry) {
    super();
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    await ctx.io.stderr.write("Error: Incomplete command found at '^' position.\n");
    return 1;
  }
}
