import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import type { ISubShell, SubShellResult } from '@/terminal/subshells/ISubShell';
import { IPAddress } from '@/network/core/types';
import { DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import type { TsigKey } from '@/network/dns/tsig/Tsig';
import type { DnsUpdateSender } from '@/network/devices/linux/commands/net/DnsUpdateSender';
import {
  parseNsupdateLine, emptyNsupdateScript, nsupdateRequest, nsupdateRcodeName,
  type NsupdateScript,
} from '@/network/dns/update/NsupdateScript';

const PROMPT = '> ';

export interface NsupdateSubShellDeps {
  readonly send: DnsUpdateSender;
  readonly resolve: (name: string) => Promise<IPAddress | null>;
  readonly key?: TsigKey;
}

function reply(output: string[], exit = false): SubShellResult {
  return { output, exit, prompt: exit ? '' : PROMPT };
}

export class NsupdateSubShell implements ISubShell {
  readonly kind = 'nsupdate';
  readonly connection = 'subshell' as const;

  private script: NsupdateScript = emptyNsupdateScript();
  private lastRcode: number | null = null;

  constructor(private readonly deps: NsupdateSubShellDeps) {}

  getPrompt(): string { return PROMPT; }

  handleKey(e: KeyEvent): boolean {
    return e.key === 'd' && e.ctrlKey;
  }

  private pendingLines(): string[] {
    const lines: string[] = [];
    for (const p of this.script.prerequisites) lines.push(`prereq ${p.kind}`);
    for (const u of this.script.updates) lines.push(`update ${u.kind}`);
    return lines.length > 0 ? lines : ['(nothing to send)'];
  }

  private async send(): Promise<SubShellResult> {
    if (this.script.updates.length === 0 && this.script.prerequisites.length === 0) {
      return reply(['']);
    }
    if (!this.script.server) {
      return reply(['nsupdate: no server given and this build does not guess one']);
    }
    const request = nsupdateRequest(this.script);
    if (!request) return reply(['nsupdate: could not determine the zone to update']);

    const serverIP = IPAddress.tryParse(this.script.server)
      ?? await this.deps.resolve(this.script.server);
    if (!serverIP) {
      return reply([`nsupdate: couldn't get address for '${this.script.server}'`]);
    }

    const outcome = await this.deps.send(serverIP, request, this.deps.key);
    const server = this.script.server;
    this.script = emptyNsupdateScript();
    this.script.server = server;

    if (!outcome.answered) {
      this.lastRcode = null;
      return reply(['nsupdate: no answer from the server']);
    }
    this.lastRcode = outcome.rcode;
    if (outcome.rcode === DnsRcode.NOERROR) return reply(['']);
    return reply([`update failed: ${nsupdateRcodeName(outcome.rcode)}`]);
  }

  processLine(line: string): SubShellResult | Promise<SubShellResult> {
    const trimmed = line.trim();
    if (trimmed.length === 0) return reply(['']);

    const verb = trimmed.split(/\s+/)[0].toLowerCase();
    if (verb === 'quit' || verb === 'exit') return { output: [''], exit: true, prompt: '' };
    if (verb === 'send') return this.send();
    if (verb === 'show') return reply(this.pendingLines());
    if (verb === 'answer') {
      return reply([this.lastRcode === null
        ? '(no answer yet)'
        : `rcode ${nsupdateRcodeName(this.lastRcode)}`]);
    }

    const error = parseNsupdateLine(trimmed, this.script);
    return reply(error ? [error] : ['']);
  }

  dispose(): void {
    this.script = emptyNsupdateScript();
  }
}
