/**
 * `lsb_release` — l'identité de la distribution.
 *
 * `OsRelease` disait déjà, dans son propre en-tête, être « la source unique
 * derrière `/etc/os-release`, `/etc/lsb-release`, la ligne
 * `Operating System` de `hostnamectl` **et la commande `lsb_release`** ».
 * Les trois premières existaient ; la quatrième, non. Encore un moteur
 * sans porte.
 *
 * La commande lit **les fichiers**, pas le modèle en mémoire, et c'est
 * délibéré : c'est ce que fait le vrai `lsb_release`, et c'est ce qui rend
 * `rm /etc/lsb-release` observable. Sans fichier ni l'un ni l'autre, la
 * distribution devient `n/a` — la réponse du vrai binaire sur un système
 * dépourvu de ces fichiers, pas une erreur.
 *
 * L'ordre importe : `/etc/lsb-release` prime sur `/etc/os-release` pour
 * les champs qu'il porte, parce que c'est le fichier spécifique à LSB, et
 * `os-release` sert de repli — supprimer l'un laisse donc l'autre
 * répondre, ce qui est exactement le comportement réel.
 *
 * Relevé sur la machine de référence :
 *
 *     Distributor ID:␉Ubuntu
 *     Description:␉Ubuntu 24.04.4 LTS
 *     Release:␉24.04
 *     Codename:␉noble
 *
 * Le séparateur est une **tabulation**, pas des espaces — c'est ce qui
 * fait marcher `lsb_release -a | cut -f2`.
 */

import type { LinuxCommand, LinuxCommandOption } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';

const LSB_OPTIONS: readonly LinuxCommandOption[] = [
  { flag: '-a', aliases: ['--all'], dest: 'all', description: 'Show all of the below information' },
  { flag: '-i', aliases: ['--id'], dest: 'id', description: 'Show distributor ID' },
  { flag: '-d', aliases: ['--description'], dest: 'description', description: 'Show description of this distribution' },
  { flag: '-r', aliases: ['--release'], dest: 'release', description: 'Show release number of this distribution' },
  { flag: '-c', aliases: ['--codename'], dest: 'codename', description: 'Show code name of this distribution' },
  { flag: '-s', aliases: ['--short'], dest: 'short', description: 'Show requested information in short format' },
  { flag: '-v', aliases: ['--version'], dest: 'version', description: 'Show LSB modules this system supports' },
];

const NA = 'n/a';

interface DistroFacts {
  id: string;
  description: string;
  release: string;
  codename: string;
}

/** `KEY=value` / `KEY="value"`, le format partagé des deux fichiers. */
function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    out[m[1]] = m[2].trim().replace(/^"(.*)"$/, '$1');
  }
  return out;
}

export function readDistroFacts(ctx: LinuxCommandContext): DistroFacts {
  const vfs = ctx.executor.vfs;
  const lsb = parseEnvFile(vfs.readFile('/etc/lsb-release') ?? '');
  const os = parseEnvFile(vfs.readFile('/etc/os-release') ?? '');
  return {
    id: lsb.DISTRIB_ID ?? os.NAME ?? NA,
    description: lsb.DISTRIB_DESCRIPTION ?? os.PRETTY_NAME ?? NA,
    release: lsb.DISTRIB_RELEASE ?? os.VERSION_ID ?? NA,
    codename: lsb.DISTRIB_CODENAME ?? os.VERSION_CODENAME ?? NA,
  };
}

/**
 * Éclate les options courtes groupées : `-cs` vaut `-c -s`. Mesuré, et
 * corrigé après coup — un `args.includes('-c')` naïf laissait
 * `lsb_release -cs` (la forme qu'on écrit réellement dans un script)
 * tomber dans le cas « aucune sélection » et répondre la version LSB.
 */
function expandShortFlags(args: string[]): string[] {
  const out: string[] = [];
  for (const a of args) {
    if (/^-[a-z]{2,}$/i.test(a)) out.push(...[...a.slice(1)].map((c) => `-${c}`));
    else out.push(a);
  }
  return out;
}

export function runLsbRelease(ctx: LinuxCommandContext, argv: string[]): { output: string; exitCode: number } {
  const args = expandShortFlags(argv);
  const has = (...names: string[]) => names.some((n) => args.includes(n));
  const short = has('-s', '--short');
  const facts = readDistroFacts(ctx);

  if (has('-h', '--help')) {
    return {
      output: [
        'Usage: lsb_release [options]',
        '',
        'Options:',
        '  -h, --help         show this help message and exit',
        '  -v, --version      show LSB modules this system supports',
        '  -i, --id           show distributor ID',
        '  -d, --description  show description of this distribution',
        '  -r, --release      show release number of this distribution',
        '  -c, --codename     show code name of this distribution',
        '  -a, --all          show all of the above information',
        '  -s, --short        show requested information in short format',
      ].join('\n'),
      exitCode: 0,
    };
  }

  const wanted: Array<[string, string]> = [];
  const all = has('-a', '--all');
  if (has('-v', '--version')) wanted.push(['LSB Version', NA]);
  if (all || has('-i', '--id')) wanted.push(['Distributor ID', facts.id]);
  if (all || has('-d', '--description')) wanted.push(['Description', facts.description]);
  if (all || has('-r', '--release')) wanted.push(['Release', facts.release]);
  if (all || has('-c', '--codename')) wanted.push(['Codename', facts.codename]);

  // Sans option de sélection, le vrai binaire n'affiche que la version LSB.
  if (wanted.length === 0) wanted.push(['LSB Version', NA]);

  const lines = wanted.map(([label, value]) => (short ? value : `${label}:\t${value}`));
  return { output: lines.join('\n'), exitCode: 0 };
}

export const lsbReleaseCommand: LinuxCommand = {
  name: 'lsb_release',
  package: 'lsb-release',
  needsNetworkContext: true,
  usage: 'lsb_release [-adcirsv]',
  manSection: 1,
  options: LSB_OPTIONS,
  help: 'Print certain LSB and distribution-specific information.',
  run(ctx, args) { return runLsbRelease(ctx, args).output; },
  runWithStatusSync(ctx, args) { return runLsbRelease(ctx, args); },
};
