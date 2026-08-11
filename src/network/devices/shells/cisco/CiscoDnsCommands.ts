import type { CommandTrie } from '../CommandTrie';
import type { CiscoDnsConfig, DnsErreur } from '../../router/dns/CiscoDnsConfig';
import type { RouterHostsTable } from '../../router/dns/RouterHostsTable';
import { isValidIPv4 } from '@/network/core/ip';

export interface DnsCommandContext {
  config(): CiscoDnsConfig | null;
  hosts(): RouterHostsTable | null;
  afterApply?(): void;
}

const INVALID = "% Invalid input detected at '^' marker.";
const INCOMPLETE = '% Incomplete command.';

function rendre(err: DnsErreur | null): string {
  if (!err) return '';
  return err.kind === 'incomplete' ? INCOMPLETE : INVALID;
}

function borne(v: string | undefined, min: number, max: number): number | null {
  const n = Number.parseInt(v ?? '', 10);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

export function registerCiscoDnsCommands(trie: CommandTrie, ctx: DnsCommandContext): void {
  const cfg = () => ctx.config();
  const applique = (f: (c: CiscoDnsConfig) => string): string => {
    const c = cfg();
    if (!c) return '';
    const out = f(c);
    if (out === '') ctx.afterApply?.();
    return out;
  };

  for (const racine of ['ip domain-lookup', 'ip domain lookup']) {
    trie.registerGreedy(racine, 'Enable IP Domain Name System hostname translation', (args) =>
      applique((c) => {
        if (args.length === 0) { c.lookupEnabled = true; return ''; }
        if (args[0].toLowerCase() !== 'source-interface') return INVALID;
        if (!args[1]) return INCOMPLETE;
        c.lookupSourceInterface = args[1];
        c.lookupEnabled = true;
        return '';
      }));
    trie.registerGreedy(`no ${racine}`, 'Disable IP Domain Name System hostname translation', (args) =>
      applique((c) => {
        if (args[0]?.toLowerCase() === 'source-interface') {
          c.lookupSourceInterface = null;
          return '';
        }
        c.lookupEnabled = false;
        return '';
      }));
  }

  for (const racine of ['ip domain-name', 'ip domain name']) {
    trie.registerGreedy(racine, 'Define the default domain name', (args) =>
      applique((c) => {
        if (!args[0]) return INCOMPLETE;
        c.domainName = args[0];
        return '';
      }));
    trie.registerGreedy(`no ${racine}`, 'Remove the default domain name', () =>
      applique((c) => { c.domainName = ''; return ''; }));
  }

  for (const racine of ['ip domain-list', 'ip domain list']) {
    trie.registerGreedy(racine, 'Define a list of default domain names', (args) =>
      applique((c) => rendre(c.addDomainToList(args[0]))));
    trie.registerGreedy(`no ${racine}`, 'Remove a default domain name', (args) =>
      applique((c) => { c.removeDomainFromList(args[0]); return ''; }));
  }

  trie.registerGreedy('ip name-server', 'Specify address of name server to use', (args) =>
    applique((c) => rendre(c.setNameServers(args))));
  trie.registerGreedy('no ip name-server', 'Remove a name server', (args) =>
    applique((c) => { c.removeNameServers(args); return ''; }));

  trie.registerGreedy('ip domain timeout', 'Set time to wait for a DNS response', (args) =>
    applique((c) => {
      const n = borne(args[0], 0, 3600);
      if (n === null) return args[0] === undefined ? INCOMPLETE : INVALID;
      c.timeout = n;
      return '';
    }));
  trie.registerGreedy('no ip domain timeout', 'Restore the default DNS timeout', () =>
    applique((c) => { c.timeout = 3; return ''; }));

  trie.registerGreedy('ip domain retry', 'Set number of times to retry a DNS query', (args) =>
    applique((c) => {
      const n = borne(args[0], 0, 100);
      if (n === null) return args[0] === undefined ? INCOMPLETE : INVALID;
      c.retry = n;
      return '';
    }));
  trie.registerGreedy('no ip domain retry', 'Restore the default DNS retry count', () =>
    applique((c) => { c.retry = 2; return ''; }));

  trie.register('ip domain round-robin', 'Rotate the order of returned addresses', () =>
    applique((c) => { c.roundRobin = true; return ''; }));
  trie.register('no ip domain round-robin', 'Stop rotating returned addresses', () =>
    applique((c) => { c.roundRobin = false; return ''; }));

  trie.register('ip dns server', 'Enable the DNS server', () =>
    applique((c) => { c.serverEnabled = true; return ''; }));
  trie.register('no ip dns server', 'Disable the DNS server', () =>
    applique((c) => { c.serverEnabled = false; return ''; }));

  trie.registerGreedy('ip dns spoofing', 'Enable DNS spoofing', (args) =>
    applique((c) => {
      if (args[0] !== undefined && !isValidIPv4(args[0])) return INVALID;
      c.spoofing = true;
      c.spoofingAddress = args[0] ?? null;
      return '';
    }));
  trie.registerGreedy('no ip dns spoofing', 'Disable DNS spoofing', () =>
    applique((c) => { c.spoofing = false; c.spoofingAddress = null; return ''; }));

  trie.registerGreedy('ip dns primary', 'Configure this device as primary for a zone', (args) =>
    applique((c) => rendre(c.setPrimaryZone(args))));
  trie.registerGreedy('no ip dns primary', 'Remove a primary zone', (args) =>
    applique((c) => { c.primaryZones.delete((args[0] ?? '').toLowerCase()); return ''; }));

  trie.registerGreedy('ip host', 'Add a host to the host table', (args) =>
    applique((c) => {
      if (args.length < 2) return INCOMPLETE;
      if (args[1].toLowerCase() === 'ns') {
        if (!args[2]) return INCOMPLETE;
        return rendre(c.addNsRecord(args[0], args[2]));
      }
      const adresses = args.slice(1).filter((a) => !/^\d+$/.test(a) || isValidIPv4(a));
      for (const a of adresses) if (!isValidIPv4(a)) return `% Invalid IP address ${a}.`;
      if (adresses.length === 0) return INCOMPLETE;
      if (adresses.length > 8) return INVALID;
      ctx.hosts()?.upsert(args[0], adresses, true);
      return '';
    }));
  trie.registerGreedy('no ip host', 'Remove a host from the host table', (args) =>
    applique((c) => {
      if (args.length < 1) return INCOMPLETE;
      if (args[1]?.toLowerCase() === 'ns') {
        c.nsRecords.delete(args[0].toLowerCase());
        return '';
      }
      ctx.hosts()?.remove(args[0]);
      return '';
    }));
}

export function registerCiscoDnsExecCommands(trie: CommandTrie, ctx: DnsCommandContext): void {
  trie.registerGreedy('clear host', 'Delete entries from the host table', (args) => {
    const t = ctx.hosts();
    if (!t) return '';
    if (args.length === 0) return INCOMPLETE;
    if (args[0] === '*') { t.clearLearned(); return ''; }
    t.remove(args[0]);
    return '';
  });
}
