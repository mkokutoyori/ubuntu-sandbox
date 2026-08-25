/**
 * Les raccourcis d'edition de ligne de la page « CLI basics ».
 *
 * MESURE DE DEPART, dans le vrai navigateur : Ctrl+A laissait le curseur
 * a 17 sur `get system status`, Ctrl+B ne bougeait pas de 6 sur `config`,
 * Ctrl+D n'effacait rien, Ctrl+P et Ctrl+N ne rendaient aucune commande.
 * `CLITerminalSession` et `LinuxTerminalSession` portaient meme la
 * preuve ecrite du defaut — « Ctrl+A/E -> cursor (handled by view, but
 * consume) » — une touche consommee pour que le navigateur ne fasse rien
 * et une vue qui n'en faisait rien non plus.
 *
 * La page decrit : Ctrl+A debut de ligne, Ctrl+E fin de ligne, Ctrl+B et
 * Ctrl+F d'un caractere, Ctrl+D efface le caractere, Ctrl+P et Ctrl+N
 * parcourent l'historique (comme les fleches haut et bas).
 *
 * Ce fichier eprouve la REGLE ; le comportement dans le DOM est eprouve
 * par `e2e/fortigate-raccourcis-edition.spec.ts`.
 */

import { describe, it, expect } from 'vitest';
import {
  applyLineEdit, lineEditActionFor, movesCaretOnly,
} from '@/terminal/core/lineEditing';

const ctrl = (key: string) => ({
  key, ctrlKey: true, altKey: false, metaKey: false, shiftKey: false,
});

describe('la touche designe une action', () => {
  it('les sept raccourcis de la page', () => {
    expect(lineEditActionFor(ctrl('a'))).toBe('start');
    expect(lineEditActionFor(ctrl('e'))).toBe('end');
    expect(lineEditActionFor(ctrl('b'))).toBe('back');
    expect(lineEditActionFor(ctrl('f'))).toBe('forward');
    expect(lineEditActionFor(ctrl('d'))).toBe('delete');
    expect(lineEditActionFor(ctrl('p'))).toBe('history-prev');
    expect(lineEditActionFor(ctrl('n'))).toBe('history-next');
  });

  it('sans Ctrl, ce n\'est pas un raccourci', () => {
    expect(lineEditActionFor({
      key: 'a', ctrlKey: false, altKey: false, metaKey: false, shiftKey: false,
    })).toBeNull();
  });

  it('une autre touche modifiee ne l\'est pas non plus', () => {
    expect(lineEditActionFor(ctrl('c'))).toBeNull();
    expect(lineEditActionFor(ctrl('l'))).toBeNull();
    expect(lineEditActionFor(ctrl('u'))).toBeNull();
    expect(lineEditActionFor(ctrl('r'))).toBeNull();
  });

  it('Alt ou Meta rendent la main', () => {
    expect(lineEditActionFor({
      key: 'a', ctrlKey: true, altKey: true, metaKey: false, shiftKey: false,
    })).toBeNull();
    expect(lineEditActionFor({
      key: 'e', ctrlKey: true, altKey: false, metaKey: true, shiftKey: false,
    })).toBeNull();
  });
});

describe('l\'action deplace ou efface', () => {
  it('Ctrl+A et Ctrl+E vont aux deux bouts', () => {
    expect(applyLineEdit('start', 'config system', 6)).toEqual(
      { text: 'config system', caret: 0 });
    expect(applyLineEdit('end', 'config system', 2)).toEqual(
      { text: 'config system', caret: 13 });
  });

  it('Ctrl+B et Ctrl+F d\'un caractere, sans sortir de la ligne', () => {
    expect(applyLineEdit('back', 'config', 3).caret).toBe(2);
    expect(applyLineEdit('back', 'config', 0).caret).toBe(0);
    expect(applyLineEdit('forward', 'config', 3).caret).toBe(4);
    expect(applyLineEdit('forward', 'config', 6).caret).toBe(6);
  });

  it('Ctrl+D efface le caractere SOUS le curseur, pas celui d\'avant', () => {
    expect(applyLineEdit('delete', 'confXig', 4)).toEqual(
      { text: 'config', caret: 4 });
  });

  it('en fin de ligne, Ctrl+D n\'efface rien', () => {
    expect(applyLineEdit('delete', 'config', 6)).toEqual(
      { text: 'config', caret: 6 });
  });

  it('un curseur hors bornes est ramene dans la ligne', () => {
    expect(applyLineEdit('back', 'config', 99).caret).toBe(5);
    expect(applyLineEdit('forward', 'config', -3).caret).toBe(1);
  });

  it('les quatre deplacements ne touchent pas au texte', () => {
    for (const action of ['start', 'end', 'back', 'forward'] as const) {
      expect(movesCaretOnly(action)).toBe(true);
      expect(applyLineEdit(action, 'config system', 4).text).toBe('config system');
    }
    expect(movesCaretOnly('delete')).toBe(false);
  });
});
