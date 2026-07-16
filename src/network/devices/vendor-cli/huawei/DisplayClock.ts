import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

const WEEKDAYS = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
];

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * `display clock` (Huawei VRP, tous équipements — routeur et switch).
 * Feuille standalone : lit `ctx.machine.now()` (méthode standard des
 * MachineApi Router/Switch) et rend le format VRP exact (date +
 * weekday + timezone). Identique côté routeur et switch, d'où son
 * emplacement partagé `vendor-cli/huawei/`.
 */
export class HuaweiDisplayClockCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'clock',
    summary: 'Display the system clock',
    usage: 'display clock',
    args: [],
    options: [],
    privileges: ANY,
    category: 'router',
  };
  readonly allowedModes = ['user-view', 'system-view'];

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const now = ctx.machine.now();
    const date = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
    const time = `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
    const lines = [
      `${date} ${time}`,
      WEEKDAYS[now.getDay()],
      'Time Zone(UTC) : UTC',
    ];
    await ctx.io.stdout.write(`${lines.join('\n')}\n`);
    return EXIT_OK;
  }
}
