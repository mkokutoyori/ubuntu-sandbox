/**
 * vim 9.1 : un motif a quantificateurs imbriques ne doit pas geler l'editeur. Le motif rnd22-202 du corpus (retire parce que `RegExp.exec` y passait 128 s sur huit lignes ; vim repond sans delai, aucune occurrence) est rejoue : les motifs dont la hauteur d'etoile est au moins 2 passent par un simulateur de Thompson (VimLinearRegex) qui garde les memes atomes natifs.
 * Mesure de depart : le motif occupait le processus 128 s (arrete a la main) ; les 2 cas de temps tombent avant (le test depasse son delai de 20 s), le temoin (un motif simple) passe des deux cotes. Les corpus vim-pattern-oracle, vim-pattern-commands-oracle et vim-substitute-oracle passent avec le simulateur.
 */
import { describe, it, expect } from 'vitest';
import { compileVimPattern } from '@/network/devices/linux/editors/vim/VimPattern';

const PATHOLOGICAL = '\\V\\>-\\{-2,3}-\\|\\(b\\%(\\X\\)\\@=\\|\\f\\+\\_D\\{-2,3}\\|\\L\\?\\)\\{-1,}\\(\\A\\{2,}\\K\\*\\)\\{-2,3}\\[[:space:]o]\\{2}';
const TEXT = Array.from({ length: 8 }, () => 'foo bar baz 12 -- ab').join('\n');

describe('motifs a quantificateurs imbriques', () => {
  it('le motif du corpus repond sans delai et sans occurrence', () => {
    const started = Date.now();
    const found = compileVimPattern(PATHOLOGICAL, false, null).exec(TEXT, 0);
    expect(found).toBeNull();
    expect(Date.now() - started).toBeLessThan(5000);
  }, 20000);

  it('un motif ambigu classique repond vite', () => {
    const started = Date.now();
    const found = compileVimPattern('\\(a\\+\\)\\+b', false, null).exec(`${'a'.repeat(40)}c`, 0);
    expect(found).toBeNull();
    expect(Date.now() - started).toBeLessThan(5000);
  }, 20000);

  it('temoin : un motif simple trouve son occurrence', () => {
    expect(compileVimPattern('b\\+', false, null).exec('aabbc', 0)?.index).toBe(2);
  });

  it('le simulateur rend les memes groupes que RegExp', () => {
    const found = compileVimPattern('\\(a\\+\\)\\+\\(b\\)', false, null).exec('xaaab', 0);
    expect(found?.index).toBe(1);
    expect(found?.[0]).toBe('aaab');
    expect(found?.[2]).toBe('b');
  });
});
