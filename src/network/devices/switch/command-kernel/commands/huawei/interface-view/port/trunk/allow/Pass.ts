import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { CliSession } from '@/command-kernel/cli';
import type { SwitchMachineApi } from '../../../../../../SwitchMachineApi';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/** Parse une liste VRP `10 20 30` ou `10 to 20` en un Set. Fonction
 *  pure locale — pas d'utilitaire legacy réutilisé. */
function parseVlanTokens(tokens: readonly string[]): Set<number> {
  const out = new Set<number>();
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.toLowerCase() === 'to' && i + 1 < tokens.length) {
      // range `<start> to <end>` — le token précédent est déjà consommé.
      const start = tokens[i - 1] ? Number.parseInt(tokens[i - 1], 10) : NaN;
      const end = Number.parseInt(tokens[++i], 10);
      if (Number.isInteger(start) && Number.isInteger(end)) {
        const [lo, hi] = start <= end ? [start, end] : [end, start];
        for (let v = lo; v <= hi; v++) out.add(v);
      }
      continue;
    }
    const id = Number.parseInt(tok, 10);
    if (Number.isInteger(id)) out.add(id);
  }
  return out;
}

/**
 * `port trunk allow-pass vlan {all|<id>[…]|<start> to <end>}`
 * (Huawei VRP, interface-view) — feuille standalone. Sémantique
 * additive VRP : chaque appel étend la liste allowed (pas de reset,
 * sauf mot-clé explicite). Le mot-clé `all` autorise tous les VLANs.
 * L'`undo` correspondant retire par soustraction.
 */
export class HuaweiSwitchPortTrunkAllowPassCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'vlan',
    summary: 'Allow VLANs to pass through the trunk',
    usage: 'port trunk allow-pass vlan {all|<id>[ <id>…]|<start> to <end>}',
    args: [{ name: 'ids', type: 'string', required: true, variadic: true, description: 'VLAN ids or `all`' }],
    options: [],
    privileges: OP,
    category: 'switch',
  };
  readonly allowedModes = ['interface-view'];

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const machine = ctx.machine as SwitchMachineApi;
    const iface = (ctx.session as CliSession).promptFields.get('selectedInterface');
    if (!iface) {
      await ctx.io.stderr.write('Error: No interface selected.\n');
      return 1;
    }
    const tokens = ctx.args.get<string[]>('ids') ?? [];
    if (tokens.length === 0) {
      await ctx.io.stderr.write("Error: Incomplete command found at '^' position.\n");
      return 1;
    }
    if (tokens[0].toLowerCase() === 'all') {
      if (!machine.switch.resetInterfaceTrunkAllowedVlans(iface)) {
        await ctx.io.stderr.write("Error: Wrong parameter found at '^' position.\n");
        return 1;
      }
      return EXIT_OK;
    }
    const vlans = parseVlanTokens(tokens);
    if (vlans.size === 0) {
      await ctx.io.stderr.write("Error: Wrong parameter found at '^' position.\n");
      return 1;
    }
    if (!machine.switch.setInterfaceTrunkAllowedVlans(iface, 'add', vlans)) {
      await ctx.io.stderr.write("Error: Wrong parameter found at '^' position.\n");
      return 1;
    }
    return EXIT_OK;
  }
}
