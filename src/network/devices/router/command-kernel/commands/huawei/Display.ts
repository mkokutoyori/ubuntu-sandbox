import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { CommandRegistry } from '@/command-kernel/registry/command-registry';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { HuaweiDisplayVersionCommand } from './DisplayVersion';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

const DISPLAY_SUB = new CommandRegistry();
DISPLAY_SUB.register(() => new HuaweiDisplayVersionCommand());

/**
 * `display` (Huawei VRP) — commande composite. Même modèle que Cisco
 * `show` : point d'entrée hiérarchique, l'interpréteur descend dans
 * `subRegistry`. `display` seul (sans sous-mot) est une commande
 * incomplete VRP.
 */
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
  readonly subRegistry = DISPLAY_SUB;

  async execute(ctx: CommandContext): Promise<ExitCode> {
    await ctx.io.stderr.write("Error: Incomplete command found at '^' position.\n");
    return 1;
  }
}
