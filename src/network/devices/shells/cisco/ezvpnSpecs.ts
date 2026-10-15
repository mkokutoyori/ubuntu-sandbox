import type { ArgumentSpec } from '@/cli/ArgumentTypes';
import type { CommandSpec } from '@/cli/CommandTable';
import { parseLocalPool, type EzvpnServer, type MapClientPolicy } from '../../../ipsec/ezvpn/EzvpnServer';

export const ISAKMP_GROUP_MODE = 'config-isakmp-group';
export const BROWSER_PROXY_MODE = 'config-browser-proxy';

export interface EzvpnEngine {
  readonly ezvpn: EzvpnServer;
  getOrCreateCryptoMapEntry(mapName: string, seq: number): unknown;
  addDynamicRefToCryptoMap(mapName: string, seq: number, dynMapName: string): void;
  removeCryptoMapEntry(mapName: string, seq: number): void;
  removeCryptoMap(mapName: string): void;
  setClientPolicy(mapName: string, patch: Partial<MapClientPolicy> | null): void;
  clientPolicyOf(mapName: string): MapClientPolicy | undefined;
}

export interface EzvpnHost {
  engine(): EzvpnEngine;
  selectCryptoMap(tag: string, seq: number): void;
  selectGroup(name: string | null): void;
  selectedGroup(): string | null;
  selectBrowserProxy(name: string | null): void;
  selectedBrowserProxy(): string | null;
  resolveInterface(text: string): string | null;
}

const CONFIG = Object.freeze(['config']);
const GROUP_MODE = Object.freeze([ISAKMP_GROUP_MODE]);
const PROXY_MODE = Object.freeze([BROWSER_PROXY_MODE]);
const SHOW = Object.freeze(['user', 'privileged']);

const address = (name: string, optional = false): ArgumentSpec => ({
  name, type: 'IP_ADDR', description: 'IPv4 address', ...(optional ? { optional: true } : {}),
});
const word = (name: string, description: string): ArgumentSpec => ({ name, type: 'WORD', description });
const count = (name: string, description: string): ArgumentSpec => ({
  name, type: 'INT', range: [1, 2147483647], description,
});

