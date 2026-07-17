import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { toFileSystemActor } from '@/command-kernel/machine/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

const VALID_FLAGS = new Set([
  '-s', '--short', '-f', '--fqdn', '-i', '--ip-address',
  '-d', '--domain', '-A', '--all-fqdns', '-I', '--all-ip-addresses',
]);

/**
 * `hostname [options] [NEWHOSTNAME]` — lit/positionne `/etc/hostname`.
 * Le legacy écrit sans aucune vérification de permission (uid/gid 0 en
 * dur) — reproduit ici via un acteur root explicite pour ne pas
 * introduire une restriction que le legacy n'a jamais eue.
 */
export class HostnameCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'hostname',
    summary: 'Affiche ou positionne le nom d\'hôte',
    usage: 'hostname [options] [NEWHOSTNAME]',
    args: [
      { name: 'rest', type: 'string', required: false, variadic: true, description: 'options (-s/-f/-i/-d/-A/-I) ou nouveau nom d\'hôte' },
    ],
    options: [],
    privileges: ANY,
    category: 'linux',
    lenientOptions: true,
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const args = ctx.args.get<string[] | undefined>('rest') ?? [];
    const readActor = toFileSystemActor(ctx.session.user);
    const hn = ((await ctx.machine.fs.readFile('/etc/hostname', readActor).catch(() => '')) || 'localhost').trim();

    for (const a of args) {
      if (a.startsWith('-') && !VALID_FLAGS.has(a)) {
        await ctx.io.stdout.write(`hostname: unrecognized option: ${a}\n`);
        return EXIT_OK;
      }
    }
    if (args.includes('-s') || args.includes('--short')) {
      await ctx.io.stdout.write(`${hn.split('.')[0]}\n`);
      return EXIT_OK;
    }
    if (args.includes('-d') || args.includes('--domain')) {
      await ctx.io.stdout.write(`${hn.includes('.') ? hn.split('.').slice(1).join('.') : ''}\n`);
      return EXIT_OK;
    }
    if (args.includes('-f') || args.includes('--fqdn')) {
      await ctx.io.stdout.write(`${hn}\n`);
      return EXIT_OK;
    }
    if (args.includes('-i') || args.includes('--ip-address') || args.includes('-I') || args.includes('--all-ip-addresses')) {
      await ctx.io.stdout.write('127.0.1.1\n');
      return EXIT_OK;
    }
    if (args.includes('-A') || args.includes('--all-fqdns')) {
      await ctx.io.stdout.write(`${hn}\n`);
      return EXIT_OK;
    }
    if (args.length > 0 && !args[0].startsWith('-')) {
      const rootActor = { uid: 0, gid: 0, gids: [0], name: 'root', groupNames: ['root'] };
      await ctx.machine.fs.writeFile('/etc/hostname', `${args[0]}\n`, rootActor);
      return EXIT_OK;
    }
    await ctx.io.stdout.write(`${hn}\n`);
    return EXIT_OK;
  }
}
