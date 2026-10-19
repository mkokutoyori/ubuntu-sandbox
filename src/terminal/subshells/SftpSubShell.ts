import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import type { ISubShell, SubShellResult } from './ISubShell';
import type { SftpClientSession } from '@/network/protocols/ssh/sftp/client/SftpClientCommand';

const PROMPT = 'sftp> ';

export class SftpSubShell implements ISubShell {
  readonly kind = 'sftp';
  readonly connection = 'subshell' as const;
  constructor(private readonly session: SftpClientSession) {}

  getPrompt(): string {
    return PROMPT;
  }

  handleKey(e: KeyEvent): boolean {
    return e.key === 'd' && e.ctrlKey === true;
  }

  async processLine(line: string): Promise<SubShellResult> {
    const outcome = await this.session.execute(line, true);
    const text = this.session.drain().replace(/\n$/, '');
    const output = text === '' ? [''] : text.split('\n');
    if (outcome === 'continue') return { output, exit: false, prompt: PROMPT };
    this.session.close();
    return { output, exit: true, prompt: '' };
  }

  dispose(): void {
    this.session.close();
  }
}
