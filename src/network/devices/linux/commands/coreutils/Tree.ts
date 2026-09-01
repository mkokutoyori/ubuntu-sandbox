/**
 * `tree` — l'arborescence d'un répertoire.
 *
 * Le VFS sait déjà tout ce qu'il faut (`listDirectory` rend le nom et
 * l'inode de chaque entrée) ; il manquait seulement la commande. C'est
 * l'outil qu'on tape en premier pour montrer une hiérarchie — une
 * arborescence `/etc`, un dépôt, un `/var/log` — et son absence obligeait
 * à enchaîner des `ls` répertoire par répertoire.
 *
 * Relevé sur le vrai binaire (tree v2.1.1, Ubuntu 24.04) :
 *
 *     demo
 *     |-- a
 *     |   |-- b
 *     |   |   `-- f2.txt
 *     |   `-- f1.txt
 *     |-- c
 *     |   `-- f3.log
 *     `-- top.md
 *
 *     4 directories, 4 files
 *
 * Deux détails que seule la mesure donne : le décompte **inclut la racine**
 * (4 répertoires ici pour `demo` + `a` + `b` + `c`), et il compte ce qui a
 * été *listé*, pas ce qui a été parcouru — `tree -L 1 demo` annonce donc
 * « 3 directories, 1 file » alors qu'il n'a affiché aucun descendant. Le
 * répertoire illisible se signale sur sa propre ligne
 * (`/nope  [error opening dir]`) et fait sortir en 2, sans interrompre le
 * reste du parcours.
 */

import type { LinuxCommand, LinuxCommandOption } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import type { DirEntry } from '../../VirtualFileSystem';

const TREE_OPTIONS: readonly LinuxCommandOption[] = [
  { flag: '-a', dest: 'all', description: 'All files are listed' },
  { flag: '-d', dest: 'dirsOnly', description: 'List directories only' },
  { flag: '-f', dest: 'fullPath', description: 'Print the full path prefix for each file' },
  { flag: '-L', dest: 'level', takesArg: true, argName: 'level', description: 'Descend only level directories deep' },
  { flag: '--noreport', dest: 'noreport', description: 'Turn off file/directory count at end of tree listing' },
  { flag: '--version', dest: 'version', description: 'Print version and exit' },
];

const VERSION = 'tree v2.1.1 (c) 1996 - 2023 by Steve Baker, Thomas Moore, '
  + 'Francesc Rocher, Florian Sesser, Kyosuke Tokoro';

interface TreeFlags {
  all: boolean;
  dirsOnly: boolean;
  fullPath: boolean;
  level: number;
}

interface Counters {
  dirs: number;
  files: number;
  /** Vrai dès qu'un répertoire n'a pas pu être ouvert — `tree` sort alors en 2. */
  failed: boolean;
}

/** `-a` mis à part, un nom commençant par un point ne se montre pas. */
function visible(name: string, all: boolean): boolean {
  return all || !name.startsWith('.');
}

function sortEntries(entries: DirEntry[]): DirEntry[] {
  return [...entries].sort((a, b) => a.name.localeCompare(b.name, 'en'));
}

export function runTree(ctx: LinuxCommandContext, args: string[]): { output: string; exitCode: number } {
  const flags: TreeFlags = { all: false, dirsOnly: false, fullPath: false, level: Infinity };
  const roots: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--version' || a === '-v') return { output: VERSION, exitCode: 0 };
    if (a === '-L') {
      const n = parseInt(args[++i] ?? '', 10);
      if (Number.isNaN(n) || n < 1) {
        return { output: 'tree: Invalid level, must be greater than 0.', exitCode: 1 };
      }
      flags.level = n;
      continue;
    }
    if (a.startsWith('-') && a.length > 1 && !a.startsWith('--')) {
      for (const ch of a.slice(1)) {
        if (ch === 'a') flags.all = true;
        else if (ch === 'd') flags.dirsOnly = true;
        else if (ch === 'f') flags.fullPath = true;
        else return { output: `tree: Invalid argument -${ch}.`, exitCode: 1 };
      }
      continue;
    }
    if (a.startsWith('--')) continue;
    roots.push(a);
  }

  const noreport = args.includes('--noreport');
  if (roots.length === 0) roots.push('.');

  const vfs = ctx.executor.vfs;
  const cwd = ctx.executor.getCwd();
  const lines: string[] = [];
  const counters: Counters = { dirs: 0, files: 0, failed: false };

  for (const root of roots) {
    const abs = vfs.normalizePath(root, cwd);
    const node = vfs.resolveInode(abs);
    if (!node || node.type !== 'directory') {
      lines.push(`${root}  [error opening dir]`);
      counters.failed = true;
      continue;
    }
    lines.push(root);
    counters.dirs++;
    walk(abs, root, '', 1);
  }

  function walk(abs: string, display: string, prefix: string, depth: number): void {
    if (depth > flags.level) return;
    const raw = vfs.listDirectory(abs);
    if (raw === null) { counters.failed = true; return; }
    const entries = sortEntries(raw).filter((e) => visible(e.name, flags.all))
      .filter((e) => !flags.dirsOnly || e.inode.type === 'directory');

    entries.forEach((e, idx) => {
      const last = idx === entries.length - 1;
      const childDisplay = flags.fullPath
        ? `${display.replace(/\/$/, '')}/${e.name}`
        : e.name;
      lines.push(`${prefix}${last ? '`-- ' : '|-- '}${childDisplay}`);
      if (e.inode.type === 'directory') counters.dirs++;
      else counters.files++;
      if (e.inode.type === 'directory') {
        walk(`${abs.replace(/\/$/, '')}/${e.name}`,
          flags.fullPath ? childDisplay : e.name,
          `${prefix}${last ? '    ' : '|   '}`, depth + 1);
      }
    });
  }

  if (!noreport) {
    // Le décompte porte sur ce qui a été *listé* et compte la racine
    // elle-même — mesuré sur le vrai binaire, pas déduit (voir l'en-tête).
    const d = `${counters.dirs} director${counters.dirs === 1 ? 'y' : 'ies'}`;
    lines.push('');
    lines.push(flags.dirsOnly ? d : `${d}, ${counters.files} file${counters.files === 1 ? '' : 's'}`);
  }

  return { output: lines.join('\n'), exitCode: counters.failed ? 2 : 0 };
}

export const treeCommand: LinuxCommand = {
  name: 'tree',
  package: 'tree',
  needsNetworkContext: true,
  usage: 'tree [-adf] [-L level] [--noreport] [directory ...]',
  manSection: 1,
  options: TREE_OPTIONS,
  help: 'List contents of directories in a tree-like format.',
  run(ctx, args) { return runTree(ctx, args).output; },
  runWithStatusSync(ctx, args) { return runTree(ctx, args); },
};
