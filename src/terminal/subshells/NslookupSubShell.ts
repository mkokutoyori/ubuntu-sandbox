/**
 * NslookupSubShell — interactive `nslookup` REPL (PRD-Nslookup-Dig-Rndc-Runas.md §2.1.1).
 *
 * Real `nslookup` invoked with no domain argument enters an interactive
 * mode: a bare `>` prompt accepting `server <host>`/`lserver <host>`,
 * `set type=<TYPE>`/`set querytype=<TYPE>`, `exit`/`quit`, and a bare name
 * to resolve with the current server/type. Shares the exact same query
 * transport and `nslookup`-style answer formatting
 * (`RecordFormat.ts#formatAnswerLines`) as the non-interactive command
 * (`NslookupRunner.ts`) — this is purely a REPL wrapper around it, not a
 * parallel reimplementation.
 */

import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import type { ISubShell, SubShellResult } from './ISubShell';
import type { DnsQueryFn } from '@/network/dns/compat/DnsWireCompat';
import { DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import { rcodeFromWire, ptrQName } from '@/network/dns/compat/DnsWireCompat';
import { isDisplayableRecord, formatAnswerLines } from '@/network/devices/linux/commands/dns/RecordFormat';

const IPV4_LITERAL = /^\d{1,3}(\.\d{1,3}){3}$/;

export interface NslookupSubShellDeps {
  readonly query: DnsQueryFn;
  readonly initialServer: string;
}

export class NslookupSubShell implements ISubShell {
  readonly kind = 'nslookup';
  readonly connection = 'subshell' as const;

  private server: string;
  private qtype = 'A';

  constructor(private readonly deps: NslookupSubShellDeps) {
    this.server = deps.initialServer;
  }

  /** Startup banner lines, printed once by the caller before the first prompt. */
  bannerLines(): string[] {
    return this.serverBannerLines();
  }

  getPrompt(): string {
    return '> ';
  }

  handleKey(e: KeyEvent): boolean {
    if (e.key === 'd' && e.ctrlKey) return true;
    return false;
  }

  async processLine(line: string): Promise<SubShellResult> {
    const trimmed = line.trim();
    if (!trimmed) return done(['']);

    const lower = trimmed.toLowerCase();
    if (lower === 'exit' || lower === 'quit') {
      return { output: [], exit: true, prompt: '' };
    }

    const setMatch = /^set\s+(\S+)$/i.exec(trimmed);
    if (setMatch) return done(this.handleSet(setMatch[1]));

    const serverMatch = /^(?:server|lserver)\s+(\S+)$/i.exec(trimmed);
    if (serverMatch) {
      this.server = serverMatch[1];
      return done(this.serverBannerLines());
    }

    return done(await this.lookup(trimmed));
  }

  dispose(): void {
    /* nothing to release: the query transport is owned by the host device. */
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
    const reverse = IPV4_LITERAL.test(domain);
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

function done(output: string[]): SubShellResult {
  return { output, exit: false, prompt: '> ' };
}
