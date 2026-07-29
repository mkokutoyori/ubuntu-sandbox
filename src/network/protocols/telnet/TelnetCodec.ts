/**
 * TelnetCodec — RFC 854 (Telnet Protocol) / RFC 855 (Option
 * Specifications) framing.
 *
 * The wire carries bytes; `TcpStream.write` carries a string, so a byte
 * is one char with a code in 0-255 — the same convention the rest of the
 * TCP-facing code uses. Everything here is pure: no device, no socket,
 * no state beyond what a caller hands back in.
 */

export const IAC = 255;
export const DONT = 254;
export const DO = 253;
export const WONT = 252;
export const WILL = 251;
export const SB = 250;
export const GA = 249;
export const EL = 248;
export const EC = 247;
export const AYT = 246;
export const AO = 245;
export const IP = 244;
export const BRK = 243;
export const DM = 242;
export const NOP = 241;
export const SE = 240;

export const OPT_ECHO = 1;
export const OPT_SUPPRESS_GO_AHEAD = 3;
export const OPT_STATUS = 5;
export const OPT_TIMING_MARK = 6;
export const OPT_TERMINAL_TYPE = 24;
export const OPT_NAWS = 31;
export const OPT_TERMINAL_SPEED = 32;
export const OPT_REMOTE_FLOW_CONTROL = 33;
export const OPT_LINEMODE = 34;
export const OPT_X_DISPLAY_LOCATION = 35;
export const OPT_NEW_ENVIRON = 39;

export type TelnetVerb = typeof WILL | typeof WONT | typeof DO | typeof DONT;

export interface TelnetNegotiation {
  readonly verb: TelnetVerb;
  readonly option: number;
}

export interface TelnetSubnegotiation {
  readonly option: number;
  readonly params: readonly number[];
}

export interface TelnetParseResult {
  /** In-band application data, with `IAC IAC` already collapsed to one 0xFF. */
  readonly data: string;
  readonly negotiations: readonly TelnetNegotiation[];
  readonly subnegotiations: readonly TelnetSubnegotiation[];
  /** Two-byte commands with no option byte (IP, AYT, NOP, …). */
  readonly controls: readonly number[];
  /**
   * Bytes of an IAC sequence that had not finished when the chunk ended.
   * Feed them back as `carry` on the next call so a sequence split across
   * two TCP segments is still understood.
   */
  readonly carry: readonly number[];
}

const NEGOTIATION_VERBS = new Set<number>([WILL, WONT, DO, DONT]);

/**
 * Split one received chunk into application data and telnet commands.
 *
 * `carry` is the previous call's `carry` — an IAC sequence may straddle
 * segment boundaries, and a parser that reset per segment would silently
 * emit the option bytes as user input.
 */
export function parseTelnetChunk(chunk: string, carry: readonly number[] = []): TelnetParseResult {
  const bytes: number[] = [];
  for (const b of carry) bytes.push(b);
  for (let i = 0; i < chunk.length; i++) bytes.push(chunk.charCodeAt(i) & 0xff);

  const data: string[] = [];
  const negotiations: TelnetNegotiation[] = [];
  const subnegotiations: TelnetSubnegotiation[] = [];
  const controls: number[] = [];

  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    if (b !== IAC) { data.push(String.fromCharCode(b)); i++; continue; }

    if (i + 1 >= bytes.length) return finish(bytes.slice(i));
    const cmd = bytes[i + 1];

    if (cmd === IAC) { data.push(String.fromCharCode(IAC)); i += 2; continue; }

    if (NEGOTIATION_VERBS.has(cmd)) {
      if (i + 2 >= bytes.length) return finish(bytes.slice(i));
      negotiations.push({ verb: cmd as TelnetVerb, option: bytes[i + 2] });
      i += 3;
      continue;
    }

    if (cmd === SB) {
      const end = findSubnegotiationEnd(bytes, i + 2);
      if (end < 0) return finish(bytes.slice(i));
      subnegotiations.push({ option: bytes[i + 2], params: unescapeIac(bytes.slice(i + 3, end)) });
      i = end + 2;
      continue;
    }

    controls.push(cmd);
    i += 2;
  }

  return finish([]);

  function finish(rest: number[]): TelnetParseResult {
    return { data: data.join(''), negotiations, subnegotiations, controls, carry: rest };
  }
}

/** Index of the `IAC` starting the `IAC SE` that ends a subnegotiation, or -1. */
function findSubnegotiationEnd(bytes: readonly number[], from: number): number {
  for (let i = from; i < bytes.length - 1; i++) {
    if (bytes[i] === IAC && bytes[i + 1] === IAC) { i++; continue; }
    if (bytes[i] === IAC && bytes[i + 1] === SE) return i;
  }
  return -1;
}

function unescapeIac(bytes: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === IAC && bytes[i + 1] === IAC) { out.push(IAC); i++; continue; }
    out.push(bytes[i]);
  }
  return out;
}

export function encodeNegotiation(verb: TelnetVerb, option: number): string {
  return String.fromCharCode(IAC, verb, option & 0xff);
}

export function encodeSubnegotiation(option: number, params: readonly number[]): string {
  const escaped: number[] = [];
  for (const p of params) {
    const b = p & 0xff;
    if (b === IAC) escaped.push(IAC);
    escaped.push(b);
  }
  return String.fromCharCode(IAC, SB, option & 0xff, ...escaped, IAC, SE);
}

export function encodeControl(command: number): string {
  return String.fromCharCode(IAC, command & 0xff);
}

/**
 * Application text as NVT bytes (RFC 854 §"The NVT Printer and
 * Keyboard"): end of line is CR LF, and a literal 0xFF has to be
 * doubled so it is not read back as an IAC.
 */
export function toNvtText(text: string): string {
  return text.replace(/\r\n|\r|\n/g, '\r\n').replace(/\xff/g, '\xff\xff');
}

/**
 * NVT line endings back to a plain `\n`. A bare CR is followed by NUL on
 * the wire (RFC 854) to mean "carriage return, no line feed"; both that
 * and CR LF arrive here as one end of line, which is what a line-oriented
 * CLI wants.
 */
export function fromNvtText(text: string): string {
  return text.replace(/\r\0/g, '\n').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

const OPTION_NAMES: Readonly<Record<number, string>> = {
  [OPT_ECHO]: 'ECHO',
  [OPT_SUPPRESS_GO_AHEAD]: 'SUPPRESS-GO-AHEAD',
  [OPT_STATUS]: 'STATUS',
  [OPT_TIMING_MARK]: 'TIMING-MARK',
  [OPT_TERMINAL_TYPE]: 'TERMINAL-TYPE',
  [OPT_NAWS]: 'NAWS',
  [OPT_TERMINAL_SPEED]: 'TERMINAL-SPEED',
  [OPT_REMOTE_FLOW_CONTROL]: 'REMOTE-FLOW-CONTROL',
  [OPT_LINEMODE]: 'LINEMODE',
  [OPT_X_DISPLAY_LOCATION]: 'X-DISPLAY-LOCATION',
  [OPT_NEW_ENVIRON]: 'NEW-ENVIRON',
};

export function telnetOptionName(option: number): string {
  return OPTION_NAMES[option] ?? `OPTION-${option}`;
}
