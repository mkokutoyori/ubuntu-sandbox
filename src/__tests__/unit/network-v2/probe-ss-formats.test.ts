/**
 * Les nombres que `ss` imprime ne sont pas ceux de `toFixed` : `print_ms_timer` ecrit `1.234ms` (une
 * seconde et 234 ms, le point est un separateur de la minuterie et non une decimale), `sprint_bw`
 * garde trois chiffres significatifs avec `%.3g` et bascule en notation scientifique (`1e+03k`), et
 * `-n` l'imprime avec `%.0f`, qui arrondit a l'entier pair. `SsFormat` les reproduit.
 *
 * Mesure de depart (origin/mandeng 75c5280d8) : ces formats n'existaient pas, `ss` n'imprimait ni
 * minuterie ni debit. Les valeurs attendues ne viennent pas de la memoire de l'auteur : elles ont ete
 * produites par un programme C compile avec gcc qui contient telles quelles les fonctions
 * `print_ms_timer` et `sprint_bw` de `misc/ss.c` (iproute2 v5.15.0, lu) et laisse a la libc le
 * `printf` des formats `%g` et `%.0f`.
 *
 * Discrimination : le module n'existe pas sur origin/mandeng 75c5280d8, donc les SOIXANTE-TROIS cas
 * tombent a l'import ; c'est structurel, et le temoin (un entier simple s'imprime tel quel) ne dit
 * rien de plus. Contre une erreur du module, onze mutations de `SsFormat` (une regle de
 * `print_ms_timer` retiree, le point de `1.234ms` remplace par `sec`, trois chiffres portes a quatre,
 * l'arrondi pair remplace par `Math.round`, le seuil de la notation scientifique deplace, le zero
 * final conserve, l'unite choisie au seuil strict, un diviseur ou une precision changes) font
 * tomber chacune de 1 a 24 cas.
 */
import { describe, it, expect } from 'vitest';
import { bandwidthText, formatG, printMsTimer } from '@/network/devices/linux/commands/net/ss/SsFormat';

const TIMERS: ReadonlyArray<readonly [number, string]> = [
  [0, ''], [1, '001ms'], [200, '200ms'], [999, '999ms'], [1000, '1sec'], [1001, '1.001ms'], [1234, '1.234ms'],
  [7140, '7.140ms'], [9999, '9.999ms'], [10000, '10sec'], [10500, '10sec'], [15000, '15sec'], [59000, '59sec'],
  [59999, '59sec'], [60000, '1min'], [60001, '1min'], [61000, '1min1sec'], [61234, '1min1sec'],
  [119000, '1min59sec'], [120000, '2min'], [599000, '9min59sec'], [600000, '10min'], [601000, '10min'],
  [3600000, '60min'], [7199000, '119min'], [7200000, '120min'], [7200999, '120min'],
];

const BANDWIDTHS: ReadonlyArray<readonly [number, string, string]> = [
  [0, '0', '0'], [1, '1', '1'], [12.5, '12.5', '12'], [999, '999', '999'], [1000, '1k', '1000'],
  [1500, '1.5k', '1500'], [999499, '999k', '999499'], [999600, '1e+03k', '999600'], [1000000, '1M', '1000000'],
  [3459768, '3.46M', '3459768'], [14500000000, '14.5G', '14500000000'], [999600000, '1e+03M', '999600000'],
  [1000000000, '1G', '1000000000'], [2500000000000, '2.5T', '2500000000000'],
  [123456789012345, '123T', '123456789012345'], [0.5, '0.5', '0'],
];

const GENERAL: ReadonlyArray<readonly [number, string]> = [
  [0, '0'], [204, '204'], [0.016, '0.016'], [1234567, '1.23457e+06'], [0.00001234, '1.234e-05'],
  [100000, '100000'], [999999.5, '1e+06'], [0.1, '0.1'], [3.83979, '3.83979'], [10.0446, '10.0446'],
  [212, '212'], [3000, '3000'], [0.0001, '0.0001'], [123456, '123456'], [0.00001, '1e-05'],
  [1e21, '1e+21'], [33.333333333, '33.3333'], [2.5, '2.5'], [200.5, '200.5'],
];

describe('the bench is sound (witnesses)', () => {
  it('a plain integer prints as itself and a round second as sec', () => {
    expect(formatG(204)).toBe('204');
    expect(printMsTimer(1000)).toBe('1sec');
    expect(bandwidthText(1000, false)).toBe('1k');
  });
});

describe('print_ms_timer of iproute2 5.15, compiled from ss.c and read back', () => {
  it.each(TIMERS)('%i ms prints %j', (milliseconds, text) => {
    expect(printMsTimer(milliseconds)).toBe(text);
  });
});

describe('sprint_bw of iproute2 5.15: three significant digits and a unit, or %.0f with -n', () => {
  it.each(BANDWIDTHS)('%f bit/s prints %j, and %j with -n', (rate, text, numeric) => {
    expect(bandwidthText(rate, false)).toBe(text);
    expect(bandwidthText(rate, true)).toBe(numeric);
  });
});

describe('printf %g, which ss uses for every tcp_info estimate', () => {
  it.each(GENERAL)('%g prints %j', (value, text) => {
    expect(formatG(value)).toBe(text);
  });
});
