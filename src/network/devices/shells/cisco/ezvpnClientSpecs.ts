import type { ArgumentSpec } from '@/cli/ArgumentTypes';
import type { CommandSpec } from '@/cli/CommandTable';
import type { EzvpnClient, ClientMode } from '../../../ipsec/ezvpn/EzvpnClient';

export const EZVPN_CLIENT_MODE = 'config-crypto-ezvpn';

export interface EzvpnClientShellHost {
  client(): EzvpnClient;
  selectedInterfaces(): string[];
  selectTunnel(name: string | null): void;
  selectedTunnel(): string | null;
}

const CONFIG = Object.freeze(['config']);
const INTERFACE = Object.freeze(['config-if', 'config-subif']);
const SUBMODE = Object.freeze([EZVPN_CLIENT_MODE]);
const EXEC = Object.freeze(['privileged']);

const word = (name: string, description: string): ArgumentSpec => ({ name, type: 'WORD', description });
const tunnel = word('name', 'Easy VPN remote configuration name');

export function ezvpnClientSpecs(host: () => EzvpnClientShellHost): CommandSpec[] {
  const client = () => host().client();
  const config = () => {
    const name = host().selectedTunnel();
    return name ? client().configs.get(name) ?? null : null;
  };
  const mode = (id: string, tail: string[], value: ClientMode, text: string): CommandSpec => ({
    id, path: ['mode', ...tail], description: text, undoDescription: 'Restore client mode',
    modes: SUBMODE, minPrivilege: 15, undoOmitsArguments: true,
    run: () => { const c = config(); if (c) c.mode = value; return ''; },
    undo: () => { const c = config(); if (c) c.mode = 'client'; return ''; },
  });
  return [
    {
      id: 'crypto-ipsec-client-ezvpn',
      path: ['crypto', 'ipsec', 'client', 'ezvpn', tunnel],
      description: 'Easy VPN remote configuration', undoDescription: 'Delete an Easy VPN remote configuration',
      modes: CONFIG, minPrivilege: 15,
      enters: EZVPN_CLIENT_MODE,
      run: (_s, args) => { client().ensureConfig(args.name); host().selectTunnel(args.name); return ''; },
      undo: (_s, args) => client().removeConfig(args.name) ?? '',
    },
    {
      id: 'crypto-ipsec-client-ezvpn-interface',
      path: ['crypto', 'ipsec', 'client', 'ezvpn', tunnel, {
        name: 'side', type: 'ENUM', optional: true, values: [
          { keyword: 'outside', description: 'Outside interface of the client router' },
          { keyword: 'inside', description: 'Inside interface of the client router' },
        ],
      }],
      description: 'Assign an Easy VPN remote configuration to an interface',
      undoDescription: 'Remove the Easy VPN remote configuration from the interface',
      modes: INTERFACE, minPrivilege: 15,
      run: (_s, args) => {
        if (!client().configs.has(args.name)) return `% Easy VPN configuration ${args.name} is not defined`;
        for (const iface of host().selectedInterfaces()) {
          if (args.side === 'inside') client().assignInside(args.name, iface);
          else {
            const refusal = client().assignOutside(args.name, iface);
            if (refusal) return refusal;
          }
        }
        return '';
      },
      undo: (_s, args) => {
        for (const iface of host().selectedInterfaces()) {
          if (args.side === 'inside') client().unassignInside(args.name, iface);
          else client().unassignOutside(args.name);
        }
        return '';
      },
    },
    {
      id: 'ezvpn-group-key',
      path: ['group', word('group', 'Group name'), 'key', word('key', 'Group key')],
      description: 'Group name and key of the VPN connection', undoDescription: 'Remove the group',
      modes: SUBMODE, minPrivilege: 15, undoOmitsArguments: true,
      run: (_s, args) => { const c = config(); if (c) { c.group = args.group; c.key = args.key; } return ''; },
      undo: () => { const c = config(); if (c) { c.group = undefined; c.key = undefined; } return ''; },
    },
    {
      id: 'ezvpn-peer',
      path: ['peer', word('peer', 'Peer address or host name')],
      description: 'Peer of the VPN connection', undoDescription: 'Remove a peer',
      modes: SUBMODE, minPrivilege: 15,
      options: [{ keyword: 'default', description: 'Primary peer', argument: null }],
      run: (_s, args) => {
        const c = config();
        if (!c) return '';
        c.peers = c.peers.filter((p) => p.address !== args.peer);
        c.peers.push({ address: args.peer, primary: args.default !== undefined });
        return '';
      },
      undo: (_s, args) => {
        const c = config();
        if (c) c.peers = args.peer ? c.peers.filter((p) => p.address !== args.peer) : [];
        return '';
      },
    },
    mode('ezvpn-mode-client', ['client'], 'client', 'Easy VPN client mode (NAT/PAT)'),
    mode('ezvpn-mode-nem', ['network-extension'], 'network-extension', 'Network extension mode'),
    mode('ezvpn-mode-nem-plus', ['network', 'extension', 'plus'], 'network-extension-plus', 'Network extension mode that also requests an address'),
    {
      id: 'ezvpn-connect',
      path: ['connect', {
        name: 'how', type: 'ENUM', values: [
          { keyword: 'auto', description: 'Connect when the configuration is assigned' },
          { keyword: 'manual', description: 'Connect on command' },
        ],
      }],
      description: 'Connection mode', undoDescription: 'Restore automatic connection',
      modes: SUBMODE, minPrivilege: 15, undoOmitsArguments: true,
      run: (_s, args) => { const c = config(); if (c) c.connect = args.how as 'auto' | 'manual'; return ''; },
      undo: () => { const c = config(); if (c) c.connect = 'auto'; return ''; },
    },
    {
      id: 'ezvpn-username',
      path: ['username', word('user', 'Extended authentication user name'), 'password', {
        name: 'encoding', type: 'ENUM', values: [
          { keyword: '0', description: 'Unencrypted password follows' },
          { keyword: '6', description: 'Encrypted password follows' },
        ],
      }, word('password', 'Password')],
      description: 'Save the extended authentication credentials', undoDescription: 'Forget the credentials',
      modes: SUBMODE, minPrivilege: 15, undoOmitsArguments: true,
      run: (_s, args) => { const c = config(); if (c) { c.username = args.user; c.password = args.password; } return ''; },
      undo: () => { const c = config(); if (c) { c.username = undefined; c.password = undefined; } return ''; },
    },
    {
      id: 'ezvpn-xauth-mode',
      path: ['xauth', 'userid', 'mode', {
        name: 'how', type: 'ENUM', values: [
          { keyword: 'interactive', description: 'Prompt on the console' },
          { keyword: 'local', description: 'Use the saved user name and password' },
        ],
      }],
      description: 'How extended authentication requests are answered', undoDescription: 'Restore interactive',
      modes: SUBMODE, minPrivilege: 15, undoOmitsArguments: true,
      run: (_s, args) => { const c = config(); if (c) c.xauthMode = args.how as 'interactive' | 'local'; return ''; },
      undo: () => { const c = config(); if (c) c.xauthMode = undefined; return ''; },
    },
    {
      id: 'ezvpn-acl',
      path: ['acl', word('acl', 'Access list of extra networks')],
      description: 'Extra networks extended in network-extension mode', undoDescription: 'Remove the access list',
      modes: SUBMODE, minPrivilege: 15, undoOmitsArguments: true,
      run: (_s, args) => { const c = config(); if (c) c.acl = args.acl; return ''; },
      undo: () => { const c = config(); if (c) c.acl = undefined; return ''; },
    },
    {
      id: 'crypto-ipsec-client-ezvpn-connect',
      path: ['crypto', 'ipsec', 'client', 'ezvpn', 'connect', tunnel],
      description: 'Connect a manually configured tunnel', undoDescription: 'Disconnect the tunnel',
      modes: EXEC, minPrivilege: 15,
      run: (_s, args) => {
        const c = client().configs.get(args.name);
        if (!c) return `% Easy VPN configuration ${args.name} is not defined`;
        if (c.connect !== 'manual') return `% Easy VPN configuration ${args.name} is not set to connect manually`;
        return client().connect(args.name);
      },
      undo: (_s, args) => { client().disconnect(args.name); return ''; },
    },
    {
      id: 'crypto-ipsec-client-ezvpn-xauth',
      path: ['crypto', 'ipsec', 'client', 'ezvpn', 'xauth', { ...tunnel, optional: true }],
      description: 'Answer a pending extended authentication request',
      modes: EXEC, minPrivilege: 15,
      run: () => '% The user name and password are asked interactively on a console or a terminal',
    },
    {
      id: 'clear-crypto-ipsec-client-ezvpn',
      path: ['clear', 'crypto', 'ipsec', 'client', 'ezvpn', { ...tunnel, optional: true }],
      description: 'Reset the Easy VPN remote state machine',
      modes: EXEC, minPrivilege: 15,
      run: (_s, args) => { client().clear(args.name); return ''; },
    },
    {
      id: 'show-crypto-ipsec-client-ezvpn',
      path: ['show', 'crypto', 'ipsec', 'client', 'ezvpn'],
      description: 'Display the Easy VPN remote configuration',
      modes: EXEC, minPrivilege: 15,
      run: () => client().renderStatus(),
    },
  ];
}
