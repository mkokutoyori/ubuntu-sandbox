import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { CommandRegistry } from '@/command-kernel/registry/command-registry';
import { HuaweiRouterSysSnmpAgentEnableCommand } from './snmp-agent/Enable';
import { HuaweiRouterSnmpAgentCommunityCommand } from './snmp-agent/Community';
import { HuaweiRouterSnmpAgentSysInfoCommand } from './snmp-agent/SysInfo';
import { HuaweiRouterSnmpAgentTargetHostCommand } from './snmp-agent/TargetHost';
import { HuaweiRouterSnmpAgentTrapCommand } from './snmp-agent/Trap';
import { HuaweiRouterSnmpAgentGroupCommand } from './snmp-agent/Group';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `snmp-agent` — commande COMPOSITE (racine + sous-registre) : seule
 * appelée directement si aucun sous-mot ne matche (message vendeur
 * « incomplete command »), sinon l'interpréteur descend dans
 * `subRegistry` jusqu'à la feuille.
 */
export class HuaweiRouterSysSnmpAgentCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'snmp-agent',
    summary: 'SNMP agent configuration',
    usage: 'snmp-agent [<subcommand>]',
    args: [],
    options: [],
    privileges: OP,
    category: 'router',
  };
  readonly allowedModes = ['system-view'];
  readonly subRegistry = new CommandRegistry();

  constructor() {
    super();
    this.subRegistry.register(() => new HuaweiRouterSysSnmpAgentEnableCommand());
    this.subRegistry.register(() => new HuaweiRouterSnmpAgentCommunityCommand());
    this.subRegistry.register(() => new HuaweiRouterSnmpAgentSysInfoCommand());
    this.subRegistry.register(() => new HuaweiRouterSnmpAgentTargetHostCommand());
    this.subRegistry.register(() => new HuaweiRouterSnmpAgentTrapCommand());
    this.subRegistry.register(() => new HuaweiRouterSnmpAgentGroupCommand());
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    await ctx.io.stderr.write('Error: Incomplete command found at \'^\' position.\n');
    return 1;
  }
}
