import { DirectoryStore } from '../DirectoryStore';
import { createForest, joinForestAsChildDomain, type Forest } from './Forest';

export function registerStandInForest(source: Forest, excludedDomain: string): void {
  const root = source.getRootDomain();
  if (!root) return;
  const seed = new DirectoryStore(root.dnsName, root.netbiosName, 'stand-in');
  createForest(root.dnsName, root.netbiosName, seed.getSchemaValidatorForSharing(), source.functionalLevel);
  const excluded = excludedDomain.toLowerCase();
  for (const domain of source.listDomains()) {
    if (!domain.parentDnsName || domain.dnsName.toLowerCase() === excluded) continue;
    joinForestAsChildDomain(domain.parentDnsName, domain.dnsName, domain.netbiosName);
  }
}
