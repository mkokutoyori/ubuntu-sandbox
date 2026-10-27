/*
 * Sonde de la souris de nano (`-m`, `M-M`), un laboratoire minimal par regle, enregistres sur nano 7.2
 * (scripts/oracle/record_nano_screen.py --corpus cli --from labs.json --workdir /tmp/nano-lab, tmux 3.4).  Les
 * evenements sont des rapports xterm SGR injectes dans le pane (`click@LIGNE,COL` = appui et relachement de
 * bouton 1, `wheel-up@` et `wheel-down@` = boutons 4 et 5), exactement ce qu'un terminal enverrait.
 *
 * Mesure : nano 7.2 ne demande la souris au terminal qu'avec `-m` ou apres `M-M` (« Mouse support enabled /
 * disabled ») ; sans elle le moteur ignore les evenements, comme un terminal ne les enverrait pas.  Clic dans le
 * texte : le curseur va a la cellule, au bout de la ligne si on clique plus loin, a la derniere ligne sous le
 * texte ; la colonne s'ajoute au decalage horizontal de la fenetre pour TOUTES les rangees (le decalage vient de
 * la colonne du curseur) ; un clic sur les numeros de ligne ne fait rien ; un second clic sur la cellule du curseur
 * bascule la marque (« Mark Set / Unset ») ; la colonne de la barre `-q` n'est PAS une barre cliquable en 7.2 (le
 * saut proportionnel du source 8.x n'y existe pas) : c'est un clic ordinaire.  Clic sur une barre de raccourcis :
 * l'element cliquee est l'indice `(x / largeur) * 2 + rangee` (largeur = COLS / ((n + 1) / 2), les deux derniers
 * elargis), et nano rejoue sa touche ; dans les invites et l'aide la meme regle s'applique a leurs barres ; sur
 * la question oui/non Y, N, A et ^C se cliquent.  Clic sur la rangee d'etat d'une invite : le curseur de la
 * reponse va a la colonne cliquee, SAUF a gauche de la premiere colonne de la reponse (calculee avec l'etiquette
 * COUPEE), ou il ne bouge pas.  Molette : trois fois Haut ou Bas dans la fenetre d'edition et sur la rangee
 * d'etat, rien sur le titre ni sur les barres (le source 8.x en fait deux defilements : le binaire 7.2 fait foi).
 * Tout evenement, meme ignore, compte comme une touche : il use un message et, avec `-c`, repose le rapport de
 * position ; dans l'aide il efface le message « Unbound key ».
 *
 * Mesure avec `git stash` du moteur (l'ancien `clickAt` etait toujours actif, ignorait les barres, les invites
 * et la molette de nano) : 29 des 44 tests tombent avant, 0 apres.  Les 15 qui passent avant comme apres : le test
 * de chargement (structurel), ms-witness (TEMOIN : sans `-m` rien n'est demande), ms-click-text,
 * ms-click-past-end, ms-click-below, ms-click-softwrap et ms-sidebar (le clic de texte etait deja bon), ms-click-title,
 * ms-click-status, ms-wheel-title, ms-wheel-footer et ms-nohelp (rien ne bouge), pc-label, pc-narrow et
 * pc-label-ends (l'ancien moteur n'agissait pas dans les invites, donc le curseur de la reponse restait ou il
 * etait, ce que nano fait aussi pour ces clics).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { replayNanoCliCase, type NanoCliCase } from '../../support/oracle/nanoCliReplay';

interface Lab extends NanoCliCase { why: string }

const labs = (JSON.parse(readFileSync('src/__tests__/support/oracle/nano-mouse/mouse-labs.json', 'utf8')) as { cases: Lab[] }).cases;

describe('nano -m, one measured laboratory per rule', () => {
  it('loads the recorded laboratories', () => {
    expect(labs.length).toBe(43);
  });

  it.each(labs.map((lab) => [lab.id, lab.why, lab] as const))('%s: %s', (_id, _why, lab) => {
    expect(replayNanoCliCase(lab) ?? '').toBe('');
  });
});
