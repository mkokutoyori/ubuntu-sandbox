import { describe, it, expect } from 'vitest';
import { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import {
  parseMailArgs, buildMailMessage, sendMail, parseMailbox, formatMailboxSummary, MailComposeSession,
  type MailCommandDeps,
} from '@/network/devices/linux/commands/net/mail/MailCommand';

describe('MailCommand.ts argument parsing (objective 14)', () => {
  it('parses a recipient with -s subject', () => {
    const parsed = parseMailArgs(['-s', 'hello there', 'bob@example.org']);
    expect(parsed.recipients).toEqual(['bob@example.org']);
    expect(parsed.subject).toBe('hello there');
    expect(parsed.readMode).toBe(false);
  });

  it('parses multiple recipients', () => {
    const parsed = parseMailArgs(['bob@example.org', 'carol@example.org']);
    expect(parsed.recipients).toEqual(['bob@example.org', 'carol@example.org']);
  });

  it('no recipients means read mode', () => {
    expect(parseMailArgs([]).readMode).toBe(true);
  });
});

describe('MailCommand.ts message building', () => {
  it('builds a message with a Subject: header', () => {
    const msg = buildMailMessage('hi there', 'body text');
    expect(msg).toContain('Subject: hi there');
    expect(msg).toContain('body text');
  });

  it('builds a message with no subject header when none given', () => {
    const msg = buildMailMessage(undefined, 'body text');
    expect(msg).not.toContain('Subject:');
    expect(msg).toContain('body text');
  });
});

function buildDeps(overrides: Partial<MailCommandDeps> = {}): { vfs: VirtualFileSystem; deps: MailCommandDeps } {
  const vfs = new VirtualFileSystem();
  const deps: MailCommandDeps = {
    vfs, hostname: 'mail.example.com', senderUser: 'alice', senderUid: 1000, senderGid: 1000,
    isLocalRecipient: (addr) => !addr.includes('@') || addr.endsWith('@mail.example.com'),
    ...overrides,
  };
  return { vfs, deps };
}

describe('sendMail() — non-interactive send (echo body | mail -s subject user)', () => {
  it('delivers to a local (bare-username) recipient in real mbox format', () => {
    const { vfs, deps } = buildDeps();
    const result = sendMail(deps, ['bob'], 'hi', 'hello bob');
    expect(result.delivered).toEqual(['bob']);
    const mailbox = vfs.readFile('/var/mail/bob');
    expect(mailbox).toContain('hello bob');
    expect(mailbox).toContain('Subject: hi');
    expect(mailbox).toMatch(/^From alice@mail\.example\.com /);
  });

  it('queues (via the relay hook) a remote recipient instead of delivering locally', () => {
    const relayed: Array<{ recipient: string; from: string; message: string }> = [];
    const { deps } = buildDeps({
      isLocalRecipient: () => false,
      relay: (recipient, from, message) => { relayed.push({ recipient, from, message }); },
    });
    const result = sendMail(deps, ['bob@remote.example'], 'hi', 'hello bob');
    expect(result.queued).toEqual(['bob@remote.example']);
    expect(result.delivered).toEqual([]);
    expect(relayed).toHaveLength(1);
    expect(relayed[0].recipient).toBe('bob@remote.example');
  });

  it('sends to multiple recipients in one call', () => {
    const { vfs, deps } = buildDeps();
    sendMail(deps, ['bob', 'carol'], 'team update', 'hi team');
    expect(vfs.readFile('/var/mail/bob')).toContain('hi team');
    expect(vfs.readFile('/var/mail/carol')).toContain('hi team');
  });
});

describe('parseMailbox()/formatMailboxSummary() — reading local mail', () => {
  it('reports no mail for an empty mailbox', () => {
    expect(formatMailboxSummary(parseMailbox(''))).toBe('No mail for user');
  });

  it('parses a mailbox with a single delivered message', () => {
    const { vfs, deps } = buildDeps();
    sendMail(deps, ['bob'], 'hi', 'hello bob');
    const raw = vfs.readFile('/var/mail/bob')!;
    const messages = parseMailbox(raw);
    expect(messages).toHaveLength(1);
    expect(messages[0].from).toBe('alice@mail.example.com');
    expect(messages[0].headers.get('Subject')).toBe('hi');
    expect(messages[0].body).toContain('hello bob');
  });

  it('parses a mailbox with multiple messages in order', () => {
    const { vfs, deps } = buildDeps();
    sendMail(deps, ['bob'], 'first', 'first body');
    sendMail(deps, ['bob'], 'second', 'second body');
    const messages = parseMailbox(vfs.readFile('/var/mail/bob')!);
    expect(messages).toHaveLength(2);
    expect(messages[0].headers.get('Subject')).toBe('first');
    expect(messages[1].headers.get('Subject')).toBe('second');
  });

  it('formats a summary listing with message count and headers', () => {
    const { vfs, deps } = buildDeps();
    sendMail(deps, ['bob'], 'hi', 'hello bob');
    const summary = formatMailboxSummary(parseMailbox(vfs.readFile('/var/mail/bob')!));
    expect(summary).toContain('1 message');
    expect(summary).toContain('"hi"');
  });
});

describe('MailComposeSession — interactive mode (To:/Subject: prompts, body ends with a lone dot)', () => {
  it('prompts for To: then Subject: then collects the body until a lone dot', () => {
    const session = new MailComposeSession();
    expect(session.currentPrompt()).toBe('To: ');
    session.submitLine('bob@example.org');
    expect(session.currentPrompt()).toBe('Subject: ');
    session.submitLine('hello');
    expect(session.currentPrompt()).toBeNull();
    expect(session.isDone()).toBe(false);

    session.submitLine('line one');
    session.submitLine('line two');
    expect(session.isDone()).toBe(false);
    session.submitLine('.');
    expect(session.isDone()).toBe(true);

    expect(session.to).toEqual(['bob@example.org']);
    expect(session.subject).toBe('hello');
    expect(session.body()).toBe('line one\r\nline two');
  });

  it('skips the To:/Subject: prompts when both are already provided (mail -s "x" user)', () => {
    const session = new MailComposeSession('bob@example.org', 'already set');
    expect(session.currentPrompt()).toBeNull();
    session.submitLine('body text');
    session.submitLine('.');
    expect(session.isDone()).toBe(true);
    expect(session.body()).toBe('body text');
  });

  it('splits multiple To: addresses on commas/whitespace', () => {
    const session = new MailComposeSession();
    session.submitLine('bob@example.org, carol@example.org');
    expect(session.to).toEqual(['bob@example.org', 'carol@example.org']);
  });
});
