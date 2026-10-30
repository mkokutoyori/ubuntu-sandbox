import {
  established, refused, resolved, unresolved,
  type NetkitAddress, type NetkitConnection, type NetkitResolution, type NetkitTelnetHost, type NetkitTelnetTerminal,
  type NetkitTelnetTransport, type NetkitTerminalMode,
} from '@/network/protocols/telnet/client/NetkitTelnetHost';
import type { NetkitTelnetClient } from '@/network/protocols/telnet/client/NetkitTelnetClient';

export const RECORDED_PATH = '/nix/var/nix/profiles/default/bin:/root/.local/bin:/root/.cargo/bin:/usr/local/go/bin:/opt/node22/bin:/opt/maven/bin:/opt/gradle/bin:/opt/rbenv/bin:/root/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

const ESC_CHARS = { interrupt: 0x03, quit: 0x1c, susp: 0x1a, eof: 0x04, erase: 0x7f, kill: 0x15 };

export function toHex(text: string): string {
  return Array.from(text, (c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
}

export function fromHex(hex: string): string {
  let out = '';
  for (let i = 0; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  return out;
}

export class PtyDiscipline implements NetkitTelnetTerminal {
  screen = '';
  client: NetkitTelnetClient | null = null;
  exited = false;
  private mode: NetkitTerminalMode | null = null;
  private line = '';

  write(text: string): void {
    this.emit(text);
  }

  error(text: string): void {
    this.emit(text);
  }

  setMode(mode: NetkitTerminalMode): void {
    this.mode = mode;
  }

  private emit(text: string): void {
    const onlcr = this.mode === null || this.mode.echo;
    this.screen += onlcr ? text.replace(/\n/g, '\r\n') : text;
  }

  private echoOn(): boolean {
    return this.mode === null || this.mode.echo;
  }

  private canonical(): boolean {
    return this.mode === null || this.mode.edit;
  }

  private signals(): boolean {
    return this.mode === null || this.mode.trapSignals;
  }

  private literal(): boolean {
    return this.mode !== null && this.mode.literalEcho;
  }

  private echoChar(c: number): void {
    if (!this.echoOn()) return;
    if (c === 0x0a) this.screen += '\r\n';
    else if (c < 0x20 && c !== 0x09 && !this.literal()) this.screen += `^${String.fromCharCode(c + 64)}`;
    else if (c === 0x7f && !this.literal()) this.screen += '^?';
    else this.screen += String.fromCharCode(c);
  }

  type(data: string): void {
    if (this.exited) return;
    let chunk = '';
    const deliver = (): void => {
      if (chunk === '') return;
      const text = chunk;
      chunk = '';
      this.client?.input(text);
    };
    for (const ch of data) {
      let c = ch.charCodeAt(0);
      const icrnl = this.canonical() || this.mode === null;
      if (c === 0x0d && icrnl) c = 0x0a;
      if (this.signals()) {
        if (c === ESC_CHARS.interrupt) { deliver(); this.echoChar(c); this.line = ''; this.client?.signal('INT'); continue; }
        if (c === ESC_CHARS.quit) { deliver(); this.echoChar(c); this.line = ''; this.client?.signal('QUIT'); continue; }
        if (c === ESC_CHARS.susp) { deliver(); this.echoChar(c); this.client?.signal('TSTP'); continue; }
      }
      if (this.canonical()) {
        if (c === ESC_CHARS.eof) {
          if (this.line === '') this.client?.inputEof();
          else {
            this.client?.input(this.line);
            this.line = '';
          }
          continue;
        }
        if (c === ESC_CHARS.erase) {
          if (this.line !== '') {
            this.line = this.line.slice(0, -1);
            if (this.echoOn()) this.screen += '\b \b';
          }
          continue;
        }
        if (c === ESC_CHARS.kill) {
          this.line = '';
          continue;
        }
        this.echoChar(c);
        this.line += String.fromCharCode(c);
        const delivering = c === 0x0a || (this.mode !== null && c === this.mode.escape && this.mode.escape !== 0);
        if (delivering) {
          const delivered = this.line;
          this.line = '';
          this.client?.input(delivered);
        }
        continue;
      }
      this.echoChar(c);
      chunk += String.fromCharCode(c);
    }
    deliver();
  }

  take(): string {
    const text = this.screen.replace(/\r\n/g, '\n');
    this.screen = '';
    return text;
  }
}

export class ScriptedPeer {
  received = '';
  private dataHandlers: Array<(data: string) => void> = [];
  private closeHandlers: Array<(reason: string) => void> = [];
  closedByClient = false;

  readonly transport: NetkitTelnetTransport = {
    write: (data) => { this.received += data; },
    close: () => { this.closedByClient = true; },
    onData: (handler) => {
      this.dataHandlers.push(handler);
      return () => { this.dataHandlers = this.dataHandlers.filter((h) => h !== handler); };
    },
    onClose: (handler) => {
      this.closeHandlers.push(handler);
      return () => { this.closeHandlers = this.closeHandlers.filter((h) => h !== handler); };
    },
  };

  send(data: string): void {
    for (const handler of [...this.dataHandlers]) handler(data);
  }

  close(): void {
    for (const handler of [...this.closeHandlers]) handler('closed');
  }

  drain(): string {
    const got = this.received;
    this.received = '';
    return got;
  }
}

export interface PtyHostOptions {
  readonly environment?: ReadonlyArray<readonly [string, string]>;
  readonly peers?: Record<number, ScriptedPeer>;
  readonly files?: Record<string, string>;
  readonly size?: { rows: number; cols: number } | null;
  readonly tty?: boolean;
}

export class PtyHost implements NetkitTelnetHost {
  readonly attempts: Array<{ address: string; port: number }> = [];

  constructor(private readonly options: PtyHostOptions = {}) {}

  environment(): ReadonlyArray<readonly [string, string]> {
    return this.options.environment ?? [['TERM', 'xterm'], ['PATH', RECORDED_PATH], ['HOME', '/root'], ['USER', 'root'], ['LOGNAME', 'root']];
  }

  currentUser(): { readonly name: string; readonly uid: number } | null {
    return { name: 'root', uid: 0 };
  }

  lookupUser(name: string): { readonly uid: number } | null {
    return name === 'root' ? { uid: 0 } : name === 'alice' ? { uid: 1000 } : null;
  }

  private size: { rows: number; cols: number } | null = this.options.size === undefined ? { rows: 24, cols: 80 } : this.options.size;

  resize(rows: number, cols: number): void {
    this.size = { rows, cols };
  }

  terminalSize(): { readonly rows: number; readonly cols: number } | null {
    return this.isTty() ? this.size : null;
  }

  terminalSpeed(): { readonly input: number; readonly output: number } {
    return this.isTty() ? { input: 38400, output: 38400 } : { input: 0, output: 0 };
  }

  isTty(): boolean {
    return this.options.tty !== false;
  }

  hostname(): string {
    return 'vm';
  }

  canonicalHostname(name: string): string {
    return name;
  }

  readFile(path: string): string | null {
    return this.options.files?.[path] ?? null;
  }

  resolve(host: string, service: string, family: 0 | 4 | 6, numericOnly: boolean): NetkitResolution {
    const port = this.servicePort(service);
    if (port === null) return unresolved('Servname not supported for ai_socktype', false);
    const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    if (v4 !== null && v4.slice(1).every((part) => Number(part) <= 255)) {
      if (family === 6) return unresolved('Address family for hostname not supported', false);
      return resolved([{ text: host, family: 4 }], port, null);
    }
    if (host.includes(':') && /^[0-9a-f:]+$/i.test(host)) {
      if (family === 4) return unresolved('Address family for hostname not supported', false);
      return resolved([{ text: host, family: 6 }], port, null);
    }
    if (numericOnly) return unresolved('Name or service not known', true);
    if (host === 'localhost') return resolved([{ text: '127.0.0.1', family: 4 }], port, 'localhost');
    return unresolved('Name or service not known', true);
  }

  private servicePort(service: string): number | null {
    if (/^\d+$/.test(service)) return Number(service);
    return service === 'telnet' ? 23 : null;
  }

  async connect(address: NetkitAddress, port: number): Promise<NetkitConnection> {
    this.attempts.push({ address: address.text, port });
    if (address.family === 6) return refused('Address family not supported by protocol');
    const peer = this.options.peers?.[port];
    if (peer === undefined) return refused('Connection refused');
    return established(peer.transport);
  }
}

export async function settle(turns = 6): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

export class PipeTerminal implements NetkitTelnetTerminal {
  text = '';

  write(text: string): void {
    this.text += text;
  }

  error(text: string): void {
    this.text += text;
  }

  setMode(): void {}

  take(): string {
    const taken = this.text;
    this.text = '';
    return taken;
  }
}
