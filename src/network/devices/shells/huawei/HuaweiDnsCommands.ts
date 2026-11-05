import type { CommandTrie } from '../CommandTrie';
import type { CiscoDnsConfig } from '../../router/dns/CiscoDnsConfig';
import type { RouterHostsTable } from '../../router/dns/RouterHostsTable';
import { IPAddress } from '../../../core/types';
import { resolveHostnameFor } from '../../NameResolution';
import { padToWidth } from '../cli/TextTable';
import { looksLikeIPv6 } from '../cisco/ciscoPing';

export interface HuaweiDnsHost {
  config(): CiscoDnsConfig;
  hosts(): RouterHostsTable;
}

const INCOMPLETE = "Error: Incomplete command found at '^' position.";
const WRONG = "Error: Wrong parameter found at '^' position.";

export async function withTargetResolved(device: unknown, args: readonly string[]): Promise<string[]> {
  const name = args[args.length - 1];
  if (name === undefined || name.startsWith('-') || IPAddress.tryParse(name) !== null || looksLikeIPv6(name)) return [...args];
  const address = await resolveHostnameFor(device, name);
  return address === null ? [...args] : [...args.slice(0, -1), address];
}

export function huaweiDnsConfigLines(host: HuaweiDnsHost): string[] {
  const config = host.config();
  const lines: string[] = [];
  if (config.lookupEnabled) lines.push('dns resolve');
  for (const server of config.nameServers) lines.push(`dns server ${server}`);
  for (const domain of config.domainList) lines.push(`dns domain ${domain}`);
  for (const entry of host.hosts().entries()) {
    if (entry.permanent) lines.push(`ip host ${entry.name} ${entry.ips.join(' ')}`);
  }
  return lines;
}

export function registerHuaweiDnsDisplayCommands(trie: CommandTrie, host: HuaweiDnsHost): void {
  trie.register('display dns server', 'Display DNS servers', () => {
    const servers = host.config().nameServers;
    if (servers.length === 0) return 'No DNS server configured.';
    return [
      ' Type: D:Dynamic  S:Static',
      ' Domain-name-server           Type',
      ...servers.map((s) => ` ${padToWidth(s, 29)}S`),
    ].join('\n');
  });
  trie.register('display dns domain', 'Display DNS domain suffixes', () => {
    const suffixes = host.config().suffixesDeRecherche();
    if (suffixes.length === 0) return 'No domain name configured.';
    return [
      ' Type: D:Dynamic  S:Static',
      ' No.   Domain-name                             Type',
      ...suffixes.map((s, i) => ` ${padToWidth(String(i + 1), 6)}${padToWidth(s, 40)}S`),
    ].join('\n');
  });
  trie.register('display dns dynamic-host', 'Display the dynamic DNS cache', () => {
    const entries = host.hosts().entries().filter((e) => !e.permanent);
    if (entries.length === 0) return 'No dynamic host resolved.';
    return [
      ' No.  Host                     TTL         IpAddress',
      ...entries.map((e, i) =>
        ` ${padToWidth(String(i + 1), 5)}${padToWidth(e.name, 25)}${padToWidth(String(86400 - e.ageSeconds), 12)}${e.ips.join(' ')}`),
    ].join('\n');
  });
}

export function registerHuaweiDnsConfigCommands(trie: CommandTrie, host: HuaweiDnsHost): void {
  trie.register('dns resolve', 'Enable dynamic DNS resolution', () => {
    host.config().lookupEnabled = true;
    return '';
  });
  trie.register('undo dns resolve', 'Disable dynamic DNS resolution', () => {
    host.config().lookupEnabled = false;
    return '';
  });
  trie.registerGreedy('dns server', 'Configure a DNS server', (args) => {
    const error = host.config().setNameServers(args);
    if (!error) return '';
    return error.kind === 'incomplete' ? INCOMPLETE : WRONG;
  });
  trie.registerGreedy('undo dns server', 'Remove a DNS server', (args) => {
    host.config().removeNameServers(args);
    return '';
  });
  trie.registerGreedy('dns domain', 'Configure a DNS domain suffix', (args) => {
    const error = host.config().addDomainToList(args[0]);
    return error ? INCOMPLETE : '';
  });
  trie.registerGreedy('undo dns domain', 'Remove a DNS domain suffix', (args) => {
    host.config().removeDomainFromList(args[0]);
    return '';
  });
}
