export const POSTFIX_SMTPD_COMMANDS: readonly string[] = [
  'helo', 'ehlo', 'xclient', 'xforward', 'starttls', 'auth', 'mail', 'rcpt', 'data', 'bdat',
  'rset', 'noop', 'vrfy', 'etrn', 'quit', 'help',
];

const UNKNOWN_COMMAND = 'unknown';

interface CommandCount {
  success: number;
  total: number;
}

export class SmtpCommandStats {
  private readonly counts = new Map<string, CommandCount>();

  private countOf(verb: string): CommandCount {
    const name = POSTFIX_SMTPD_COMMANDS.includes(verb) ? verb : UNKNOWN_COMMAND;
    let count = this.counts.get(name);
    if (count === undefined) {
      count = { success: 0, total: 0 };
      this.counts.set(name, count);
    }
    return count;
  }

  record(verb: string, replyCode: number): void {
    const count = this.countOf(verb.toLowerCase());
    count.total++;
    if (replyCode < 400) count.success++;
  }

  retract(verb: string): void {
    const count = this.countOf(verb.toLowerCase());
    if (count.success > 0) count.success--;
  }

  format(): string {
    let allSuccess = 0;
    let allTotal = 0;
    let text = '';
    for (const name of [...POSTFIX_SMTPD_COMMANDS, UNKNOWN_COMMAND]) {
      const count = this.counts.get(name);
      if (count === undefined || count.total === 0) continue;
      text += ` ${name}=${count.success}`;
      if (count.success !== count.total) text += `/${count.total}`;
      allSuccess += count.success;
      allTotal += count.total;
    }
    text += ` commands=${allSuccess}`;
    if (allSuccess !== allTotal || allTotal === 0) text += `/${allTotal}`;
    return text;
  }
}
