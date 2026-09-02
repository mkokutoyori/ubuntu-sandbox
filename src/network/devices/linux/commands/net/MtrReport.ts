/**
 * `mtr --report` — la porte non interactive du moteur `mtr` existant.
 *
 * `mtr` est entièrement simulé depuis longtemps (`devices/linux/Mtr.ts` :
 * analyse d'arguments, statistiques par saut, rendu de trame) mais il
 * n'était atteignable que par `LinuxTerminalSession.tryStartMtrStream`,
 * c'est-à-dire depuis un terminal, en plein écran. Dans un script ou
 * derrière un tube, `mtr` répondait `command not found` — alors même que
 * `which mtr` rendait `/usr/bin/mtr` (audit 11, §2).
 *
 * Or `--report` existe précisément pour être scripté : le vrai `mtr -r`
 * envoie ses sondes, imprime un tableau, et rend la main. C'est cette
 * forme-là, et elle seule, qui est servie ici. Le mode plein écran reste
 * au terminal, qui l'intercepte avant que le registre ne soit consulté —
 * un flux qui se repeint n'a aucun sens dans un tube.
 *
 * Sans `-r`/`--report`, la commande dit ce qu'il en est plutôt que de
 * faire semblant : hors terminal, il n'y a pas d'écran à repeindre.
 */

import { IPAddress } from '@/network/core/types';
import type { LinuxCommand } from '../LinuxCommand';
import { parseMtrArgs, MtrHopStats, formatMtrFrame, MTR_USAGE, MTR_VERSION } from '../../Mtr';
import { makeArgCompleter } from '../completionHelpers';

export const mtrCommand: LinuxCommand = {
  name: 'mtr',
  package: 'mtr-tiny',
  needsNetworkContext: true,
  manSection: 8,
  usage: 'mtr [-r|--report] [-c count] [-m max_hops] [-n] HOSTNAME',
  help:
    'Combines the functionality of traceroute and ping in one tool.\n\n'
    + 'Only the report form (-r / --report) runs outside a terminal: the\n'
    + 'full-screen live display needs a screen to repaint.',
  options: [
    { flag: '-r', aliases: ['--report'], description: 'Report mode: send the probes, print a table, exit.' },
    { flag: '-c', description: 'Number of pings sent to each hop.', takesArg: true, argName: 'count' },
    { flag: '-m', description: 'Maximum number of hops.', takesArg: true, argName: 'max_hops' },
    { flag: '-n', description: 'Print numeric addresses without DNS lookup.' },
  ],
  complete: makeArgCompleter({
    flags: ['-r', '--report', '-c', '-m', '-n', '-w', '-i', '--help', '--version'],
    hostsAtBarePosition: true,
  }),
  run: async (ctx, args) => {
    const parsed = parseMtrArgs(args);
    if (parsed.showHelp) return MTR_USAGE;
    if (parsed.showVersion) return MTR_VERSION;
    if (parsed.parseError) return parsed.parseError;
    if (!parsed.target) return 'mtr: no host specified';
    if (!parsed.reportMode) {
      // Le terminal intercepte le mode vivant avant d'arriver ici : y
      // parvenir signifie qu'il n'y a pas d'écran.
      return 'mtr: no curses display available outside a terminal — use -r/--report';
    }

    let ip = await ctx.net.resolveHostname(parsed.target);
    if (!ip && parsed.target.toLowerCase() === 'localhost') {
      try { ip = new IPAddress('127.0.0.1'); } catch { /* rien */ }
    }
    if (!ip) return `mtr: Failed to resolve host: ${parsed.target}`;

    const maxHops = Math.min(parsed.maxHops, 8);
    const cycles = Math.max(1, Math.min(parsed.cycles, 10));
    const stats: MtrHopStats[] = [];
    for (let tour = 0; tour < cycles; tour++) {
      const hops = await ctx.net.traceroute(ip, maxHops, 1, 1, 100);
      if (hops.length === 0) return 'mtr: no hops discovered';
      hops.forEach((hop, idx) => {
        if (!stats[idx]) stats[idx] = new MtrHopStats();
        const sonde = hop.probes?.[0];
        stats[idx].record({
          ip: sonde?.ip,
          rttMs: sonde?.rttMs,
          lost: hop.timeout === true || sonde?.rttMs === undefined,
        });
      });
    }
    if (stats.length === 0) return 'mtr: no hops discovered';

    return formatMtrFrame({
      // Le nom de la machine, pas celui du profil : `mtr` affiche
      // l'hôte d'où part la mesure, et `hostname` a pu être changé.
      hostname: (ctx.executor.vfs.readFile('/etc/hostname') ?? ctx.profile.hostname).trim(),
      target: stats[stats.length - 1].ip ?? ip.toString(),
      startedAt: new Date(),
      hops: stats,
    }, 'report');
  },
};
