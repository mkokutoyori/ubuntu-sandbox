/**
 * La ligne de commande de nano rejouee contre un vrai GNU nano 7.2 (scripts/oracle/record_nano_screen.py
 * --corpus cli et place, `nano -I`) : chaque cas est un vecteur d'arguments complet.  nano tourne d'abord
 * sans terminal pour savoir s'il imprime et sort (sortie standard, erreur standard, code de sortie) ou s'il
 * ouvre l'editeur ; dans ce second cas un second lancement dans un pane tmux enregistre le premier ecran, la
 * cellule du curseur et quelques etapes (`^W`, fleches).
 *   - cli : options groupees (`-ilc`), arguments colles ou separes (`-T4`, `-T 4`, `--tabsize=4`), options
 *     longues abregees (`--tabsi`), ambigues (`--no`, `--tab=`), inconnues, `--`, options apres le fichier,
 *     nombres invalides pour `-T -r -J`, `-h -V` et leurs abreviations, `+LIGNE[,COLONNE]`, `+/motif`,
 *     `+?motif`, modificateurs `c C r R`, plusieurs fichiers ;
 *   - place : `+`, `+-1`, `+99`, `+N`, `+N,C` avec `-S`, `-Sl`, `-l` sur des tampons de 3 a 60 lignes dans des
 *     fenetres de 8 a 24 lignes : ou le saut place la fenetre.
 *
 * Methode : le comportement de nano.c (boucle getopt_long, `parse_line_column`, `goto_line_and_column`,
 * `statusline`) a ete lu dans une version plus recente (8.x) et confronte au binaire 7.2, qui fait foi
 * quand ils divergent : le jeu d'options et l'ordre de la table des options longues (celui de la liste des
 * candidates d'une abreviation ambigue) viennent du binaire, comme les separateurs de `+L,C` (virgule,
 * point, point-virgule, barre oblique, blanc ; pas le deux-points).  La fenetre se place comme
 * `goto_line_and_column(..., hugfloor)` : au centre sauf si la ligne est a moins d'une demi-fenetre de la
 * fin, auquel cas la derniere ligne colle au bas ; le calcul se fait SANS la marge des numeros de ligne
 * (elle n'est posee qu'a la premiere iteration de la boucle principale), puis le premier dessin recentre le
 * curseur s'il est sorti de l'ecran.  Un message d'alerte pose a l'analyse (modificateur invalide, nombre
 * invalide, motif vide) masque les messages de moindre importance, et une seconde alerte ajoute « ... » a la
 * premiere.
 *
 * Mesure : avec l'ancien analyseur (`parseEditorArgs`, qui ne connaissait que `-v -c -l -S` et les quatre
 * mots `-h -V --help --version`) 52 cas sur 300 (cli seed 1), 65 (seed 2) et 63 (seed 3) ne sont pas
 * classes comme nano le fait (imprime et sort, ou ouvre) ; ce fichier-ci ne se charge meme pas sur le code
 * precedent (NanoCommandLine n'existe pas).  Le seed 1 de chaque corpus a guide les reglages, les seeds 2 et 3
 * ont ete enregistres ensuite et n'ont rien fait changer : place 0/300 et 0/300, cli 2/300 et 1/300 (les trois
 * cas ci-dessous).
 *
 * Seules les options dont l'effet est porte (SCREEN_PORTED_FLAGS) sont rejouees sur l'ecran ; avec les autres, le test verifie le classement (imprime, refuse ou ouvre) et le
 * texte, pas le premier ecran, tant que leur effet n'est pas evalue : voir SCREEN_PORTED_FLAGS.
 *
 * Divergences connues, mesurees et NON portees (UNPORTED_CASES) : 4 cas sur 1800.  Aucun n'est epingle comme
 * contrat : un cas de la liste qui se met a passer fait echouer le test pour qu'on le retire.
 *   - cli1-255, cli2-17, cli2-148, cli3-180 : un fichier dont le dossier n'existe pas (`+C/Foo` est un chemin) : nano
 *     affiche `[ Directory '+C' does not exist ]` au lieu de `[ New File ]`.  EditorFsContext ne sait pas
 *     dire qu'un chemin est un dossier ; `"x" is a directory`, `is meant to be read-only` et les fichiers de
 *     peripherique sont dans le meme cas.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { replayNanoCliCase, type NanoCliCase } from '../../support/oracle/nanoCliReplay';

const dir = 'src/__tests__/support/oracle/nano-cli';
const fixtures = readdirSync(dir).filter((f) => f.startsWith('nano-7.2')).sort()
  .map((f) => ({ name: f, ...(JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')) as { nano: string; cases: NanoCliCase[] }) }));

const UNPORTED_CASES: ReadonlySet<string> = new Set(['cli1-255', 'cli2-17', 'cli2-148', 'cli3-180']);

describe('nano command lines recorded from a real nano', () => {
  for (const fixture of fixtures) {
    it(`${fixture.name} gives the same output, status and first screen`, () => {
      const outcomes = fixture.cases.map((c) => ({ id: c.id, failure: replayNanoCliCase(c) }));
      const unexpected = outcomes.filter((o) => o.failure !== null && !UNPORTED_CASES.has(o.id)).map((o) => o.failure);
      const nowPassing = outcomes.filter((o) => o.failure === null && UNPORTED_CASES.has(o.id)).map((o) => o.id);
      expect(unexpected.length > 0 ? `${unexpected.length} of ${fixture.cases.length}\n${unexpected.slice(0, 4).join('\n')}` : '').toBe('');
      expect(nowPassing).toEqual([]);
    });
  }
});
