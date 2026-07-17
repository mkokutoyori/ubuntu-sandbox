import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { two } from '@/network/devices/linux/system/SystemInfo';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** `Tue 2026-05-21 14:00:00` — la forme de l'horodatage `timedatectl`. */
function formatTimestamp(d: Date): string {
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())} ` +
    `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}`;
}

/** `timedatectl` — statut date/heure via `machine.os.timezone` (champ additif Wave 5). */
export class TimedatectlCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'timedatectl',
    summary: 'Affiche l\'état de la date/heure système (systemd-timedated)',
    usage: 'timedatectl',
    args: [],
    options: [],
    privileges: ANY,
    category: 'linux',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const timezone = ctx.machine.os?.timezone ?? 'Etc/UTC';
    const stamp = formatTimestamp(new Date());
    const lines = [
      `               Local time: ${stamp} UTC`,
      `           Universal time: ${stamp} UTC`,
      `                 RTC time: ${stamp}`,
      `                Time zone: ${timezone} (UTC, +0000)`,
      'System clock synchronized: yes',
      '              NTP service: active',
      '          RTC in local TZ: no',
    ];
    await ctx.io.stdout.write(lines.join('\n') + '\n');
    return EXIT_OK;
  }
}
