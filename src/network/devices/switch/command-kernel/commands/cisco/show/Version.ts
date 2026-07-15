import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { SwitchMachineApi } from '../../../SwitchMachineApi';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

/** Profil matériel figé du modèle Catalyst 2960 — donnée de référence
 *  de la commande, aucune source externe. */
const CHASSIS = {
  dramKB: 131072,
  ioMemoryKB: 32768,
  nvramKB: 64,
  serialNumber: 'FOC1234X56Y',
  flashImage: 'c2960-lanbasek9-mz.150-2.SE.bin',
  softwareVersion: '15.0(2)SE',
  bootromVersion: '12.2(53r)SEY3',
  model: 'WS-C2960-24TT-L',
};

function formatUptime(ms: number): string {
  if (ms < 60_000) return '0 minutes';
  const totalMin = Math.floor(ms / 60_000);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  const parts: string[] = [];
  if (days) parts.push(`${days} day${days === 1 ? '' : 's'}`);
  if (hours) parts.push(`${hours} hour${hours === 1 ? '' : 's'}`);
  parts.push(`${mins} minute${mins === 1 ? '' : 's'}`);
  return parts.join(', ');
}

/**
 * `show version` (Cisco Catalyst switch) — commande FEUILLE standalone.
 * Lit uniquement `ctx.machine` (hostname, interfaces, bootedAt) et met
 * en forme le banner C2960 elle-même. Aucun import de formateur legacy.
 * Différent de `show version` routeur : modèle, image logicielle et
 * texte de bannière propres à un switch d'accès L2.
 */
export class CiscoSwitchShowVersionCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'version',
    summary: 'Display system hardware and software status',
    usage: 'show version',
    args: [],
    options: [],
    privileges: ANY,
    category: 'switch',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const machine = ctx.machine as SwitchMachineApi;
    const interfaces = await machine.net.interfaces();
    const feCount = interfaces.filter((i) => /^fa/i.test(i.name)).length;
    const giCount = interfaces.filter((i) => /^gi/i.test(i.name)).length;
    const uptimeMs = Date.now() - machine.bootedAt().getTime();

    const lines = [
      `Cisco IOS Software, C2960 Software (C2960-LANBASEK9-M), Version ${CHASSIS.softwareVersion}`,
      'Copyright (c) 1986-2013 by Cisco Systems, Inc.',
      '',
      `ROM: Bootstrap program is C2960 boot loader, Version ${CHASSIS.bootromVersion}`,
      '',
      `${machine.hostname} uptime is ${formatUptime(uptimeMs)}`,
      `System image file is "flash:${CHASSIS.flashImage}"`,
      '',
      `cisco ${CHASSIS.model} (PowerPC405) processor with ${CHASSIS.dramKB}K bytes of memory.`,
      `Processor board ID ${CHASSIS.serialNumber}`,
      `${feCount} FastEthernet interfaces`,
      `${giCount} Gigabit Ethernet interfaces`,
      `${CHASSIS.nvramKB}K bytes of non-volatile configuration memory.`,
      '',
      'Model number                    : ' + CHASSIS.model,
      'System serial number            : ' + CHASSIS.serialNumber,
      '',
      'Configuration register is 0xF',
    ];
    await ctx.io.stdout.write(`${lines.join('\n')}\n`);
    return EXIT_OK;
  }
}
