import { isValidIPv4, isValidIPv6, isValidSubnetMask } from '../network/core/ip';

export type ArgumentType =
  | 'INT' | 'WORD' | 'LINE' | 'IP_ADDR' | 'IPV6_ADDR' | 'IP_ANY' | 'SUBNET_MASK'
  | 'MAC_ADDR' | 'INTERFACE' | 'VLAN_ID' | 'REST' | 'ENUM' | 'TIME';

export interface EnumValue {
  readonly keyword: string;
  readonly description: string;
}

export interface ArgumentSpec {
  readonly name: string;
  readonly type: ArgumentType;
  readonly optional?: boolean;
  /**
   * Ce que `?` ecrit en face du type.
   *
   * Sans elle, l'aide rendait le NOM de l'argument — `strate` la ou IOS
   * ecrit « Stratum number ». Un nom est fait pour le code, une
   * description pour l'operateur ; les confondre donne une aide
   * redigee en variables.
   */
  readonly description?: string;
  /**
   * Les bornes d'un entier, quand la commande en a.
   *
   * Sans elles un reglage borne se declare `INT` et son gestionnaire
   * refait le controle a la main, donc l'aide annonce
   * `<0-4294967295>` — un intervalle que la commande n'accepte pas — et
   * une valeur hors plage traverse l'analyse pour n'etre refusee qu'au
   * fond. IOS annonce la vraie plage, et c'est ce qui dispense de la
   * chercher dans la documentation.
   */
  readonly range?: readonly [number, number];
  /**
   * Les valeurs qu'un mot-cle-argument accepte, avec leur description.
   *
   * C'est ce qui distingue `logging console ?` — qui doit rendre les
   * huit severites AVEC leur numero — d'un `WORD` muet. Un argument
   * enumere n'est pas un mot-cle de plus dans l'arbre : il occupe une
   * position d'argument, mais son domaine est fini et descriptible.
   */
  readonly values?: readonly EnumValue[];
  /**
   * Les FORMES qu'une meme place accepte, quand il y en a plusieurs.
   *
   * `ip access-group ?` en rend trois — `<1-199>`, `<1300-2699>`,
   * `WORD` — et ce ne sont pas des valeurs admises mais des TYPES,
   * chacun avec sa description. Sans elles, la place est decrite par
   * une seule de ses formes et les autres passent pour invalides a la
   * lecture, alors que la machine les accepte.
   */
  readonly alternatives?: readonly EnumValue[];
  /**
   * Le rendu impose, quand le type ne suffit pas a le decrire (`hh:mm`).
   */
  readonly literal?: string;
  /**
   * La FORME que la valeur doit avoir, quand le type ne suffit pas.
   *
   * `clock set hh:mm:ss` en est le cas type : un `WORD` accepte
   * `99:99:99`, donc le refus arrive au fond du gestionnaire et ne peut
   * plus dire OU l'operateur s'est trompe. Valider a la place de
   * l'argument est ce qui rend le caret d'IOS possible.
   */
  readonly pattern?: RegExp;
}

export interface ArgumentTypeDefinition {
  readonly placeholder: string;
  accepts(token: string): boolean;
}

const MAC = /^([0-9a-f]{4}\.){2}[0-9a-f]{4}$|^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i;
const INTERFACE_NAME = /^[A-Za-z][A-Za-z-]*[0-9]+(\/[0-9]+)*(\.[0-9]+)?$/;
/**
 * Une heure du jour, `hh:mm` ou `hh:mm:ss`.
 *
 * Elle etait declaree `WORD` avec un `literal` d'affichage, ce qui
 * annonce `hh:mm` a l'operateur et accepte n'importe quoi — `25:99`
 * passait. Le `literal` decrit, il ne verifie pas ; un type qui ne
 * verifie rien est un critere range et jamais evalue.
 */
const TIME_OF_DAY = /^(?:[01]\d|2[0-3]|24):[0-5]\d(?::[0-5]\d)?$/;

