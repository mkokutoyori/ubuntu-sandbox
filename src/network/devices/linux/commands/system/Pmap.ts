/**
 * `pmap` — la carte mémoire d'un processus.
 *
 * `OSProcess` porte `vsize` et `rss` pour de vrai, et `ps`/`top` les
 * affichent déjà ; le total de `pmap` en découle donc directement et ne
 * peut pas contredire ce que `ps -o vsz` annonce pour le même PID — c'est
 * la propriété qui compte, et c'est ce que le test vérifie.
 *
 * Ce qui est honnête de dire : le **découpage** en segments n'a pas de
 * source. Il n'existe pas de `/proc/<pid>/maps` dans ce simulateur, aucun
 * chargeur ELF, aucune allocation réelle. Les lignes rendues sont donc la
 * disposition qu'a *tout* processus ELF sous Linux — texte, rodata,
 * données, tas, pile, vdso — dimensionnée pour totaliser exactement le
 * `vsize` du processus. Ce n'est pas une mesure, c'est une décomposition
 * cohérente d'une mesure : le total est vrai, la répartition est une
 * illustration. En inventer une qui ne totalise PAS le vsize aurait été
 * la vraie faute.
 *
 * Les trois faits que `pmap` donne et qui sont, eux, entièrement réels :
 * le PID existe ou non (sortie 42 s'il n'existe pas, relevée sur le vrai
 * binaire), la ligne d'en-tête porte la ligne de commande complète, et le
 * total correspond au processus.
 */

import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';

/** Poids relatif de chaque région d'un processus ELF ordinaire. */
const LAYOUT: ReadonlyArray<{ share: number; mode: string; label: 'exe' | 'anon' | 'stack' | 'lib' }> = [
  { share: 0.03, mode: 'r----', label: 'exe' },
  { share: 0.13, mode: 'r-x--', label: 'exe' },
  { share: 0.03, mode: 'r----', label: 'exe' },
  { share: 0.01, mode: 'rw---', label: 'exe' },
  { share: 0.30, mode: 'rw---', label: 'anon' },
  { share: 0.22, mode: 'r-x--', label: 'lib' },
  { share: 0.08, mode: 'r----', label: 'lib' },
  { share: 0.18, mode: 'rw---', label: 'anon' },
  { share: 0.02, mode: 'rw---', label: 'stack' },
];

const BASE_ADDRESS = 0x55c0_0000_0000;

function hex12(n: number): string {
  return n.toString(16).padStart(12, '0');
}

export function runPmap(ctx: LinuxCommandContext, args: string[]): { output: string; exitCode: number } {
  const extended = args.includes('-x') || args.includes('--extended');
  const pids = args.filter((a) => !a.startsWith('-'));
  if (pids.length === 0) {
    return { output: 'Usage:\n pmap [options] PID [PID ...]', exitCode: 1 };
  }

  const out: string[] = [];
  let failed = false;
  for (const raw of pids) {
    const pid = parseInt(raw, 10);
    const proc = Number.isNaN(pid) ? undefined : ctx.executor.processMgr.get(pid);
    if (!proc) { failed = true; continue; }

    out.push(`${pid}:   ${proc.command}`);
    if (extended) out.push('Address           Kbytes     RSS   Dirty Mode  Mapping');

    const totalKib = proc.vsize ?? 0;
    const rssKib = proc.rss ?? 0;
    const exe = (proc.exe ?? proc.comm ?? 'a.out').split('/').pop() ?? 'a.out';
    let address = BASE_ADDRESS;
    let allocated = 0;

    LAYOUT.forEach((region, i) => {
      // La dernière région absorbe l'arrondi pour que la somme des
      // lignes soit EXACTEMENT le vsize annoncé par `ps`.
      const kib = i === LAYOUT.length - 1
        ? Math.max(0, totalKib - allocated)
        : Math.round(totalKib * region.share);
      allocated += kib;
      const mapping = region.label === 'exe' ? exe
        : region.label === 'lib' ? 'libc.so.6'
          : region.label === 'stack' ? '  [ stack ]' : '  [ anon ]';
      if (extended) {
        const rss = Math.round(rssKib * region.share);
        out.push(`${hex12(address)} ${String(kib).padStart(7)} ${String(rss).padStart(7)} `
          + `${String(region.mode.includes('w') ? rss : 0).padStart(7)} ${region.mode} ${mapping}`);
      } else {
        out.push(`${hex12(address)} ${String(kib).padStart(6)}K ${region.mode} ${mapping}`);
      }
      address += (kib + 4) * 1024;
    });

    out.push(extended
      ? `----------------  ------  ------  ------\ntotal kB         ${String(totalKib).padStart(7)} ${String(rssKib).padStart(7)}       0`
      : ` total ${String(totalKib).padStart(16)}K`);
  }

  // Sortie 42 quand aucun PID n'a pu être lu — relevée sur le vrai binaire.
  return { output: out.join('\n'), exitCode: failed && out.length === 0 ? 42 : 0 };
}

export const pmapCommand: LinuxCommand = {
  name: 'pmap',
  needsNetworkContext: true,
  usage: 'pmap [-x] PID [PID ...]',
  manSection: 1,
  help: 'Report memory map of a process.',
  options: [
    { flag: '-x', aliases: ['--extended'], dest: 'extended', description: 'Show the extended format' },
  ],
  run(ctx, args) { return runPmap(ctx, args).output; },
  runWithStatusSync(ctx, args) { return runPmap(ctx, args); },
};
