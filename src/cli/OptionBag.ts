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
  readonly moreArguments?: readonly ArgumentSpec[];
  readonly choices?: readonly OptionSpec[];
}

function placesOf(option: OptionSpec, choix?: OptionSpec): readonly ArgumentSpec[] {
  const source = choix ?? option;
  return [
    ...(source.argument ? [source.argument] : []),
    ...(source.moreArguments ?? []),
  ];
}

function choiceArgument(option: OptionSpec): ArgumentSpec {
  return {
    name: option.keyword, type: 'ENUM', description: option.description,
    values: (option.choices ?? []).map(choix => ({
      keyword: choix.keyword, description: choix.description,
    })),
  };
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
 * Une place cede-t-elle ce jeton au sac ?
 *
 * `permit icmp any any ttl lt 255` posait un TYPE de message ICMP :
 * `ttl` abrege `ttl-exceeded`, que la place enumere, et la place est
 * consultee avant le sac. La regle qui tranche est celle que le sac
 * applique deja entre ses propres mots — un EXACT l'emporte sur un
 * prefixe — et elle vaut aussi entre une place et une option.
 */
export function placeCedeAuSac(
  place: ArgumentSpec, token: string, options: readonly OptionSpec[] | undefined,
): boolean {
  const bas = token.toLowerCase();
  if (!options?.some(option => option.keyword.toLowerCase() === bas)) return false;
  const resolu = resolveEnumValue(place, token);
  return resolu !== undefined && resolu.toLowerCase() !== bas;
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

    let choix: OptionSpec | undefined;
    if (option.choices) {
      const suivant = tokens[index + 1];
      if (suivant === undefined) return { kind: 'incomplete' };
      choix = resolveOption(option.choices, suivant);
      if (!choix) return { kind: 'invalid', at: index + 1 };
      args[option.keyword] = choix.keyword;
      index++;
    }

    const places = placesOf(option, choix);
    if (places.length === 0) {
      if (!choix) args[optionArgName(option)] = option.keyword;
      continue;
    }

    let fini = false;
    for (const place of places) {
      const brut = tokens[index + 1];
      if (brut === undefined) {
        if (place.optional) break;
        return { kind: 'incomplete' };
      }
      /*
       * Une valeur `REST` prend TOUTE la suite de la ligne et termine le
       * sac : `username bob description chef de projet` decrit un chef de
       * projet, pas une option `chef` suivie de deux mots inconnus. C'est
       * la meme regle qu'une place `REST` dans un chemin — le sac ne
       * savait pas la dire, si bien qu'une famille dont une option prend
       * une phrase ne pouvait pas se declarer et restait glouton.
       */
      if (place.type === 'REST') {
        args[place.name] = tokens.slice(index + 1).join(' ');
        fini = true;
        break;
      }
      if (!argumentAccepts(place, brut)) {
        if (place.optional) break;
        return { kind: 'invalid', at: index + 1 };
      }
      args[place.name] = resolveEnumValue(place, brut) ?? brut;
      index++;
    }
    if (fini) return { kind: 'ok', args };
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
  const facultatives: OptionSpec[] = [];
  for (let index = 0; index < typed.length; index++) {
    const option = resolveOption(restantes, typed[index]);
    if (!option) continue;
    restantes = restantes.filter(autre => autre !== option);

    let choix: OptionSpec | undefined;
    if (option.choices) {
      choix = resolveOption(option.choices, typed[index + 1] ?? '');
      index++;
    }
    for (const place of placesOf(option, choix)) {
      if (place.type === 'REST' && index + 1 < typed.length) return [];
      const brut = typed[index + 1];
      if (brut === undefined) {
        if (place.optional && place.values) {
          facultatives.push(...place.values.map(valeur => ({
            keyword: valeur.keyword, description: valeur.description,
          })));
        }
        break;
      }
      if (place.optional && !argumentAccepts(place, brut)) break;
      index++;
    }
  }
  return [...restantes, ...facultatives];
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

    let choix: OptionSpec | undefined;
    if (option.choices) {
      if (index + 1 >= typed.length) return choiceArgument(option);
      choix = resolveOption(option.choices, typed[index + 1]);
      index++;
      if (!choix) continue;
    }
    for (const place of placesOf(option, choix)) {
      const brut = typed[index + 1];
      if (brut === undefined) return place.optional ? undefined : place;
      if (place.optional && !argumentAccepts(place, brut)) break;
      index++;
    }
  }
  return undefined;
}
