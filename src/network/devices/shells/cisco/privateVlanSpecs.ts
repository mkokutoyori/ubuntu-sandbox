import type { ArgumentSpec } from '@/cli/ArgumentTypes';
import type { CommandSpec } from '@/cli/CommandTable';

export interface PrivateVlanHost {
  applyPrivateVlan(words: readonly string[]): string;
}

const CONFIG_VLAN = Object.freeze(['config-vlan']);

const ROLE: ArgumentSpec = {
  name: 'role', type: 'ENUM', description: 'Private VLAN role of this VLAN',
  values: [
    { keyword: 'community', description: 'Community private VLAN' },
    { keyword: 'isolated', description: 'Isolated private VLAN' },
    { keyword: 'primary', description: 'Primary private VLAN' },
  ],
};

const SECONDAIRES: ArgumentSpec = {
  name: 'secondaires', type: 'WORD', literal: 'WORD',
  pattern: /^\d+(-\d+)?(,\d+(-\d+)?)*$/,
  description: 'Secondary VLANs associated with this primary VLAN',
};

export function privateVlanSpecs(ctx: () => PrivateVlanHost): CommandSpec[] {
  return [
    {
      id: 'private-vlan-role',
      path: ['private-vlan', ROLE],
      description: 'Configure the private VLAN role of this VLAN',
      modes: CONFIG_VLAN, minPrivilege: 15,
      run: (_session, args) => ctx().applyPrivateVlan([args.role]),
    },
    {
      id: 'private-vlan-association',
      path: ['private-vlan', 'association', SECONDAIRES],
      description: 'Associate secondary VLANs with this primary VLAN',
      modes: CONFIG_VLAN, minPrivilege: 15,
      run: (_session, args) => ctx().applyPrivateVlan(['association', args.secondaires]),
    },
  ];
}
