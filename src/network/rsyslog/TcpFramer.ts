import { posixToJsSource } from '@/network/devices/linux/regex/PosixRegex';

type InputState = 'at-frame-start' | 'in-message' | 'in-octet-count' | 'in-message-truncating' | 'check-multiline';
type Framing = 'octet-stuffing' | 'octet-counting';

export interface TcpFramerSettings {
  readonly inputName: string;
  readonly maxLine: number;
  readonly supportOctetCounted: boolean;
  readonly spFramingFix: boolean;
  readonly disableLfDelimiter: boolean;
  readonly additionalDelimiter: number | null;
  readonly maxFrameSize: number;
  readonly discardTruncated: boolean;
  readonly multiLine: boolean;
  readonly startRegex: string | null;
}

export interface TcpFramerSink {
  submit(message: Uint8Array): void;
  error(text: string): void;
  peer(): { host: string; ip: string; port: string };
}

const MAX_OCTET_COUNT_ACCUMULATOR = 200_000_000;
const LF = 0x0a;
const SP = 0x20;
const LESS_THAN = 0x3c;
const DIGIT_ZERO = 0x30;
const DIGIT_NINE = 0x39;

export class TcpFramer {
  private state: InputState = 'at-frame-start';
  private framing: Framing = 'octet-stuffing';
  private message: number[] = [];
  private octetsRemaining = 0;
  private frameOversize = false;
  private currentLine = 0;
  private readonly startRegex: RegExp | null;

  constructor(private readonly settings: TcpFramerSettings, private readonly sink: TcpFramerSink) {
    this.startRegex = settings.startRegex === null ? null : new RegExp(posixToJsSource(settings.startRegex, { extended: true }), 'u');
  }

  get hasPendingFrame(): boolean {
    return this.state !== 'at-frame-start';
  }

  get oversizeFrame(): boolean {
    return this.frameOversize;
  }

  private emit(): void {
    if (this.message.length > 0) this.sink.submit(Uint8Array.from(this.message));
    this.message = [];
    this.frameOversize = false;
  }

  private describePeer(): string {
    const peer = this.sink.peer();
    return `(hostname) ${peer.host}, (ip) ${peer.ip}, (port) ${peer.port}`;
  }

  push(data: Uint8Array): void {
    for (let index = 0; index < data.length; index++) this.processByte(data, index);
  }

  private processRegexByte(byte: number): void {
    const settings = this.settings;
    if (this.message.length >= 2 * settings.maxLine) {
      this.sink.error(`imtcp: more then double max message size (${this.message.length + 1}) received without finding frame terminator via regex - assuming end of frame now.`);
      this.emit();
      this.currentLine = 0;
    }
    this.message.push(byte);
    if (byte === LF) {
      this.currentLine = this.message.length;
      return;
    }
    if (this.currentLine > 0 && this.startRegex !== null) {
      const tail = String.fromCharCode(...this.message.slice(this.currentLine));
      if (this.startRegex.test(tail)) {
        const saved = this.message.slice(this.currentLine);
        this.message = this.message.slice(0, this.currentLine - 1);
        this.emit();
        this.message = saved;
        this.currentLine = 0;
      }
    }
  }

  private processByte(data: Uint8Array, index: number): void {
    const settings = this.settings;
    const byte = data[index];
    const remainingInChunk = data.length - index;
    if (this.startRegex !== null) {
      this.processRegexByte(byte);
      return;
    }
    if (this.state === 'check-multiline') {
      if (byte === LESS_THAN) {
        this.emit();
        this.state = 'at-frame-start';
      } else {
        if (this.message.length < settings.maxLine) this.message.push(LF);
        this.state = 'in-message';
      }
    }
    if (this.state === 'at-frame-start') {
      if (byte >= DIGIT_ZERO && byte <= DIGIT_NINE && settings.supportOctetCounted) {
        this.state = 'in-octet-count';
        this.frameOversize = false;
        this.octetsRemaining = 0;
        this.framing = 'octet-counting';
      } else if (byte === SP && settings.spFramingFix) {
        return;
      } else {
        this.state = 'in-message';
        this.frameOversize = false;
        this.framing = 'octet-stuffing';
      }
    }
    const isDelimiter = (byte === LF && !settings.disableLfDelimiter) || (settings.additionalDelimiter !== null && byte === settings.additionalDelimiter);
    if (this.state === 'in-message') {
      if (isDelimiter && this.framing === 'octet-stuffing') {
        if (settings.multiLine) {
          if (remainingInChunk > 1) {
            if (data[index + 1] === LESS_THAN) {
              this.emit();
              this.state = 'at-frame-start';
            } else if (this.message.length < settings.maxLine) {
              this.message.push(byte);
            }
          } else {
            this.state = 'check-multiline';
            return;
          }
        } else {
          this.emit();
          this.state = 'at-frame-start';
        }
      } else if (this.message.length < settings.maxLine) {
        this.message.push(byte);
      } else {
        this.frameOversize = true;
        this.emit();
        if (settings.discardTruncated) {
          if (this.framing === 'octet-counting') {
            this.octetsRemaining--;
            if (this.octetsRemaining === 0) {
              this.state = 'at-frame-start';
              return;
            }
          }
          this.state = 'in-message-truncating';
          return;
        }
      }
      if (this.framing === 'octet-counting') {
        this.octetsRemaining--;
        if (this.octetsRemaining < 1) {
          this.emit();
          this.state = 'at-frame-start';
        }
      }
    } else if (this.state === 'in-message-truncating') {
      if (this.framing === 'octet-counting') {
        this.octetsRemaining--;
        if (this.octetsRemaining < 1) this.state = 'at-frame-start';
      } else if (isDelimiter) {
        this.state = 'at-frame-start';
      }
    } else {
      this.processOctetCount(byte);
    }
  }

  private processOctetCount(byte: number): void {
    const settings = this.settings;
    if (byte >= DIGIT_ZERO && byte <= DIGIT_NINE) {
      if (this.octetsRemaining <= MAX_OCTET_COUNT_ACCUMULATOR) this.octetsRemaining = this.octetsRemaining * 10 + byte - DIGIT_ZERO;
      if (this.message.length < settings.maxLine) this.message.push(byte);
      return;
    }
    const prefix = `imtcp ${settings.inputName}: Framing Error in received TCP message from peer: ${this.describePeer()}:`;
    if (byte !== SP) this.sink.error(`${prefix} delimiter is not SP but has ASCII value ${byte}.`);
    if (this.octetsRemaining < 1) {
      this.sink.error(`${prefix} invalid octet count ${this.octetsRemaining}.`);
      this.framing = 'octet-stuffing';
    } else if (this.octetsRemaining > settings.maxLine) {
      this.frameOversize = true;
      this.sink.error(
        `imtcp ${settings.inputName}: received oversize message from peer: ${this.describePeer()}: size is ${this.octetsRemaining} bytes, max msg size is ${settings.maxLine}, truncating...`,
      );
    }
    if (this.octetsRemaining > settings.maxFrameSize) {
      this.sink.error(`${prefix} frame too large: ${this.octetsRemaining}, change to octet stuffing`);
      this.framing = 'octet-stuffing';
    } else {
      this.message = [];
    }
    this.state = 'in-message';
  }

  finish(): void {
    if (this.state === 'at-frame-start') return;
    if (this.framing === 'octet-counting') {
      this.sink.error('Incomplete frame at end of stream in session - ignoring extra data (a message may be lost).');
      return;
    }
    this.emit();
  }
}
