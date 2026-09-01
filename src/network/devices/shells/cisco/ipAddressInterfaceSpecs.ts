import type { ArgumentSpec } from '@/cli/ArgumentTypes';
import type { CommandSpec } from '@/cli/CommandTable';

export interface IpAddressHost {
  setPrimaryAddress(address: string, mask: string): string;
  setSecondaryAddress(address: string, mask: string): string;
  clearAddress(): string;
  clearSecondaryAddress(address: string, mask: string): string;
  setNegotiatedAddress(): string;
}

const MODES = ['config-if', 'config-subif'] as const;

const ADRESSE: ArgumentSpec = {
  name: 'adresse', type: 'IP_ADDR', description: 'IP address',
};

const MASQUE: ArgumentSpec = {
  name: 'masque', type: 'SUBNET_MASK', description: 'IP subnet mask',
};

export function ipAddressInterfaceSpecs(ctx: () => IpAddressHost): CommandSpec[] {
  return [
    {
      id: 'config-if-ip-address',
      path: ['ip', 'address', ADRESSE, MASQUE],
      description: 'Set the IP address of an interface',
      undoDescription: 'Remove the IP address of an interface',
      modes: MODES, minPrivilege: 15,
      run: (_session, args) =>
        ctx().setPrimaryAddress(args.adresse ?? '', args.masque ?? ''),
      undo: () => ctx().clearAddress(),
    },
    {
      id: 'config-if-ip-address-secondary',
      path: ['ip', 'address', ADRESSE, MASQUE, 'secondary'],
      description: 'Set the IP address of an interface',
      undoDescription: 'Remove a secondary IP address',
      modes: MODES, minPrivilege: 15,
      run: (_session, args) =>
        ctx().setSecondaryAddress(args.adresse ?? '', args.masque ?? ''),
      undo: (_session, args) =>
        ctx().clearSecondaryAddress(args.adresse ?? '', args.masque ?? ''),
    },
    {
      id: 'config-if-ip-address-nue',
      path: ['ip', 'address'],
      description: 'Set the IP address of an interface',
      undoDescription: 'Remove the IP address of an interface',
      existsOnlyNegated: true,
      modes: MODES, minPrivilege: 15,
      run: () => '% Incomplete command.',
      undo: () => ctx().clearAddress(),
    },
    {
      id: 'config-if-ip-address-negotiated',
      path: ['ip', 'address', 'negotiated'],
      description: 'IP Address negotiated over PPP',
      modes: MODES, minPrivilege: 15,
      run: () => ctx().setNegotiatedAddress(),
    },
  ];
}
