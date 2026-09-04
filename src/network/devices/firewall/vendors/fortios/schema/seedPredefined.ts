import type { AddressObject } from '../../../model/AddressObject';
import type { ServiceEntry, ServiceObject } from '../../../model/ServiceObject';
import type { FortiConfigTree } from '../runtime/FortiConfigTree';
import { FIREWALL_ADDRESS, FIREWALL_ADDRESS6, FIREWALL_SERVICE_CUSTOM } from './firewallObjects';
import { PREDEFINED_ADDRESSES, PREDEFINED_SERVICES } from './predefined';

function portRanges(entries: readonly ServiceEntry[], protocol: string): string[] {
  return entries
    .filter(entry => entry.protocol === protocol)
    .flatMap(entry => entry.destinationPorts ?? [])
    .map(range => (range.from === range.to ? `${range.from}` : `${range.from}-${range.to}`));
}

function serviceSettings(service: ServiceObject): Array<[string, string[]]> {
  const icmp = service.entries.find(entry => entry.protocol === 'icmp');
  if (icmp) {
    const settings: Array<[string, string[]]> = [['protocol', ['ICMP']]];
    if (icmp.icmpType !== undefined) settings.push(['icmptype', [String(icmp.icmpType)]]);
    if (icmp.icmpCode !== undefined) settings.push(['icmpcode', [String(icmp.icmpCode)]]);
    return settings;
  }

  const ip = service.entries.find(entry => entry.protocol === 'ip');
  if (ip) {
    return [
      ['protocol', ['IP']],
      ['protocol-number', [String(ip.ipProtocolNumber ?? 0)]],
    ];
  }

  const settings: Array<[string, string[]]> = [];
  const tcp = portRanges(service.entries, 'tcp');
  const udp = portRanges(service.entries, 'udp');
  if (tcp.length > 0) settings.push(['tcp-portrange', tcp]);
  if (udp.length > 0) settings.push(['udp-portrange', udp]);
  return settings;
}

function addressSettings(object: AddressObject): Array<[string, string[]]> {
  if (object.family === 'ipv6') return [['type', ['ipprefix']], ['ip6', ['::/0']]];
  return [['type', ['ipmask']], ['subnet', ['0.0.0.0', '0.0.0.0']]];
}

export function seedPredefinedConfig(tree: FortiConfigTree): void {
  for (const service of PREDEFINED_SERVICES) {
    const object = tree.table(FIREWALL_SERVICE_CUSTOM).ensure(service.name);
    for (const [name, values] of serviceSettings(service)) object.set(name, values);
  }

  for (const address of PREDEFINED_ADDRESSES) {
    const spec = address.family === 'ipv6' ? FIREWALL_ADDRESS6 : FIREWALL_ADDRESS;
    const object = tree.table(spec).ensure(address.name);
    for (const [name, values] of addressSettings(address)) object.set(name, values);
  }
}
