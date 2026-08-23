import type { MailboxStore } from './MailboxStore';
import type { DistributionGroupStore, DistributionGroupType } from './DistributionGroupStore';

export type GalEntryKind = 'Mailbox' | DistributionGroupType;

export interface GalEntry {
  readonly displayName: string;
  readonly samAccountName: string;
  readonly primarySmtpAddress: string;
  readonly kind: GalEntryKind;
}

export function buildGlobalAddressList(mailboxes: MailboxStore, groups: DistributionGroupStore): GalEntry[] {
  const mailboxEntries: GalEntry[] = mailboxes.list().map((m) => ({
    displayName: m.adIdentity, samAccountName: m.adIdentity, primarySmtpAddress: m.primarySmtpAddress, kind: 'Mailbox',
  }));
  const groupEntries: GalEntry[] = groups.list().map((g) => ({
    displayName: g.adGroupSam, samAccountName: g.adGroupSam, primarySmtpAddress: g.primarySmtpAddress,
    kind: g.type,
  }));
  return [...mailboxEntries, ...groupEntries];
}

export type GalResolution =
  | { readonly kind: 'literal-address'; readonly address: string }
  | { readonly kind: 'resolved'; readonly entry: GalEntry }
  | { readonly kind: 'ambiguous'; readonly matches: readonly GalEntry[] }
  | { readonly kind: 'not-found' };

export function resolveGalRecipient(query: string, entries: readonly GalEntry[]): GalResolution {
  if (query.includes('@')) return { kind: 'literal-address', address: query };
  const matches = entries.filter(
    (e) => e.samAccountName.toLowerCase() === query.toLowerCase() || e.displayName.toLowerCase() === query.toLowerCase(),
  );
  if (matches.length === 0) return { kind: 'not-found' };
  if (matches.length > 1) return { kind: 'ambiguous', matches };
  return { kind: 'resolved', entry: matches[0] };
}
