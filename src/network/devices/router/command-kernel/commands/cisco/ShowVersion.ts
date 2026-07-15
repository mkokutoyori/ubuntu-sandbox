import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { RouterMachineApi } from '../../RouterMachineApi';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

/** Profil matériel figé du modèle ISR2911 — donnée de référence de la
 *  commande (aucune source externe, pas de partage inter-commande). */
const CHASSIS = {
  dramKB: 524288,
  ioMemoryKB: 65536,
  nvramKB: 256,
  serialNumber: 'FTX1234567A',
  flashImage: 'c2900-universalk9-mz.SPA.157-3.M5.bin',
  softwareVersion: '15.7(3)M5',
  bootromVersion: '15.0(1r)M15',
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
 * `show version` (Cisco IOS) — commande FEUILLE : enregistrée dans le
 * sous-registre de `show`, l'interpréteur descend jusqu'à elle. Elle
 * lit son unique source d'information via `ctx.machine` (hostname,
 * interfaces, bootedAt) et met en forme le texte elle-même.
 */
export class CiscoShowVersionCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'version',
    summary: 'Display system hardware and software status',
    usage: 'show version',
    args: [],
    options: [],
    privileges: ANY,
    category: 'router',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const machine = ctx.machine as RouterMachineApi;
    const interfaces = machine.router.interfaces();
    const gigCount = interfaces.filter((i) => i.name.toLowerCase().startsWith('gig')).length;
    const uptimeMs = Date.now() - machine.bootedAt().getTime();

    const lines = [
      `Cisco IOS Software, C2900 Software (C2900-UNIVERSALK9-M), Version ${CHASSIS.softwareVersion}`,
      'Copyright (c) 1986-2025 by Cisco Systems, Inc.',
      '',
      `ROM: System Bootstrap, Version ${CHASSIS.bootromVersion}`,
      '',
      `${machine.hostname} uptime is ${formatUptime(uptimeMs)}`,
      `System image file is "flash:${CHASSIS.flashImage}"`,
      '',
      `Cisco C2911 (revision 1.0) with ${CHASSIS.dramKB}K/${CHASSIS.ioMemoryKB}K bytes of memory.`,
      `Processor board ID ${CHASSIS.serialNumber}`,
      `${gigCount} Gigabit Ethernet interfaces`,
      'DRAM configuration is 64 bits wide with parity enabled.',
      `${CHASSIS.nvramKB}K bytes of non-volatile configuration memory.`,
      '',
      'Configuration register is 0x2102',
    ];
    await ctx.io.stdout.write(`${lines.join('\n')}\n`);
    return EXIT_OK;
  }
}
