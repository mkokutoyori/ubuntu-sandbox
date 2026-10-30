import type { ArgumentSpec } from '../../ArgumentTypes';
import type { CommandSpec } from '../../CommandTable';

export interface SharedShowHost {
  errorCounters(): string;
  providesMacAddressTable(): boolean;
  macAddressTable(): string;
  cdp(words: readonly string[]): string;
  lldp(words: readonly string[]): string;
  snmp(words: readonly string[]): string;
  parserView(words: readonly string[]): string;
  hosts(): string;
  dnsStatistics(): string;
  hasRedundancy(): boolean;
  redundancy(): string;
  aaa(words: readonly string[]): string;
}

const words = (value: string | undefined): string[] =>
  (value ?? '').trim().split(/\s+/).filter(Boolean);

function rest(
  name: string, description: string, forms: ReadonlyArray<readonly [string, string]> = [],
): ArgumentSpec {
  return {
    name, type: 'REST', optional: true, description, literal: 'LINE',
    ...(forms.length === 0 ? {} : {
      alternatives: forms.map(([keyword, text]) => ({ keyword, description: text })),
    }),
  };
}


interface DiscoveryBase {
  readonly modes: string[];
  readonly minPrivilege: number;
}

function discoveryFamily(
  protocol: 'cdp' | 'lldp', base: DiscoveryBase, run: (words: readonly string[]) => string,
): CommandSpec[] {
  const label = protocol === 'cdp' ? 'CDP' : 'LLDP';
  const interfaceArgument: ArgumentSpec = {
    name: 'interface', type: 'INTERFACE', optional: true, description: `Interface to show the ${label} status of`,
  };
  const leaf = (stem: string, description: string, extra: Partial<CommandSpec> & { arguments?: ArgumentSpec[] } = {}): CommandSpec => ({
    ...base, id: `show-${protocol}-${stem}`, path: ['show', protocol, stem, ...(extra.arguments ?? [])],
    description, run: () => run([stem]),
  } as CommandSpec);
  const specs: CommandSpec[] = [
    { ...base, id: `show-${protocol}`, path: ['show', protocol], description: `Display ${label} information`, run: () => run([]) },
    {
      ...base, id: `show-${protocol}-neighbors`,
      path: ['show', protocol, 'neighbors', rest('detail', 'Interface or detail selector', [['detail', 'Show detailed information']])],
      description: `${label} neighbor entries`,
      run: (_session, args) => run(['neighbors', ...words(args.detail)]),
    },
    {
      ...base, id: `show-${protocol}-entry`,
      path: ['show', protocol, 'entry', { name: 'device', type: 'WORD', description: 'Name of the neighbor entry' }, rest('selector', 'Entry detail')],
      description: 'Information for specific neighbor entry',
      run: (_session, args) => run(['entry', String(args.device), ...words(args.selector)]),
    },
    {
      ...base, id: `show-${protocol}-interface`, path: ['show', protocol, 'interface', interfaceArgument],
      description: `${label} interface status and configuration`,
      run: (_session, args) => run(['interface', ...words(args.interface)]),
    },
    leaf('traffic', `${label} statistics`),
  ];
  if (protocol === 'lldp') {
    specs.push(
      leaf('errors', 'LLDP computational errors and overflows'),
      { ...base, id: 'show-lldp-local-info', path: ['show', 'lldp', 'local-info'], description: 'Local LLDP information', run: () => run(['local-info']) },
    );
  }
  return specs;
}

export function sharedShowFamily(host: () => SharedShowHost): CommandSpec[] {
  const base = { modes: ['user', 'privileged'], minPrivilege: 1 };
  return [
    {
      ...base, id: 'show-interfaces-counters-errors',
      path: ['show', 'interfaces', 'counters', 'errors'],
      description: 'Display interface error counters', run: () => host().errorCounters(),
    },
    ...(host().providesMacAddressTable() ? [{
      ...base, id: 'show-mac-address-table',
      path: ['show', 'mac', 'address-table', rest('filter', 'Filter the MAC address table')],
      description: 'Display MAC address table',
      run: () => host().macAddressTable(),
    }] : []),
    ...discoveryFamily('cdp', base, (words) => host().cdp(words)),
    ...discoveryFamily('lldp', base, (words) => host().lldp(words)),
    {
      ...base, modes: ['privileged'], id: 'show-snmp', path: ['show', 'snmp', rest('view', 'SNMP detail to display')],
      description: 'Display SNMP status',
      run: (_session, args) => host().snmp(words(args.view)),
    },
    {
      ...base, modes: ['privileged'], id: 'show-parser-view',
      path: ['show', 'parser', 'view', rest('scope', 'Views to display', [
        ['all', 'Every view declared on the device'],
      ])],
      description: 'Display CLI view information',
      run: (_session, args) => host().parserView(words(args.scope)),
    },
    {
      ...base, id: 'show-hosts', path: ['show', 'hosts'],
      description: 'Display host cache', run: () => host().hosts(),
    },
    {
      ...base, id: 'show-ip-dns-statistics', path: ['show', 'ip', 'dns', 'statistics'],
      description: 'Display DNS server statistics', run: () => host().dnsStatistics(),
    },
    ...(host().hasRedundancy() ? [{
      ...base, id: 'show-redundancy', path: ['show', 'redundancy'],
      description: 'Display redundancy state',
      run: () => host().redundancy(),
    }] : []),
    {
      ...base, id: 'show-aaa', path: ['show', 'aaa', rest('detail', 'AAA detail to display')],
      description: 'Display AAA state',
      run: (_session, args) => host().aaa(words(args.detail)),
    },
  ];
}
