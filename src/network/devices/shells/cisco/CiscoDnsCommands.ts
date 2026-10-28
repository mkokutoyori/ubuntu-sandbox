import type { ArgumentSpec } from '@/cli/ArgumentTypes';
import type { CommandSpec } from '@/cli/CommandTable';
import type { CiscoDnsConfig, DnsErreur } from '../../router/dns/CiscoDnsConfig';
import type { RouterHostsTable } from '../../router/dns/RouterHostsTable';
import { isValidIPv4 } from '@/network/core/ip';

export interface DnsCommandContext {
  config(): CiscoDnsConfig | null;
  hosts(): RouterHostsTable | null;
  afterApply?(): void;
}

export const DNS_RETRY_RANGE: readonly [number, number] = [0, 100];
export const DNS_TIMEOUT_RANGE: readonly [number, number] = [0, 3600];

const INVALID = "% Invalid input detected at '^' marker.";
const INCOMPLETE = '% Incomplete command.';

function rendre(err: DnsErreur | null): string {
  if (!err) return '';
  return err.kind === 'incomplete' ? INCOMPLETE : INVALID;
}

const words = (value: string | undefined): string[] =>
  (value ?? '').trim().split(/\s+/).filter(Boolean);

export function ciscoDnsConfigSpecs(ctx: DnsCommandContext): CommandSpec[] {
  const cfg = () => ctx.config();
  const applique = (f: (c: CiscoDnsConfig) => string): string => {
    const c = cfg();
    if (!c) return '';
    const out = f(c);
    if (out === '') ctx.afterApply?.();
    return out;
  };
  const base = { modes: ['config'], minPrivilege: 15 };
  const specs: CommandSpec[] = [];

  const command = (
    id: string, path: ReadonlyArray<string | ArgumentSpec>, description: string,
    run: (args: Record<string, string>) => string,
    undo?: (args: Record<string, string>) => string,
  ): void => {
    specs.push({
      ...base, id, path: [...path], description,
      run: (_session, args) => applique(() => run(args)),
      ...(undo ? { undo: (_session: unknown, args: Record<string, string>) => applique(() => undo(args)) } : {}),
    } as CommandSpec);
  };
  const bareUndo = (
    id: string, path: ReadonlyArray<string | ArgumentSpec>, description: string,
    undo: () => string,
  ): void => {
    specs.push({
      ...base, id: `${id}-undo`, path: [...path], description, existsOnlyNegated: true,
      run: () => INCOMPLETE,
      undo: () => applique(() => undo()),
    });
  };

  for (const root of [['ip', 'domain-lookup'], ['ip', 'domain', 'lookup']]) {
    const tag = root.join('-');
    command(tag, root, 'Enable IP Domain Name System hostname translation',
      () => { const c = cfg(); if (c) c.lookupEnabled = true; return ''; },
      () => { const c = cfg(); if (c) c.lookupEnabled = false; return ''; });
    command(`${tag}-source-interface`, [...root, 'source-interface', {
      name: 'interface', type: 'INTERFACE', description: 'Interface used as the source address',
    }], 'Source interface for packets',
    (args) => {
      const c = cfg();
      if (c) { c.lookupSourceInterface = args.interface; c.lookupEnabled = true; }
      return '';
    },
    () => { const c = cfg(); if (c) c.lookupSourceInterface = null; return ''; });
    bareUndo(`${tag}-source-interface`, [...root, 'source-interface'],
      'Source interface for packets',
      () => { const c = cfg(); if (c) c.lookupSourceInterface = null; return ''; });
  }

  for (const root of [['ip', 'domain-name'], ['ip', 'domain', 'name']]) {
    const tag = root.join('-');
    const clear = () => { const c = cfg(); if (c) c.domainName = ''; return ''; };
    command(tag, [...root, { name: 'name', type: 'WORD', description: 'Default domain name' }],
      'Define the default domain name',
      (args) => { const c = cfg(); if (c) c.domainName = args.name; return ''; }, clear);
    bareUndo(tag, root, 'Remove the default domain name', clear);
  }

  for (const root of [['ip', 'domain-list'], ['ip', 'domain', 'list']]) {
    const tag = root.join('-');
    command(tag, [...root, {
      name: 'name', type: 'WORD', description: 'Domain name to append to the list',
    }], 'Define a list of default domain names',
    (args) => rendre(cfg()?.addDomainToList(args.name) ?? null),
    (args) => { cfg()?.removeDomainFromList(args.name); return ''; });
  }

  const nameServers: ArgumentSpec[] = [
    { name: 'address', type: 'IP_ADDR', description: 'Domain server IP address' },
    { name: 'more', type: 'REST', optional: true, description: 'Further domain server addresses' },
  ];
  const serverWords = (args: Record<string, string>) => [args.address, ...words(args.more)];
  command('ip-name-server', ['ip', 'name-server', ...nameServers],
    'Specify address of name server to use',
    (args) => rendre(cfg()?.setNameServers(serverWords(args)) ?? null),
    (args) => { cfg()?.removeNameServers(serverWords(args)); return ''; });
  bareUndo('ip-name-server', ['ip', 'name-server'], 'Remove a name server',
    () => { cfg()?.removeNameServers([]); return ''; });

  const timed = (
    keyword: string, name: string, range: readonly [number, number], description: string,
    set: (c: CiscoDnsConfig, n: number) => void, restore: (c: CiscoDnsConfig) => void,
  ): void => {
    const reset = () => { const c = cfg(); if (c) restore(c); return ''; };
    command(`ip-domain-${keyword}`, ['ip', 'domain', keyword, {
      name, type: 'INT', range: [range[0], range[1]], description,
    }], description,
    (args) => { const c = cfg(); if (c) set(c, Number(args[name])); return ''; }, reset);
    bareUndo(`ip-domain-${keyword}`, ['ip', 'domain', keyword], description, reset);
  };
  timed('timeout', 'seconds', DNS_TIMEOUT_RANGE, 'Set time to wait for a DNS response',
    (c, n) => { c.timeout = n; }, (c) => { c.timeout = 3; });
  timed('retry', 'tries', DNS_RETRY_RANGE, 'Set number of times to retry a DNS query',
    (c, n) => { c.retry = n; }, (c) => { c.retry = 2; });

  command('ip-domain-round-robin', ['ip', 'domain', 'round-robin'],
    'Rotate the order of returned addresses',
    () => { const c = cfg(); if (c) c.roundRobin = true; return ''; },
    () => { const c = cfg(); if (c) c.roundRobin = false; return ''; });
  command('ip-dns-server', ['ip', 'dns', 'server'], 'Enable the DNS server',
    () => { const c = cfg(); if (c) c.serverEnabled = true; return ''; },
    () => { const c = cfg(); if (c) c.serverEnabled = false; return ''; });

  const spoofingOff = () => {
    const c = cfg();
    if (c) { c.spoofing = false; c.spoofingAddress = null; }
    return '';
  };
  const spoofingOn = (address: string | null) => {
    const c = cfg();
    if (c) { c.spoofing = true; c.spoofingAddress = address; }
    return '';
  };
  command('ip-dns-spoofing', ['ip', 'dns', 'spoofing'], 'Enable DNS spoofing',
    () => spoofingOn(null), spoofingOff);
  command('ip-dns-spoofing-address', ['ip', 'dns', 'spoofing', {
    name: 'address', type: 'IP_ADDR', description: 'Address answered to every query',
  }], 'Enable DNS spoofing', (args) => spoofingOn(args.address), spoofingOff);

  command('ip-dns-primary', ['ip', 'dns', 'primary', {
    name: 'zone', type: 'REST', description: 'Zone, then `soa` with its name server and mailbox',
  }], 'Configure this device as primary for a zone',
  (args) => rendre(cfg()?.setPrimaryZone(words(args.zone)) ?? null),
  (args) => { cfg()?.primaryZones.delete((words(args.zone)[0] ?? '').toLowerCase()); return ''; });

  command('ip-host', ['ip', 'host', { name: 'name', type: 'WORD', description: 'Name of host' }, {
    name: 'more', type: 'REST', optional: true,
    description: 'Host addresses, or `ns` then the name server address',
  }], 'Add a host to the host table',
  (args) => {
    const c = cfg();
    if (!c) return '';
    const rest = words(args.more);
    if (rest.length < 1) return INCOMPLETE;
    if (rest[0].toLowerCase() === 'ns') {
      if (!rest[1]) return INCOMPLETE;
      return rendre(c.addNsRecord(args.name, rest[1]));
    }
    const addresses = rest.filter((a) => !/^\d+$/.test(a) || isValidIPv4(a));
    for (const a of addresses) if (!isValidIPv4(a)) return `% Invalid IP address ${a}.`;
    if (addresses.length === 0) return INCOMPLETE;
    if (addresses.length > 8) return INVALID;
    ctx.hosts()?.upsert(args.name, addresses, true);
    return '';
  },
  (args) => {
    const c = cfg();
    if (!c) return '';
    if (words(args.more)[0]?.toLowerCase() === 'ns') {
      c.nsRecords.delete(args.name.toLowerCase());
      return '';
    }
    ctx.hosts()?.remove(args.name);
    return '';
  });

  return specs;
}
