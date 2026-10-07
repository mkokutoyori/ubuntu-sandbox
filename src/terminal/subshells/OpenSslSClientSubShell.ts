import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import type { ISubShell, SubShellResult } from './ISubShell';
import type { TlsPeerChannelPort } from '@/network/crypto/openssl/OpenSslHost';
import { bytesToFileText, fileTextToBytes } from '@/crypto/encoding';

export class OpenSslSClientSubShell implements ISubShell {
  readonly kind = 'openssl-s_client';
  readonly connection = 'subshell' as const;

  constructor(
    private readonly channel: TlsPeerChannelPort, private readonly version: string,
    output: (line: string) => void = () => undefined,
  ) {
    channel.onPush((text) => { for (const line of text.replace(/\r?\n$/, '').split(/\r?\n/)) output(line); });
  }

  getPrompt(): string {
    return '';
  }

  handleKey(e: KeyEvent): boolean {
    return e.key === 'd' && e.ctrlKey === true;
  }

  processLine(line: string): SubShellResult {
    if (line === 'Q') {
      this.channel.close();
      return { output: ['DONE'], exit: true, prompt: '' };
    }
    if (line === 'k' || line === 'K') {
      if (this.version !== '1.3') return reply(['openssl: s_client: KeyUpdate needs TLS 1.3']);
      this.channel.keyUpdate(line === 'K');
      return reply(['KEYUPDATE']);
    }
    if (line === 'R' || line === 'r') {
      if (this.version === '1.3') return reply(['openssl: s_client: renegotiation does not exist in TLS 1.3, use K for a key update']);
      return reply(this.channel.renegotiate() ? ['RENEGOTIATING'] : ['RENEGOTIATING', 'openssl: s_client: renegotiation refused by the server']);
    }
    if (line === 'B') {
      return reply(['openssl: s_client: command B (heartbeat) is not available in this simulator']);
    }
    const answer = bytesToFileText(this.channel.exchange(fileTextToBytes(`${line}\n`)));
    return reply(answer === '' ? [] : answer.replace(/\r?\n$/, '').split(/\r?\n/));
  }

  dispose(): void {
    this.channel.close();
  }
}

function reply(output: string[]): SubShellResult {
  return { output, exit: false, prompt: '' };
}
