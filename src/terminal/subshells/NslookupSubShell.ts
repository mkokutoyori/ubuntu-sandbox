import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import type { ISubShell, SubShellResult } from './ISubShell';
import type { NslookupInterpreter } from '@/network/dns/tools/NslookupInterpreter';

const PROMPT = '> ';

export class NslookupSubShell implements ISubShell {
  readonly kind = 'nslookup';
  readonly connection = 'subshell' as const;

  constructor(private readonly interpreter: NslookupInterpreter) {}

  bannerLines(): Promise<string[]> {
    return this.interpreter.bannerLines();
  }

  getPrompt(): string {
    return PROMPT;
  }

  handleKey(e: KeyEvent): boolean {
    if (e.key === 'd' && e.ctrlKey) return true;
    return false;
  }

  async processLine(line: string): Promise<SubShellResult> {
    const reply = await this.interpreter.interpret(line);
    return reply.exit
      ? { output: [], exit: true, prompt: '' }
      : { output: reply.lines, exit: false, prompt: PROMPT };
  }

  dispose(): void {
    void 0;
  }
}
