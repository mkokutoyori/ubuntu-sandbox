import type { CommandContext, CommandDescriptor } from '@/command-kernel/command/types';
import { PushModeCommand } from '@/command-kernel/cli';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

/**
 * `system-view` (Huawei VRP) — transition user-view → system-view.
 * Équivalent VRP de `configure terminal` chez Cisco. Le vrai VRP
 * affiche `Enter system view, return user view with Ctrl+Z.` — texte
 * qui reste stable, écrit ici (pas dans un formateur legacy).
 */
export class HuaweiSystemViewCommand extends PushModeCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'system-view',
    aliases: ['sys'],
    summary: 'Enter system view',
    usage: 'system-view',
    args: [],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'cli-mode',
  };
  readonly allowedModes = ['user-view'];

  protected async prepare(ctx: CommandContext): Promise<boolean> {
    await ctx.io.stdout.write('Enter system view, return user view with Ctrl+Z.\n');
    return true;
  }

  protected targetMode(_ctx: CommandContext): string {
    return 'system-view';
  }
}
