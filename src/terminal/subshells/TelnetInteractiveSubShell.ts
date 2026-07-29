/**
 * TelnetInteractiveSubShell — a telnet session driven from a terminal.
 *
 * Telnet has no channel layer and no authentication protocol of its own,
 * so this is far simpler than its SSH counterpart: it is a byte pipe.
 * Every line goes out as typed, and everything that comes back —
 * including the whole login dialog and the prompt — is the *remote*
 * device's own text, printed verbatim. Nothing here reconstructs what
 * the far end might have said.
 *
 * The one reconciliation needed: the server drives echo (it answered
 * `WILL ECHO`), while the host terminal already echoes the line the user
 * typed. The server's copy of that line is therefore dropped, or it would
 * appear twice.
 */

import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import type { ISubShell, SubShellResult } from './ISubShell';
import type { TelnetClientSession } from '@/network/protocols/telnet/TelnetClientSession';

/** How many event-loop turns to wait for a quiet wire before answering. */
const MAX_COLLECT_TICKS = 24;

export class TelnetInteractiveSubShell implements ISubShell {
  readonly kind = 'telnet';
  readonly connection = 'telnet' as const;
  private prompt = '';

  constructor(
    private readonly client: TelnetClientSession,
    private readonly host: string,
    private readonly onEnd?: () => void,
  ) {}

  getPrompt(): string { return this.prompt; }

  /** Ctrl+D closes the session, as it does on a real telnet client. */
  handleKey(e: KeyEvent): boolean {
    if (e.key !== 'd' || !e.ctrlKey) return false;
    this.client.close();
    return true;
  }

  /** The opening burst — banner, login header, first prompt. */
  async begin(): Promise<SubShellResult> {
    return this.render(await this.collect(), null);
  }

  async processLine(line: string): Promise<SubShellResult> {
    if (this.client.closed) return this.finish([`Connection closed by foreign host.`]);
    this.client.send(line);
    return this.render(await this.collect(), line);
  }

  dispose(): void {
    this.client.close();
    this.onEnd?.();
  }

  /**
   * Read until the wire goes quiet. A command's answer can take several
   * turns (the server runs the CLI through its own promise chain), so
   * silence — not the first chunk — is what marks the end of a reply.
   */
  private async collect(): Promise<string> {
    let text = '';
    let sawData = false;
    for (let i = 0; i < MAX_COLLECT_TICKS; i++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const chunk = this.client.drain();
      if (chunk) { text += chunk; sawData = true; continue; }
      if (sawData || this.client.closed) break;
    }
    return text;
  }

  /**
   * Split what came back into finished lines and the trailing prompt —
   * a prompt is exactly the text after the last newline, since the
   * remote never terminates it.
   */
  private render(raw: string, echoed: string | null): SubShellResult {
    const text = echoed === null ? raw : stripLeadingEcho(raw, echoed);
    const cut = text.lastIndexOf('\n');
    const body = cut >= 0 ? text.slice(0, cut) : '';
    this.prompt = cut >= 0 ? text.slice(cut + 1) : text;

    const output = body.length > 0 ? body.split('\n') : [];
    while (output.length > 0 && output[0] === '') output.shift();

    if (this.client.closed) {
      if (this.prompt) { output.push(this.prompt); this.prompt = ''; }
      return this.finish(output);
    }
    return { output, exit: false, prompt: this.prompt };
  }

  private finish(output: string[]): SubShellResult {
    this.onEnd?.();
    return { output, exit: true, prompt: '' };
  }
}

/**
 * Drop the server's echo of the line just sent. Only a leading match is
 * removed: the same text appearing later is genuine command output.
 */
function stripLeadingEcho(raw: string, echoed: string): string {
  const withNewline = `${echoed}\n`;
  if (raw.startsWith(withNewline)) return raw.slice(withNewline.length);
  if (echoed !== '' && raw.startsWith(echoed)) return raw.slice(echoed.length);
  if (raw.startsWith('\n')) return raw.slice(1);
  return raw;
}
