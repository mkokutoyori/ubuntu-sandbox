/*
 * Deux comportements de regcomp (glibc) dont nano depend et que les outils qui pretraitent leur motif (sed, grep) ne voient pas,
 * mesures sur nano 7.2 (labs `syntax-*` de probe-nano-syntax.test.ts) :
 *   - REG_NOTBOL : `^` ne reconnait pas le debut de la chaine quand nano reprend la recherche a l'interieur d'une rangee ;
 *   - REG_ICASE : l'entree est mise en majuscules et le caractere echappe reste tel que le motif l'a ecrit, donc `\t` (une
 *     lettre minuscule echappee) ne reconnait rien ; sed convertit `\t` en tabulation et grep le lit comme `t` AVANT de compiler,
 *     c'est pourquoi `ereToJsSource`, que ces deux outils appellent, garde `t`.
 *
 * Mesure avec le compilateur precedent (qui ignorait le troisieme argument de `exec` et traitait `\t` comme `t` dans les deux
 * chemins) : 2 des 5 tests tombent (REG_NOTBOL, REG_ICASE direct). Les trois autres sont des TEMOINS : `^` en debut de chaine
 * sans REG_NOTBOL, `\t` sans REG_ICASE (la lettre `t` en minuscule) et le chemin `ereToJsSource` des outils.
 */
import { describe, it, expect } from 'vitest';
import { compileEre, ereToJsSource } from '@/network/devices/linux/regex/PosixEre';

describe('regcomp behaviours that tools preprocessing their pattern do not see', () => {
  it('WITNESS: ^ matches the start of the string without REG_NOTBOL', () => {
    expect(compileEre('^a', false).exec('ab', 0)).not.toBeNull();
  });

  it('REG_NOTBOL: ^ does not match the start of the string', () => {
    expect(compileEre('^a', false).exec('ab', 0, true)).toBeNull();
  });

  it('WITNESS: an escaped lower-case letter without REG_ICASE is the letter itself', () => {
    expect(compileEre('\\t', false).exec('xt', 0)).not.toBeNull();
  });

  it('REG_ICASE: an escaped lower-case letter matches nothing, upper-case input included', () => {
    expect(compileEre('\\t', true).exec('xt', 0)).toBeNull();
    expect(compileEre('\\t', true).exec('xT', 0)).toBeNull();
  });

  it('WITNESS: ereToJsSource, used by sed and grep, keeps the letter under -i', () => {
    expect(new RegExp(ereToJsSource('\\t', true), 'i').test('xT')).toBe(true);
  });
});
