/**
 * Le langage bash rejoue contre un vrai bash 5.2.
 *
 * src/__tests__/support/oracle/bash-language-bash.json vient de scripts/oracle/record_bash_language.py : des fragments (expansion
 * des parametres, tableaux, arithmetique, tests, boucles, fonctions, citations, redirections, printf, builtins) lances par `bash -c`
 * dans un /tmp/w vide, sortie standard gardee octet pour octet. La sortie d'erreur est coupee des deux cotes par `exec 2>/dev/null` :
 * son libelle porte le nom de l'interprete et le numero de ligne, que le simulateur ne partage pas. Le simulateur rejoue chaque
 * fragment par `bash -c` (shell non interactif, comme au releve).
 *
 * Mesure avant correction (git stash de src/bash et src/network, corpus de 894 fragments) : 230 cas tombaient, repartis sur
 * l'arithmetique 32 bits et sans bases, "$@" / $* / IFS / ${v: -n} / ${!x} / ${@:n} / $(( $(cmd) )), les accolades, le statut de
 * (exit n) et de $(...), PIPESTATUS, la sortie standard d'un groupe { read; } nourri par un tube, les redirections de if/for/while/{ },
 * &>> et >|, `a=1 cmd $a`, les tableaux creux et associatifs, declare -i/-l/-u/-r/-p/-f, printf (%q %e %g %u %*d %(..)T), read -n/-d/IFS,
 * shopt/set -o, pushd/popd/dirs, compgen, trap -p, $LINENO/$_/$RANDOM/$SECONDS/BASH_VERSION, [[ -eq ]] arithmetique, case [[:class:]].
 * Passent avant comme apres : les fragments a une seule commande dont la sortie ne depend d'aucun de ces points (temoins).
 *
 * Ecarts connus et acceptes, retires du corpus : la sortie de `od`, `help`, `env -i`, `export -p` (dependent de la machine de releve),
 * `$_` au demarrage, les entrelacements `a & b & wait` (course), l'alias defini et utilise sur la meme ligne (bash analyse la ligne
 * avant de l'executer), les motifs etendus sans `shopt -s extglob` (le simulateur les accepte toujours).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { LinuxPC } from '@/network/devices/LinuxPC';

interface Fixture {
  readonly cases: ReadonlyArray<{ readonly group: string; readonly command: string; readonly stdout: string }>;
}

const fixture = JSON.parse(readFileSync(new URL('../../support/oracle/bash-language-bash.json', import.meta.url), 'utf8')) as Fixture;

const PRELUDE = 'exec 2>/dev/null; rm -rf /tmp/w; mkdir -p /tmp/w; cd /tmp/w; ';

function quoted(script: string): string {
  return `'${script.replace(/'/g, `'\\''`)}'`;
}

describe('bash language against the recorded bash', () => {
  for (const [index, recorded] of fixture.cases.entries()) {
    it(`#${index} ${recorded.group}: ${recorded.command}`, async () => {
      const pc = new LinuxPC('linux-pc', 'pc1', 0, 0);
      pc.powerOn();
      expect(await pc.executeCommand(`bash -c ${quoted(PRELUDE + recorded.command)}`)).toBe(recorded.stdout.replace(/\n$/, ''));
    });
  }
});
