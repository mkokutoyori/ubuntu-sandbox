import type { CommandSpec } from '../../CommandTable';

export interface AsaNetworkHost {
  ping(words: readonly string[]): string;
  traceroute(words: readonly string[]): string;
  route(words: readonly string[]): string;
  removeRoute(words: readonly string[]): string;
  dnsDomainLookup(nameif: string, enabled: boolean): string;
  dnsServerGroup(name: string): string;
  nameServer(addresses: readonly string[], present: boolean): string;
  groupDomainName(name: string, present: boolean): string;
}

const WORDS = { name: 'words', type: 'REST', optional: true, description: 'Arguments' } as const;
const REQUIRED_WORDS = { name: 'words', type: 'REST', description: 'Arguments' } as const;

const words = (value: string | undefined): string[] => (value ?? '').trim().split(/\s+/).filter(Boolean);

const EXEC_AND_CONFIG = Object.freeze([
  'privileged', 'config', 'config-if', 'config-object', 'config-group', 'config-dns-server-group',
]);

export function asaNetworkFamily(host: () => AsaNetworkHost): CommandSpec[] {
  return [
    {
      id: 'ping', path: ['ping', WORDS], description: 'Test connectivity from an interface to a host',
      modes: EXEC_AND_CONFIG, minPrivilege: 1,
      run: (_session, args) => host().ping(words(args.words)),
    },
    {
      id: 'traceroute', path: ['traceroute', REQUIRED_WORDS], description: 'Determine the route packets will take to their destination',
      modes: EXEC_AND_CONFIG, minPrivilege: 1,
      run: (_session, args) => host().traceroute(words(args.words)),
    },
    {
      id: 'route', path: ['route', REQUIRED_WORDS], description: 'Add a static route',
      modes: ['config'], minPrivilege: 15,
      run: (_session, args) => host().route(words(args.words)),
      undo: (_session, args) => host().removeRoute(words(args.words)),
    },
    {
      id: 'dns-domain-lookup',
      path: ['dns', 'domain-lookup', { name: 'interface', type: 'WORD', description: 'Interface name' }],
      description: 'Enable the ASA to send DNS requests to a DNS server',
      modes: ['config'], minPrivilege: 15,
      run: (_session, args) => host().dnsDomainLookup(args.interface, true),
      undo: (_session, args) => host().dnsDomainLookup(args.interface, false),
    },
    {
      id: 'dns-server-group',
      path: ['dns', 'server-group', { name: 'name', type: 'WORD', description: 'DNS server group name' }],
      description: 'Enter dns server-group mode',
      modes: ['config'], minPrivilege: 15,
      run: (_session, args) => host().dnsServerGroup(args.name),
    },
    {
      id: 'name-server',
      path: ['name-server', { name: 'address', type: 'IP_ADDR', description: 'DNS server address' }, { name: 'more', type: 'REST', optional: true, description: 'Further addresses' }],
      description: 'Add a DNS server to the group',
      modes: ['config-dns-server-group'], minPrivilege: 15,
      run: (_session, args) => host().nameServer([args.address, ...words(args.more)], true),
      undo: (_session, args) => host().nameServer([args.address, ...words(args.more)], false),
    },
    {
      id: 'group-domain-name',
      path: ['domain-name', { name: 'name', type: 'WORD', description: 'Default domain name' }],
      description: 'Set the default domain name of the group',
      modes: ['config-dns-server-group'], minPrivilege: 15,
      run: (_session, args) => host().groupDomainName(args.name, true),
      undo: (_session, args) => host().groupDomainName(args.name, false),
    },
  ] as unknown as CommandSpec[];
}
