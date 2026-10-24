import type { OpenReadResult, ReadableFile } from '../engine/Host';
import { RS_RET } from '../engine/Log';

export interface MonitorStreamServices {
  openFile(path: string): OpenReadResult;
  warning(text: string, code: number): void;
  error(text: string, code: number): void;
  nowSeconds(): number;
  maxMessageSize(): number;
}

export class StreamFailure extends Error {
  constructor(readonly code: number) {
    super(`stream failure ${code}`);
  }
}

export interface ReadLine {
  readonly text: string;
  readonly startOffset: number;
}

export interface ReadLineOptions {
  readonly mode: number;
  readonly escapeLF: boolean;
  readonly escapeLFString: string | null;
  readonly trimLineOverBytes: number;
}

export interface ReadMultiLineOptions {
  readonly startRegex: RegExp | null;
  readonly endRegex: RegExp | null;
  readonly escapeLF: boolean;
  readonly escapeLFString: string | null;
  readonly discardTruncatedMsg: boolean;
  readonly msgDiscardingError: boolean;
}

const BLOCK_SIZE = 4096;
const DEFAULT_LF_ESCAPE = '#012';

function endOfFile(): null {
  return null;
}

export class MonitorStream {
  currOffs = 0;
  strtOffs = 0;
  prevWasNL = false;
  prevLineSegment: string | null = null;
  prevMsgSegment: string | null = null;
  ignoringMsg = false;
  lastRead: number;
  readTimeout = 0;
  reopenOnTruncate = false;
  private file: ReadableFile | null = null;
  private filePosition = 0;
  private buffer = '';
  private bufferPointer = 0;
  private bufferMax = 0;
  private ungetChar: string | null = null;
  private openErrorReported = false;

  constructor(readonly path: string, private readonly services: MonitorStreamServices, private readonly fileNotFoundError: boolean) {
    this.lastRead = services.nowSeconds();
  }

  private open(): void {
    if (this.file !== null) return;
    const result = this.services.openFile(this.path);
    if ('error' in result) {
      const code = result.missing ? RS_RET.FILE_NOT_FOUND : RS_RET.FILE_OPEN_ERROR;
      if (this.fileNotFoundError && !this.openErrorReported) {
        this.openErrorReported = true;
        this.services.error(`file '${this.path}': open error: ${result.error}`, code);
      }
      throw new StreamFailure(code);
    }
    this.openErrorReported = false;
    this.file = result.file;
    this.currOffs = 0;
    this.bufferMax = 0;
    this.filePosition = 0;
  }

  closeFile(): void {
    this.file?.close();
    this.file = null;
  }

  seek(offset: number): void {
    this.open();
    this.filePosition = offset;
    this.strtOffs = offset;
    this.currOffs = offset;
    this.bufferPointer = 0;
  }

  currentInode(): number | null {
    return this.file === null ? null : this.file.inode;
  }

  private rereadTruncated(reason: string, data: number): void {
    this.services.warning(
      `file '${this.path}': truncation detected, (${reason}) - re-start reading from beginning (data ${data})`, RS_RET.FILE_TRUNCATED,
    );
    this.closeFile();
    this.open();
  }

  private checkTruncation(): boolean {
    if (this.bufferMax === 0) return false;
    const file = this.file as ReadableFile;
    const start = this.filePosition - this.bufferMax;
    const again = file.read(start, this.bufferMax);
    if (again.length !== this.bufferMax) {
      this.rereadTruncated('last block could not be re-read', again.length);
      return true;
    }
    if (again !== this.buffer.slice(0, this.bufferMax)) {
      this.rereadTruncated('last block data different', 0);
      return true;
    }
    return false;
  }

  private readBuffer(): boolean {
    for (;;) {
      this.open();
      if (this.reopenOnTruncate && this.checkTruncation()) continue;
      const chunk = (this.file as ReadableFile).read(this.filePosition, BLOCK_SIZE);
      if (chunk.length === 0) return false;
      this.buffer = chunk;
      this.bufferMax = chunk.length;
      this.filePosition += chunk.length;
      this.bufferPointer = 0;
      return true;
    }
  }

  private readChar(): string | null {
    if (this.ungetChar !== null) {
      const char = this.ungetChar;
      this.currOffs++;
      this.ungetChar = null;
      return char;
    }
    if (this.bufferPointer >= this.bufferMax && !this.readBuffer()) return endOfFile();
    const char = this.buffer[this.bufferPointer++];
    this.currOffs++;
    return char;
  }

  private unreadChar(char: string): void {
    this.ungetChar = char;
    this.currOffs--;
  }

  private finishLine(text: string): ReadLine {
    const startOffset = this.strtOffs;
    this.strtOffs = this.currOffs;
    return { text, startOffset };
  }

