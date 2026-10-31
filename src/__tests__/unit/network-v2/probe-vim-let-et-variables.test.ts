/**
 * vim (ex_cmds eval.c ex_let, ex_unlet) : :let, :unlet et les variables g: b: w: t: vues par les expressions \= ; résultats relevés sur vim 8.2 réel.
 * Mesure de départ : :let était refusée et toute variable répondait E121. 16 des 18 cas tombent avant (les 4 cas &option et @register ajoutés après coup tombaient seuls sur la version précédente de :let) ; passent dans les deux états : le témoin (substitution sans variable) et la variable indéfinie (non-régression).
 */

import { describe, it, expect } from 'vitest';
import { VimEngine } from '@/network/devices/linux/editors/VimEngine';
import { InMemoryEditorFsContext } from '@/network/devices/linux/editors/InMemoryEditorFsContext';
import { editorKey } from '@/network/devices/linux/editors/EditorKeyInput';

function run(command: string): string {
  const fs = new InMemoryEditorFsContext();
  fs.writeFile('/tmp/f', 'x\n');
  const vim = new VimEngine(fs, '/tmp/f', 'x\n', false, 'vim', 'root');
  vim.applyKey(editorKey(':'));
  for (const ch of command) vim.applyKey(editorKey(ch));
  vim.applyKey(editorKey('Enter'));
  return vim.content;
}

describe(':let', () => {
  it('variable nue', () => { expect(run('let a=5|s/x/\\=a+1/')).toBe('6'); });
  it('g: et nue sont la même', () => { expect(run('let g:a=5|s/x/\\=g:a . a/')).toBe('55'); });
  it('b:', () => { expect(run('let b:a=5|s/x/\\=b:a/')).toBe('5'); });
  it('+=', () => { expect(run('let a=5|let a+=2|s/x/\\=a/')).toBe('7'); });
  it('.= et ..=', () => { expect(run('let a="p"|let a.="q"|let a..="r"|s/x/\\=a/')).toBe('pqr'); });
  it('élément de liste', () => { expect(run('let l=[1,2]|let l[0]=9|s/x/\\=string(l)/')).toBe('[9, 2]'); });
  it('dictionnaire', () => { expect(run('let d={}|let d.k=3|let d["j"]=1|s/x/\\=string(d)/')).toBe("{'j': 1, 'k': 3}"); });
  it('déstructuration', () => { expect(run('let [a,b]=[1,2]|s/x/\\=a.b/')).toBe('12'); });
  it(':unlet', () => { expect(run('let a=1|unlet a|s/x/\\=exists("a")/')).toBe('0'); });
  it('exists', () => { expect(run('let a=1|s/x/\\=exists("a")/')).toBe('1'); });
  it('une liste est partagée', () => { expect(run('let l=[1]|let m=l|let m+=[2]|s/x/\\=string(l)/')).toBe('[1, 2]'); });
  it('un nombre est copié', () => { expect(run('let a=1|let b=a|let a=2|s/x/\\=b/')).toBe('1'); });
  it('variable indéfinie : E121 et texte vide', () => { expect(run('s/x/\\=zz/')).toBe(''); });
  it('témoin : substitution sans variable', () => { expect(run('s/x/\\=1+1/')).toBe('2'); });
});

describe(':let options and registers', () => {
  it('&option', () => { expect(run('let &tabstop=3|s/x/\\=&tabstop/')).toBe('3'); });
  it('&option booléenne', () => { expect(run('let &ignorecase=1|s/x/\\=&ignorecase/')).toBe('1'); });
  it('@register', () => { expect(run('let @a="reg"|s/x/\\=@a/')).toBe('reg'); });
  it('&option +=', () => { expect(run('let &tabstop=4|let &tabstop+=2|s/x/\\=&tabstop/')).toBe('6'); });
});
