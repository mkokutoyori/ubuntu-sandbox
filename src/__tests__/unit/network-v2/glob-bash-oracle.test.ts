/*
 * glob(3) / fnmatch(3) : le motif `*.log`, `[!a]`, `[[:upper:]]`, `\*`, `.*` et
 * `dir*\/` se developpent comme dans un vrai bash (GNU bash 5.2, Ubuntu 24.04,
 * locale C) sur le meme arbre de fichiers.
 *
 * L'oracle est enregistre dans support/oracle/glob-bash.json : 56 motifs, l'arbre
 * (fichiers, repertoires, liens dont un casse, noms avec espace, `[` et `?`) et la
 * liste que bash a reellement produite, motif conserve quand rien ne correspond
 * (GLOB_NOCHECK). Le developpement de la VFS (`globExpand`) etait une
 * approximation : mesure avant correctif, 17 des 56 motifs divergeaient (`*`
 * rendait les fichiers caches, `[!a]` et les classes POSIX `[[:upper:]]` n'etaient
 * pas compris, `dir*\/` perdait sa barre finale, l'ordre n'etait pas celui de la
 * locale C). `globExpand` et `globMatch` de la VFS delegent maintenant au module
 * partage `fs/Glob.ts`, que ce fichier exerce.
 *
 * Le seul ecart conserve est celui de la suppression des guillemets par bash : un
 * motif sans correspondance contenant `\\` est rendu tel quel par glob(3) avec
 * GLOB_NOCHECK, et sans la barre par bash. Le TEMOIN est le motif sans meta
 * (`a.log`), qui doit rendre le fichier lui-meme.
 */
import { describe, it, expect } from 'vitest';
import oracle from '../../support/oracle/glob-bash.json';
import { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { globPaths, type GlobFileSystem } from '@/network/devices/linux/fs/Glob';

const BASE = '/tmp/claude-0/globlab/t';

function lab(): { fs: GlobFileSystem; vfs: VirtualFileSystem } {
  const vfs = new VirtualFileSystem();
  vfs.mkdirp(BASE, 0o755, 0, 0);
  for (const entry of oracle.tree) {
    const path = `${BASE}/${entry.path}`;
    if (entry.type === 'dir') vfs.mkdirp(path, 0o755, 0, 0);
    else if (entry.type === 'symlink') vfs.createSymlink(path, entry.target as string, 0, 0);
    else vfs.writeFile(path, 'x', 0, 0, 0o022);
  }
  const fs: GlobFileSystem = {
    listNames: (dir) => vfs.listDirectory(dir)?.map((e) => e.name).filter((n) => n !== '.' && n !== '..') ?? null,
    existsNoFollow: (path) => vfs.existsNoFollow(path),
    isDirectory: (path) => vfs.getType(path) === 'directory',
  };
  return { fs, vfs };
}

describe('glob(3) contre bash', () => {
  const { fs } = lab();
  for (const c of oracle.cases) {
    it(`motif ${JSON.stringify(c.pattern)}`, () => {
      const absolute = c.pattern.startsWith('/');
      const pattern = absolute ? c.pattern : `${BASE}/${c.pattern}`;
      const got = globPaths(fs, pattern, { noCheck: true });
      const normalised = got.map((p) => (absolute ? p : p.replace(`${BASE}/`, '')));
      const quoteRemoved = c.pattern.includes('\\') && normalised.length === 1 && normalised[0] === c.pattern
        && c.result.length === 1 && c.result[0] === c.pattern.replace(/\\(.)/g, '$1');
      if (quoteRemoved) return;
      expect(normalised).toEqual(c.result);
    });
  }
});
