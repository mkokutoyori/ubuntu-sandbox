import type { ArgumentSpec } from '@/cli/ArgumentTypes';
import type { CommandSpec } from '@/cli/CommandTable';
import type { DfBitPolicy, FragmentationPoint } from '../../../ipsec/IPSecTypes';

export interface IpsecDataPlaneEngine {
  setDfBit(policy: DfBitPolicy | null, ifName?: string): void;
  setFragmentationPoint(point: FragmentationPoint | null, ifName?: string): void;
}

export interface IpsecDataPlaneHost {
  engine(): IpsecDataPlaneEngine;
  selectedInterfaces(): string[];
}

const GLOBAL = ['config'] as const;
const INTERFACE = ['config-if', 'config-subif'] as const;

const DF_BIT: ArgumentSpec = {
  name: 'policy', type: 'ENUM', optional: true,
  values: [
    { keyword: 'clear', description: 'Outer IP header has the DF bit cleared' },
    { keyword: 'copy', description: 'Outer IP header DF bit is copied from the original packet' },
    { keyword: 'set', description: 'Outer IP header has the DF bit set' },
  ],
};

const FRAGMENTATION: ArgumentSpec = {
  name: 'point', type: 'ENUM',
  values: [
    { keyword: 'after-encryption', description: 'Fragment the encrypted packet' },
    { keyword: 'before-encryption', description: 'Fragment the packet before encrypting it' },
  ],
};

export function ipsecDataPlaneSpecs(host: () => IpsecDataPlaneHost): CommandSpec[] {
  const forScope = (
    scope: 'global' | 'interface', apply: (engine: IpsecDataPlaneEngine, ifName: string | undefined) => void,
  ) => {
    if (scope === 'global') apply(host().engine(), undefined);
    else for (const ifName of host().selectedInterfaces()) apply(host().engine(), ifName);
    return '';
  };
  const dfBit = (scope: 'global' | 'interface'): CommandSpec => ({
    id: `crypto-ipsec-df-bit-${scope}`,
    path: ['crypto', 'ipsec', 'df-bit', DF_BIT],
    description: 'Set the DF bit of the encapsulating header in tunnel mode',
    undoDescription: 'Restore the default DF bit handling',
    modes: scope === 'global' ? GLOBAL : INTERFACE, minPrivilege: 15,
    run: (_session, args) => forScope(scope, (engine, ifName) =>
      engine.setDfBit((args.policy ?? 'copy') as DfBitPolicy, ifName)),
    undo: () => forScope(scope, (engine, ifName) => engine.setDfBit(null, ifName)),
    undoOmitsArguments: true,
  });
  const fragmentation = (scope: 'global' | 'interface'): CommandSpec => ({
    id: `crypto-ipsec-fragmentation-${scope}`,
    path: ['crypto', 'ipsec', 'fragmentation', FRAGMENTATION],
    description: 'Select where IPsec packets are fragmented',
    undoDescription: 'Restore prefragmentation',
    modes: scope === 'global' ? GLOBAL : INTERFACE, minPrivilege: 15,
    run: (_session, args) => forScope(scope, (engine, ifName) =>
      engine.setFragmentationPoint(args.point as FragmentationPoint, ifName)),
    undo: () => forScope(scope, (engine, ifName) => engine.setFragmentationPoint(null, ifName)),
  });
  return [dfBit('global'), dfBit('interface'), fragmentation('global'), fragmentation('interface')];
}
