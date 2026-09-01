import type { ArgumentSpec } from '@/cli/ArgumentTypes';
import type { CommandSpec } from '@/cli/CommandTable';
import { CISCO_ERRORS } from '../cli-utils';
import { LOAD_INTERVAL_MIN_SEC, LOAD_INTERVAL_MAX_SEC } from '../../../hardware/PortLoad';

export const MTU_MIN = 68;
export const MTU_MAX_ETHERNET = 9216;

export interface LoadMtuPort {
  setMTU(bytes: number): void;
  setLoadIntervalSec(sec: number): boolean;
  getMaxMTU?(): number;
}

export interface LoadMtuHost {
  targetPorts(): LoadMtuPort[];
  onInterfaceLine?(line: string): void;
  refuseOnSelected?(commande: 'mtu' | 'load-interval'): string | null;
}

const MODES = ['config-if', 'config-subif'] as const;

const OCTETS: ArgumentSpec = {
  name: 'octets', type: 'INT', description: 'MTU size in bytes',
  range: [MTU_MIN, MTU_MAX_ETHERNET], rangeIsAdvisory: true,
};

const SECONDES: ArgumentSpec = {
  name: 'secondes', type: 'INT',
  description: 'Load interval in seconds, a multiple of 30',
  range: [LOAD_INTERVAL_MIN_SEC, LOAD_INTERVAL_MAX_SEC],
};

export function interfaceLoadMtuSpecs(ctx: () => LoadMtuHost): CommandSpec[] {
  return [
    {
      id: 'config-if-mtu',
      path: ['mtu', OCTETS],
      description: 'Set the interface Maximum Transmission Unit (MTU)',
      modes: MODES, minPrivilege: 15,
      run: (_session, args) => {
        const octets = Number(args.octets);
        const host = ctx();
        const refus = host.refuseOnSelected?.('mtu');
        if (refus) return refus;
        for (const port of host.targetPorts()) {
          try {
            port.setMTU(octets);
          } catch (e) {
            return `% ${e instanceof Error ? e.message : String(e)}`;
          }
        }
        host.onInterfaceLine?.(`mtu ${octets}`);
        return '';
      },
    },
    {
      id: 'config-if-load-interval',
      path: ['load-interval', SECONDES],
      description: 'Specify interval for load calculation for an interface',
      modes: MODES, minPrivilege: 15,
      run: (_session, args) => {
        const secondes = Number(args.secondes);
        const host = ctx();
        const refus = host.refuseOnSelected?.('load-interval');
        if (refus) return refus;
        for (const port of host.targetPorts()) {
          if (!port.setLoadIntervalSec(secondes)) return CISCO_ERRORS.INVALID_INPUT;
        }
        host.onInterfaceLine?.(`load-interval ${secondes}`);
        return '';
      },
    },
  ];
}
