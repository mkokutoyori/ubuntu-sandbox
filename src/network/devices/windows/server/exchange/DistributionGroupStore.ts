import type { Mailbox, MailboxStore, DeliverResult } from './MailboxStore';

export type DistributionGroupType = 'Distribution' | 'SecurityMailEnabled';

export interface DistributionGroupExtension {
  readonly adGroupSam: string;
  readonly type: DistributionGroupType;
  primarySmtpAddress: string;
}

export interface DistributionGroupOpResult { ok: boolean; message: string }

export class DistributionGroupStore {
  private readonly byGroupSam = new Map<string, DistributionGroupExtension>();
  private readonly byAddress = new Map<string, string>();

  mailEnable(adGroupSam: string, primarySmtpAddress: string, type: DistributionGroupType): DistributionGroupOpResult {
    const key = adGroupSam.toLowerCase();
    if (this.byGroupSam.has(key)) {
      return { ok: false, message: `New-DistributionGroup : '${adGroupSam}' is already a mail-enabled group.` };
    }
    const addrKey = primarySmtpAddress.toLowerCase();
    if (this.byAddress.has(addrKey)) {
      return { ok: false, message: `New-DistributionGroup : The proxy address "smtp:${primarySmtpAddress}" is already being used by another recipient.` };
    }
    this.byGroupSam.set(key, { adGroupSam, type, primarySmtpAddress });
    this.byAddress.set(addrKey, key);
    return { ok: true, message: '' };
  }

  get(adGroupSam: string): DistributionGroupExtension | null {
    return this.byGroupSam.get(adGroupSam.toLowerCase()) ?? null;
  }

  getByAddress(address: string): DistributionGroupExtension | null {
    const key = this.byAddress.get(address.toLowerCase());
    return key ? this.byGroupSam.get(key) ?? null : null;
  }

  list(): DistributionGroupExtension[] {
    return [...this.byGroupSam.values()];
  }

  setPrimarySmtpAddress(adGroupSam: string, address: string): DistributionGroupOpResult {
    const group = this.byGroupSam.get(adGroupSam.toLowerCase());
    if (!group) {
      return { ok: false, message: `Set-DistributionGroup : The operation couldn't be performed because object '${adGroupSam}' couldn't be found.` };
    }
    const addrKey = address.toLowerCase();
    if (this.byAddress.has(addrKey) && this.byAddress.get(addrKey) !== adGroupSam.toLowerCase()) {
      return { ok: false, message: `Set-DistributionGroup : The proxy address "smtp:${address}" is already being used by another recipient.` };
    }
    this.byAddress.delete(group.primarySmtpAddress.toLowerCase());
    group.primarySmtpAddress = address;
    this.byAddress.set(addrKey, adGroupSam.toLowerCase());
    return { ok: true, message: '' };
  }
}

export function resolveGroupRecipients(members: readonly string[], mailboxStore: MailboxStore): string[] {
  return members
    .map((sam): Mailbox | null => mailboxStore.get(sam))
    .filter((mailbox): mailbox is Mailbox => mailbox !== null)
    .map((mailbox) => mailbox.primarySmtpAddress);
}

export function deliverExpanded(
  groupStore: DistributionGroupStore,
  mailboxStore: MailboxStore,
  groupMembersOf: (adGroupSam: string) => readonly string[],
  recipientAddress: string,
  from: string,
  subject: string,
  rawMessage: string,
  receivedAt: number,
): DeliverResult[] {
  const group = groupStore.getByAddress(recipientAddress);
  if (!group) return [mailboxStore.deliver(recipientAddress, from, subject, rawMessage, receivedAt)];
  const memberAddresses = resolveGroupRecipients(groupMembersOf(group.adGroupSam), mailboxStore);
  return memberAddresses.map((addr) => mailboxStore.deliver(addr, from, subject, rawMessage, receivedAt));
}
