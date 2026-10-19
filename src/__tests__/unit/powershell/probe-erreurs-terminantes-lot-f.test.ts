/**
 * Probe — erreurs terminantes d'instruction (statement-terminating) du shell interactif PowerShell, mesurees contre
 * about_Throw / about_Try_Catch_Finally / about_Trap et le comportement de pwsh 7.6 :
 * une erreur du moteur (1/0, commande inconnue, liaison de parametres) termine l'INSTRUCTION, est rapportee puis
 * l'execution reprend a l'instruction suivante, sauf sous try/catch ou trap actifs plus haut dans la pile ou si
 * $ErrorActionPreference vaut Stop ; `throw` reste terminant pour le script entier, sauf sous SilentlyContinue/Ignore
 * hors portee de capture (l'erreur va dans $Error pour SilentlyContinue seulement, execution reprise).
 * Discrimination : sur la base 59565f1b2, 13 cas rouges sur 17 (dont 3 cas ABORT rouges parce que `describeFailure`, qui rend
 * le texte d'erreur partage avec le terminal, n'existe pas encore).
 * Temoins (4, verts avant et apres) : trap + continue, try/catch attrape 1/0 (deux formes), execute() (API hote) leve toujours.
 */
import { describe, it, expect } from 'vitest';
import { PSInterpreter } from '@/powershell/interpreter/PSInterpreter';
import { NativeCommandNeedsAsync } from '@/powershell/nativeAsync';

function interactive(code: string): string {
  const interp = new PSInterpreter(undefined, { language: 'core' });
  try {
    interp.beginInteractive(code);
    for (;;) {
      try {
        return interp.resumeInteractive().replace(/\r?\n/g, '|');
      } catch (e) {
        if (!(e instanceof NativeCommandNeedsAsync)) throw e;
        interp.provideNativeResult({
          output: `The term '${interp.typedCommandName(e.command)}' is not recognized as a name of a cmdlet, function, script file, or executable program.`,
          exitCode: 1,
          notRecognized: true,
        });
      }
    }
  } catch (e) {
    return `ABORT ${interp.describeFailure(e)}`.replace(/\r?\n/g, '|');
  }
}

const CASES: Array<[string, string]> = [
  ["1/0; 'after'", "RuntimeException: Attempted to divide by zero.|after"],
  ["$x = 1/0; 'after'", "RuntimeException: Attempted to divide by zero.|after"],
  ["Get-Zork; 'after'", "Get-Zork: The term 'Get-Zork' is not recognized as a name of a cmdlet, function, script file, or executable program.|after"],
  ["function f { 1/0; 'in-f' }; f; 'after'", "RuntimeException: Attempted to divide by zero.|in-f|after"],
  ["1/0; 1/0; 'after'", "RuntimeException: Attempted to divide by zero.|RuntimeException: Attempted to divide by zero.|after"],
  ["$ErrorActionPreference='SilentlyContinue'; 1/0; 'after'; $Error.Count", "after|1"],
  ["$ErrorActionPreference='Ignore'; 1/0; 'after'; $Error.Count", "after|0"],
  ["$ErrorActionPreference='SilentlyContinue'; throw 'x'; 'after'; $Error.Count", "after|1"],
  ["$ErrorActionPreference='Ignore'; throw 'x'; 'after'; $Error.Count", "after|0"],
  ["trap { 'trapped'; continue } 1/0; 'after'", "trapped|after"],
  ["function g { [CmdletBinding()]param() 1/0; 'g-after' }; g; 'after'", "RuntimeException: Attempted to divide by zero.|g-after|after"],
  ["try { function h { 1/0; 'h-after' }; h } catch { 'caught' }; 'after'", "caught|after"],
  ["try { 1/0; 'in-try' } catch { 'caught' }; 'after'", "caught|after"],
  ["throw 'x'; 'after'", "ABORT Exception: x"],
  ["$ErrorActionPreference='Stop'; 1/0; 'after'", "ABORT RuntimeException: Attempted to divide by zero."],
  ["Write-Error 'e' -ErrorAction Stop; 'after'", "ABORT Write-Error: e"],
];

describe('erreurs terminantes d\'instruction (shell interactif)', () => {
  for (const [code, expected] of CASES) {
    it(code, () => {
      expect(interactive(code)).toBe(expected);
    });
  }

  it('execute() (API hote) leve toujours la premiere erreur', () => {
    const interp = new PSInterpreter(undefined, { language: 'core' });
    expect(() => interp.execute("1/0; 'after'")).toThrow();
  });
});