export const ARGUMENT_TYPES: Readonly<Record<ArgumentType, ArgumentTypeDefinition>> =
  Object.freeze({
    INT: { placeholder: '<0-4294967295>', accepts: (t) => /^\d+$/.test(t) },
    WORD: { placeholder: 'WORD', accepts: (t) => t.length > 0 && !/\s/.test(t) },
    LINE: { placeholder: 'LINE', accepts: (t) => t.length > 0 },
    IP_ADDR: { placeholder: 'A.B.C.D', accepts: (t) => isValidIPv4(t) },
    IPV6_ADDR: { placeholder: 'X:X:X:X::X', accepts: (t) => isValidIPv6(t) },
    /*
     * Une place qui prend l'une OU l'autre famille.
     *
     * `icmp-echo <cible>` en est une : la meme commande accepte
     * `10.0.0.9` et `2001:db8::2`. La declarer `IP_ADDR` refuse la
     * moitie de ce que la machine execute, et la declarer `WORD`
     * n'annonce plus rien — c'est le type qui doit porter les deux, les
     * deux formes se nommant par `alternatives`.
     */
    IP_ANY: {
      placeholder: 'A.B.C.D',
      accepts: (t) => isValidIPv4(t) || isValidIPv6(t),
    },
    SUBNET_MASK: { placeholder: 'A.B.C.D', accepts: (t) => isValidSubnetMask(t) },
    MAC_ADDR: { placeholder: 'H.H.H', accepts: (t) => MAC.test(t) },
    INTERFACE: { placeholder: 'IFACE', accepts: (t) => INTERFACE_NAME.test(t) },
    REST: { placeholder: 'LINE', accepts: (t) => t.length > 0 },
    ENUM: { placeholder: 'WORD', accepts: (t) => t.length > 0 },
    TIME: { placeholder: 'hh:mm', accepts: (t) => TIME_OF_DAY.test(t) },
    VLAN_ID: {
      placeholder: '<1-4094>',
      accepts: (t) => /^\d+$/.test(t) && Number(t) >= 1 && Number(t) <= 4094,
    },
  });

/**
 * Ce que l'argument accepte VRAIMENT, bornes et domaine compris.
 *
 * La table des types ne connait que la forme ; c'est la declaration qui
 * porte la plage et les valeurs. Les separer laisserait le gestionnaire
 * refaire le controle, ce qui est exactement le critere range et jamais
 * evalue que ce depot passe son temps a refermer.
 */
/**
 * La valeur enumeree que designe ce mot, abreviations comprises.
 *
 * IOS abrege TOUT, y compris les valeurs : `logging console warn` vaut
 * `warnings`. Un exact l'emporte sur un prefixe — sans quoi `serve`
 * serait ambigu avec `serve-only` alors qu'il existe pour lui-meme — et
 * un prefixe partage par plusieurs ne designe rien.
 */
export function quotedContent(token: string): string {
  return token.length >= 2 && token.startsWith('"') && token.endsWith('"')
    ? token.slice(1, -1)
    : token;
}

export function resolveEnumValue(
  spec: ArgumentSpec, raw: string,
): string | undefined {
  const bas = quotedContent(raw).toLowerCase();
  const exact = spec.values?.find(value => value.keyword.toLowerCase() === bas);
  if (exact) return exact.keyword;

  const prefixes = spec.values?.filter(
    value => value.keyword.toLowerCase().startsWith(bas)) ?? [];
  return prefixes.length === 1 ? prefixes[0].keyword : undefined;
}

const ANNOUNCED_RANGE = /^<(\d+)-(\d+)>$/;

export function outsideEveryAnnouncedRange(
  token: string, forms: readonly { readonly keyword: string }[],
): boolean {
  if (!/^\d+$/.test(token)) return false;
  const ranges = forms.filter(form => ANNOUNCED_RANGE.test(form.keyword));
  if (ranges.length === 0 || ranges.length !== forms.length) return false;
  const value = Number(token);
  return ranges.every(form => {
    const bounds = ANNOUNCED_RANGE.exec(form.keyword) as RegExpExecArray;
    return value < Number(bounds[1]) || value > Number(bounds[2]);
  });
}

