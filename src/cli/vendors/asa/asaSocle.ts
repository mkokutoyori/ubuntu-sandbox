import { CommandTable } from '../../CommandTable';
import { newSession, type CliSession } from '../../CliSession';
import { parseCommand } from '../../CommandParser';
import { complete, type CompletionTrigger } from '../../CompletionEngine';
import { ASA_MODES, ASA_PROMPTS, ASA_TOP_LEVEL, ASA_EXEC_LEVEL } from './asaModes';
import { asaShowFamily, type AsaShowHost } from './asaShowFamily';

export interface HelpLine {
  readonly keyword: string;
  readonly description: string;
}

/**
 * Le socle d'un ASA : une table, trois portes.
 *
 * Ce qui y est declare s'execute, se decrit et se complete par le meme
 * objet — alors que `ASA_VOCABULARY`, `ASA_COMMAND_HELP` et le `switch`
 * du shell etaient trois magasins qu'aucune regle ne tenait ensemble.
 *
 * Il vit dans la couche CLI et non dans le module pare-feu, dont les
 * garde-fous d'architecture veulent qu'un fichier vendeur assemble sans
 * calculer.
 */
export class AsaSocle {
  private readonly table = new CommandTable();

  constructor(
    private readonly hostname: () => string,
    private readonly device: unknown,
    host: () => AsaShowHost,
  ) {
    for (const spec of asaShowFamily(host)) this.table.declare(spec);
  }

  private session(mode: string): CliSession {
    return newSession(this.hostname(), this.device, {
      hierarchy: ASA_MODES, prompts: ASA_PROMPTS,
      topLevel: ASA_TOP_LEVEL, execLevel: ASA_EXEC_LEVEL,
      initialMode: mode,
    });
  }

  run(line: string, mode: string): string | null {
    const session = this.session(mode);
    const parsed = parseCommand(this.table, line, session);
    if (parsed.status !== 'ok') return null;

    const output = parsed.spec.run(session, parsed.args);
    return typeof output === 'string' ? output : null;
  }

  suggestions(input: string, mode: string, trigger: CompletionTrigger): HelpLine[] {
    const stem = stemOf(input);
    return complete(this.table, input, this.session(mode), trigger).suggestions
      .filter(suggestion => !suggestion.isArgument)
      .map(suggestion => ({
        keyword: `${stem} ${suggestion.value}`.trim(),
        description: suggestion.description,
      }));
  }
}

/**
 * Ce qui precede le mot en cours de frappe.
 *
 * Le vocabulaire herite d'un ASA est une liste de LIGNES (`show conn`),
 * la completion du socle une liste de MOTS-CLES : sans ce recollement,
 * un mot-cle arriverait seul dans une liste de lignes.
 */
export function stemOf(input: string): string {
  const trimmed = input.trimStart();
  if (input.endsWith(' ') || trimmed === '') return trimmed.trim();
  return trimmed.slice(0, trimmed.lastIndexOf(' ') + 1).trim();
}

export function mergeHelpLines(
  legacy: readonly HelpLine[], fromSocle: readonly HelpLine[],
): HelpLine[] {
  const merged = [...legacy];
  for (const line of fromSocle) {
    if (!merged.some(known => known.keyword === line.keyword)) merged.push(line);
  }
  return merged.sort((left, right) => left.keyword.localeCompare(right.keyword));
}
