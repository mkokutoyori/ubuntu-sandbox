export type MailFolderName = 'Inbox' | 'Sent Items' | 'Drafts' | 'Deleted Items' | 'Junk Email';

export const MAIL_FOLDER_NAMES: readonly MailFolderName[] = ['Inbox', 'Sent Items', 'Drafts', 'Deleted Items', 'Junk Email'];

export interface StoredMailItem {
  readonly id: string;
  readonly from: string;
  readonly to: readonly string[];
  readonly subject: string;
  readonly receivedAt: number;
  read: boolean;
  readonly sizeBytes: number;
}

export interface Mailbox {
  readonly adIdentity: string;
  readonly primarySmtpAddress: string;
  readonly proxyAddresses: string[];
  quotaBytes: number | null;
  readonly folders: Record<MailFolderName, StoredMailItem[]>;
}

export interface MailboxOpResult { ok: boolean; message: string }

export type DeliverFailureReason = 'not-found' | 'quota-exceeded';
export interface DeliverResult { readonly delivered: boolean; readonly reason?: DeliverFailureReason }

function emptyFolders(): Record<MailFolderName, StoredMailItem[]> {
  return { Inbox: [], 'Sent Items': [], Drafts: [], 'Deleted Items': [], 'Junk Email': [] };
}

export class MailboxStore {
  private readonly byIdentity = new Map<string, Mailbox>();
  private readonly byAddress = new Map<string, string>();
  private nextItemId = 1;

  enable(adIdentity: string, primarySmtpAddress: string): MailboxOpResult {
    const key = adIdentity.toLowerCase();
    if (this.byIdentity.has(key)) {
      return { ok: false, message: `Enable-Mailbox : '${adIdentity}' is already mailbox-enabled.` };
    }
    const addrKey = primarySmtpAddress.toLowerCase();
    if (this.byAddress.has(addrKey)) {
      return { ok: false, message: `Enable-Mailbox : The proxy address "smtp:${primarySmtpAddress}" is already being used by another mailbox.` };
    }
    this.byIdentity.set(key, {
      adIdentity, primarySmtpAddress, proxyAddresses: [primarySmtpAddress], quotaBytes: null, folders: emptyFolders(),
    });
    this.byAddress.set(addrKey, key);
    return { ok: true, message: '' };
  }

  disable(adIdentity: string): MailboxOpResult {
    const key = adIdentity.toLowerCase();
    const mailbox = this.byIdentity.get(key);
    if (!mailbox) {
      return { ok: false, message: `Disable-Mailbox : The operation couldn't be performed because object '${adIdentity}' couldn't be found.` };
    }
    for (const addr of mailbox.proxyAddresses) this.byAddress.delete(addr.toLowerCase());
    this.byIdentity.delete(key);
    return { ok: true, message: '' };
  }

  get(adIdentity: string): Mailbox | null {
    return this.byIdentity.get(adIdentity.toLowerCase()) ?? null;
  }

  getByAddress(address: string): Mailbox | null {
    const key = this.byAddress.get(address.toLowerCase());
    return key ? this.byIdentity.get(key) ?? null : null;
  }

  list(): Mailbox[] {
    return [...this.byIdentity.values()];
  }

  setQuota(adIdentity: string, quotaBytes: number | null): MailboxOpResult {
    const mailbox = this.byIdentity.get(adIdentity.toLowerCase());
    if (!mailbox) {
      return { ok: false, message: `Set-Mailbox : The operation couldn't be performed because object '${adIdentity}' couldn't be found.` };
    }
    mailbox.quotaBytes = quotaBytes;
    return { ok: true, message: '' };
  }

  totalSizeBytes(mailbox: Mailbox): number {
    return MAIL_FOLDER_NAMES.reduce((sum, folder) => sum + mailbox.folders[folder].reduce((s, item) => s + item.sizeBytes, 0), 0);
  }

  totalItemCount(mailbox: Mailbox): number {
    return MAIL_FOLDER_NAMES.reduce((sum, folder) => sum + mailbox.folders[folder].length, 0);
  }

  deliver(recipientAddress: string, from: string, subject: string, rawMessage: string, receivedAt: number): DeliverResult {
    const mailbox = this.getByAddress(recipientAddress);
    if (!mailbox) return { delivered: false, reason: 'not-found' };
    const sizeBytes = rawMessage.length;
    if (mailbox.quotaBytes !== null && this.totalSizeBytes(mailbox) + sizeBytes > mailbox.quotaBytes) {
      return { delivered: false, reason: 'quota-exceeded' };
    }
    mailbox.folders.Inbox.push({
      id: `mail-${this.nextItemId++}`, from, to: [recipientAddress], subject, receivedAt, read: false, sizeBytes,
    });
    return { delivered: true };
  }
}
