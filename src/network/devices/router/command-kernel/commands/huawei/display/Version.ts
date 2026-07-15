import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { RouterMachineApi } from '../../../RouterMachineApi';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

/** Profil matériel figé de l'AR2220. */
const CHASSIS = {
  boardType: 'AR2220',
  softwareBranch: 'V200R009C00SPC500',
  bootromVersion: '1.0',
  versionString: 'VRP (R) software, Version 5.170 (AR2220 V200R009C00SPC500)',
};

function formatUptime(ms: number): string {
  const totalMin = Math.floor(ms / 60_000);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  return `${days} days, ${hours} hours, ${mins} minutes`;
}

/**
 * `display version` (Huawei VRP) — commande FEUILLE standalone. Lit
 * uniquement `ctx.machine` (hostname + bootedAt) et met en forme le
 * texte VRP réel. Aucun formateur legacy réutilisé.
 */
export class HuaweiRouterDisplayVersionCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'version',
    summary: 'Display running system information',
    usage: 'display version',
    args: [],
    options: [],
    privileges: ANY,
    category: 'router',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const machine = ctx.machine as RouterMachineApi;
    const uptimeMs = Date.now() - machine.bootedAt().getTime();
    const lines = [
      'Huawei Versatile Routing Platform Software',
      CHASSIS.versionString,
      'Copyright (C) 2000-2025 HUAWEI TECH CO., LTD',
      '',
      `BOARD TYPE:          ${CHASSIS.boardType}`,
      `BootROM Version:     ${CHASSIS.bootromVersion}`,
      `${machine.hostname} uptime is ${formatUptime(uptimeMs)}`,
    ];
    await ctx.io.stdout.write(`${lines.join('\n')}\n`);
    return EXIT_OK;
  }
}
