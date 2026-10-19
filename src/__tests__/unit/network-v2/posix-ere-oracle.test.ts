/**
 * Les expressions regulieres etendues POSIX (ERE) rejouees contre la glibc 2.39 (scripts/oracle/record_posix_regex.py,
 * `regcomp(REG_EXTENDED | REG_ICASE)` puis `regexec(REG_STARTEND)`, comme le fait `strstrwrapper` de nano) : 11 000 couples
 * motif / texte, dont 7 000 tires de la grammaire brute (parentheses, crochets, intervalles et operateurs en desordre,
 * donc surtout des erreurs de compilation) et 4 000 de motifs valides (alternances, groupes, references arriere, classes,
 * ancres de mot).  Pour chacun on compare le texte de `regerror` quand la compilation echoue, sinon la plage de la
 * correspondance la plus a gauche et la plus longue, en octets.
 *
 * Methode : regcomp.c de la glibc (parse_reg_exp, parse_branch, parse_expression, parse_dup_op, parse_bracket_exp,
 * peek_token) pour la grammaire de RE_SYNTAX_POSIX_EXTENDED : `*`, `+`, `?`, `{` en tete d'expression ou apres une
 * ancre sont une erreur (« Invalid preceding regular expression »), `)` seul est ordinaire, `{,n}` vaut `{0,n}`, un
 * intervalle mal forme est une erreur, `[` en fin de motif est « Invalid regular expression », une reference arriere ne
 * vise qu'un groupe deja ferme dans la meme branche, `\w \W \s \S \< \> \b \B` sont les operateurs GNU et tout autre
 * `\x` est le caractere x.  Le moteur de JavaScript donne la premiere correspondance, pas la plus longue : le
 * traducteur (regex/PosixEre.ts) cherche donc la fin la plus lointaine qui reste possible a partir du meme depart.
 *
 * Mesure avec `git stash push -- src/network/devices/linux/regex/PosixRegex.ts` (l'ancien traducteur, qui laisse passer
 * la syntaxe de JavaScript et retombe sur un motif litteral quand elle est invalide) : 5 374 des 10 886 cas compares
 * tombaient avant, dont 5 110 erreurs de compilation que l'ancien traducteur ne signale jamais et 264 plages
 * differentes : alternances (86, la premiere branche au lieu de la plus longue), ancres de mot (79, `\<` et `\>`
 * toutes deux traduites en `\b`), quantificateurs empiles (34), intervalle `{,n}` (35) et classes `[[:upper:]]`
 * (30) ; 0 apres.  Passent dans les deux cas les motifs triviaux (lettres, classes simples), qui servent de temoin.
 *
 * Ecarts connus, mesures et NON portes (exclus de la comparaison, comptes) :
 *   - les groupes de capture sous un quantificateur, ou derriere une reference arriere, suivent la semantique de
 *     JavaScript (derniere iteration, groupe non participant vide) et non celle de la glibc ; seule la plage globale est
 *     alors comparee, et le cas est ecarte quand une reference arriere vise un groupe repete ;
 *   - sous REG_ICASE la glibc ne reconnait jamais `\c` (une lettre minuscule echappee) : defaut de la bibliotheque, non
 *     reproduit ;
 *   - les classes `[[:alpha:]]` etc. suivent les categories Unicode, la glibc suit la table de la locale C.UTF-8.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { compileEre, PosixRegexError } from '@/network/devices/linux/regex/PosixEre';

interface EreCase { flags: string; pattern: string; text: string; start: number; want: string }

const dir = 'src/__tests__/support/oracle/posix-regex';
const fixtures = readdirSync(dir).filter((f) => f.startsWith('glibc-ere')).sort()
  .map((f) => ({ name: f, ...(JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')) as { cases: EreCase[] }) }));

function byteOffset(text: string, index: number): number {
  return Buffer.byteLength(text.slice(0, index), 'utf8');
}

function answer(c: EreCase, spanOnly: boolean): string {
  try {
    const compiled = compileEre(c.pattern, c.flags.includes('i'));
    const startChars = Buffer.from(c.text, 'utf8').subarray(0, c.start).toString('utf8').length;
    const found = compiled.exec(c.text, startChars);
    if (found === null) return 'NOMATCH';
    const parts = [`${byteOffset(c.text, found.index)},${byteOffset(c.text, found.end)}`];
    for (let group = 0; group < 9; group++) {
      const range = spanOnly ? null : found.groups[group] ?? null;
      parts.push(range === null ? '-1,-1' : `${byteOffset(c.text, range[0])},${byteOffset(c.text, range[1])}`);
    }
    return `OK ${parts.join(' ')}`;
  } catch (error) {
    if (error instanceof PosixRegexError) return `ERR ${error.message}`;
    throw error;
  }
}

function spanOf(answerText: string): string {
  return answerText.startsWith('OK ') ? answerText.split(' ')[1] : answerText;
}

const hasRepeatedGroup = (p: string): boolean => /\)[*+?{]/.test(p) || /\\[1-9]/.test(p);
const hasBackReferenceToRepeatedGroup = (p: string): boolean => /\)[*+?{]/.test(p) && /\\[1-9]/.test(p);
const hasEscapedLowercase = (p: string): boolean => /\\[a-z]/.test(p.replace(/\\[wWsSbB]/g, ''));

describe('POSIX extended regular expressions recorded from glibc regcomp / regexec', () => {
  for (const fixture of fixtures) {
    it(`${fixture.name} gives the same error text or the same match`, () => {
      let compared = 0;
      let spanOnly = 0;
      const mismatches: string[] = [];
      for (const c of fixture.cases) {
        if (c.flags.includes('i') && hasEscapedLowercase(c.pattern)) continue;
        if (hasBackReferenceToRepeatedGroup(c.pattern)) continue;
        const groupsExcluded = hasRepeatedGroup(c.pattern);
        const got = answer(c, groupsExcluded);
        const want = groupsExcluded ? spanOf(c.want) : c.want;
        const gotCompared = groupsExcluded ? spanOf(got) : got;
        compared++;
        if (groupsExcluded) spanOnly++;
        if (gotCompared !== want) mismatches.push(`${JSON.stringify(c.pattern)} on ${JSON.stringify(c.text)} @${c.start} ${c.flags}\n  want ${want}\n  got  ${gotCompared}`);
      }
      expect(compared).toBeGreaterThan(fixture.cases.length * 0.9);
      expect(spanOnly).toBeLessThan(fixture.cases.length * 0.35);
      expect(mismatches.length > 0 ? `${mismatches.length} of ${compared}\n${mismatches.slice(0, 5).join('\n')}` : '').toBe('');
    });
  }
});
