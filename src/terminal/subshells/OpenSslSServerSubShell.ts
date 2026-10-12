import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import type { ISubShell, SubShellResult } from './ISubShell';
import type { TlsServerStatistics, TlsStreamServerPort } from '@/network/crypto/openssl/OpenSslHost';

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
      const connected = this.controller.connectionVersion() !== null;
      const statistics = formatStatistics(this.controller.statistics());
      this.controller.stop();
      return {
        output: connected ? ['DONE', 'shutdown accept socket', 'shutting down SSL', 'CONNECTION CLOSED', ...statistics] : ['DONE', ...statistics],
        exit: true, prompt: '',
      };
    }
    if (line === 'q') {
      this.controller.closeConnection();
      return reply([]);
    }
    const version = this.controller.connectionVersion();
    if (line === 'r' || line === 'R') {
      if (version === null) return reply(['openssl: s_server: no client is connected']);
      if (version === '1.3') return reply([openSslErrorLine('0A00010A', 'can_renegotiate', 'wrong ssl version', 'ssl/ssl_lib.c:2323'), HANDSHAKE_RESULT]);
      this.controller.renegotiate(line === 'R');
      return reply([HANDSHAKE_RESULT]);
    }
    if (line === 'k' || line === 'K') {
      if (version === null) return reply(['openssl: s_server: no client is connected']);
      if (version === '1.3') this.controller.keyUpdate(line === 'K');
      return reply([HANDSHAKE_RESULT]);
    }
    if (line === 'c') {
      if (version === null) return reply(['openssl: s_server: no client is connected']);
      const refusal = version === '1.3'
        ? openSslErrorLine('0A000117', 'SSL_verify_client_post_handshake', 'extension not received', 'ssl/ssl_lib.c:5908')
        : openSslErrorLine('0A00010A', 'SSL_verify_client_post_handshake', 'wrong ssl version', 'ssl/ssl_lib.c:5893');
      return reply([refusal, 'Failed to initiate request']);
    }
    const output: string[] = [];
    if (line === 'P' && !this.controller.sendClear(CLEAR_TEXT)) return reply(['openssl: s_server: no client is connected']);
    if (line === 'S') output.push(...formatStatistics(this.controller.statistics()));
    if (!this.controller.send(`${line}\n`) && line !== 'P') return reply(['openssl: s_server: no client is connected']);
    return reply(output);
  }

  dispose(): void {
    this.controller.stop();
  }
}

function reply(output: string[]): SubShellResult {
  return { output, exit: false, prompt: '' };
}

const HANDSHAKE_RESULT = 'SSL_do_handshake -> 1';
const CLEAR_TEXT = 'Lets print some clear text\n';

function openSslErrorLine(code: string, func: string, reason: string, source: string): string {
  const thread = Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16).toUpperCase()).join('');
  return `${thread}:error:${code}:SSL routines:${func}:${reason}:../${source}:`;
}

function formatStatistics(stats: TlsServerStatistics): string[] {
  const field = (value: number): string => String(value).padStart(4, ' ');
  return [
    `${field(stats.itemsInCache)} items in the session cache`,
    `${field(0)} client connects (SSL_connect())`,
    `${field(0)} client renegotiates (SSL_connect())`,
    `${field(0)} client connects that finished`,
    `${field(stats.accepts)} server accepts (SSL_accept())`,
    `${field(stats.renegotiates)} server renegotiates (SSL_accept())`,
    `${field(stats.acceptsFinished)} server accepts that finished`,
    `${field(stats.cacheHits)} session cache hits`,
    `${field(stats.cacheMisses)} session cache misses`,
    `${field(0)} session cache timeouts`,
    `${field(0)} callback cache hits`,
    `${field(0)} cache full overflows (${stats.cacheSize} allowed)`,
  ];
}
