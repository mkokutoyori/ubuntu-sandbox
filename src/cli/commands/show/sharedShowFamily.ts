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
    {
      ...base, id: 'show-cdp',
      path: ['show', 'cdp', rest('detail', 'CDP detail to display', [
        ['neighbors', 'CDP neighbor entries'],
        ['entry', 'Information for specific neighbor entry'],
        ['interface', 'CDP interface status and configuration'],
        ['traffic', 'CDP statistics'],
      ])],
      description: 'Display CDP information',
      run: (_session, args) => host().cdp(words(args.detail)),
    },
    {
      ...base, id: 'show-lldp',
      path: ['show', 'lldp', rest('detail', 'LLDP detail to display', [
        ['neighbors', 'LLDP neighbor entries'],
        ['entry', 'Information for specific neighbor entry'],
        ['errors', 'LLDP computational errors and overflows'],
        ['interface', 'LLDP interface status and configuration'],
        ['local-info', 'Local LLDP information'],
        ['traffic', 'LLDP statistics'],
      ])],
      description: 'Display LLDP information',
      run: (_session, args) => host().lldp(words(args.detail)),
    },
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
