import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { HuaweiRouterDisplayCurrentConfigurationCommand } from './CurrentConfiguration';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

/**
 * `display saved-configuration` (Huawei VRP) — feuille standalone.
 * Alias de `display current-configuration` côté simulateur : le
 * simulateur ne différencie pas encore running-config et
 * startup-config (`save` est un no-op sur disque). On délègue à la
 * même synthèse — quand `save` deviendra persistant, on introduira
 * un vrai snapshot séparé.
 */
export class HuaweiRouterDisplaySavedConfigurationCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'saved-configuration',
    summary: 'Display the saved (startup) configuration',
    usage: 'display saved-configuration',
    args: [],
    options: [],
    privileges: ANY,
    category: 'router',
  };
  readonly allowedModes = ['user-view', 'system-view'];

  private readonly current = new HuaweiRouterDisplayCurrentConfigurationCommand();

  async execute(ctx: CommandContext): Promise<ExitCode> {
    return this.current.execute(ctx);
  }
}
