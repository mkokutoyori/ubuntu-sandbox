import type { CommandContext, CommandDescriptor } from '@/command-kernel/command/types';
import { PushModeCommand } from '@/command-kernel/cli';
import { CommandRegistry } from '@/command-kernel/registry/command-registry';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

/**
 * `configure terminal` (Cisco IOS) — transition privileged → config.
 * Identique sur routeur et switch, d'où son emplacement vendor-cli
 * partagé. Composée : `configure` seul est incomplete ; seul `configure
 * terminal` (abrégeable `conf t`) est valide.
 */

const CONFIGURE_SUB = new CommandRegistry();

class TerminalSubCommand extends PushModeCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'terminal',
    aliases: ['t'],
    summary: 'Configure from the terminal',
    usage: 'configure terminal',
    args: [],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'cli-mode',
  };

  protected targetMode(_ctx: CommandContext): string {
    return 'config';
  }
}
CONFIGURE_SUB.register(() => new TerminalSubCommand());

export class CiscoConfigureCommand extends PushModeCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'configure',
    aliases: ['conf', 'config'],
    summary: 'Enter configuration mode',
    usage: 'configure <sub>',
    args: [],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'cli-mode',
  };
  readonly allowedModes = ['privileged'];
  readonly subRegistry = CONFIGURE_SUB;

  protected async prepare(ctx: CommandContext): Promise<boolean> {
    await ctx.io.stderr.write('% Incomplete command.\n');
    return false;
  }

  protected targetMode(_ctx: CommandContext): string {
    return 'config';
  }
}
