import { isValidIPv4, isValidSubnetMask } from '../network/core/ip';

export type ArgumentType =
  | 'INT' | 'WORD' | 'LINE' | 'IP_ADDR' | 'SUBNET_MASK'
  | 'MAC_ADDR' | 'INTERFACE' | 'VLAN_ID';

export interface ArgumentSpec {
  readonly name: string;
  readonly type: ArgumentType;
  readonly optional?: boolean;
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
    VLAN_ID: {
      placeholder: '<1-4094>',
      accepts: (t) => /^\d+$/.test(t) && Number(t) >= 1 && Number(t) <= 4094,
    },
  });

export function isArgumentSpec(step: unknown): step is ArgumentSpec {
  return typeof step === 'object' && step !== null && 'type' in step;
}
