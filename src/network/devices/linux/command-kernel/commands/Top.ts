import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { renderTop, type TopProc } from './topRender';

/**
 * `top`/`htop` — instantané des processus et de la charge système. Commande
 * façade : lit la table des processus via `ctx.machine.processControl`, la
 * mémoire et l'uptime via `ctx.machine.metrics`, puis délègue le formatage à
 * `renderTop`. Une seule frame par invocation (le rafraîchissement interactif
 * est géré par le terminal, qui repeint la frame produite ici).
 */
export class TopCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'top',
    aliases: ['htop'],
    summary: 'Affiche les processus et l\'utilisation des ressources',
    usage: 'top [-b] [-n N] [-d délai]',
    args: [{ name: 'operands', type: 'string', required: false, variadic: true, description: '[options]' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'système',
    lenientOptions: true,
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    if (!ctx.machine.processControl || !ctx.machine.metrics) {
      await ctx.io.stdout.write('top: process/metrics view unavailable\n');
      return 1;
    }
    const mem = ctx.machine.metrics.memory();
    const procs: TopProc[] = ctx.machine.processControl.list().map((p) => ({
      pid: p.pid,
      user: p.user,
      priority: p.priority ?? 20,
      nice: p.nice,
      vsizeKib: p.vsizeKib ?? 0,
      rssKib: p.rssKib ?? 0,
      state: p.state,
      cpuTimeMs: p.cpuTimeMs ?? 0,
      comm: p.comm,
    }));
    const frame = renderTop({
      procs,
      memory: {
        totalKib: mem.totalKib,
        usedKib: mem.usedKib,
        freeKib: mem.freeKib,
        buffCacheKib: mem.buffersKib + mem.cacheKib,
      },
      uptimeSeconds: ctx.machine.metrics.uptimeSeconds(),
      now: new Date(),
    });
    await ctx.io.stdout.write(frame + '\n');
    return EXIT_OK;
  }
}
