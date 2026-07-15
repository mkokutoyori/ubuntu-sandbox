import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import type { SwitchMachineApi } from '../../../SwitchMachineApi';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

/** Profil matériel figé du modèle Huawei S5720 (switch d'accès L2/L3). */
const CHASSIS = {
  boardType: 'S5720-28X-LI-AC',
  softwareBranch: 'V200R019C10SPC500',
  bootromVersion: '1.0',
  versionString: 'VRP (R) software, Version 5.170 (S5720 V200R019C10SPC500)',
};

function formatUptime(ms: number): string {
  const totalMin = Math.floor(ms / 60_000);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  return `${days} days, ${hours} hours, ${mins} minutes`;
}

/**
 * `display version` (Huawei S5720 switch) — feuille standalone. Diffère
 * de la version routeur AR2220 par le modèle (`S5720-28X-LI-AC`) et la
 * branche logicielle (V200R019). Lit uniquement `ctx.machine`.
 */
export class HuaweiSwitchDisplayVersionCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'version',
    summary: 'Display running system information',
    usage: 'display version',
    args: [],
    options: [],
    privileges: ANY,
    category: 'switch',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const machine = ctx.machine as SwitchMachineApi;
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
