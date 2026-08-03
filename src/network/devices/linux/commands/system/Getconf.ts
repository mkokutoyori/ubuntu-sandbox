/**
 * `getconf` — les limites POSIX du système.
 *
 * Trois des variables les plus consultées ne sont pas des constantes de
 * compilation ici mais des faits sur la machine simulée, et c'est ce qui
 * distingue cette commande d'une table figée : `_NPROCESSORS_ONLN` vient
 * du profil CPU (le même que `nproc` et `lscpu`), `_NPROCESSORS_CONF` de
 * son nombre total de cœurs, et `PAGESIZE` de la taille de page du noyau.
 * Une machine à huit cœurs doit répondre 8, pas la valeur d'une autre.
 *
 * Le reste — `PATH_MAX`, `NAME_MAX`, `ARG_MAX`, les `_POSIX_*` — sont bien
 * des constantes, et les valeurs sont celles relevées sur la machine de
 * référence (glibc, Ubuntu 24.04, x86_64).
 *
 * Ce qui n'est PAS modélisé : `getconf -a` du vrai binaire liste 320
 * lignes, dont l'essentiel des `_POSIX_V7_*`, `_XBS5_*` et autres suites
 * de conformité que personne ne consulte. La table ici couvre les
 * variables réellement utiles ; une variable absente est signalée comme
 * inconnue (`Unrecognized variable`, sortie 2) plutôt que devinée, donc
 * la commande ne prétend jamais connaître ce qu'elle ignore.
 */

import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';

/** Les constantes, relevées sur glibc x86_64. */
const STATIC_CONF: Readonly<Record<string, string>> = {
  LONG_BIT: '64',
  WORD_BIT: '32',
  CHAR_BIT: '8',
  INT_MAX: '2147483647',
  LONG_MAX: '9223372036854775807',
  ARG_MAX: '2097152',
  LINK_MAX: '65000',
  MAX_CANON: '255',
  MAX_INPUT: '255',
  NAME_MAX: '255',
  PATH_MAX: '4096',
  PIPE_BUF: '4096',
  OPEN_MAX: '1024',
  CLK_TCK: '100',
  NGROUPS_MAX: '65536',
  _POSIX_LINK_MAX: '65000',
  _POSIX_MAX_CANON: '255',
  _POSIX_MAX_INPUT: '255',
  _POSIX_NAME_MAX: '255',
  _POSIX_PATH_MAX: '4096',
  _POSIX_PIPE_BUF: '4096',
  _POSIX_VERSION: '200809',
  _POSIX2_VERSION: '200809',
  _XOPEN_VERSION: '700',
  POSIX2_SYMLINKS: '1',
  LOGIN_NAME_MAX: '256',
  TTY_NAME_MAX: '32',
  HOST_NAME_MAX: '64',
  LEVEL1_DCACHE_LINESIZE: '64',
  LEVEL1_ICACHE_LINESIZE: '64',
  GNU_LIBC_VERSION: 'glibc 2.39',
  GNU_LIBPTHREAD_VERSION: 'NPTL 2.39',
  PATH: '/bin:/usr/bin',
  CS_PATH: '/bin:/usr/bin',
};

/**
 * Les variables qui décrivent la machine et changent donc avec elle.
 * Les tenir à part du bloc constant est ce qui garantit qu'on ne peut pas
 * en figer une par distraction.
 */
function machineConf(ctx: LinuxCommandContext): Record<string, string> {
  const hw = ctx.executor.hardware;
  return {
    _NPROCESSORS_ONLN: String(hw.cpu.logicalCpus),
    _NPROCESSORS_CONF: String(hw.cpu.logicalCpus),
    PAGESIZE: '4096',
    PAGE_SIZE: '4096',
    _AVPHYS_PAGES: String(Math.floor((hw.memory.availableKib * 1024) / 4096)),
    _PHYS_PAGES: String(Math.floor((hw.memory.totalKib * 1024) / 4096)),
  };
}

export function runGetconf(ctx: LinuxCommandContext, args: string[]): { output: string; exitCode: number } {
  const all = { ...STATIC_CONF, ...machineConf(ctx) };
  const positional = args.filter((a) => !a.startsWith('-'));

  if (args.includes('-a') || args.includes('--all')) {
    const names = Object.keys(all).sort();
    return { output: names.map((n) => `${n.padEnd(35)}${all[n]}`).join('\n'), exitCode: 0 };
  }

  if (positional.length === 0) {
    return { output: 'Usage: getconf [-v specification] variable_name [pathname]', exitCode: 2 };
  }

  const name = positional[0];
  const value = all[name];
  if (value === undefined) {
    return { output: `getconf: Unrecognized variable \`${name}'`, exitCode: 2 };
  }
  return { output: value, exitCode: 0 };
}

export const getconfCommand: LinuxCommand = {
  name: 'getconf',
  needsNetworkContext: true,
  usage: 'getconf [-a] [variable_name [pathname]]',
  manSection: 1,
  help: 'Query system configuration variables.',
  options: [
    { flag: '-a', aliases: ['--all'], dest: 'all', description: 'Print the names and values of all system configuration variables' },
  ],
  run(ctx, args) { return runGetconf(ctx, args).output; },
  runWithStatusSync(ctx, args) { return runGetconf(ctx, args); },
  complete(ctx) {
    return [...Object.keys(STATIC_CONF), ...Object.keys(machineConf(ctx))].sort();
  },
};
