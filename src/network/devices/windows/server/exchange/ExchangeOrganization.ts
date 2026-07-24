import { MailboxStore } from './MailboxStore';
import { DistributionGroupStore } from './DistributionGroupStore';

export interface ExchangeServerRecord {
  readonly hostname: string;
  readonly roles: ReadonlySet<string>;
  readonly installedAt: number;
}

export interface ExchangeOrganization {
  readonly name: string;
  readonly servers: Map<string, ExchangeServerRecord>;
  readonly mailboxes: MailboxStore;
  readonly distributionGroups: DistributionGroupStore;
}

const organizations = new Map<string, ExchangeOrganization>();

export function resetExchangeOrganizations(): void {
  organizations.clear();
}

export function getExchangeOrganization(name: string): ExchangeOrganization | undefined {
  return organizations.get(name);
}

export function getOrCreateExchangeOrganization(name: string): ExchangeOrganization {
  let org = organizations.get(name);
  if (!org) {
    org = { name, servers: new Map(), mailboxes: new MailboxStore(), distributionGroups: new DistributionGroupStore() };
    organizations.set(name, org);
  }
  return org;
}
