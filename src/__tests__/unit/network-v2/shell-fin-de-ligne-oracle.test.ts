/**
 * Les octets d'une commande ne gagnent pas de fin de ligne en route : rejoue contre un vrai bash.
 *
 * src/__tests__/support/oracle/shell-output-bash.json vient de scripts/oracle/record_shell_output.py : des lignes de commande lancees par
 * `bash -c`, dont la sortie est gardee octet pour octet. Les entrees sont des printf, avec et sans fin de ligne finale ; le `; echo END`
 * qui suit montre si la commande precedente a ecrit des octets ou des lignes. Le simulateur rejoue les memes lignes. Comme partout dans
 * le simulateur, la derniere fin de ligne de la sortie finale n'est pas rendue (le terminal l'ajoute) : on la retire de la sortie de bash.
 *
 * Mesure avant correction (git stash de src/network et src/bash) : 79 cas sur 261 tombent. Le shell ajoutait une fin de ligne a la sortie d'une commande
 * « brute » (curl, printf, cat, head...) des qu'une redirection etait presente ou que la commande etait un etage de tube, head, tail
 * (fichier) et sed -n retiraient la leur, rev, tac, base64 et xargs la fabriquaient ou la perdaient, wc justifiait a 7 colonnes un
 * operande unique, wc sur l'entree standard perdait sa justification, sort -n ne departageait pas les egalites par la comparaison
 * de dernier recours de GNU sort, cat ignorait -n -b -E -T -A -s -v -e -t.
 * Passent avant comme apres : les cas ou la commande ecrit des lignes entieres et ou la sortie finale se termine par echo.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { LinuxPC } from '@/network/devices/LinuxPC';

interface Fixture {
  readonly cases: ReadonlyArray<{ readonly command: string; readonly stdout: string }>;
}

const fixture = JSON.parse(readFileSync(new URL('../../support/oracle/shell-output-bash.json', import.meta.url), 'utf8')) as Fixture;

describe('shell output against the recorded bash', () => {
  const pc = new LinuxPC('linux-pc', 'pc1', 0, 0);
  pc.powerOn();

  for (const [index, recorded] of fixture.cases.entries()) {
    it(`#${index} ${recorded.command}`, async () => {
      expect(await pc.executeCommand(recorded.command)).toBe(recorded.stdout.replace(/\n$/, ''));
    });
  }
});
