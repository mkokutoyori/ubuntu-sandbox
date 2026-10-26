/*
 * Le paquet nano d'Ubuntu (`/etc/nanorc` et les fichiers de `/usr/share/nano`) lu par le moteur, rejoue contre un vrai GNU nano 7.2 qui
 * lit les MEMES fichiers (scripts/oracle/record_nano_screen.py --corpus package, tmux 3.4, TERM=xterm-256color, ni -I ni /etc/nanorc
 * monte a la main : le binaire lit le vrai /etc/nanorc d'Ubuntu, c'est-a-dire `set historylog`, `set locking`, `set stateflags` et
 * `include "/usr/share/nano/*.nanorc"`).  Le recorder note, pour CHAQUE cellule, la couleur de premier plan et de fond et les attributs ;
 * le rejeu seme le systeme de fichiers du moteur avec NanoPackageFiles.ts, que scripts/oracle/export_nano_package.py exporte octet pour
 * octet du paquet.  Chaque cas ouvre un fichier tire au hasard : une fenetre de 6 a 40 lignes d'un VRAI fichier de la machine
 * d'enregistrement (c, h, cc, hpp, py, sh, bash, pl, pm, json, yaml, xml, html, css, js, go, rb, sql, md, s, 1, 5, cmake, txt, conf, el,
 * tcl, mk), un exemple ecrit a la main pour les langages sans fichier reel (java, rs, patch, scm, hs, ml, ac, nft, tex, texi, php, lua,
 * awk, po, m, eml, ChangeLog, spec, pov, nanorc, ms, list) ou un fichier choisi par son en-tete (`#!/bin/sh`, `<?xml`, `<!DOCTYPE html>`,
 * `-*- C -*-`...) ou son nom (Makefile, CMakeLists.txt, sources.list), 0 a 2 options parmi -l -S -q -c -x -0 -_ -D -% -v -E -A -J, parfois
 * -Y, puis 2 a 8 gestes (deplacements, frappe de guillemets, commentaires et crochets qui ouvrent ou ferment une regle multi-lignes, M-3,
 * Tab, M-Y, recherche, selection, ^O sous un autre nom).
 *
 * Methode : le binaire 7.2-2ubuntu0.2 tranche ; les sources du tarball nano_7.2.orig (winio.c, text.c) disent pourquoi.  Le seed 1 a guide
 * les reglages ; les seeds 2 et 3 ont ete enregistres ensuite.  Les regles mesurees sont dans probe-nano-package.test.ts (115 laboratoires).
 *
 * Mesure : sans les fichiers du paquet (rejeu seme sans NanoPackageFiles) 200 cas sur 200 tombent, pour chaque seed (aucune couleur, ni
 * `historylog`, `locking`, `stateflags`) ; avec le moteur du commit precedent et les fichiers, 4, 3 et 4 cas sur 200 tombaient encore, pour
 * deux raisons que ce changement corrige : une plage peinte ne s'arrete pas a la largeur du texte (elle recouvrait la colonne de la barre
 * de defilement de `-q`), et `M-3`, Tab sur une selection et `M-{` recalculaient la colonne voulue du curseur alors que nano ne la change
 * que si la ligne courante a ete modifiee (text.c : comment_line, indent_a_line, compensate_leftward).  0 apres, hors deux cas non portes.
 *
 * Cas non portes, 2 sur 600, tous mesures (un cas de la liste qui se met a passer fait echouer le test) :
 *   - repeint incremental (pkg1-128, pkg2-2) : le guide `-J` que le moteur dessine sur la rangee de la nouvelle ligne magique, que nano ne
 *     repeint pas ; voir TODO.md, « le repeint incremental ».
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { replayNanoStateCase, type NanoStateCase } from '../../support/oracle/nanoStateReplay';

const dir = 'src/__tests__/support/oracle/nano-package';
const fixtures = readdirSync(dir).filter((f) => f.startsWith('nano-7.2')).sort()
  .map((f) => ({ name: f, ...(JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')) as { nano: string; cases: NanoStateCase[] }) }));

const UNPORTED_CASES: ReadonlySet<string> = new Set([
  'pkg1-128', 'pkg2-2',
]);

describe('nano with the files of the Ubuntu package recorded from a real nano', () => {
  for (const fixture of fixtures) {
    it(`${fixture.name} replays rows, cursor and the colour of every cell`, () => {
      const outcomes = fixture.cases.map((c) => ({ id: c.id, failure: replayNanoStateCase(c) }));
      const unexpected = outcomes.filter((o) => o.failure !== null && !UNPORTED_CASES.has(o.id)).map((o) => o.failure);
      const nowPassing = outcomes.filter((o) => o.failure === null && UNPORTED_CASES.has(o.id)).map((o) => o.id);
      expect(unexpected.length > 0 ? `${unexpected.length} of ${fixture.cases.length}\n${unexpected.slice(0, 4).join('\n')}` : '').toBe('');
      expect(nowPassing).toEqual([]);
    });
  }
});
