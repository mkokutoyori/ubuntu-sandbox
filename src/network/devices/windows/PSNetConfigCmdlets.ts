import type { Port } from '../../hardware/Port';
import { toDisplayName } from './WindowsInterfaceNaming';
import { parsePSArgs } from './psArgs';

export interface PSNetConfigContext {
  ports: Map<string, Port>;
  getDnsServers: (ifName: string) => string[];
  setDnsServers?: (ifName: string, servers: string[]) => void;
  networkProfiles: Map<number, string>;
}

export function psGetDnsClientServerAddress(ctx: PSNetConfigContext, args: string[]): string {
  const params = parsePSArgs(args);
  const ifFilter = (params.get('interfacealias') ?? params.get('_positional') ?? '').replace(/^["']|["']$/g, '').toLowerCase();
  const afFilter = (params.get('addressfamily') ?? '').toLowerCase();

  const lines: string[] = ['', 'InterfaceAlias               ServerAddresses', '--------------               ---------------'];
  let found = false;

  for (const [name] of ctx.ports) {
    const displayName = toDisplayName(name);
    if (ifFilter && !displayName.toLowerCase().includes(ifFilter) && displayName.toLowerCase() !== ifFilter) continue;
    if (afFilter === 'ipv6') continue;
    const servers = ctx.getDnsServers(name);
    lines.push(`${displayName.padEnd(29)}${servers.join(', ')}`);
    found = true;
  }

  if (!found && ifFilter) {
    return `Get-DnsClientServerAddress : Interface '${ifFilter}' not found. No MSFT_DnsClientServerAddress objects found matching the specified interface.`;
  }

  return lines.join('\n');
}

export function psSetDnsClientServerAddress(ctx: PSNetConfigContext, args: string[]): string {
  const params = parsePSArgs(args);
  const ifAlias = (params.get('interfacealias') ?? params.get('_positional') ?? '').replace(/^["']|["']$/g, '');
  const serversRaw = (params.get('serveraddresses') ?? '').replace(/^["']|["']$/g, '');
  const reset = params.has('resetserveraddresses');

  if (!ifAlias) {
    return `Set-DnsClientServerAddress : The -InterfaceAlias parameter is mandatory.\nAt line:1 char:1\n    + CategoryInfo          : InvalidArgument`;
  }

  let matchedName = '';
  for (const [name] of ctx.ports) {
    const dn = toDisplayName(name).toLowerCase();
    const af = ifAlias.toLowerCase();
    if (dn === af || name.toLowerCase() === af || dn.includes(af) || dn.startsWith(af)) {
      matchedName = name;
      break;
    }
  }

  if (!matchedName) {
    return `Set-DnsClientServerAddress : Interface '${ifAlias}' not found.`;
  }

  if (reset) {
    ctx.setDnsServers?.(matchedName, []);
    return '';
  }

  const cleanRaw = serversRaw.replace(/^\(|\)$/g, '');
  const servers = cleanRaw.split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  ctx.setDnsServers?.(matchedName, servers);
  return '';
}

export function psGetNetConnectionProfile(ctx: PSNetConfigContext, args: string[]): string {
  const params = parsePSArgs(args);
  const ifIndexParam = params.get('interfaceindex');
  const ifAlias = params.get('interfacealias')?.replace(/^["']|["']$/g, '');

  const ifIndex = ifIndexParam ? parseInt(ifIndexParam, 10) : 2;
  const category = ctx.networkProfiles.get(ifIndex) ?? 'DomainAuthenticated';

  let adapterName = 'Ethernet';
  let portIdx = 2;
  for (const [name] of ctx.ports) {
    if (portIdx === ifIndex) { adapterName = toDisplayName(name); break; }
    portIdx++;
  }
  if (ifAlias) adapterName = ifAlias;

  return [
    `Name             : ${adapterName}`,
    `InterfaceAlias   : ${adapterName}`,
    `InterfaceIndex   : ${ifIndex}`,
    `NetworkCategory  : ${category}`,
    `IPv4Connectivity : Internet`,
    `IPv6Connectivity : LocalNetwork`,
  ].join('\n');
}

export function psSetNetConnectionProfile(ctx: PSNetConfigContext, args: string[]): string {
  const params = parsePSArgs(args);
  const ifIndexParam = params.get('interfaceindex');
  const category = params.get('networkcategory')?.replace(/^["']|["']$/g, '');
  if (!category) return '';
  const ifIndex = ifIndexParam ? parseInt(ifIndexParam, 10) : 2;
  ctx.networkProfiles.set(ifIndex, category);
  return '';
}
