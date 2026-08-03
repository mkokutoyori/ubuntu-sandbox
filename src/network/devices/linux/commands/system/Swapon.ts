/**
 * `swapon` — les espaces d'échange.
 *
 * `MemoryProfile` porte déjà `swapTotalKib` et `swapUsedKib`, et `free`
 * les affiche depuis toujours ; il manquait seulement la commande qui les
 * nomme. Un `free` qui annonce 2 Gio de swap sur une machine dont
 * `swapon --show` ne répond rien est une machine qui se contredit.
 *
 * Relevé sur la machine de référence : un système SANS swap répond **rien
 * du tout** et sort en 0 — ni en-tête, ni message. C'est le comportement
 * modélisé, et c'est pour ça que la sortie est vide quand `swapTotalKib`
 * vaut zéro plutôt qu'un tableau à en-tête seul.
 *
 * Ce qui n'est PAS modélisé : activer ou désactiver un espace. `swapon
 * /swapfile` et `swapoff` sont refusés plutôt que silencieusement
 * acceptés — il n'existe aucun sous-système de pagination derrière, et
 * faire semblant d'ajouter un espace que rien ne consommerait ferait
 * mentir `free` juste après.
 */

import type { LinuxCommand, LinuxCommandOption } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';

const SWAPON_OPTIONS: readonly LinuxCommandOption[] = [
  { flag: '-s', aliases: ['--summary'], dest: 'summary', description: 'Display swap usage summary by device' },
  { flag: '--show', dest: 'show', description: 'Display a definable table of swap areas' },
  { flag: '--bytes', dest: 'bytes', description: 'Display swap size in bytes in --show output' },
];

/** `KiB` → une taille lisible, la conversion que `--show` fait par défaut. */
function human(kib: number): string {
  if (kib >= 1024 * 1024) return `${(kib / 1024 / 1024).toFixed(kib % (1024 * 1024) === 0 ? 0 : 1)}G`;
  if (kib >= 1024) return `${Math.round(kib / 1024)}M`;
  return `${kib}K`;
}

export function runSwapon(ctx: LinuxCommandContext, args: string[]): { output: string; exitCode: number } {
  const mem = ctx.executor.hardware.memory;
  const summary = args.includes('-s') || args.includes('--summary');
  const show = args.some((a) => a === '--show' || a.startsWith('--show='));
  const bytes = args.includes('--bytes');
  const positional = args.filter((a) => !a.startsWith('-'));

  if (positional.length > 0 || args.includes('-a') || args.includes('--all')) {
    // Refus assumé : il n'y a pas de pagination derrière, et accepter
    // ajouterait un espace que rien ne consommerait.
    const target = positional[0] ?? '';
    return {
      output: `swapon: ${target}: swap areas cannot be activated on this system`,
      exitCode: 255,
    };
  }

  if (mem.swapTotalKib === 0) return { output: '', exitCode: 0 };

  if (summary) {
    return {
      output: [
        'Filename\t\t\t\tType\t\tSize\t\tUsed\t\tPriority',
        `/swapfile                               file\t\t${mem.swapTotalKib}\t\t${mem.swapUsedKib}\t\t-2`,
      ].join('\n'),
      exitCode: 0,
    };
  }

  // `--show` est la vue par défaut de swapon(8) depuis util-linux 2.26.
  void show;
  const size = bytes ? String(mem.swapTotalKib * 1024) : human(mem.swapTotalKib);
  const used = bytes ? String(mem.swapUsedKib * 1024) : human(mem.swapUsedKib);
  return {
    output: [
      'NAME       TYPE      SIZE USED PRIO',
      `/swapfile  file  ${size.padStart(8)} ${used.padStart(4)}   -2`,
    ].join('\n'),
    exitCode: 0,
  };
}

export const swaponCommand: LinuxCommand = {
  name: 'swapon',
  needsNetworkContext: true,
  usage: 'swapon [-s] [--show] [--bytes]',
  manSection: 8,
  binaryPath: '/usr/sbin/swapon',
  options: SWAPON_OPTIONS,
  help: 'Enable devices and files for paging and swapping, or list those in use.',
  run(ctx, args) { return runSwapon(ctx, args).output; },
  runWithStatusSync(ctx, args) { return runSwapon(ctx, args); },
};

export const swapoffCommand: LinuxCommand = {
  name: 'swapoff',
  needsNetworkContext: true,
  usage: 'swapoff [-a] [specialfile ...]',
  manSection: 8,
  binaryPath: '/usr/sbin/swapoff',
  help: 'Disable devices and files for paging and swapping.',
  runWithStatusSync(ctx: LinuxCommandContext, args: string[]) {
    const target = args.find((a) => !a.startsWith('-')) ?? '';
    if (ctx.executor.hardware.memory.swapTotalKib === 0 && !target) {
      return { output: '', exitCode: 0 };
    }
    return {
      output: `swapoff: ${target || '-a'}: swap areas cannot be deactivated on this system`,
      exitCode: 255,
    };
  },
  run(ctx: LinuxCommandContext, args: string[]): string {
    return this.runWithStatusSync!(ctx, args).output;
  },
};
