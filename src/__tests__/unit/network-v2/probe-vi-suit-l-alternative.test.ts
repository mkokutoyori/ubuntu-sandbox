/**
 * `vi' se comportait en vi STRICT sur une machine qui declare avoir vim.
 *
 * MESURE DE DEPART sur `db16002d' :
 *
 *   `dpkg -l' annonce le paquet `vim' — « Vi IMproved - enhanced vi
 *   editor » — et la machine livre les commandes `vi', `vim' et `vimdiff'.
 *   Pourtant :
 *
 *     vi, touche `i'   -> mode insertion, mais AUCUN `-- INSERT --'
 *     vi, touche `gg'  -> refusee, « gg is a vim extension »
 *
 *   Deux vues de la meme machine en desaccord : la table des paquets dit
 *   « vim complet installe », l'editeur se comporte comme `vim-tiny'.
 *
 * AUTORITE. Le mecanisme des alternatives de Debian/Ubuntu, mesure sur
 * l'Ubuntu 24.04.4 hote de cette session.
 *
 * `/etc/vim/vimrc.tiny' porte sa propre explication :
 *
 *   " Vim configuration file, in effect when invoked as "vi". The aim of
 *   " this configuration file is to provide a Vim environment as
 *   " compatible with the original vi as possible.
 *   set compatible
 *
 * Ce chemin est COMPILE dans `vim.tiny' seul — `strings /usr/bin/vim.tiny'
 * rend `/etc/vim/vimrc' ET `/etc/vim/vimrc.tiny', `strings
 * /usr/bin/vim.basic' ne rend que le premier. Le comportement ne depend
 * donc pas du nom tape, mais du BINAIRE derriere l'alternative :
 *
 *   # update-alternatives --display vi
 *       link currently points to /usr/bin/vim.basic
 *
 *   invocation            binaire     compatible   -- INSERT --
 *   vi  -> vim.tiny       vim.tiny    compatible   non
 *   vim.tiny              vim.tiny    nocompatible oui
 *   vi  -> vim.basic      vim.basic   nocompatible oui
 *
 * Le paquet `vim' fournit `vim.basic' et prend la priorite de
 * l'alternative `vi'. Sur une machine qui a `vim', `vi' EST donc vim ; sur
 * une Ubuntu minimale qui n'a que `vim-tiny', `vi' est le vi strict. Les
 * deux sont reels — c'est le paquet qui tranche, jamais le nom.
 *
 * `vi' N'APPARTIENT A AUCUN PAQUET : c'est une alternative. La table le
 * disait mal (`vi: 'vim''), ce qui aurait rendu `vim' installe meme sans
 * lui. Elle rattache maintenant `vi' a `vim-tiny', le paquet de base qui
 * le livre sur toute Ubuntu, et `vim' ne compte plus que ses propres
 * commandes.
 *
 * MESURE : 5 cas tombent sur 8.
 * Les trois cas qui passent des deux cotes sont nommes :
 *   - TEMOIN : `vim' affichait DEJA `-- INSERT --' et acceptait `gg' —
 *     sans lui, une sonde faite de refus ne prouverait pas que le lab
 *     pilote un editeur ;
 *   - NON-REGRESSION : le mode d'insertion de `vi' etait deja REEL, seul
 *     l'indicateur manquait ;
 *   - NON-REGRESSION : `vim-tiny' seul rend bien le vi strict, ce qui est
 *     l'autre moitie du mecanisme et ne doit pas disparaitre.
 */
import { describe, it, expect } from 'vitest';
import { VimEngine } from '@/network/devices/linux/editors/VimEngine';
import { InMemoryEditorFsContext } from '@/network/devices/linux/editors/InMemoryEditorFsContext';
import { editorKey } from '@/network/devices/linux/editors/EditorKeyInput';
import { viVariantFor } from '@/network/devices/linux/editors/editorLaunch';
import { findPackage } from '@/network/devices/linux/packages/PackageDatabase';

const CONTENU = 'alpha\nbravo\ncharlie\ndelta\n';

function press(e: VimEngine, k: string): void { e.applyKey(editorKey(k)); }

const moteur = (variant: 'vi' | 'vim'): VimEngine => new VimEngine(
  new InMemoryEditorFsContext({ '/tmp/t.txt': CONTENU }), '/tmp/t.txt', CONTENU, false, variant);

describe('`vi` suit l alternative, donc le paquet installe', () => {
  it('TEMOIN : `vim` affiche -- INSERT -- et accepte gg', () => {
    const e = moteur('vim');
    press(e, 'i');
    expect(e.showsInsertIndicator).toBe(true);
    press(e, 'Escape'); press(e, 'j');
    press(e, 'g'); press(e, 'g');
    expect(e.cursorLine).toBe(0);
  });

  it('le paquet `vim` est installe sur cette image', () => {
    expect(findPackage('vim')?.installed).toBe(true);
  });

  it('`vim-tiny` figure aussi au catalogue', () => {
    expect(findPackage('vim-tiny')).toBeDefined();
  });

  it('l alternative rend vim.basic quand le paquet vim est la', () => {
    expect(viVariantFor(true)).toBe('vim');
  });

  it('NON-REGRESSION : sans le paquet vim, l alternative rend le vi strict', () => {
    expect(viVariantFor(false)).toBe('vi');
  });

  it('sur cette image, `vi` affiche donc -- INSERT --', () => {
    const e = moteur(viVariantFor(findPackage('vim')?.installed === true));
    press(e, 'i');
    expect(e.showsInsertIndicator).toBe(true);
  });

  it('sur cette image, `vi` accepte donc gg', () => {
    const e = moteur(viVariantFor(findPackage('vim')?.installed === true));
    press(e, 'j'); press(e, 'j');
    press(e, 'g'); press(e, 'g');
    expect(e.cursorLine).toBe(0);
  });

  it('NON-REGRESSION : le vi strict entre REELLEMENT en insertion, sans indicateur', () => {
    const e = moteur('vi');
    press(e, 'i');
    expect(e.mode).toBe('insert');
    expect(e.showsInsertIndicator).toBe(false);
  });
});
