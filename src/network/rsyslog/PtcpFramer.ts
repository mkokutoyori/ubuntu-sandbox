import { posixToJsSource } from '@/network/devices/linux/regex/PosixRegex';

type InputState = 'at-frame-start' | 'in-octet-count' | 'in-message' | 'in-message-truncation';
type Framing = 'octet-stuffing' | 'octet-counting';

export interface PtcpFramerSettings {
  readonly inputName: string;
  readonly maxLine: number;
  readonly maxFrameSize: number;
  readonly supportOctetCounted: boolean;
  readonly spFramingFix: boolean;
  readonly additionalDelimiter: number | null;
  readonly discardTruncated: boolean;
  readonly multiLine: boolean;
  readonly startRegex: string | null;
}

export interface PtcpFramerSink {
  submit(message: Uint8Array, frameOversize: boolean): void;
  error(text: string): void;
  peer(): { host: string; ip: string };
}

const LF = 0x0a;
const SP = 0x20;
const LESS_THAN = 0x3c;
const DIGIT_ZERO = 0x30;
const DIGIT_NINE = 0x39;
const MAX_OCTET_COUNT_ACCUMULATOR = 200_000_000;
const MAX_QUOTED_BYTES = 32;

const isDigit = (byte: number): boolean => byte >= DIGIT_ZERO && byte <= DIGIT_NINE;
const signedChar = (byte: number): number => (byte > 127 ? byte - 256 : byte);

function cStringLength(buffer: Uint8Array, from: number): number {
  let end = from;
  while (end < buffer.length && buffer[end] !== 0) end++;
  return end - from;
}

function latin1(buffer: Uint8Array, from: number, length: number): string {
  let text = '';
  for (let index = from; index < from + length; index++) text += String.fromCharCode(buffer[index]);
  return text;
}

export class PtcpFramer {
  private state: InputState = 'at-frame-start';
  private framing: Framing = 'octet-stuffing';
  private readonly message: Uint8Array;
  private readonly saved: Uint8Array;
  private length = 0;
  private currentLine = 1;
  private octetsRemaining = 0;
  private frameOversize = false;
  private messages = 0;
  private readonly startRegex: RegExp | null;

  constructor(private readonly settings: PtcpFramerSettings, private readonly sink: PtcpFramerSink) {
    const factor = settings.startRegex === null ? 1 : 2;
    this.message = new Uint8Array(1 + settings.maxLine * factor);
    this.saved = new Uint8Array(1 + settings.maxLine * factor);
    this.startRegex = settings.startRegex === null ? null : new RegExp(posixToJsSource(settings.startRegex, { extended: true }), 'u');
  }

  push(data: Uint8Array): number {
    this.messages = 0;
    let at = 0;
    while (at < data.length) at = this.processByte(data, at) + 1;
    return this.messages;
  }

  private submit(): void {
    if (this.length > 0) this.sink.submit(this.message.slice(0, this.length), this.frameOversize);
    this.length = 0;
    this.frameOversize = false;
  }

  private submitAndCount(): void {
    this.submit();
    this.messages++;
  }

  private isFrameDelimiter(byte: number): boolean {
    return byte === LF || (this.settings.additionalDelimiter !== null && byte === this.settings.additionalDelimiter);
  }

  private describePeer(): string {
    const peer = this.sink.peer();
    return `(hostname) ${peer.host}, (ip) ${peer.ip}`;
  }

  private processRegexByte(byte: number): void {
    const settings = this.settings;
    this.message[this.length++] = byte;
    this.message[this.length] = 0;
    if (this.length === 2 * settings.maxLine) {
      this.sink.error(
        `imptcp: more then double max message size (${this.length + 1}) received without finding frame terminator via regex - assuming end of frame now.`,
      );
      this.submitAndCount();
      this.length = 0;
      this.currentLine = 1;
    }
    if (byte === LF) {
      this.currentLine = this.length;
      return;
    }
    const tailLength = cStringLength(this.message, this.currentLine);
    const matched = this.startRegex !== null && this.startRegex.test(latin1(this.message, this.currentLine, tailLength));
    if (this.currentLine > 0 && matched) {
      const keep = cStringLength(this.message, this.currentLine);
      this.saved.set(this.message.subarray(this.currentLine, this.currentLine + keep), 0);
      this.saved[keep] = 0;
      this.length = this.currentLine - 1;
      this.submitAndCount();
      const restored = cStringLength(this.saved, 0);
      this.message.set(this.saved.subarray(0, restored), 0);
      this.message[restored] = 0;
      this.length = restored;
      this.currentLine = 1;
    }
  }

