import { argumentAccepts, resolveEnumValue } from './ArgumentTypes';
import type { ArgumentSpec } from './ArgumentTypes';

/**
 * Un mot-cle FACULTATIF, que sa commande accepte a n'importe quel rang.
 *
 * Un `CommandSpec` decrit une SEQUENCE de pas, et beaucoup de commandes
 * d'IOS ne sont pas des sequences : `crypto key generate rsa
 * [general-keys | usage-keys] [label <nom>] [exportable] [modulus
 * <360-4096>]` accepte ses quatre options dans n'importe quel ordre.
 * Sans une notion pour le dire, il ne restait que trois issues, toutes
 * mauvaises — declarer chaque ordre, declarer une place `REST` et
 * analyser dans le gestionnaire (c'est le glouton du trie, sans le
 * gain), ou refuser des formes que la machine accepte.
 *
 * Le sac est LU PAR LES DEUX MOTEURS, l'analyse et l'aide, depuis ce
 * seul fichier : deux lectures d'une meme declaration finiraient par
 * annoncer autre chose que ce qui est accepte, et c'est precisement le
 * defaut que ce chantier passe son temps a refermer.
 */
export interface OptionSpec {
  readonly keyword: string;
  readonly description: string;
  /** La valeur que ce mot-cle prend, s'il en prend une. */
  readonly argument?: ArgumentSpec;
}

export type OptionBagVerdict =
  | { readonly kind: 'ok'; readonly args: Record<string, string> }
  | { readonly kind: 'invalid'; readonly at: number }
  | { readonly kind: 'incomplete' };

/**
 * Ce que ce mot designe parmi les options RESTANTES.
 *
 * IOS abrege tout, options comprises, et la regle est celle du reste du
 * socle : un exact l'emporte sur un prefixe, un prefixe partage par
 * plusieurs ne designe rien. Une option DEJA donnee ne se propose plus,
 * donc `modulus 1024 mod 2048` refuse le second au lieu de l'ecraser en
 * silence.
 */
export function resolveOption(
  options: readonly OptionSpec[], token: string,
): OptionSpec | undefined {
  const bas = token.toLowerCase();
  const exact = options.find(option => option.keyword.toLowerCase() === bas);
  if (exact) return exact;
  const prefixes = options.filter(
    option => option.keyword.toLowerCase().startsWith(bas));
  return prefixes.length === 1 ? prefixes[0] : undefined;
}

/** Le nom sous lequel le gestionnaire lit cette option. */
export function optionArgName(option: OptionSpec): string {
  return option.argument?.name ?? option.keyword;
}

/**
 * Lit la queue de la frappe comme un sac d'options.
 *
 * Rend le rang ABSOLU du jeton fautif plutot qu'un booleen, pour que
 * l'appelant place son caret la ou l'operateur s'est trompe.
 */
export function consumeOptionBag(
  options: readonly OptionSpec[], tokens: readonly string[], from: number,
): OptionBagVerdict {
  const args: Record<string, string> = {};
  let restantes = [...options];

  for (let index = from; index < tokens.length; index++) {
    const option = resolveOption(restantes, tokens[index]);
    if (!option) return { kind: 'invalid', at: index };
    restantes = restantes.filter(autre => autre !== option);

    if (!option.argument) {
      args[optionArgName(option)] = option.keyword;
      continue;
    }
    const brut = tokens[index + 1];
    if (brut === undefined) return { kind: 'incomplete' };
    if (!argumentAccepts(option.argument, brut)) {
      return { kind: 'invalid', at: index + 1 };
    }
    args[optionArgName(option)] =
      resolveEnumValue(option.argument, brut) ?? brut;
    index++;
  }

  return { kind: 'ok', args };
}

/**
 * Les options qu'il reste a proposer apres ce qui a deja ete tape.
 *
 * L'aide lit la MEME resolution que l'analyse — c'est ce qui empeche
 * `?` d'offrir une option que la commande vient de refuser comme
 * doublon.
 */
export function remainingOptions(
  options: readonly OptionSpec[], typed: readonly string[],
): OptionSpec[] {
  let restantes = [...options];
  for (let index = 0; index < typed.length; index++) {
    const option = resolveOption(restantes, typed[index]);
    if (!option) continue;
    restantes = restantes.filter(autre => autre !== option);
    if (option.argument) index++;
  }
  return restantes;
}

/**
 * Le rang du jeton ou l'aide se trouve : sur un mot-cle d'option, ou sur
 * la VALEUR que ce mot-cle attend.
 *
 * `crypto key generate rsa modulus ?` doit annoncer `<360-4096>` et non
 * la liste des options restantes — la place est prise, et c'est elle que
 * l'operateur interroge.
 */
export function pendingOptionArgument(
  options: readonly OptionSpec[], typed: readonly string[],
): ArgumentSpec | undefined {
  let restantes = [...options];
  for (let index = 0; index < typed.length; index++) {
    const option = resolveOption(restantes, typed[index]);
    if (!option) continue;
    restantes = restantes.filter(autre => autre !== option);
    if (!option.argument) continue;
    if (index + 1 >= typed.length) return option.argument;
    index++;
  }
  return undefined;
}
