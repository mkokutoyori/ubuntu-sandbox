import { DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import { rcodeFromWire, ptrQName, isIpLiteral } from '@/network/dns/compat/DnsWireCompat';
import type { DnsQueryFn } from '@/network/dns/compat/DnsWireCompat';
import type { NslookupInterpreter, NslookupReply } from '@/network/dns/tools/NslookupInterpreter';
import { isDisplayableRecord, formatAnswerLines } from './RecordFormat';

export interface BindNslookupDeps {
  readonly query: DnsQueryFn;
  readonly initialServer: string;
}

export class BindNslookupInterpreter implements NslookupInterpreter {
  private server: string;
  private qtype = 'A';

  constructor(private readonly deps: BindNslookupDeps) {
    this.server = deps.initialServer;
  }

  async bannerLines(): Promise<string[]> {
    return this.serverBannerLines();
  }

  async interpret(line: string): Promise<NslookupReply> {
    const trimmed = line.trim();
    if (!trimmed) return reply(['']);

    const lower = trimmed.toLowerCase();
    if (lower === 'exit' || lower === 'quit') return { lines: [], exit: true };

    const setMatch = /^set\s+(\S+)$/i.exec(trimmed);
    if (setMatch) return reply(this.handleSet(setMatch[1]));

    const serverMatch = /^(?:server|lserver)\s+(\S+)$/i.exec(trimmed);
    if (serverMatch) {
      this.server = serverMatch[1];
      return reply(this.serverBannerLines());
    }

    return reply(await this.lookup(trimmed));
  }

  private serverBannerLines(): string[] {
    return [`Default Server:  ${this.server}`, `Address:  ${this.server}#53`, ''];
  }

  private handleSet(assignment: string): string[] {
    const eq = assignment.indexOf('=');
    if (eq === -1) return [`*** Invalid option: ${assignment}`];
    const key = assignment.slice(0, eq).toLowerCase();
    const value = assignment.slice(eq + 1);
    if (key === 'type' || key === 'querytype' || key === 'q') {
      this.qtype = value.toUpperCase();
      return [];
    }
    return [`*** Invalid option: ${assignment}`];
  }

  private async lookup(domain: string): Promise<string[]> {
    if (!this.server) return [`*** Can't find server name for address : Timed out`];
    const reverse = isIpLiteral(domain);
    const message = await this.deps.query(this.server, domain, reverse ? 'PTR' : this.qtype);
    if (!message) return [';; connection timed out; no servers could be reached'];

    if (message.flags.rcode !== DnsRcode.NOERROR) {
      return [`** server can't find ${reverse ? ptrQName(domain) : domain}: ${rcodeFromWire(message.flags.rcode)}`];
    }
    const records = message.answers.filter(isDisplayableRecord);
    const lines: string[] = [];
    if (!message.flags.aa && records.length > 0) lines.push('Non-authoritative answer:');
    lines.push(...formatAnswerLines(reverse ? ptrQName(domain) : domain, records));
    return lines;
  }
}

function reply(lines: string[]): NslookupReply {
  return { lines, exit: false };
}
