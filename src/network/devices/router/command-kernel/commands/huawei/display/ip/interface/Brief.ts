import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { RouterMachineApi, RouterInterfaceInfo } from '../../../../../RouterMachineApi';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

/** Nom d'affichage VRP : les ports internes sont stockés en `GE0/0/N` ;
 *  le rendu vendeur les développe en `GigabitEthernet0/0/N`. Fonction
 *  pure locale, propre à ce vendeur — pas d'import d'un formateur legacy. */
function renderInterfaceName(name: string): string {
  return name.startsWith('GE') ? name.replace(/^GE/, 'GigabitEthernet') : name;
}

function physicalState(info: RouterInterfaceInfo): string {
  if (!info.adminUp) return '*down';
  return info.linkUp ? 'up' : 'down';
}

function protocolState(info: RouterInterfaceInfo): string {
  return info.adminUp && info.linkUp ? 'up' : 'down';
}

/**
 * `display ip interface brief` (Huawei VRP routeur) — commande FEUILLE
 * standalone. Lit UNIQUEMENT `RouterMachineApi.router.interfaces()` et
 * produit elle-même la mise en forme tabulaire vendeur (bannière VRP
 * exacte + compteurs UP/DOWN + colonnes fixes).
 */
export class HuaweiRouterDisplayIpInterfaceBriefCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'brief',
    summary: 'Brief summary of IP interface state',
    usage: 'display ip interface brief',
    args: [],
    options: [],
    privileges: ANY,
    category: 'router',
  };
  readonly allowedModes = ['user-view', 'system-view'];

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const machine = ctx.machine as RouterMachineApi;
    const infos = machine.router.interfaces();

    let upPhys = 0, downPhys = 0, upProto = 0, downProto = 0;
    const rows: string[] = [];
    for (const info of infos) {
      const phys = physicalState(info);
      const proto = protocolState(info);
      if (phys === 'up') upPhys++; else downPhys++;
      if (proto === 'up') upProto++; else downProto++;
      const ipStr = info.ip === ''
        ? 'unassigned'
        : `${info.ip}/${maskToCidr(info.mask)}`;
      rows.push(
        `${renderInterfaceName(info.name).padEnd(34)}${ipStr.padEnd(21)}${phys.padEnd(11)}${proto}`,
      );
    }

    const lines = [
      '*down: administratively down',
      '^down: standby',
      '(l): loopback',
      '(s): spoofing',
      `The number of interface that is UP in Physical is ${upPhys}`,
      `The number of interface that is DOWN in Physical is ${downPhys}`,
      `The number of interface that is UP in Protocol is ${upProto}`,
      `The number of interface that is DOWN in Protocol is ${downProto}`,
      '',
      'Interface                         IP Address/Mask      Physical   Protocol',
      ...rows,
    ];
    await ctx.io.stdout.write(`${lines.join('\n')}\n`);
    return EXIT_OK;
  }
}

/** Convertit un masque en notation décimale (`255.255.255.0`) en CIDR
 *  (`24`). Fonction pure locale — évite un import d'un helper legacy. */
function maskToCidr(mask: string): number {
  if (!mask) return 0;
  const octets = mask.split('.').map((o) => Number.parseInt(o, 10));
  let bits = 0;
  for (const o of octets) {
    for (let i = 7; i >= 0; i--) {
      if ((o >> i) & 1) bits++;
      else return bits;
    }
  }
  return bits;
}
