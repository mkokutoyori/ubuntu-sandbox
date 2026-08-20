import { deliverLocalMessage, resolveLocalPart, type MailDropFileSystem } from '@/network/smtp/localDelivery';
import { splitHeadersAndBody } from '@/network/smtp/envelope';

const CRLF = '\r\n';

export interface ParsedMailArgs {
  readonly recipients: readonly string[];
  readonly subject?: string;
  readonly readMode: boolean;
}

export function parseMailArgs(args: readonly string[]): ParsedMailArgs {
  const recipients: string[] = [];
  let subject: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-s') { subject = args[++i]; continue; }
    if (!args[i].startsWith('-')) recipients.push(args[i]);
  }
  return { recipients, subject, readMode: recipients.length === 0 };
}

export function buildMailMessage(subject: string | undefined, body: string): string {
  const headerLine = subject !== undefined ? `Subject: ${subject}${CRLF}` : '';
  return `${headerLine}${CRLF}${body}`;
}

export interface MailCommandDeps {
  readonly vfs: MailDropFileSystem;
  readonly hostname: string;
  readonly senderUser: string;
  readonly senderUid: number;
  readonly senderGid: number;
  readonly isLocalRecipient: (address: string) => boolean;
  readonly resolveRecipientOwner?: (localPart: string) => { uid: number; gid: number } | undefined;
  readonly relay?: (recipient: string, envelopeFrom: string, rawMessage: string) => void;
}

export interface SendMailResult {
  readonly delivered: readonly string[];
  readonly queued: readonly string[];
}

export function sendMail(
  deps: MailCommandDeps,
  recipients: readonly string[],
  subject: string | undefined,
  body: string,
): SendMailResult {
  const envelopeFrom = deps.senderUser.includes('@') ? deps.senderUser : `${deps.senderUser}@${deps.hostname}`;
  const rawMessage = buildMailMessage(subject, body);
  const delivered: string[] = [];
  const queued: string[] = [];
  for (const recipient of recipients) {
    if (deps.isLocalRecipient(recipient)) {
      const owner = deps.resolveRecipientOwner?.(resolveLocalPart(recipient)) ?? { uid: deps.senderUid, gid: deps.senderGid };
      deliverLocalMessage(deps.vfs, recipient, { envelopeFrom, receivedAt: Date.now(), rawMessage }, owner);
      delivered.push(recipient);
    } else if (deps.relay) {
      deps.relay(recipient, envelopeFrom, rawMessage);
      queued.push(recipient);
    } else {
      queued.push(recipient);
    }
  }
  return { delivered, queued };
}

export interface MailboxMessage {
  readonly index: number;
  readonly from: string;
  readonly date: string;
  readonly headers: ReadonlyMap<string, string>;
  readonly body: string;
}

export function parseMailbox(raw: string): MailboxMessage[] {
  // Même raison que `splitHeadersAndBody` : le fichier mbox du disque est
  // en LF, le fil SMTP en CRLF, et le lecteur doit lire les deux.
  const lines = raw.split(/\r\n|\n/);
  const messages: MailboxMessage[] = [];
  let current: string[] | null = null;
  let fromLine = '';

  const flush = (): void => {
    if (current === null) return;
    while (current.length > 0 && current[current.length - 1] === '') current.pop();
    const { headers, body } = splitHeadersAndBody(current.join('\n'));
    const m = /^From (\S*)\s*(.*)$/.exec(fromLine);
    messages.push({ index: messages.length + 1, from: m ? m[1] : '', date: m ? m[2] : '', headers, body });
  };

  for (const line of lines) {
    if (/^From \S/.test(line) || /^From $/.test(line)) {
      flush();
      fromLine = line;
      current = [];
    } else if (current !== null) {
      current.push(line);
    }
  }
  flush();
  return messages;
}

export function formatMailboxSummary(messages: readonly MailboxMessage[]): string {
  if (messages.length === 0) return 'No mail for user';
  const lines = [messages.length === 1 ? '1 message' : `${messages.length} messages`];
  for (const m of messages) {
    const subject = m.headers.get('Subject') ?? '(no subject)';
    lines.push(`${m.index}  ${m.from}  ${m.date}  "${subject}"`);
  }
  return lines.join(CRLF);
}

export type MailComposeStep = 'to' | 'subject' | 'body' | 'done';

export class MailComposeSession {
  to: string[];
  subject: string;
  private step: MailComposeStep;
  private bodyLines: string[] = [];

  constructor(initialTo?: string, initialSubject?: string) {
    this.to = initialTo ? [initialTo] : [];
    this.subject = initialSubject ?? '';
    this.step = this.to.length === 0 ? 'to' : this.subject !== '' || initialSubject !== undefined ? 'body' : 'subject';
  }

  currentPrompt(): string | null {
    if (this.step === 'to') return 'To: ';
    if (this.step === 'subject') return 'Subject: ';
    return null;
  }

  isDone(): boolean {
    return this.step === 'done';
  }

  submitLine(line: string): void {
    if (this.step === 'to') {
      this.to = line.split(/[,\s]+/).filter((s) => s.length > 0);
      this.step = 'subject';
      return;
    }
    if (this.step === 'subject') {
      this.subject = line;
      this.step = 'body';
      return;
    }
    if (this.step === 'body') {
      if (line === '.') { this.step = 'done'; return; }
      this.bodyLines.push(line);
    }
  }

  body(): string {
    return this.bodyLines.join(CRLF);
  }
}
