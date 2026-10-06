/**
 * Sonde : une affectation posee devant une commande (`VAR=val cmd`) vaut pour
 * cette commande seule. Bash l'exporte vers le processus, la rend visible a la
 * fonction ou au builtin appele, puis restaure la valeur precedente (ou laisse
 * la variable non definie) quand la commande est terminee. `declare -x` et
 * `declare -r` portent leurs attributs sur les affectations qui les suivent.
 *
 * Mesure avant correction (`git stash` des deux fichiers sources) : 9 des 13
 * cas tombent. La valeur ecrite devant la commande restait dans le shell :
 * `LDAPTLS_REQCERT=never ldapsearch ...` affaiblissait toutes les commandes
 * suivantes de la session ; `declare -x B=2` n'exportait pas B.
 *
 * Passent avant comme apres, et pourquoi :
 *  - « the external command receives the prefix assignment » : temoin, il
 *    prouve que le laboratoire transmet l'environnement au processus ;
 *  - « a later external command does not inherit it » : structurel, la
 *    variable fuyante n'etait pas exportee, seule la lecture par le shell
 *    la trahissait ;
 *  - « a plain assignment persists » et « an assignment-only line with a
 *    redirection persists » : non-regression, aucune commande ne suit.
 */
import { describe, it, expect } from 'vitest';
import { BashLexer } from '@/bash/lexer/BashLexer';
import { BashParser } from '@/bash/parser/BashParser';
import { BashInterpreter } from '@/bash/interpreter/BashInterpreter';
import type { ExternalCommandFn } from '@/bash/interpreter/BashInterpreter';

const lexer = new BashLexer();
const parser = new BashParser();

const environmentProbe: ExternalCommandFn = (argv, env, _background, _outputPiped, stdin) => {
  if (argv[0] === 'showenv') {
    return argv.slice(1).map((name) => `${name}=${env?.[name] ?? ''}`).join(' ');
  }
  if (argv[0] === 'cat') return stdin ?? '';
  return '';
};

function run(script: string): string {
  const interpreter = new BashInterpreter({ executeCommand: environmentProbe });
  return interpreter.execute(parser.parse(lexer.tokenize(script))).output;
}

describe('A prefix assignment applies to its own command only', () => {
  it('the external command receives the prefix assignment', () => {
    expect(run('FOO=bar showenv FOO')).toContain('FOO=bar');
  });

  it('the shell does not keep the variable once the external command returned', () => {
    expect(run('FOO=bar showenv FOO; echo "[$FOO]"')).toContain('[]');
  });

  it('a later external command does not inherit it', () => {
    const output = run('FOO=bar showenv FOO; showenv FOO');
    expect(output.trim().split('\n')).toEqual(['FOO=bar', 'FOO=']);
  });

  it('the previous value of the variable comes back', () => {
    expect(run('FOO=old; FOO=new showenv FOO; echo "[$FOO]"')).toContain('[old]');
  });

  it('an exported variable keeps its exported value for later commands', () => {
    const output = run('export FOO=old; FOO=new showenv FOO; showenv FOO');
    expect(output.trim().split('\n')).toEqual(['FOO=new', 'FOO=old']);
  });

  it('two prefix assignments are both visible and both withdrawn', () => {
    const output = run('A=1 B=2 showenv A B; echo "[$A$B]"');
    expect(output).toContain('A=1 B=2');
    expect(output).toContain('[]');
  });

  it('a pipeline stage does not leak it', () => {
    expect(run('FOO=bar showenv FOO | cat; echo "[$FOO]"')).toContain('[]');
  });

  it('a function sees it during the call and loses it afterwards', () => {
    const output = run('show() { echo "in=$FOO"; }; FOO=bar show; echo "after=[$FOO]"');
    expect(output).toContain('in=bar');
    expect(output).toContain('after=[]');
  });

  it('eval sees it and the shell does not keep it', () => {
    const output = run("FOO=bar eval 'echo in=$FOO'; echo \"after=[$FOO]\"");
    expect(output).toContain('in=bar');
    expect(output).toContain('after=[]');
  });

  it('a builtin that reads a prefixed IFS does not leave it behind', () => {
    const output = run('IFS=: read first second <<< "x:y"; echo "$first $second [$IFS]"');
    expect(output).toContain('x y');
    expect(output).not.toContain('[:]');
  });

  it('a plain assignment persists', () => {
    expect(run('FOO=bar; echo "[$FOO]"')).toContain('[bar]');
  });

  it('export and declare -x persist', () => {
    const output = run('export A=1; declare -x B=2; showenv A B; echo "[$A$B]"');
    expect(output).toContain('A=1 B=2');
    expect(output).toContain('[12]');
  });

  it('an assignment-only line with a redirection persists', () => {
    expect(run('FOO=bar > /dev/null; echo "[$FOO]"')).toContain('[bar]');
  });
});
