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
import { padToWidth } from '@/network/devices/shells/cli/TextTable';

/** Les constantes, relevées sur glibc x86_64. */
const STATIC_CONF: Readonly<Record<string, string>> = {
  LONG_BIT: '64',
  WORD_BIT: '32',
  CHAR_BIT: '8',
  INT_MAX: '2147483647',
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
  POSIX2_VERSION: '200809',
  _XOPEN_VERSION: '700',
  POSIX2_SYMLINKS: '1',
  FILESIZEBITS: '64',
  _POSIX_CHOWN_RESTRICTED: '1',
  _POSIX_NO_TRUNC: '1',
  _POSIX_VDISABLE: '0',
  POSIX_ALLOC_SIZE_MIN: '4096',
  LOGIN_NAME_MAX: '256',
  TTY_NAME_MAX: '32',
  HOST_NAME_MAX: '64',
  LEVEL1_DCACHE_LINESIZE: '64',
  LEVEL1_ICACHE_LINESIZE: '64',
  GNU_LIBC_VERSION: 'glibc 2.35',
  GNU_LIBPTHREAD_VERSION: 'NPTL 2.35',
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

const PATH_VARIABLES: ReadonlySet<string> = new Set([
  'LINK_MAX', 'MAX_CANON', 'MAX_INPUT', 'NAME_MAX', 'PATH_MAX', 'PIPE_BUF', '_POSIX_LINK_MAX', '_POSIX_MAX_CANON', '_POSIX_MAX_INPUT',
  '_POSIX_NAME_MAX', '_POSIX_PATH_MAX', '_POSIX_PIPE_BUF', 'POSIX2_SYMLINKS', 'FILESIZEBITS', '_POSIX_CHOWN_RESTRICTED', '_POSIX_NO_TRUNC',
  '_POSIX_VDISABLE', 'POSIX_ALLOC_SIZE_MIN',
]);

const USAGE = 'Usage: getconf [-v specification] variable_name [pathname]\n       getconf -a [pathname]';

const HELP = `Usage: getconf [-v SPEC] VAR
  or:  getconf [-v SPEC] PATH_VAR PATH

Get the configuration value for variable VAR, or for variable PATH_VAR
for path PATH.  If SPEC is given, give values for compilation
environment SPEC.

For bug reporting instructions, please see:
<https://bugs.launchpad.net/ubuntu/+source/glibc/+bugs>.`;

const VERSION = `getconf (Ubuntu GLIBC 2.35-0ubuntu3.4) 2.35
Copyright (C) 2022 Free Software Foundation, Inc.
This is free software; see the source for copying conditions.  There is NO
warranty; not even for MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
Written by Roland McGrath.`;

type GetconfOutcome = { output: string; exitCode: number; stderr?: string; interleaved?: string };

function getconfFailure(text: string, status: number): GetconfOutcome {
  return { output: '', stderr: `${text}\n`, interleaved: `${text}\n`, exitCode: status };
}

export function runGetconf(ctx: LinuxCommandContext, args: string[]): GetconfOutcome {
  const all = { ...STATIC_CONF, ...machineConf(ctx) };
  if (args[0] === '--help') return { output: HELP, exitCode: 0 };
  if (args[0] === '--version') return { output: VERSION, exitCode: 0 };
  let index = 0;
  if (args[index]?.startsWith('-v')) {
    if (args[index].length === 2 && args[index + 1] === undefined) return getconfFailure(USAGE, 2);
    index += args[index].length > 2 ? 1 : 2;
  }
  const listing = args[index] === '-a';
  if (listing) index++;
  const operands = args.slice(index);
  if (listing) {
    if (operands.length > 1) return getconfFailure(USAGE, 2);
    const names = Object.keys(all).sort();
    return { output: names.map((n) => `${padToWidth(n, 35)}${all[n]}`).join('\n'), exitCode: 0 };
  }
  if (operands.length === 0 || operands.length > 2) return getconfFailure(USAGE, 2);
  const name = operands[0];
  const value = all[name];
  if (value === undefined) return getconfFailure(`getconf: Unrecognized variable \`${name}'`, 2);
  if (PATH_VARIABLES.has(name) !== (operands.length === 2)) return getconfFailure(USAGE, 2);
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
