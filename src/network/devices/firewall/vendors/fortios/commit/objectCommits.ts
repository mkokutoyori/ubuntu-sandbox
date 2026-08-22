import { vipAddress } from '../../../model/AddressObject';
import { proxyOwnerKey, type Firewall } from '../../../Firewall';
import type {
  CategoryFilterEntry, FilterTable, UrlFilterEntry, UtmAction,
} from '../../../inspection/UtmProfiles';
import type {
  FortiCategoryFilterPatch, FortiCentralSnatPatch, FortiFilterTablePatch,
  FortiUrlFilterPatch, FortiVipPatch, FortiFqdnVipPatch,
} from '../schema/types';

export function utmAction(declared: string): UtmAction {
  if (declared === 'block') return 'block';
  if (declared === 'monitor' || declared === 'log-only') return 'monitor';
  return 'allow';
}

export function urlEntry(entry: FortiUrlFilterPatch): UrlFilterEntry {
  return {
    id: entry.id,
    pattern: entry.pattern,
    type: entry.type === 'wildcard' || entry.type === 'regex' ? entry.type : 'simple',
    action: utmAction(entry.action),
  };
}

export function filterTable(table: FortiFilterTablePatch): FilterTable {
  return {
    id: table.id,
    name: table.name,
    entries: table.entries.filter(entry => entry.enabled).map(urlEntry),
    comment: table.comment,
  };
}

export function categoryEntry(entry: FortiCategoryFilterPatch): CategoryFilterEntry {
  return { id: entry.id, category: entry.category, action: utmAction(entry.action) };
}

export function vipRuleId(name: string): string {
  return `vip:${name}`;
}

export function centralSnatRuleId(id: string): string {
  return `csnat:${id}`;
}

export function applyFqdnVipToFirewall(
  fw: Firewall, vip: FortiFqdnVipPatch,
): string | void {
  const object = fw.getObjectStore().getAddress(vip.mappedAddressObject);
  if (!object) return `unknown address ${vip.mappedAddressObject}.`;
  if (object.kind !== 'fqdn' || object.fqdn === undefined) {
    return `${vip.mappedAddressObject} is not a fqdn address object.`;
  }

  const fqdn = object.fqdn;
  fw.bindFqdnVip(vip.name, () => {
    const resolved = fw.getDnsClient().resolve(fqdn)[0];
    if (resolved === undefined) return;

    applyVipToFirewall(fw, {
      name: vip.name,
      externalAddress: vip.externalAddress,
      externalEndAddress: vip.externalEndAddress,
      mappedAddress: resolved,
      externalInterfaces: vip.externalInterfaces,
      sourceFilters: vip.sourceFilters,
      arpReply: vip.arpReply,
      portForward: false,
      protocol: 0,
      externalPortFrom: 0,
      externalPortTo: 0,
      mappedPort: 0,
      natSourceVip: false,
      comment: vip.comment,
    });
  });
}

export function applyVipToFirewall(fw: Firewall, vip: FortiVipPatch): void {
  const interfaces = vip.externalInterfaces.filter(name => name !== 'any');

  fw.getNatPolicy().upsert({
    id: vipRuleId(vip.name),
    type: 'static',
    name: vip.name,
    fromZone: interfaces.length > 0 ? [...interfaces] : ['any'],
    originalSource: vip.sourceFilters.length > 0 ? [...vip.sourceFilters] : ['any'],
    originalDestination: [vip.externalAddress],
    originalPort: vip.portForward
      ? {
        protocol: vip.protocol,
        from: vip.externalPortFrom,
        to: vip.externalPortTo === 0 ? vip.externalPortFrom : vip.externalPortTo,
      }
      : undefined,
    destinationTranslation: {
      kind: 'static-ip',
      translatedAddress: vip.mappedAddress,
      translatedEndAddress: vip.mappedEndAddress,
      translatedPort: vip.portForward && vip.mappedPort > 0 ? vip.mappedPort : undefined,
    },
    comment: vip.comment,
  });

  fw.getObjectStore().upsertAddress(
    vipAddress(vip.name, vip.mappedAddress, vipRuleId(vip.name), vip.mappedEndAddress));

  const owner = proxyOwnerKey('vip', vip.name);
  if (!vip.arpReply) { fw.clearProxyArpEntries(owner); return; }

  fw.setProxyArpEntries(owner, interfaces.length === 0
    ? [{ from: vip.externalAddress, to: vip.externalEndAddress }]
    : interfaces.map(iface => ({
      from: vip.externalAddress, to: vip.externalEndAddress, iface,
    })));
}

export function applyCentralSnatToFirewall(fw: Firewall, entry: FortiCentralSnatPatch): void {
  fw.getNatPolicy().upsert({
    id: centralSnatRuleId(entry.id),
    type: entry.translate ? 'dynamic-pat' : 'no-nat',
    enabled: entry.enabled,
    fromZone: listOrAny(entry.sourceInterfaces),
    toZone: listOrAny(entry.destinationInterfaces),
    originalSource: listOrAny(entry.originalAddresses),
    originalDestination: listOrAny(entry.destinationAddresses),
    sourcePort: entry.sourcePortFrom > 0
      ? {
        protocol: entry.protocol,
        from: entry.sourcePortFrom,
        to: entry.sourcePortTo === 0 ? entry.sourcePortFrom : entry.sourcePortTo,
      }
      : undefined,
    noTranslation: !entry.translate,
    sourceTranslation: entry.translate
      ? {
        kind: 'dynamic-ip-and-port',
        pool: entry.pool,
        fallbackToInterface: entry.pool === undefined,
        translatedPortFrom: entry.translatedPortFrom,
        translatedPortTo: entry.translatedPortTo,
      }
      : undefined,
    comment: entry.comment,
  }, entry.position);
}

function listOrAny(values: readonly string[]): string[] {
  const cleaned = values.filter(value => value !== 'any' && value !== 'all');
  return cleaned.length > 0 ? cleaned : ['any'];
}
