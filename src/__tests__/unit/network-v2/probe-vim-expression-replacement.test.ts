/**
 * `:s/motif/\=expression/` : ce que le corpus enregistre contre un vrai vim ne peut pas dire (vim-substitute-oracle),
 * parce que cela depend de la machine ou de l'etat du moteur.
 *
 * Mesure de depart : `\=` n'etait pas evalue du tout, `:s/o/\=1+2/` ecrivait la chaine `=1+2` (regle 6 : un critere
 * lu, rendu et jamais evalue).  9 des 11 cas tombent avant (git stash push -- src/network), tous sauf les deux TEMOINS - `:s/o/0/` et un
 * remplacement qui ne commence pas par `\=` - qui prouvent que le lab tape bien des commandes et que `\=` ne
 * capture pas un remplacement ordinaire.
 *
 *   - `$NOM` lit l'environnement de la MACHINE par `printenv`, jamais celui du poste qui execute le moteur ;
 *   - le numero de lambda (`function('<lambda>1')`) continue de compter d'une commande a l'autre ;
 *   - la premiere erreur d'une evaluation reste le message de la commande, meme si le compte des
 *     substitutions la suit ;
 *   - sous `:g`, l'erreur survit a la fin de la commande globale ;
 *   - une option que le moteur ne modelise pas rend la valeur par defaut de vim (`&textwidth` vaut 0) et `vi`
 *     (profil compatible) la refuse en E113 plutot que de repondre avec le defaut d'un autre profil.
 */
import { describe, it, expect } from 'vitest';
import { VimEngine } from '@/network/devices/linux/editors/VimEngine';
import { InMemoryEditorFsContext } from '@/network/devices/linux/editors/InMemoryEditorFsContext';
import { editorKey } from '@/network/devices/linux/editors/EditorKeyInput';

function engine(content: string, variant: 'vim' | 'vi' = 'vim', fs = new InMemoryEditorFsContext({ '/tmp/t.txt': content })): VimEngine {
  return new VimEngine(fs, '/tmp/t.txt', content, false, variant);
}

function ex(e: VimEngine, command: string): void {
  e.applyKey(editorKey(':'));
  for (const character of command) e.applyKey(editorKey(character));
  e.applyKey(editorKey('Enter'));
}

describe('le remplacement par expression est evalue', () => {
  it('TEMOIN : un remplacement ordinaire reste litteral', () => {
    const e = engine('foo\n');
    ex(e, 's/o/0/');
    expect(e.lines).toEqual(['f0o']);
  });

  it('TEMOIN : un remplacement qui contient `=` mais ne commence pas par `\\=` reste litteral', () => {
    const e = engine('foo\n');
    ex(e, 's/o/=1+2/');
    expect(e.lines).toEqual(['f=1+2o']);
  });

  it('evalue l\'arithmetique', () => {
    const e = engine('foo\n');
    ex(e, 's/o/\\=1+2/');
    expect(e.lines).toEqual(['f3o']);
  });

  it('lit l\'environnement de la machine par printenv', () => {
    const fs = new InMemoryEditorFsContext({ '/tmp/t.txt': 'foo\n' }, (cmd) => (cmd === 'printenv LAB_NAME' ? 'srv-01' : ''));
    const e = engine('foo\n', 'vim', fs);
    ex(e, 's/o/\\=$LAB_NAME/');
    expect(e.lines).toEqual(['fsrv-01o']);
    expect(fs.shellCommandsRun).toContain('printenv LAB_NAME');
  });

  it('une variable d\'environnement absente vaut la chaine vide', () => {
    const e = engine('foo\n');
    ex(e, 's/o/\\=$NO_SUCH/');
    expect(e.lines).toEqual(['fo']);
  });

  it('le compteur de lambdas continue d\'une commande a l\'autre', () => {
    const e = engine('foo\n');
    ex(e, 's/o/\\=string({-> 1})/');
    expect(e.lines).toEqual(["ffunction('<lambda>1')o"]);
    ex(e, 's/o$/\\=string({-> 1})/');
    expect(e.lines[0]).toContain("function('<lambda>2')");
  });

  it('la premiere erreur reste le message, le compte des substitutions ne la recouvre pas', () => {
    const e = engine('foo\nfoo\nfoo\n');
    ex(e, '%s/o/\\=nosuch()/g');
    expect(e.message).toBe('E117: Unknown function: nosuch');
    expect(e.lines).toEqual(['f', 'f', 'f']);
  });

  it('sous :g l\'erreur survit a la fin de la commande globale', () => {
    const e = engine('foo\nbar\nfoo\n');
    ex(e, 'g/foo/s/o/\\=nosuch()/');
    expect(e.message).toBe('E117: Unknown function: nosuch');
    expect(e.lines).toEqual(['fo', 'bar', 'fo']);
  });

  it('une option non modelisee rend la valeur par defaut de vim', () => {
    const e = engine('foo\n');
    ex(e, 's/o/\\=&textwidth . "|" . &tw/');
    expect(e.lines).toEqual(['f0|0o']);
  });

  it('en profil vi une option non modelisee reste refusee', () => {
    const e = engine('foo\n', 'vi');
    ex(e, 's/o/\\=&textwidth/');
    expect(e.message).toBe('E113: Unknown option: textwidth');
  });

  it('une option modelisee suit :set', () => {
    const e = engine('foo\n');
    ex(e, 'set tabstop=4');
    ex(e, 's/o/\\=&ts/');
    expect(e.lines).toEqual(['f4o']);
  });
});
