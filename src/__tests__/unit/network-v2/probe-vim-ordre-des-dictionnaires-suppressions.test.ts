/**
 * vim 9.1 (hashtab.c) : l'ordre d'un dictionnaire après des suppressions et des réinsertions (« unlet d.k » laisse une case supprimée que le sondage réutilise, et le tableau est reconstruit quand il est plein à 2/3 ou à moins de 1/5) ; 60 scénarios aléatoires rejoués sur le vrai vim : string(keys(d)) . string(items(d)[0:1]).
 * Mesure de départ : l'ordre était calculé sur la liste des clés vivantes, comme si la table n'avait jamais connu de suppression, et « unlet d['k'] » n'existait pas. 58 des 60 scénarios tombent avant ; 2 passent dans les deux états (aucune suppression ne perturbe la sonde).
 */

import { describe, it, expect } from 'vitest';
import { VimEngine } from '@/network/devices/linux/editors/VimEngine';
import { InMemoryEditorFsContext } from '@/network/devices/linux/editors/InMemoryEditorFsContext';
import { editorKey } from '@/network/devices/linux/editors/EditorKeyInput';

const SCENARIOS: ReadonlyArray<readonly [string, string]> = [
  ["+k2 +foo -k2 +foo +gamma -gamma +one -one -foo +delta +foo +eleven -delta -foo -eleven +y +alpha -y +bar +gamma +thirteen +fifteen +fifteen +one", "['fifteen', 'one', 'thirteen', 'alpha', 'bar', 'gamma'][['fifteen', 1], ['one', 1]]"],
  ["+one -one +seventeen +fourteen -seventeen -fourteen +k3 +k2 +twelve -twelve -k2 -k3 +seventeen +fifteen -seventeen", "['fifteen'][['fifteen', 1]]"],
  ["+sixteen +bar -bar +fourteen -fourteen +eight -eight +y +gamma +k1 +eleven +seventeen -k1 +three +thirteen +three +eight +ten +k2 -gamma -seventeen", "['ten', 'eleven', 'thirteen', 'eight', 'sixteen', 'y', 'three', 'k2'][['ten', 1], ['eleven', 1]]"],
  ["+seventeen +alpha -seventeen -alpha", "[][]"],
  ["+six +foo +eleven +eleven -eleven +beta -six +y -foo -beta +nine +bar +ten -bar +nine +y +fifteen +five -y +two +k3 +gamma +nine -two +five +baz +two +k3 +delta +seven +beta +eleven +delta -two +b +three +beta +eight +eight +nine", "['seven', 'fifteen', 'nine', 'gamma', 'delta', 'b', 'baz', 'three', 'k3', 'ten', 'beta', 'five', 'eight', 'eleven'][['seven', 1], ['fifteen', 1]]"],
  ["+delta -delta +beta -beta +a +eight +baz +y +beta", "['a', 'eight', 'baz', 'y', 'beta'][['a', 1], ['eight', 1]]"],
  ["+alpha +seven -seven +baz +k3 +b -b +k2 +sixteen +eight -sixteen -alpha +x +k1 +beta +gamma -eight -k3 +six -k1 +foo +eight +twelve +k1 +b +alpha +k2 -eight +y +six +sixteen +x +foo -gamma", "['six', 'baz', 'b', 'twelve', 'sixteen', 'alpha', 'y', 'x', 'k2', 'foo', 'beta', 'k1'][['six', 1], ['baz', 1]]"],
  ["+x +b +bar +beta +fourteen +sixteen", "['fourteen', 'b', 'x', 'bar', 'beta', 'sixteen'][['fourteen', 1], ['b', 1]]"],
  ["+one +two +beta +k1 +eleven +bar +thirteen -bar -one +k2 +nine -beta +delta +x +seventeen -thirteen -x +eleven -k1 +baz +b -b +b +four +bar -nine +x -seventeen -k2 -delta +two +seventeen +baz -baz +bar -two", "['four', 'eleven', 'bar', 'x', 'seventeen', 'b'][['four', 1], ['eleven', 1]]"],
  ["+two -two +bar -bar +fifteen -fifteen +three +c +one", "['one', 'c', 'three'][['one', 1], ['c', 1]]"],
  ["+k3 -k3 +beta +five +gamma -gamma +three -beta +c -c +beta", "['five', 'three', 'beta'][['five', 1], ['three', 1]]"],
  ["+sixteen -sixteen +x +thirteen +eleven +five +delta -thirteen +eight +k1 -k1 +two +foo -foo +four +four -eleven -eight -delta +six -two -five -four -six +beta -x -beta +k2 +c +five -k2 -c +ten +seventeen -seventeen +k2", "['five', 'k2', 'ten'][['five', 1], ['k2', 1]]"],
  ["+thirteen +k1 +b +delta -thirteen -b", "['delta', 'k1'][['delta', 1], ['k1', 1]]"],
  ["+ten +foo +one +a +bar +baz +bar +sixteen -ten +one", "['foo', 'a', 'one', 'baz', 'sixteen', 'bar'][['foo', 1], ['a', 1]]"],
  ["+delta +fifteen +ten -ten -delta +beta -fifteen -beta +k1 -k1 +seventeen -seventeen +gamma +four +four +fifteen +beta", "['four', 'fifteen', 'gamma', 'beta'][['four', 1], ['fifteen', 1]]"],
  ["+baz +b -baz +fourteen +ten -b -fourteen -ten +nine -nine +y +delta +seventeen +k3 -k3 +eleven -delta +ten -eleven -seventeen +y +beta +four", "['four', 'y', 'ten', 'beta'][['four', 1], ['y', 1]]"],
  ["+nine -nine +bar +thirteen +foo -bar +four +k2 -four +six -k2 +thirteen +eleven +gamma +foo +twelve +k1 +four +k1 -k1", "['foo', 'six', 'thirteen', 'twelve', 'four', 'gamma', 'eleven'][['foo', 1], ['six', 1]]"],
  ["+four -four +eleven +five +eleven -eleven -five +delta +seven +fourteen +beta -seven -delta -beta -fourteen +b +twelve +gamma +seven +seventeen -gamma -twelve -b +fourteen +five", "['seven', 'five', 'fourteen', 'seventeen'][['seven', 1], ['five', 1]]"],
  ["+k1 -k1 +seventeen -seventeen +fifteen", "['fifteen'][['fifteen', 1]]"],
  ["+one +delta -one +fifteen -delta -fifteen +delta +c +five +two +thirteen +y -five +beta +delta +a -two +three +one +one +b +five -y +twelve -beta +nine -delta +twelve +eleven -one +bar -three", "['a', 'c', 'thirteen', 'b', 'bar', 'twelve', 'nine', 'five', 'eleven'][['a', 1], ['c', 1]]"],
  ["+beta -beta +two +four -four +delta +foo +k2 +foo -delta +foo -foo +six +baz +seven -seven +c -baz +seven +x -six -seven +y", "['c', 'two', 'y', 'x', 'k2'][['c', 1], ['two', 1]]"],
  ["+gamma +five +thirteen -thirteen +nine +fourteen -nine +sixteen -sixteen -fourteen +c +fifteen -gamma -fifteen -c +seven +c -c +three -three +bar -five -bar +ten +thirteen +k1 +alpha -thirteen +k2 +six +fifteen +baz +eleven +one +c +six -fifteen +bar -ten", "['six', 'seven', 'baz', 'eleven', 'alpha', 'bar', 'k1', 'k2', 'one', 'c'][['six', 1], ['seven', 1]]"],
  ["+x +fourteen -x +one +y +four -y +two -one -fourteen -four -two +two +delta +x +c -c", "['delta', 'two', 'x'][['delta', 1], ['two', 1]]"],
  ["+fourteen +c +delta -fourteen +beta +nine +alpha +two +a -alpha +eight -beta -c -two -nine +six +nine -eight", "['six', 'a', 'nine', 'delta'][['six', 1], ['a', 1]]"],
  ["+gamma -gamma +sixteen -sixteen +eleven +k2 +baz +eleven", "['baz', 'eleven', 'k2'][['baz', 1], ['eleven', 1]]"],
  ["+twelve +five +foo -foo +twelve +nine +eleven +gamma +thirteen +thirteen -twelve +nine +k3 -five +eleven -k3 +k3 -gamma -eleven +x +beta", "['thirteen', 'x', 'k3', 'beta', 'nine'][['thirteen', 1], ['x', 1]]"],
  ["+k1 +c +sixteen -sixteen +ten -ten +k3 +delta +beta +alpha +c +k3 +y -alpha +beta -beta +c +six -y +five +five +thirteen +nine", "['six', 'five', 'c', 'thirteen', 'delta', 'k1', 'k3', 'nine'][['six', 1], ['five', 1]]"],
  ["+fourteen -fourteen +seventeen +fourteen +fifteen +sixteen +bar -sixteen +fourteen +c -fourteen -bar +baz -baz +k1 -seventeen +y -y -fifteen +delta -k1 +two -two -delta -c +gamma +one -gamma -one +k3 +three +ten", "['k3', 'ten', 'three'][['k3', 1], ['ten', 1]]"],
  ["+two -two +nine +fourteen +x -x +eleven +nine -fourteen +nine -nine +alpha +foo -foo", "['eleven', 'alpha'][['eleven', 1], ['alpha', 1]]"],
  ["+five +six +c -six +thirteen +nine +k1 +c -five +five -nine +twelve +k1 -twelve +k3 -thirteen +fourteen -k1 +three +two", "['fourteen', 'five', 'c', 'two', 'k3', 'three'][['fourteen', 1], ['five', 1]]"],
  ["+foo +eight +fourteen +seventeen", "['foo', 'eight', 'fourteen', 'seventeen'][['foo', 1], ['eight', 1]]"],
  ["+k3 +c -k3 +one -c -one +k2 +twelve +alpha +bar -k2 +sixteen +a +thirteen +fifteen -thirteen +delta +two -twelve", "['a', 'fifteen', 'two', 'delta', 'alpha', 'bar', 'sixteen'][['a', 1], ['fifteen', 1]]"],
  ["+seven +two +three +thirteen +two -two -thirteen -three +beta +six -beta", "['six', 'seven'][['six', 1], ['seven', 1]]"],
  ["+one +sixteen +a +thirteen +delta +five +eleven +bar +k3 -one -thirteen -a +b -k3 +c +c -bar +beta +bar +ten -eleven -sixteen -ten +baz +four", "['four', 'baz', 'b', 'c', 'delta', 'bar', 'beta', 'five'][['four', 1], ['baz', 1]]"],
  ["+x -x +four -four +two -two +four -four +six +sixteen +b +b +x -six +gamma +baz +four -sixteen +four +foo -baz -x +eight +two +k3 -gamma +delta +y +baz +x +eight -delta +baz +b", "['four', 'baz', 'b', 'eight', 'two', 'foo', 'y', 'k3', 'x'][['four', 1], ['baz', 1]]"],
  ["+gamma -gamma +k3 +delta +k1 +c -k1 +fourteen +six -fourteen +two +k1 -k1 +one +three -one +k2 +one +eight -three +two +x -delta -six +five +thirteen -c", "['one', 'thirteen', 'two', 'x', 'k2', 'k3', 'five', 'eight'][['one', 1], ['thirteen', 1]]"],
  ["+three -three +fifteen -fifteen +thirteen +four +k2 -k2 +one +thirteen", "['four', 'one', 'thirteen'][['four', 1], ['one', 1]]"],
  ["+twelve +delta +y +six -twelve +one +k3 -one +b +twelve +alpha +six +ten +x -x -k3 +x +fifteen +sixteen +nine +twelve +fifteen -nine -fifteen +y +eight +two -ten -y +twelve +eight +x -sixteen +delta +eleven +k3 -six +beta +delta +k2", "['b', 'eleven', 'alpha', 'delta', 'two', 'x', 'k2', 'k3', 'twelve', 'beta', 'eight'][['b', 1], ['eleven', 1]]"],
  ["+twelve +four +k1 +sixteen +delta -sixteen +thirteen +sixteen -sixteen +eight -k1 -thirteen +baz +nine -delta +foo -nine +k1 +eight +a +gamma +four -four +delta -delta -eight", "['baz', 'gamma', 'a', 'foo', 'k1', 'twelve'][['baz', 1], ['gamma', 1]]"],
  ["+eleven +k3 +baz +five -k3 +fourteen +y +two +k1 +foo +k2 +one +a -two +seventeen +fifteen +twelve", "['foo', 'baz', 'five', 'eleven', 'a', 'fifteen', 'k2', 'fourteen', 'y', 'twelve', 'one', 'k1', 'seventeen'][['foo', 1], ['baz', 1]]"],
  ["+alpha +b -alpha +seven +x +seventeen +k2 -seventeen", "['seven', 'b', 'k2', 'x'][['seven', 1], ['b', 1]]"],
  ["+seven -seven +seven +gamma -gamma +foo +four +seventeen +three +eight +seventeen +seven", "['foo', 'seven', 'eight', 'four', 'seventeen', 'three'][['foo', 1], ['seven', 1]]"],
  ["+six +k1 +baz +c +eleven +foo +x -k1 +sixteen +foo +ten +baz -ten +alpha -c +twelve", "['six', 'baz', 'twelve', 'alpha', 'sixteen', 'x', 'foo', 'eleven'][['six', 1], ['baz', 1]]"],
  ["+a +k1 +two +alpha +six -six +foo +c +twelve +eleven", "['foo', 'a', 'c', 'alpha', 'two', 'k1', 'twelve', 'eleven'][['foo', 1], ['a', 1]]"],
  ["+bar -bar +k2 +twelve +baz +gamma +a +a +y +baz -k2 -twelve -gamma +alpha +nine +k2 +baz -nine +fifteen +two +foo +a -a +five +k3 +seventeen +six +fourteen +k3 -y +k3 +twelve", "['foo', 'baz', 'fifteen', 'two', 'alpha', 'seventeen', 'fourteen', 'k2', 'k3', 'twelve', 'five', 'six'][['foo', 1], ['baz', 1]]"],
  ["+ten +fourteen +seven -ten +seven +a +five +one +ten +delta +four +six -delta -fourteen -a +k2 -k2 +seventeen -seven +seventeen +beta +delta -five +fifteen +two +a +fifteen +eight +delta +two +six +beta -six -beta", "['four', 'fifteen', 'a', 'two', 'delta', 'seventeen', 'ten', 'one', 'eight'][['four', 1], ['fifteen', 1]]"],
  ["+eight +k2 -k2 +x +fifteen +k2 -eight -k2 +x -fifteen +gamma -gamma +fourteen +k1 -x -fourteen +b -b +fifteen +bar +eleven +baz -baz -k1 +eleven -fifteen +one", "['one', 'eleven', 'bar'][['one', 1], ['eleven', 1]]"],
  ["+alpha -alpha +eight -eight +foo -foo +foo -foo +a +five +fourteen +x +nine -a +ten -fourteen +a +beta", "['a', 'five', 'x', 'ten', 'beta', 'nine'][['a', 1], ['five', 1]]"],
  ["+k3 +delta -delta +k1 +x +ten", "['x', 'k1', 'k3', 'ten'][['x', 1], ['k1', 1]]"],
  ["+bar +seven -bar +nine -seven", "['nine'][['nine', 1]]"],
  ["+alpha +k2 +k2 -k2 -alpha +three +four", "['four', 'three'][['four', 1], ['three', 1]]"],
  ["+k3 -k3 +six +sixteen -six +gamma +four -sixteen +thirteen +one +x +twelve +foo +four -twelve -x -four +four -foo -four -one -gamma +delta +beta +baz", "['baz', 'thirteen', 'delta', 'beta'][['baz', 1], ['thirteen', 1]]"],
  ["+three -three +beta +beta -beta +foo +eight -eight -foo +sixteen -sixteen +one -one +c -c +a +fourteen +bar -bar -fourteen +ten +foo -a +seventeen +b +k1 -ten -seventeen -b -foo -k1 +two -two +one +x", "['one', 'x'][['one', 1], ['x', 1]]"],
  ["+x +c -c +three -x +k1 +delta +k2 +fifteen +k3 +b +ten +c +foo +seven +seven +six +foo -delta +eight -ten +a +alpha -c -a -k2", "['foo', 'fifteen', 'b', 'eight', 'alpha', 'seven', 'k1', 'k3', 'three', 'six'][['foo', 1], ['fifteen', 1]]"],
  ["+eleven +fifteen +c -c +three +c +two -eleven +c -c -fifteen -two -three +fourteen -fourteen +four +four -four +four +delta +beta +nine +five +sixteen +b -delta -sixteen +eleven -nine -beta", "['four', 'eleven', 'b', 'five'][['four', 1], ['eleven', 1]]"],
  ["+six +four +gamma -six -four +eight +foo +fourteen +x +k2 +eight -eight +three +x +sixteen -three +k1 +x -k1 +y +k2 +three +y +fourteen", "['foo', 'x', 'sixteen', 'y', 'fourteen', 'k2', 'gamma', 'three'][['foo', 1], ['x', 1]]"],
  ["+four +four +ten +a +seventeen +five -a +thirteen +delta -seventeen -delta +six -thirteen +a -five +seventeen -seventeen +thirteen +thirteen +eight -eight +a +delta -six +k2 +twelve +fourteen +seven +baz -k2 +bar +alpha -delta", "['four', 'twelve', 'baz', 'thirteen', 'alpha', 'a', 'fourteen', 'bar', 'ten', 'seven'][['four', 1], ['twelve', 1]]"],
  ["+twelve +four +gamma +beta +foo +x +c +a +five +a +eleven +a +beta -five +k2 +twelve +k2 -eleven -four -k2 +thirteen +foo +six -foo +k3", "['six', 'gamma', 'thirteen', 'c', 'a', 'x', 'k3', 'twelve', 'beta'][['six', 1], ['gamma', 1]]"],
  ["+three +bar -bar +b -b +c", "['c', 'three'][['c', 1], ['three', 1]]"],
  ["+foo +one -foo +alpha -alpha -one +seventeen +bar -bar +delta +eleven +seventeen -seventeen -delta +alpha -alpha +nine -nine -eleven +y +eight +ten -eight -ten -y +seven +one +baz -baz +k1 +fifteen +one", "['seven', 'one', 'fifteen', 'k1'][['seven', 1], ['one', 1]]"],
];

function replay(steps: string): string {
  const fs = new InMemoryEditorFsContext({ '/tmp/f': 'x\n' });
  const vim = new VimEngine(fs, '/tmp/f', 'x\n', false, 'vim', 'root');
  const ex = (text: string): void => {
    vim.applyKey(editorKey(':'));
    for (const ch of text) vim.applyKey(editorKey(ch));
    vim.applyKey(editorKey('Enter'));
  };
  ex('let d = {}');
  for (const step of steps.split(' ')) {
    const key = step.slice(1);
    ex(step[0] === '+' ? `let d['${key}'] = 1` : `unlet! d['${key}']`);
  }
  ex('s#x#\\=string(keys(d)) . string(items(d)[0:1])#');
  return vim.content.replace(/\n$/, '');
}

describe('ordre d\'un dictionnaire de vim avec suppressions', () => {
  SCENARIOS.forEach(([steps, expected], at) => {
    it(`scénario ${at + 1} (${steps.split(' ').length} opérations)`, () => { expect(replay(steps)).toBe(expected); });
  });
});
