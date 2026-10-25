import { YamlFailure } from './YamlTypes';

const RAW_BUFFER_SIZE = 16384;
const BYTE_ORDER_MARK = 0xfeff;

function utf8Width(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

function isAllowedCharacter(value: number): boolean {
  return value === 0x09 || value === 0x0a || value === 0x0d
    || (value >= 0x20 && value <= 0x7e)
    || value === 0x85
    || (value >= 0xa0 && value <= 0xd7ff)
    || (value >= 0xe000 && value <= 0xfffd)
    || (value >= 0x10000 && value <= 0x10ffff);
}

export class YamlReader {
  private readonly source: number[] = [];
  private readonly ends: number[] = [];
  private readonly decoded: number[] = [];
  private nextSource = 0;
  private bytesRead = 0;
  private bytesDecoded = 0;
  private endOfInput = false;
  pointer = 0;

  constructor(text: string) {
    let offset = 0;
    for (const symbol of text) {
      const codePoint = symbol.codePointAt(0) as number;
      const value = codePoint >= 0xd800 && codePoint <= 0xdfff ? 0xfffd : codePoint;
      offset += utf8Width(value);
      this.source.push(value);
      this.ends.push(offset);
    }
    if (this.source[0] === BYTE_ORDER_MARK) {
      this.nextSource = 1;
      this.bytesDecoded = this.ends[0];
    }
  }

  cache(length: number): void {
    while (this.decoded.length - this.pointer < length && !this.endOfInput) this.fill();
  }

  at(offset: number): number {
    return this.decoded[this.pointer + offset] ?? 0;
  }

  advance(count: number): void {
    this.pointer += count;
  }

  private fill(): void {
    this.bytesRead += RAW_BUFFER_SIZE;
    while (this.nextSource < this.source.length && this.ends[this.nextSource] <= this.bytesRead) {
      const value = this.source[this.nextSource];
      if (!isAllowedCharacter(value)) {
        throw new YamlFailure({
          kind: 'reader',
          problem: 'control characters are not allowed',
          context: null,
          contextMark: null,
          problemMark: null,
          problemOffset: this.bytesDecoded,
          problemValue: value,
        });
      }
      this.decoded.push(value);
      this.bytesDecoded = this.ends[this.nextSource];
      this.nextSource++;
    }
    if (this.nextSource >= this.source.length && this.bytesRead >= this.bytesDecoded) this.endOfInput = true;
  }
}