  readLine(options: ReadLineOptions): ReadLine | null {
    let c = this.readChar();
    if (c === null) return null;
    let line = '';
    if (this.prevLineSegment !== null) {
      line += this.prevLineSegment;
      this.prevLineSegment = null;
    }
    const escapeText = options.escapeLFString ?? DEFAULT_LF_ESCAPE;
    const escapeLength = options.escapeLFString === null ? 4 : options.escapeLFString.length;
    const trim = (): void => {
      if (options.trimLineOverBytes > 0 && line.length > options.trimLineOverBytes) line = `${line.slice(0, options.trimLineOverBytes)}\n`;
    };
    const interrupted = (): null => {
      if (line.length > 0) this.prevLineSegment = line;
      return null;
    };
    if (options.mode === 0) {
      while (c !== '\n') {
        line += c;
        c = this.readChar();
        if (c === null) return interrupted();
      }
      trim();
      return this.finishLine(line);
    }
    if (options.mode === 1) {
      let finished = false;
      while (!finished) {
        if (c !== '\n') {
          line += c;
          c = this.readChar();
          if (c === null) return interrupted();
          this.prevWasNL = false;
        } else if (line.length > 0) {
          if (this.prevWasNL && escapeLength > 0) {
            line = line.slice(0, line.length - (options.escapeLF ? escapeLength : 1));
            finished = true;
          } else {
            line += options.escapeLF ? escapeText : c;
            c = this.readChar();
            if (c === null) return interrupted();
            this.prevWasNL = true;
          }
        } else {
          finished = true;
        }
      }
      this.prevWasNL = false;
      return this.finishLine(line);
    }
    let finished = false;
    while (!finished) {
      if (line.length === 0) {
        if (c !== '\n') {
          line += c;
          c = this.readChar();
          if (c === null) return interrupted();
        } else {
          finished = true;
        }
      } else if (this.prevWasNL) {
        if (c === ' ' || c === '\t') {
          line += c;
          c = this.readChar();
          if (c === null) return interrupted();
          this.prevWasNL = false;
        } else {
          this.unreadChar(c);
          if (options.escapeLF && escapeLength > 0) line = line.slice(0, line.length - escapeLength);
          finished = true;
        }
      } else {
        if (c === '\n') {
          this.prevWasNL = true;
          line += options.escapeLF && escapeLength > 0 ? escapeText : c;
        } else {
          line += c;
        }
        c = this.readChar();
        if (c === null) return interrupted();
      }
    }
    trim();
    this.prevWasNL = false;
    return this.finishLine(line);
  }

  isTimedOut(): boolean {
    return this.readTimeout > 0 && this.prevMsgSegment !== null && this.services.nowSeconds() > this.lastRead + this.readTimeout;
  }

  readMultiLine(options: ReadMultiLineOptions): ReadLine | null {
    const now = this.readTimeout > 0 ? this.services.nowSeconds() : 0;
    const maxMessageSize = this.services.maxMessageSize();
    const startOffset = this.strtOffs;
    let result: string | null = null;
    let reachedEnd = false;
    do {
      let c = this.readChar();
      if (c === null) {
        reachedEnd = true;
        break;
      }
      this.lastRead = now;
      let line = '';
      if (this.prevLineSegment !== null) {
        line += this.prevLineSegment;
        this.prevLineSegment = null;
      }
      while (c !== '\n') {
        line += c;
        c = this.readChar();
        if (c === null) {
          this.prevLineSegment = line;
          reachedEnd = true;
          break;
        }
      }
      if (reachedEnd) break;
      const isStart = options.startRegex !== null && options.startRegex.test(line);
      const isEnd = options.endRegex !== null && options.endRegex.test(line);
      if (isStart) {
        if (!this.ignoringMsg && this.prevMsgSegment !== null) result = this.prevMsgSegment;
        this.prevMsgSegment = line;
        this.ignoringMsg = false;
      } else if (!this.ignoringMsg) {
        if (this.prevMsgSegment === null) {
          this.prevMsgSegment = line;
        } else {
          this.prevMsgSegment += options.escapeLF ? (options.escapeLFString ?? '\\n') : '\n';
          if (line.length > 0) {
            const combined = this.prevMsgSegment.length + line.length;
            if (combined < maxMessageSize) {
              this.prevMsgSegment += line;
            } else {
              let consumed = line.length;
              if (this.prevMsgSegment.length > maxMessageSize) {
                consumed = 0;
              } else {
                consumed = line.length - (combined - maxMessageSize);
                this.prevMsgSegment += line.slice(0, consumed);
              }
              result = this.prevMsgSegment;
              this.prevMsgSegment = line.slice(consumed);
              if (options.discardTruncatedMsg) this.ignoringMsg = true;
              if (options.msgDiscardingError) {
                this.services.error(
                  options.discardTruncatedMsg
                    ? 'imfile error: message received is larger than max msg size; rest of message will not be processed'
                    : 'imfile error: message received is larger than max msg size; message will be split and processed as another message',
                  RS_RET.ERR,
                );
              }
            }
          }
        }
      }
      if (isEnd) {
        if (!this.ignoringMsg && this.prevMsgSegment !== null) {
          result = this.prevMsgSegment;
          this.prevMsgSegment = null;
        }
        this.ignoringMsg = false;
      }
    } while (result === null);
    if (result !== null) {
      this.strtOffs = this.currOffs;
      return { text: result, startOffset };
    }
    if (reachedEnd && this.readTimeout > 0 && this.prevMsgSegment !== null && now > this.lastRead + this.readTimeout) {
      const text = this.prevMsgSegment;
      this.prevMsgSegment = null;
      this.lastRead = now;
      this.strtOffs = this.currOffs;
      return { text, startOffset };
    }
    return null;
  }
}
