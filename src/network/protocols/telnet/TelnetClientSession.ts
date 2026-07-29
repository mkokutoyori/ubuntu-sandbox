/**
 * TelnetClientSession — the client half of RFC 854, over a real socket.
 *
 * A telnet client is a byte pipe with an option negotiator bolted on:
 * there is no authentication protocol and no channel layer, so what the
 * operator types goes out as-is and what comes back is printed as-is.
 * Everything that looks like a login dialog is the *server's* text.
 *
 * This replaces reconstructing that dialog on the client side, which is
 * what the simulator used to do (a static "Connected to …" banner plus
 * synthesised capture frames).
 */

import {
  OPT_ECHO, OPT_NAWS, OPT_SUPPRESS_GO_AHEAD, OPT_TERMINAL_SPEED, OPT_TERMINAL_TYPE,
  encodeSubnegotiation, fromNvtText, parseTelnetChunk, toNvtText,
} from './TelnetCodec';
import { TelnetNegotiator, type TelnetOptionPolicy } from './TelnetNegotiator';

/** Sub-option codes of RFC 1091's terminal-type negotiation. */
const TERMINAL_TYPE_IS = 0;
const TERMINAL_TYPE_SEND = 1;

/** What a client describes about itself, and what it lets the server drive. */
export const DEFAULT_TELNET_CLIENT_POLICY: TelnetOptionPolicy = {
  offer: [OPT_TERMINAL_TYPE, OPT_TERMINAL_SPEED, OPT_NAWS],
  request: [OPT_SUPPRESS_GO_AHEAD, OPT_ECHO],
};

export interface TelnetClientTransport {
  write(data: string): void;
  close(): void;
  onData(handler: (data: string) => void): () => void;
  onClose?(handler: (reason: string) => void): () => void;
}

export interface TelnetClientOptions {
  /** Announced in the terminal-type subnegotiation; `VT100` like a real client. */
  terminalType?: string;
  policy?: TelnetOptionPolicy;
}

export class TelnetClientSession {
  private readonly negotiator: TelnetNegotiator;
  private readonly terminalType: string;
  private carry: readonly number[] = [];
  private buffer = '';
  private readonly sinks: Array<(text: string) => void> = [];
  private isClosed = false;

  constructor(
    private readonly transport: TelnetClientTransport,
    options: TelnetClientOptions = {},
  ) {
    this.terminalType = options.terminalType ?? 'VT100';
    this.negotiator = new TelnetNegotiator(options.policy ?? DEFAULT_TELNET_CLIENT_POLICY);
    this.transport.onData((chunk) => this.onData(chunk));
    this.transport.onClose?.(() => { this.isClosed = true; });
  }

  get closed(): boolean { return this.isClosed; }

  /** Everything received since the last drain, with NVT line endings normalised. */
  drain(): string {
    const out = this.buffer;
    this.buffer = '';
    return out;
  }

  /** Receive text as it arrives, on top of the buffer `drain()` reads. */
  onOutput(sink: (text: string) => void): () => void {
    this.sinks.push(sink);
    return () => {
      const i = this.sinks.indexOf(sink);
      if (i !== -1) this.sinks.splice(i, 1);
    };
  }

  /** One line of operator input, terminated the way the NVT expects. */
  send(line: string): void {
    this.sendRaw(`${line}\n`);
  }

  sendRaw(text: string): void {
    if (this.isClosed) return;
    this.transport.write(toNvtText(text));
  }

  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.transport.close();
  }

  private onData(chunk: string): void {
    const parsed = parseTelnetChunk(chunk, this.carry);
    this.carry = parsed.carry;

    const reply = this.negotiator.respond(parsed.negotiations);
    if (reply) this.transport.write(reply);
    for (const sub of parsed.subnegotiations) this.onSubnegotiation(sub.option, sub.params);

    if (!parsed.data) return;
    const text = fromNvtText(parsed.data);
    this.buffer += text;
    for (const sink of [...this.sinks]) sink(text);
  }

  /** RFC 1091: the server asks `SEND`, the client answers `IS <type>`. */
  private onSubnegotiation(option: number, params: readonly number[]): void {
    if (option !== OPT_TERMINAL_TYPE || params[0] !== TERMINAL_TYPE_SEND) return;
    const payload = [TERMINAL_TYPE_IS, ...Array.from(this.terminalType, (c) => c.charCodeAt(0))];
    this.transport.write(encodeSubnegotiation(OPT_TERMINAL_TYPE, payload));
  }
}
