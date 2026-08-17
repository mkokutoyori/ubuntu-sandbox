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
    return complete(this.table, input, this.session(mode), trigger).suggestions
      .filter(suggestion => !suggestion.isArgument)
      .map(suggestion => ({
        keyword: suggestion.value,
        description: suggestion.description,
      }));
  }
}

/**
 * Ce que l'aide doit montrer d'une ligne deja connue.
 *
 * L'aide d'une CLI Cisco decrit ce qui vient APRES le curseur : ayant
 * tape `show `, on veut lire `conn`, pas `show conn`. Le vocabulaire
 * herite de l'ASA etant une liste de LIGNES, il fallait en extraire le
 * mot suivant — sans quoi l'aide proposait de retaper ce qui etait deja
 * ecrit, ce que le routeur du meme depot ne fait pas.
 */
export function continuationOf(line: string, input: string): string | null {
  const typed = input.trimStart();
  const consumed = typed.endsWith(' ') || typed === ''
    ? typed.trim().split(/\s+/).filter(Boolean).length
    : typed.split(/\s+/).filter(Boolean).length - 1;

  const words = line.split(/\s+/).filter(Boolean);
  if (words.length <= consumed) return null;
  return words[consumed];
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

/**
 * La tabulation complete un MOT, pas une ligne entiere.
 *
 * L'ASA comparait la frappe au texte complet de chaque commande
 * (`'show conn'.startsWith('sh')`), avec deux consequences mesurees
 * contre un routeur et un commutateur du meme depot : `sh` correspondait
 * a huit lignes et ne resolvait donc jamais, la ou les deux autres
 * plateformes rendent `show ` ; et `conf t` ne correspondait a RIEN,
 * parce que `'configure terminal'` ne commence pas par la chaine
 * `'conf t'` — alors que mot a mot il l'abrege exactement.
 *
 * Une CLI Cisco complete mot par mot. Les trois plateformes le font
 * desormais de la meme facon.
 */
export function wordwiseMatches(
  input: string, lines: readonly string[],
): string[] {
  const typed = input.trimStart().split(/\s+/).filter(Boolean);
  const surMotPartiel = !input.endsWith(' ') && typed.length > 0;
  const complets = surMotPartiel ? typed.slice(0, -1) : typed;
  const partiel = surMotPartiel ? typed[typed.length - 1].toLowerCase() : '';

  return [...new Set(lines)].filter(line => {
    const words = line.split(/\s+/).filter(Boolean);
    if (words.length < complets.length) return false;
    for (let index = 0; index < complets.length; index++) {
      if (!words[index].toLowerCase().startsWith(complets[index].toLowerCase())) return false;
    }
    const suite = words[complets.length];
    return suite !== undefined && suite.toLowerCase().startsWith(partiel);
  });
}

export function uniqueWordCompletion(
  input: string, lines: readonly string[],
): string | null {
  const typed = input.trimStart().split(/\s+/).filter(Boolean);
  const surMotPartiel = !input.endsWith(' ') && typed.length > 0;
  const rang = surMotPartiel ? typed.length - 1 : typed.length;

  // La ligne rendue est faite des mots de la COMMANDE, pas de ceux
  // tapes : `conf t` doit devenir `configure terminal`, et non
  // `conf terminal`. Une abreviation se developpe, elle ne se recopie
  // pas.
  const prefixes = new Set<string>();
  const suites = new Set<string>();
  for (const line of wordwiseMatches(input, lines)) {
    const words = line.split(/\s+/).filter(Boolean);
    prefixes.add(words.slice(0, rang).join(' '));
    suites.add(words[rang]);
  }
  if (suites.size !== 1 || prefixes.size !== 1) return null;

  return [...[...prefixes][0].split(' ').filter(Boolean), [...suites][0]].join(' ') + ' ';
}

/**
 * Les candidats sont des MOTS a la position du curseur, pas des lignes.
 *
 * La session compte les candidats pour decider si elle complete : l'ASA
 * en rendait un par ligne, donc `sh` en avait huit — toutes commencant
 * pourtant par le meme mot — et la tabulation ne faisait rien, la ou un
 * routeur en rend un seul (`show`) et complete. Mesure faite dans le
 * NAVIGATEUR : l'unite voyait `cliTabComplete('sh')` rendre `show `
 * pendant que la touche ne produisait rien.
 */
export function wordwiseCandidates(
  input: string, lines: readonly string[],
): string[] {
  const typed = input.trimStart().split(/\s+/).filter(Boolean);
  const surMotPartiel = !input.endsWith(' ') && typed.length > 0;
  const rang = surMotPartiel ? typed.length - 1 : typed.length;

  const out = new Set<string>();
  for (const line of wordwiseMatches(input, lines)) {
    const words = line.split(/\s+/).filter(Boolean);
    out.add(words.slice(0, rang + 1).join(' '));
  }
  return [...out].sort();
}

/**
 * Tout ce que la machine sait taper a cet endroit, en LIGNES.
 *
 * Le vocabulaire herite en fournit une partie, le socle l'autre — et il
 * faut l'interroger deux fois : a la racine pour les premiers mots, puis
 * sous ce qui est deja tape pour les suivants, sinon `show ver` n'aurait
 * aucun candidat.
 */
export function knownCommandLines(
  input: string,
  vocabulary: readonly string[],
  suggestionsAt: (at: string) => readonly HelpLine[],
): string[] {
  const prefix = input.trimStart();
  const stem = stemOf(input);
  const lines = [
    ...vocabulary,
    ...suggestionsAt('').map(line => line.keyword),
    ...(stem === '' ? [] : suggestionsAt(`${stem} `).map(line => `${stem} ${line.keyword}`)),
  ];
  return [...new Set(lines)].filter(line => line !== prefix).sort();
}

/**
 * L'aide d'une CLI Cisco decrit la SUITE, en colonnes alignees.
 *
 * Une meme suite peut venir de deux sources ; la premiere description
 * non vide gagne, parce qu'une colonne vide est ce que ce rendu existe
 * pour eviter.
 */
export function renderContinuationHelp(
  input: string, lines: readonly HelpLine[],
): string[] {
  const seen = new Map<string, string>();
  for (const line of lines) {
    const suite = continuationOf(line.keyword, input);
    if (suite === null) continue;
    if (!seen.has(suite) || seen.get(suite) === '') seen.set(suite, line.description);
  }
  const large = Math.max(0, ...[...seen.keys()].map(word => word.length));
  return [...seen.entries()].sort((left, right) => left[0].localeCompare(right[0]))
    .map(([suite, description]) => `  ${suite.padEnd(large + 2)}${description}`.trimEnd());
}

/**
 * Une aide qui ne trouve rien REFUSE, elle ne se tait pas.
 *
 * L'ASA rendait une liste vide pour une commande inconnue, donc un
 * terminal qui appelle `cliHelp` directement n'affichait rien du tout,
 * la ou un routeur et un commutateur du meme depot repondent
 * `% Invalid input detected at '^' marker.`. Le silence est la pire des
 * trois reponses : il ne distingue pas « je ne connais pas » de « je
 * n'ai rien a proposer ici ».
 */
export function helpOrRefusal(lines: readonly string[], refusal: string): string[] {
  return lines.length > 0 ? [...lines] : [refusal];
}
