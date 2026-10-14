import type { ArgumentSpec } from '@/cli/ArgumentTypes';
import type { CommandSpec } from '@/cli/CommandTable';
import type { DfBitPolicy, FragmentationPoint } from '../../../ipsec/IPSecTypes';

export interface IpsecDataPlaneEngine {
  setDfBit(policy: DfBitPolicy | null, ifName?: string): void;
  setFragmentationPoint(point: FragmentationPoint | null, ifName?: string): void;
  setReplayWindowSize(size: number): void;
  setReplayCheckingDisabled(disabled: boolean): void;
  setIkeEnabled(enabled: boolean): void;
  setPassiveMode(enabled: boolean): void;
  setIdleTime(seconds: number | null): void;
  getIdleTime(): number | null;
}

export interface IpsecDataPlaneHost {
  engine(): IpsecDataPlaneEngine;
  selectedInterfaces(): string[];
}

const GLOBAL = ['config', 'config-tfset'] as const;
const INTERFACE = ['config-if', 'config-subif'] as const;

const DF_BIT: ArgumentSpec = {
  name: 'policy', type: 'ENUM', optional: true,
  values: [
    { keyword: 'clear', description: 'Outer IP header has the DF bit cleared' },
    { keyword: 'copy', description: 'Outer IP header DF bit is copied from the original packet' },
    { keyword: 'set', description: 'Outer IP header has the DF bit set' },
  ],
};

const REPLAY_WINDOW: ArgumentSpec = {
  name: 'size', type: 'ENUM', optional: true,
  description: 'Size of the anti-replay window',
  values: [64, 128, 256, 512, 1024].map((size) => ({ keyword: String(size), description: `${size} packets` })),
};

const IDLE_TIME: ArgumentSpec = {
  name: 'seconds', type: 'INT', range: [60, 86400],
  description: 'Seconds an inactive peer keeps its security association',
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
  const saGlobal = (
    id: string, tail: Array<string | ArgumentSpec>, description: string, undoDescription: string,
    run: (engine: IpsecDataPlaneEngine, args: Record<string, string>) => void,
    undo: (engine: IpsecDataPlaneEngine) => void,
  ): CommandSpec => ({
    id, path: ['crypto', 'ipsec', 'security-association', ...tail], description, undoDescription,
    modes: GLOBAL, minPrivilege: 15,
    run: (_session, args) => { run(host().engine(), args); return ''; },
    undo: () => { undo(host().engine()); return ''; },
  });
  return [
    dfBit('global'), dfBit('interface'), fragmentation('global'), fragmentation('interface'),
    {
      ...saGlobal('crypto-ipsec-sa-replay-window-size', ['replay', 'window-size', REPLAY_WINDOW],
        'Set the size of the anti-replay window', 'Restore the default window of 64',
        (engine, args) => engine.setReplayWindowSize(Number(args.size ?? 64)),
        (engine) => engine.setReplayWindowSize(64)),
      undoOmitsArguments: true,
    },
    saGlobal('crypto-ipsec-sa-replay-disable', ['replay', 'disable'],
      'Disable anti-replay checking', 'Enable anti-replay checking',
      (engine) => engine.setReplayCheckingDisabled(true),
      (engine) => engine.setReplayCheckingDisabled(false)),
    {
      ...saGlobal('crypto-ipsec-sa-idle-time', ['idle-time', IDLE_TIME],
        'Delete the security associations of a peer that stays idle', 'Disable the security association idle timer',
        (engine, args) => engine.setIdleTime(Number(args.seconds)),
        (engine) => engine.setIdleTime(null)),
      undoOmitsArguments: true,
    },
    {
      id: 'crypto-isakmp-enable',
      path: ['crypto', 'isakmp', 'enable'],
      description: 'Enable ISAKMP',
      undoDescription: 'Disable ISAKMP',
      modes: GLOBAL, minPrivilege: 15,
      run: () => { host().engine().setIkeEnabled(true); return ''; },
      undo: () => { host().engine().setIkeEnabled(false); return ''; },
    },
    {
      id: 'crypto-ipsec-optional',
      path: ['crypto', 'ipsec', 'optional'],
      description: 'Accept clear text as well as IPsec traffic (passive mode)',
      undoDescription: 'Disable IPsec passive mode',
      modes: GLOBAL, minPrivilege: 15,
      run: () => { host().engine().setPassiveMode(true); return ''; },
      undo: () => { host().engine().setPassiveMode(false); return ''; },
    },
    {
      id: 'show-crypto-ipsec-sa-idle-time',
      path: ['show', 'crypto', 'ipsec', 'security-association', 'idle-time'],
      description: 'Show the security association idle time',
      modes: ['privileged'], minPrivilege: 15,
      run: () => {
        const seconds = host().engine().getIdleTime();
        return seconds === null ? '' : `Security association idletime: ${seconds} seconds`;
      },
    },
  ];
}
