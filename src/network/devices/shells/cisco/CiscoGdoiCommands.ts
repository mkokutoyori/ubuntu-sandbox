import type { CiscoShellContext } from './CiscoConfigCommands';
import type { CommandSpec } from '@/cli/CommandTable';
import type { ArgumentSpec } from '@/cli/ArgumentTypes';

interface GdoiGroup {
  identityNumber?: number;
  groupAddress?: string;
  transformSetName?: string;
  localAddress?: string;
  keyServerAddress?: string;
}

interface GdoiEngine {
  getOrCreateGdoiGroup(name: string): GdoiGroup;
  removeGdoiGroup(name: string): void;
  activateGdoiKeyServer(name: string): unknown;
  registerWithGdoiKeyServer(name: string): void;
}

function engine(ctx: CiscoShellContext): GdoiEngine {
  return (ctx.r() as unknown as { _getOrCreateIPSecEngine(): GdoiEngine })._getOrCreateIPSecEngine();
}

const NO_GROUP_SELECTED = '% No GDOI group selected';

const GROUP_NAME: ArgumentSpec = {
  name: 'name', type: 'WORD', description: 'Name of the GDOI group',
};

export function gdoiGlobalSpecs(ctx: CiscoShellContext): CommandSpec[] {
  return [{
    id: 'config-crypto-gdoi-group', path: ['crypto', 'gdoi', 'group', GROUP_NAME],
    description: 'Define a GDOI GET-VPN group', undoDescription: 'Remove a GDOI GET-VPN group',
    modes: ['config'], minPrivilege: 15,
    run: (_session, args) => {
      engine(ctx).getOrCreateGdoiGroup(args.name);
      ctx.setSelectedGdoiGroup(args.name);
      ctx.setMode('config-gdoi-group');
      return '';
    },
    undo: (_session, args) => {
      engine(ctx).removeGdoiGroup(args.name);
      return '';
    },
  }];
}

export function gdoiGroupSpecs(ctx: CiscoShellContext): CommandSpec[] {
  const base = { modes: ['config-gdoi-group'], minPrivilege: 15 };
  const onGroup = (apply: (group: GdoiGroup, name: string) => string): string => {
    const name = ctx.getSelectedGdoiGroup();
    if (!name) return NO_GROUP_SELECTED;
    return apply(engine(ctx).getOrCreateGdoiGroup(name), name);
  };
  return [
    {
      ...base, id: 'gdoi-identity-number',
      path: ['identity', 'number', {
        name: 'number', type: 'INT', range: [1, 2147483647],
        description: 'Identity of the GDOI group',
      }],
      description: 'Set the GDOI group identity number',
      run: (_session, args) => onGroup((group) => {
        group.identityNumber = Number(args.number);
        return '';
      }),
    },
    {
      ...base, id: 'gdoi-match-address-ipv4',
      path: ['match', 'address', 'ipv4', {
        name: 'group', type: 'WORD',
        description: 'Access list name that selects the protected traffic',
        alternatives: [
          { keyword: '<100-199>', description: 'IP extended access list number' },
          { keyword: 'A.B.C.D', description: 'Protected multicast group address' },
        ],
      }],
      description: 'Set the protected multicast group address',
      run: (_session, args) => onGroup((group) => {
        group.groupAddress = args.group;
        return '';
      }),
    },
    {
      ...base, id: 'gdoi-transform-set',
      path: ['transform-set', {
        name: 'name', type: 'WORD', description: 'Name of the transform set',
      }],
      description: 'Set the transform-set used for the group SA',
      run: (_session, args) => onGroup((group) => {
        group.transformSetName = args.name;
        return '';
      }),
    },
    {
      ...base, id: 'gdoi-address-ipv4',
      path: ['address', 'ipv4', {
        name: 'address', type: 'IP_ADDR', description: 'Local address of the key server',
      }],
      description: "Set the key server's own local address",
      run: (_session, args) => onGroup((group) => {
        group.localAddress = args.address;
        return '';
      }),
    },
    {
      ...base, id: 'gdoi-server-local', path: ['server', 'local'],
      description: 'Activate this router as the GDOI key server',
      run: () => onGroup((_group, name) =>
        engine(ctx).activateGdoiKeyServer(name)
          ? '' : '% GDOI group incomplete (need match address + transform-set)'),
    },
    {
      ...base, id: 'gdoi-server-address-ipv4',
      path: ['server', 'address', 'ipv4', {
        name: 'address', type: 'IP_ADDR',
        description: 'Address of the key server to register with',
      }],
      description: 'Register as a group member with a GDOI key server',
      run: (_session, args) => onGroup((group, name) => {
        group.keyServerAddress = args.address;
        engine(ctx).registerWithGdoiKeyServer(name);
        return '';
      }),
    },
  ];
}
