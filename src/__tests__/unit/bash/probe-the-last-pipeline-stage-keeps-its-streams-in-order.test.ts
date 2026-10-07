/**
 * Sonde : la derniere commande d'un pipeline ecrit sur le terminal, comme
 * une commande seule. Ses sorties standard et d'erreur y arrivent dans
 * l'ordre ou le programme les a ecrites (`kinit -V` affiche
 * « Using principal » sur la sortie d'erreur AVANT l'invite du mot de passe
 * sur la sortie standard) ; seules les etapes qui ne sont pas les dernieres
 * alimentent le tube et laissent leur sortie d'erreur rejoindre le terminal
 * apres le pipeline.
 *
 * Mesure avant correction (interpreteur du depot sans la correction) : 3 des
 * 6 cas tombent. `echo pw | kinit -V user` rendait la sortie standard puis la
 * sortie d'erreur, le terminal montrait l'invite avant les lignes
 * « Using ... » (deux etapes), le meme programme en fin d'un pipeline a trois
 * etapes et en fin d'une liste `&&`.
 *
 * Passent avant comme apres, et pourquoi :
 *  - « a command alone keeps the order it wrote » : temoin, il prouve que
 *    le laboratoire rend bien l'ordre entrelace quand rien ne l'en empeche ;
 *  - « a stage that feeds a pipe keeps its error stream out of the pipe » :
 *    non-regression, le tube ne recoit que la sortie standard ;
 *  - « the error stream is shown once » : structurel, il compte les lignes
 *    sans dependre de l'ordre.
 *
 * Le laboratoire n'a pas de systeme de fichiers : les redirections de la
 * derniere etape sont mesurees sur la machine Linux dans la sonde de
 * `kinit`, `klist` et `kdestroy`.
 */
import { describe, it, expect } from 'vitest';
import { BashLexer } from '@/bash/lexer/BashLexer';
import { BashParser } from '@/bash/parser/BashParser';
import { BashInterpreter } from '@/bash/interpreter/BashInterpreter';
import type { ExternalCommandFn } from '@/bash/interpreter/BashInterpreter';

const lexer = new BashLexer();
const parser = new BashParser();

const programs: ExternalCommandFn = (argv, _env, _background, _outputPiped, stdin) => {
  if (argv[0] === 'chatty') {
    return { output: 'prompt: ', stderr: 'Using principal', interleaved: 'Using principal\nprompt: ', exitCode: 0 };
  }
  if (argv[0] === 'cat') return stdin ?? '';
  return '';
};

function terminal(script: string): string {
  const interpreter = new BashInterpreter({ executeCommand: programs });
  return interpreter.execute(parser.parse(lexer.tokenize(script))).output;
}

describe('The last stage of a pipeline writes to the terminal in program order', () => {
  it('a command alone keeps the order it wrote', () => {
    expect(terminal('chatty')).toBe('Using principal\nprompt: \n');
  });

  it('the last stage of a two-stage pipeline keeps the order it wrote', () => {
    expect(terminal('echo pw | chatty')).toBe('Using principal\nprompt: \n');
  });

  it('the last stage of a three-stage pipeline keeps the order it wrote', () => {
    expect(terminal('echo pw | cat | chatty')).toBe('Using principal\nprompt: \n');
  });

  it('the last stage of a command list keeps the order it wrote', () => {
    expect(terminal('true && echo pw | chatty')).toContain('Using principal\nprompt: \n');
  });

  it('a stage that feeds a pipe keeps its error stream out of the pipe', () => {
    const output = terminal('chatty | cat');
    expect(output.startsWith('prompt: ')).toBe(true);
    expect(output.endsWith('Using principal\n')).toBe(true);
  });

  it('the error stream is shown once', () => {
    const lines = terminal('echo pw | chatty').split('\n').filter((line) => line.includes('Using principal'));
    expect(lines).toHaveLength(1);
  });
});