  private processByte(data: Uint8Array, at: number): number {
    const settings = this.settings;
    const byte = data[at];
    const available = data.length - at;
    if (this.startRegex !== null) {
      this.processRegexByte(byte);
      return at;
    }
    if (this.state === 'at-frame-start') {
      if (settings.supportOctetCounted && isDigit(byte)) {
        this.state = 'in-octet-count';
        this.frameOversize = false;
        this.octetsRemaining = 0;
        this.framing = 'octet-counting';
      } else if (settings.spFramingFix && byte === SP) {
        return at;
      } else {
        this.state = 'in-message';
        this.frameOversize = false;
        this.framing = 'octet-stuffing';
      }
    }
    if (this.state === 'in-octet-count') {
      this.processOctetCount(byte);
    } else if (this.state === 'in-message-truncation') {
      if (this.isFrameDelimiter(byte)) this.state = 'at-frame-start';
    } else if (this.framing === 'octet-stuffing') {
      return this.processStuffed(data, at, available);
    } else {
      return this.processCounted(data, at, available);
    }
    return at;
  }

  private processOctetCount(byte: number): void {
    const settings = this.settings;
    if (isDigit(byte)) {
      if (this.octetsRemaining <= MAX_OCTET_COUNT_ACCUMULATOR) this.octetsRemaining = this.octetsRemaining * 10 + byte - DIGIT_ZERO;
      if (this.length < settings.maxLine) this.message[this.length++] = byte;
      return;
    }
    const prefix = `imptcp: Framing Error in received TCP message from peer: ${this.describePeer()}:`;
    if (byte !== SP) this.sink.error(`${prefix} delimiter is not SP but has ASCII value ${signedChar(byte)}.`);
    if (this.octetsRemaining < 1) {
      this.sink.error(`${prefix} invalid octet count ${this.octetsRemaining}.`);
      this.framing = 'octet-stuffing';
    } else if (this.octetsRemaining > settings.maxLine) {
      this.frameOversize = true;
      this.sink.error(
        `imptcp: received oversize message from peer: ${this.describePeer()}: size is ${this.octetsRemaining} bytes, max msg size is ${settings.maxLine}, truncating...`,
      );
    }
    if (this.octetsRemaining > settings.maxFrameSize) {
      this.sink.error(`${prefix} frame too large: ${this.octetsRemaining}, change to octet stuffing`);
      this.framing = 'octet-stuffing';
    } else {
      this.length = 0;
    }
    this.state = 'in-message';
  }

  private processStuffed(data: Uint8Array, at: number, available: number): number {
    const settings = this.settings;
    const byte = data[at];
    const delimiter = this.isFrameDelimiter(byte);
    if (this.length >= settings.maxLine) {
      let reach = 1;
      while (reach < available && !this.isFrameDelimiter(data[at + reach])) reach++;
      this.sink.error(
        `imptcp ${settings.inputName}: message received is at least ${reach} byte larger than max msg size; message will be split starting at: "${latin1(data, at, Math.min(reach, MAX_QUOTED_BYTES))}"\n`,
      );
      this.frameOversize = true;
      this.submitAndCount();
      if (settings.discardTruncated) {
        this.state = delimiter ? 'at-frame-start' : 'in-message-truncation';
        return at;
      }
    }
    if (delimiter) {
      if (settings.multiLine) {
        if (available === 1 || data[at + 1] === LESS_THAN) {
          this.submitAndCount();
          this.state = 'at-frame-start';
        } else if (this.length < settings.maxLine) {
          this.message[this.length++] = byte;
        }
      } else {
        this.submitAndCount();
        this.state = 'at-frame-start';
      }
    } else if (this.length < settings.maxLine) {
      this.message[this.length++] = byte;
    }
    return at;
  }

  private processCounted(data: Uint8Array, at: number, available: number): number {
    const settings = this.settings;
    let toCopy = this.octetsRemaining;
    let toDiscard = 0;
    if (available < toCopy) toCopy = available;
    if (this.length >= settings.maxLine) {
      toDiscard = toCopy;
      toCopy = 0;
    } else if (toCopy + this.length > settings.maxLine) {
      toDiscard = toCopy - (settings.maxLine - this.length);
      toCopy = settings.maxLine - this.length;
    }
    this.message.set(data.subarray(at, at + toCopy), this.length);
    this.length += toCopy;
    this.octetsRemaining -= toCopy + toDiscard;
    const next = at + toCopy + toDiscard - 1;
    if (this.octetsRemaining === 0) {
      this.submitAndCount();
      this.state = 'at-frame-start';
    }
    return next;
  }
}
