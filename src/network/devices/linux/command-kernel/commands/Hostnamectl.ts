import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { toFileSystemActor } from '@/command-kernel/machine/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

/**
 * `hostnamectl [set-hostname NAME]` — statut identité système via
 * `machine.os` (champs additifs Wave 5), ou repositionne `/etc/hostname`.
 * Limite de portée assumée : le legacy journalise aussi l'événement
 * `systemd-hostnamed` (`LinuxLogManager.logSystemd`) lors d'un changement
 * réel — pas encore exposé via `machine.logging` (forme dédiée `unit` +
 * `tag: 'systemd'`, distincte de `writeSyslog`) ; la sortie utilisateur
 * elle-même (chaîne vide en cas de succès) est inchangée.
 */
export class HostnamectlCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'hostnamectl',
    summary: 'Affiche ou modifie l\'identité système (systemd-hostnamed)',
    usage: 'hostnamectl [set-hostname NAME]',
    args: [
      { name: 'rest', type: 'string', required: false, variadic: true, description: 'set-hostname NAME' },
    ],
    options: [],
    privileges: ANY,
    category: 'linux',
    lenientOptions: true,
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const args = ctx.args.get<string[] | undefined>('rest') ?? [];
    const readActor = toFileSystemActor(ctx.session.user);

    if (args[0] === 'set-hostname') {
      const newName = args[1];
      if (!newName) {
        await ctx.io.stdout.write('hostnamectl: missing hostname\n');
        return EXIT_OK;
      }
      const rootActor = { uid: 0, gid: 0, gids: [0], name: 'root', groupNames: ['root'] };
      await ctx.machine.fs.writeFile('/etc/hostname', `${newName}\n`, rootActor);
      return EXIT_OK;
    }

    const hn = ((await ctx.machine.fs.readFile('/etc/hostname', readActor).catch(() => '')) || 'localhost').trim();
    const os = ctx.machine.os!;
    const lines = [
      `   Static hostname: ${hn}`,
      `         Icon name: ${os.iconName ?? 'computer-vm'}`,
      `           Chassis: ${os.chassis ?? 'vm'}`,
      `        Machine ID: ${os.machineId ?? ''}`,
      `           Boot ID: ${os.bootId ?? ''}`,
      `    Virtualization: ${os.virtualization ?? 'kvm'}`,
      `  Operating System: ${os.prettyName}`,
      `            Kernel: ${os.kernelSysname ?? 'Linux'} ${os.kernelRelease}`,
      `      Architecture: ${os.machine ?? 'x86_64'}`,
    ];
    await ctx.io.stdout.write(lines.join('\n') + '\n');
    return EXIT_OK;
  }
}