export function isQuoted(token: string): boolean {
  return token.length >= 2 && token.startsWith('"') && token.endsWith('"');
}

export function argumentAccepts(spec: ArgumentSpec, raw: string): boolean {
  const token = quotedContent(raw);
  if (isQuoted(raw) && (spec.type === 'WORD' || spec.type === 'ENUM')
    && spec.values === undefined && spec.pattern === undefined) {
    return token.length > 0;
  }
  const named = spec.values !== undefined
    && resolveEnumValue(spec, token) !== undefined;
  if (named) return true;
  // Une place a plusieurs FORMES : ce sont des types, pas des valeurs, et
  // c'est la forme qui decide de l'acceptation, jamais son intitule.
  if (spec.alternatives && spec.alternatives.length > 0 && !spec.values) {
    if (outsideEveryAnnouncedRange(token, spec.alternatives)) return false;
    return ARGUMENT_TYPES[spec.type].accepts(token);
  }
  // Porter les DEUX veut dire « l'un ou l'autre » : une severite IOS
  // s'ecrit `errors` ou `3`, et n'offrir qu'une des deux formes refuserait
  // celle que l'operateur a tapee.
  if (spec.values && !spec.range) return false;
  if (!ARGUMENT_TYPES[spec.type].accepts(token)) return false;
  if (spec.pattern && !spec.pattern.test(token)) return false;
  if (!spec.range) return true;

  const value = Number(token);
  return Number.isInteger(value) && value >= spec.range[0] && value <= spec.range[1];
}

export function argumentPlaceholder(spec: ArgumentSpec): string {
  if (spec.literal) return spec.literal;
  if (spec.range) return `<${spec.range[0]}-${spec.range[1]}>`;
  return ARGUMENT_TYPES[spec.type].placeholder;
}

/**
 * Ce que `?` doit ecrire pour une place d'argument.
 *
 * Une place peut avoir plusieurs FORMES (`alternatives`), un domaine
 * fini (`values`), les deux, ou aucun — et l'union des deux derniers
 * signifie « l'un ou l'autre ». Une seule fonction les rend toutes,
 * sinon chaque appelant en oublierait une autre.
 */
export function argumentCompletableValues(spec: ArgumentSpec): readonly EnumValue[] {
  const placeholder = argumentPlaceholder(spec);
  return [...(spec.alternatives ?? []), ...(spec.values ?? [])]
    .filter(value => value.keyword !== placeholder)
    .filter(value => !PLACEHOLDER_SHAPE.test(value.keyword))
    .filter(value => /^[A-Za-z0-9][A-Za-z0-9:._-]*$/.test(value.keyword));
}

const PLACEHOLDER_SHAPE = /^(<.*>|[A-Z]\.[A-Z]\.[A-Z]\.[A-Z].*|WORD|LINE|STRING|NAME)$/;

export function argumentSuggestions(spec: ArgumentSpec): readonly EnumValue[] {
  const out: EnumValue[] = [];
  for (const form of spec.alternatives ?? []) out.push(form);
  if (spec.values) {
    // Des FORMES declarees decrivent deja ce que la place accepte : y
    // ajouter la plage brute annoncerait un intervalle plus large que
    // celui qu'elles nomment.
    if (spec.range && out.length === 0) {
      out.push({ keyword: argumentPlaceholder(spec), description: describeArgument(spec) });
    }
    for (const value of spec.values) out.push(value);
    return out;
  }
  const placeholder = {
    keyword: argumentPlaceholder(spec), description: describeArgument(spec),
  };
  if (out.length === 0) return [placeholder];
  return spec.type === 'REST' ? out : [placeholder, ...out];
}

export function describeArgument(spec: ArgumentSpec): string {
  return spec.description ?? spec.name;
}

export function isArgumentSpec(step: unknown): step is ArgumentSpec {
  return typeof step === 'object' && step !== null && 'type' in step;
}