export function ezvpnSpecs(host: () => EzvpnHost): CommandSpec[] {
  const server = (): EzvpnServer => host().engine().ezvpn;
  const group = () => {
    const name = host().selectedGroup();
    return name ? server().groups.get(name) ?? null : null;
  };
  const proxy = () => {
    const name = host().selectedBrowserProxy();
    return name ? (server().browserProxies.get(name) as { mode: string; server?: string; exceptionList?: string; bypassLocal?: boolean } | undefined) ?? null : null;
  };
  const mapPolicy = (id: string, tail: Array<string | ArgumentSpec>, description: string, patch: (a: Record<string, string>) => Partial<MapClientPolicy>,
    clear: Partial<MapClientPolicy>): CommandSpec => ({
    id, path: ['crypto', 'map', word('carte', 'Crypto map tag'), ...tail],
    description, modes: CONFIG, minPrivilege: 15,
    undoOmitsArguments: true,
    run: (_s, args) => { host().engine().setClientPolicy(args.carte, patch(args)); return ''; },
    undo: (_s, args) => { host().engine().setClientPolicy(args.carte, clear); return ''; },
  });
  const listName = word('list', 'AAA method list name');
  const sequence: ArgumentSpec = { name: 'seq', type: 'INT', range: [1, 65535], description: 'Sequence to insert into the crypto map entry' };
  const kind: ArgumentSpec = {
    name: 'kind', type: 'ENUM', values: [{ keyword: 'ipsec-isakmp', description: 'IPSec w/ISAKMP' }],
  };
  return [
    {
      id: 'crypto-map-entry',
      path: ['crypto', 'map', word('carte', 'Crypto map tag'), sequence, kind],
      description: 'Define a crypto map entry',
      modes: CONFIG, minPrivilege: 15,
      enters: 'config-crypto-map',
      run: (_s, args) => {
        host().engine().getOrCreateCryptoMapEntry(args.carte, Number(args.seq));
        host().selectCryptoMap(args.carte, Number(args.seq));
        return '';
      },
    },
    {
      id: 'crypto-map-dynamic-reference',
      path: ['crypto', 'map', word('carte', 'Crypto map tag'), sequence, kind, 'dynamic', word('dynamic', 'Dynamic crypto map name')],
      description: 'Reference a dynamic crypto map from this entry position',
      modes: CONFIG, minPrivilege: 15,
      run: (_s, args) => { host().engine().addDynamicRefToCryptoMap(args.carte, Number(args.seq), args.dynamic); return ''; },
    },
    {
      id: 'no-crypto-map',
      path: ['crypto', 'map', word('carte', 'Crypto map tag'), { ...sequence, optional: true }],
      description: 'Remove a crypto map or one of its entries',
      modes: CONFIG, minPrivilege: 15,
      existsOnlyNegated: true,
      run: () => '',
      undo: (_s, args) => {
        if (args.seq !== undefined) host().engine().removeCryptoMapEntry(args.carte, Number(args.seq));
        else host().engine().removeCryptoMap(args.carte);
        return '';
      },
    },
    {
      id: 'ip-local-pool',
      path: ['ip', 'local', 'pool', word('pool', 'Pool name'), address('first'), address('last', true)],
      description: 'IP local address pool',
      undoDescription: 'Remove an address pool',
      modes: CONFIG, minPrivilege: 15,
      run: (_s, args) => {
        const pool = parseLocalPool(args.pool, args.first, args.last);
        if (typeof pool === 'string') return pool;
        server().pools.set(pool.name, pool);
        return '';
      },
      undo: (_s, args) => { server().pools.delete(args.pool); return ''; },
    },
    {
      id: 'show-ip-local-pool',
      path: ['show', 'ip', 'local', 'pool', { ...word('pool', 'Pool name'), optional: true }],
      description: 'IP local address pools',
      modes: SHOW, minPrivilege: 1,
      run: (_s, args) => server().renderLocalPool(args.pool),
    },
    {
      id: 'crypto-isakmp-client-group',
      path: ['crypto', 'isakmp', 'client', 'configuration', 'group', word('group', 'Group name')],
      description: 'Define a remote-access group policy',
      undoDescription: 'Remove a group policy',
      modes: CONFIG, minPrivilege: 15,
      enters: ISAKMP_GROUP_MODE,
      run: (_s, args) => { server().ensureGroup(args.group); host().selectGroup(args.group); return ''; },
      undo: (_s, args) => { server().removeGroup(args.group); return ''; },
    },
    {
      id: 'isakmp-group-key',
      path: ['key', word('key', 'Pre-shared key of the group')],
      description: 'Set the group pre-shared key', undoDescription: 'Remove the group key',
      modes: GROUP_MODE, minPrivilege: 15, undoOmitsArguments: true,
      run: (_s, args) => { const g = group(); if (g) g.key = args.key; return ''; },
      undo: () => { const g = group(); if (g) g.key = undefined; return ''; },
    },
    {
      id: 'isakmp-group-pool',
      path: ['pool', word('pool', 'Local address pool name')],
      description: 'Set the address pool of the group', undoDescription: 'Remove the pool',
      modes: GROUP_MODE, minPrivilege: 15, undoOmitsArguments: true,
      run: (_s, args) => {
        if (!server().pools.has(args.pool)) return `% Pool ${args.pool} is not defined`;
        const g = group(); if (g) g.pool = args.pool;
        return '';
      },
      undo: () => { const g = group(); if (g) g.pool = undefined; return ''; },
    },
    ...(['dns', 'wins'] as const).map((kind): CommandSpec => ({
      id: `isakmp-group-${kind}`,
      path: [kind, address('primary'), address('secondary', true)],
      description: kind === 'dns' ? 'Specify DNS servers' : 'Specify WINS servers',
      undoDescription: `Remove the ${kind.toUpperCase()} servers`,
      modes: GROUP_MODE, minPrivilege: 15, undoOmitsArguments: true,
      run: (_s, args) => {
        const g = group();
        if (g) g[kind] = [args.primary, ...(args.secondary ? [args.secondary] : [])];
        return '';
      },
      undo: () => { const g = group(); if (g) g[kind] = []; return ''; },
    })),
    {
      id: 'isakmp-group-domain',
      path: ['domain', word('domain', 'Default domain name')],
      description: 'Set the default domain name', undoDescription: 'Remove the domain',
      modes: GROUP_MODE, minPrivilege: 15, undoOmitsArguments: true,
      run: (_s, args) => { const g = group(); if (g) g.domain = args.domain; return ''; },
      undo: () => { const g = group(); if (g) g.domain = undefined; return ''; },
    },
    {
      id: 'isakmp-group-acl',
      path: ['acl', word('acl', 'Split-tunnel access list')],
      description: 'Set the split-tunnel access list', undoDescription: 'Remove split tunnelling',
      modes: GROUP_MODE, minPrivilege: 15, undoOmitsArguments: true,
      run: (_s, args) => { const g = group(); if (g) g.splitAcl = args.acl; return ''; },
      undo: () => { const g = group(); if (g) g.splitAcl = undefined; return ''; },
    },
    {
      id: 'isakmp-group-netmask',
      path: ['netmask', { name: 'mask', type: 'SUBNET_MASK', description: 'Netmask pushed to the client' }],
      description: 'Set the netmask given to the client', undoDescription: 'Restore the host mask',
      modes: GROUP_MODE, minPrivilege: 15, undoOmitsArguments: true,
      run: (_s, args) => { const g = group(); if (g) g.netmask = args.mask; return ''; },
      undo: () => { const g = group(); if (g) g.netmask = undefined; return ''; },
    },
    ...([['max-users', 'maxUsers', 'Maximum simultaneous connections of the group'],
      ['max-logins', 'maxLogins', 'Maximum simultaneous logins of one user']] as const).map(([word_, key, text]): CommandSpec => ({
      id: `isakmp-group-${word_}`,
      path: [word_, count('number', text)],
      description: text, undoDescription: 'Remove the limit',
      modes: GROUP_MODE, minPrivilege: 15, undoOmitsArguments: true,
      run: (_s, args) => { const g = group(); if (g) g[key] = Number(args.number); return ''; },
      undo: () => { const g = group(); if (g) g[key] = undefined; return ''; },
    })),
    {
      id: 'isakmp-group-banner',
      path: ['banner', { name: 'text', type: 'REST', literal: 'LINE', description: 'Mode configuration banner text' }],
      description: 'Mode configuration banner', undoDescription: 'Remove the banner',
      modes: GROUP_MODE, minPrivilege: 15, undoOmitsArguments: true,
      run: (_s, args) => { const g = group(); if (g) g.banner = args.text; return ''; },
      undo: () => { const g = group(); if (g) g.banner = undefined; return ''; },
    },
    {
      id: 'isakmp-group-configuration-url',
      path: ['configuration', 'url', word('url', 'Configuration URL pushed to the client')],
      description: 'URL the Easy VPN remote fetches its configuration from', undoDescription: 'Remove the URL',
      modes: GROUP_MODE, minPrivilege: 15, undoOmitsArguments: true,
      run: (_s, args) => { const g = group(); if (g) g.configurationUrl = args.url; return ''; },
      undo: () => { const g = group(); if (g) g.configurationUrl = undefined; return ''; },
    },
    {
      id: 'isakmp-group-configuration-version',
      path: ['configuration', 'version', { name: 'version', type: 'INT', range: [1, 32767], description: 'Configuration version' }],
      description: 'Configuration version the Easy VPN remote must use', undoDescription: 'Remove the version',
      modes: GROUP_MODE, minPrivilege: 15, undoOmitsArguments: true,
      run: (_s, args) => { const g = group(); if (g) g.configurationVersion = Number(args.version); return ''; },
      undo: () => { const g = group(); if (g) g.configurationVersion = undefined; return ''; },
    },
    {
      id: 'isakmp-group-backup-gateway',
      path: ['backup-gateway', word('gateway', 'Backup gateway address or host name')],
      description: 'Push a backup gateway to the client', undoDescription: 'Remove a backup gateway',
      modes: GROUP_MODE, minPrivilege: 15,
      run: (_s, args) => { const g = group(); if (g && !g.backupGateways.includes(args.gateway)) g.backupGateways.push(args.gateway); return ''; },
      undo: (_s, args) => {
        const g = group();
        if (g) g.backupGateways = args.gateway ? g.backupGateways.filter((x) => x !== args.gateway) : [];
        return '';
      },
    },
    ...([['include-local-lan', 'includeLocalLan', 'Let a non-split-tunnel client reach its local subnet'],
      ['save-password', 'savePassword', 'Let the client save its extended authentication password'],
      ['group-lock', 'groupLock', 'Require the user name to carry the group it logs in to']] as const).map(([word_, key, text]): CommandSpec => ({
      id: `isakmp-group-${word_}`,
      path: [word_], description: text, undoDescription: `Disable ${word_}`,
      modes: GROUP_MODE, minPrivilege: 15,
      run: () => { const g = group(); if (g) g[key] = true; return ''; },
      undo: () => { const g = group(); if (g) g[key] = undefined; return ''; },
    })),
    {
      id: 'isakmp-group-access-restrict',
      path: ['access-restrict', word('interface', 'Interface the group is restricted to')],
      description: 'Tie the group to an interface', undoDescription: 'Remove the restriction',
      modes: GROUP_MODE, minPrivilege: 15, undoOmitsArguments: true,
      run: (_s, args) => {
        const resolved = host().resolveInterface(args.interface);
        if (resolved === null) return `% Interface ${args.interface} does not exist`;
        const g = group(); if (g) g.accessRestrict = resolved;
        return '';
      },
      undo: () => { const g = group(); if (g) g.accessRestrict = undefined; return ''; },
    },
    {
      id: 'isakmp-group-browser-proxy',
      path: ['browser-proxy', word('proxy', 'Browser proxy map name')],
      description: 'Apply a browser-proxy map to the group', undoDescription: 'Remove the browser-proxy map',
      modes: GROUP_MODE, minPrivilege: 15, undoOmitsArguments: true,
      run: (_s, args) => {
        if (!server().browserProxies.has(args.proxy)) return `% Browser proxy ${args.proxy} is not defined`;
        const g = group(); if (g) g.browserProxy = args.proxy;
        return '';
      },
      undo: () => { const g = group(); if (g) g.browserProxy = undefined; return ''; },
    },
    {
      id: 'crypto-isakmp-client-browser-proxy',
      path: ['crypto', 'isakmp', 'client', 'configuration', 'browser-proxy', word('proxy', 'Browser proxy map name')],
      description: 'Browser-proxy parameters for Easy VPN remotes', undoDescription: 'Remove the browser-proxy map',
      modes: CONFIG, minPrivilege: 15,
      enters: BROWSER_PROXY_MODE,
      run: (_s, args) => {
        if (!server().browserProxies.has(args.proxy)) server().browserProxies.set(args.proxy, { mode: 'none' });
        host().selectBrowserProxy(args.proxy);
        return '';
      },
      undo: (_s, args) => { server().browserProxies.delete(args.proxy); return ''; },
    },
    {
      id: 'browser-proxy-auto-detect',
      path: ['proxy', 'auto-detect'], description: 'Let the browser detect the proxy', undoDescription: 'Remove the setting',
      modes: PROXY_MODE, minPrivilege: 15,
      run: () => { const p = proxy(); if (p) p.mode = 'auto-detect'; return ''; },
      undo: () => { const p = proxy(); if (p) p.mode = 'none'; return ''; },
    },
    {
      id: 'browser-proxy-none',
      path: ['proxy', 'none'], description: 'No browser proxy', undoDescription: 'Remove the setting',
      modes: PROXY_MODE, minPrivilege: 15,
      run: () => { const p = proxy(); if (p) p.mode = 'none'; return ''; },
      undo: () => { const p = proxy(); if (p) p.mode = 'none'; return ''; },
    },
    {
      id: 'browser-proxy-server',
      path: ['proxy', 'server', word('server', 'Proxy address:port')],
      description: 'Proxy server of the browser', undoDescription: 'Remove the proxy server',
      modes: PROXY_MODE, minPrivilege: 15, undoOmitsArguments: true,
      run: (_s, args) => {
        if (!/^[^:\s]+:\d{1,5}$/.test(args.server)) return '% The proxy server is written address:port';
        const p = proxy(); if (p) { p.mode = 'server'; p.server = args.server; }
        return '';
      },
      undo: () => { const p = proxy(); if (p) { p.mode = 'none'; p.server = undefined; } return ''; },
    },
    {
      id: 'browser-proxy-exception-list',
      path: ['proxy', 'exception-list', word('list', 'Semicolon or comma separated exceptions')],
      description: 'Addresses the browser reaches without the proxy', undoDescription: 'Remove the exception list',
      modes: PROXY_MODE, minPrivilege: 15, undoOmitsArguments: true,
      run: (_s, args) => { const p = proxy(); if (p) p.exceptionList = args.list; return ''; },
      undo: () => { const p = proxy(); if (p) p.exceptionList = undefined; return ''; },
    },
    {
      id: 'browser-proxy-bypass-local',
      path: ['proxy', 'by-pass-local'], description: 'Bypass the proxy for local addresses', undoDescription: 'Use the proxy for local addresses',
      modes: PROXY_MODE, minPrivilege: 15,
      run: () => { const p = proxy(); if (p) p.bypassLocal = true; return ''; },
      undo: () => { const p = proxy(); if (p) p.bypassLocal = false; return ''; },
    },
    mapPolicy('crypto-map-client-authentication',
      ['client', 'authentication', 'list', listName], 'Authenticate remote-access clients (XAUTH)',
      (a) => ({ authenticationList: a.list }), { authenticationList: undefined }),
    mapPolicy('crypto-map-isakmp-authorization',
      ['isakmp', 'authorization', 'list', listName], 'Authorize remote-access groups',
      (a) => ({ authorizationList: a.list }), { authorizationList: undefined }),
    {
      id: 'crypto-map-client-address',
      path: ['crypto', 'map', word('carte', 'Crypto map tag'), 'client', 'configuration', 'address', {
        name: 'role', type: 'ENUM', optional: true, values: [
          { keyword: 'initiate', description: 'Ask each peer for an address' },
          { keyword: 'respond', description: 'Answer address requests of any requesting peer' },
        ],
      }],
      description: 'Configure IKE mode configuration', undoDescription: 'Disable IKE mode configuration',
      modes: CONFIG, minPrivilege: 15, undoOmitsArguments: true,
      run: (_s, args) => {
        const role = args.role;
        host().engine().setClientPolicy(args.carte, { respond: role !== 'initiate', initiate: role !== 'respond' });
        return '';
      },
      undo: (_s, args) => { host().engine().setClientPolicy(args.carte, { respond: false, initiate: false }); return ''; },
    },
    {
      id: 'crypto-isakmp-client-address-pool',
      path: ['crypto', 'isakmp', 'client', 'configuration', 'address-pool', 'local', word('pool', 'Local address pool name')],
      description: 'Default address pool of the remote-access groups',
      undoDescription: 'Remove the default pool',
      modes: CONFIG, minPrivilege: 15, undoOmitsArguments: true,
      run: (_s, args) => {
        if (!server().pools.has(args.pool)) return `% Pool ${args.pool} is not defined`;
        server().defaultPool = args.pool;
        return '';
      },
      undo: () => { server().defaultPool = undefined; return ''; },
    },
    {
      id: 'show-crypto-session-group',
      path: ['show', 'crypto', 'session', 'group'],
      description: 'Display the active remote-access groups',
      modes: ['privileged'], minPrivilege: 15,
      run: () => server().renderSessionGroups(),
    },
    {
      id: 'show-crypto-session-summary',
      path: ['show', 'crypto', 'session', 'summary'],
      description: 'Display the active groups and their connected users',
      modes: ['privileged'], minPrivilege: 15,
      run: () => server().renderSessionSummary(),
    },
  ];
}
