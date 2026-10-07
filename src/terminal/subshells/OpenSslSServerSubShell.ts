import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import type { ISubShell, SubShellResult } from './ISubShell';
import type { TlsStreamServerPort } from '@/network/crypto/openssl/OpenSslHost';

export class OpenSslSServerSubShell implements ISubShell {
  readonly kind = 'openssl-s_server';
  readonly connection = 'subshell' as const;

  constructor(private readonly controller: TlsStreamServerPort) {}

  getPrompt(): string {
    return '';
  }

  handleKey(e: KeyEvent): boolean {
    return e.key === 'd' && e.ctrlKey === true;
  }

  processLine(line: string): SubShellResult {
    if (line === 'Q') {
      this.controller.stop();
      return { output: ['DONE'], exit: true, prompt: '' };
    }
    if (line === 'q') {
      this.controller.closeConnection();
      return reply([]);
    }
    if (line === 'r' || line === 'R') {
      const started = this.controller.renegotiate(line === 'R');
      return reply(started ? ['SSL_renegotiate -> 1'] : ['openssl: s_server: no TLS 1.2 or earlier connection to renegotiate']);
    }
    if (line === 'k' || line === 'K') {
      return reply(this.controller.keyUpdate(line === 'K') ? ['KeyUpdate sent'] : ['openssl: s_server: no TLS 1.3 connection to update']);
    }
    if (line === 'P' || line === 'S') {
      return reply([`openssl: s_server: command ${line} is not available in this simulator`]);
    }
    if (!this.controller.send(`${line}\n`)) return reply(['openssl: s_server: no client is connected']);
    return reply([]);
  }

  dispose(): void {
    this.controller.stop();
  }
}

function reply(output: string[]): SubShellResult {
  return { output, exit: false, prompt: '' };
}
