import { isValidIPv4, isValidSubnetMask } from '../network/core/ip';

export type ArgumentType =
  | 'INT' | 'WORD' | 'LINE' | 'IP_ADDR' | 'SUBNET_MASK'
  | 'MAC_ADDR' | 'INTERFACE' | 'VLAN_ID' | 'REST' | 'ENUM';

export interface EnumValue {
  readonly keyword: string;
  readonly description: string;
}

export interface ArgumentSpec {
  readonly name: string;
  readonly type: ArgumentType;
  readonly optional?: boolean;
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
}

export interface ArgumentTypeDefinition {
  readonly placeholder: string;
  accepts(token: string): boolean;
}

const MAC = /^([0-9a-f]{4}\.){2}[0-9a-f]{4}$|^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i;
const INTERFACE_NAME = /^[A-Za-z][A-Za-z-]*[0-9]+(\/[0-9]+)*(\.[0-9]+)?$/;

export const ARGUMENT_TYPES: Readonly<Record<ArgumentType, ArgumentTypeDefinition>> =
  Object.freeze({
    INT: { placeholder: '<0-4294967295>', accepts: (t) => /^\d+$/.test(t) },
    WORD: { placeholder: 'WORD', accepts: (t) => t.length > 0 && !/\s/.test(t) },
    LINE: { placeholder: 'LINE', accepts: (t) => t.length > 0 },
    IP_ADDR: { placeholder: 'A.B.C.D', accepts: (t) => isValidIPv4(t) },
    SUBNET_MASK: { placeholder: 'A.B.C.D', accepts: (t) => isValidSubnetMask(t) },
    MAC_ADDR: { placeholder: 'H.H.H', accepts: (t) => MAC.test(t) },
    INTERFACE: { placeholder: 'IFACE', accepts: (t) => INTERFACE_NAME.test(t) },
    REST: { placeholder: 'LINE', accepts: (t) => t.length > 0 },
    ENUM: { placeholder: 'WORD', accepts: (t) => t.length > 0 },
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
export function argumentAccepts(spec: ArgumentSpec, token: string): boolean {
  if (spec.values) {
    return spec.values.some(value => value.keyword.toLowerCase() === token.toLowerCase());
  }
  if (!ARGUMENT_TYPES[spec.type].accepts(token)) return false;
  if (!spec.range) return true;

  const value = Number(token);
  return Number.isInteger(value) && value >= spec.range[0] && value <= spec.range[1];
}

export function argumentPlaceholder(spec: ArgumentSpec): string {
  if (spec.range) return `<${spec.range[0]}-${spec.range[1]}>`;
  return ARGUMENT_TYPES[spec.type].placeholder;
}

export function isArgumentSpec(step: unknown): step is ArgumentSpec {
  return typeof step === 'object' && step !== null && 'type' in step;
}
