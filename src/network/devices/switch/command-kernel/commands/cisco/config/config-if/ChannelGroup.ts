import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { SwitchMachineApi } from '../../../../SwitchMachineApi';
import { broadcastInterfaces } from './selected-interfaces';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `channel-group <id> mode {active|passive|on|auto|desirable}` (Cisco
 * Catalyst, config-if) — commande FEUILLE standalone.
 *
 * Le socle command-kernel/ArgumentParser gère `id` (int) + mots
 * suivants comme argv positionnels. La feuille effectue elle-même le
 * mapping vendeur : `desirable→active`, `auto→passive` (compat legacy
 * IOS).
 */
export class CiscoSwitchChannelGroupCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'channel-group',
    summary: 'EtherChannel membership',
    usage: 'channel-group <id> mode {active|passive|on|auto|desirable}',
    args: [
      { name: 'id', type: 'int', required: true, description: 'Channel-group ID (1-64)' },
      { name: 'modeKw', type: 'string', required: true, description: 'Must be the keyword `mode`' },
      { name: 'mode', type: 'string', required: true, description: 'active | passive | on | auto | desirable' },
    ],
    options: [],
    privileges: OP,
    category: 'switch',
  };
  readonly allowedModes = ['config-if'];

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const machine = ctx.machine as SwitchMachineApi;
    const ifaces = broadcastInterfaces(ctx.session);
    if (ifaces.length === 0) { await ctx.io.stderr.write('% No interface selected.\n'); return 1; }
    const id = ctx.args.get<number>('id');
    const modeKw = (ctx.args.get<string>('modeKw') ?? '').toLowerCase();
    const raw = (ctx.args.get<string>('mode') ?? '').toLowerCase();
    if (!Number.isInteger(id) || id < 1 || id > 64) {
      await ctx.io.stderr.write("% Invalid input detected at '^' marker.\n");
      return 1;
    }
    if (modeKw !== 'mode') {
      await ctx.io.stderr.write('% Incomplete command.\n');
      return 1;
    }
    let mode: 'active' | 'passive' | 'on';
    if (raw === 'active' || raw === 'desirable') mode = 'active';
    else if (raw === 'passive' || raw === 'auto') mode = 'passive';
    else if (raw === 'on') mode = 'on';
    else {
      await ctx.io.stderr.write("% Invalid input detected at '^' marker.\n");
      return 1;
    }
    for (const iface of ifaces) {
      if (!machine.switch.setInterfaceChannelGroup(iface, id, mode)) {
        await ctx.io.stderr.write("% Invalid input detected at '^' marker.\n");
        return 1;
      }
    }
    return EXIT_OK;
  }
}
