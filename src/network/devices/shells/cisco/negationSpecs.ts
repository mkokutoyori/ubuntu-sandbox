import type { ArgumentSpec } from '@/cli/ArgumentTypes';
import type { CommandSpec } from '@/cli/CommandTable';

const MODE = ['config'] as const;

export interface NegationHost {
  retirerInterface(nomTape: string): string;
  poserStatiqueDeReseau(
    local: string, global: string, prefixe: string | undefined, vrf: string | undefined,
  ): string;
  retirerStatiqueDeReseau(local: string, global: string): string;
}

const LOCAL: ArgumentSpec = {
  name: 'local', type: 'IP_ADDR', description: 'Inside local address',
};

const GLOBAL: ArgumentSpec = {
  name: 'global', type: 'IP_ADDR', description: 'Inside global address',
};

const PREFIXE: ArgumentSpec = {
  name: 'prefixe', type: 'WORD', optional: true, literal: '/nn',
  description: 'Prefix length, or subnet mask',
};

export function negationSpecs(ctx: () => NegationHost): CommandSpec[] {
  return [
    {
      id: 'ip-nat-inside-source-static-network',
      path: ['ip', 'nat', 'inside', 'source', 'static', 'network', LOCAL, GLOBAL, PREFIXE],
      description: 'Static translation for a whole network',
      undoDescription: 'Remove network static NAT',
      modes: MODE, minPrivilege: 15,
      options: [{
        keyword: 'vrf', description: 'VRF the translation belongs to',
        argument: { name: 'vrf', type: 'WORD', description: 'VRF name' },
      }],
      run: (_s, args) => ctx().poserStatiqueDeReseau(
        args.local, args.global, args.prefixe, args.vrf),
      undo: (_s, args) => ctx().retirerStatiqueDeReseau(args.local, args.global),
    },
  ];
}
