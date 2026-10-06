import { LdapDebug, type LdapLog, berBprint } from './ldapLog';

export const LBER_DEFAULT = -1;
const LBER_BIG_TAG_MASK = 0x1f;
const LBER_MORE_TAG_MASK = 0x80;
const LEN_SIZEOF = 8;

export interface BerValue {
  start: number;
  length: number;
}

export function formatPointer(address: number): string {
  return `0x${address.toString(16)}`;
}

export class BerElement {
  readonly buf: Uint8Array;
  ptr: number;
  end: number;
  tag: number;
  lastLength = 0;
  lastStringBv: BerValue = { start: 0, length: 0 };

  constructor(
    contents: Uint8Array,
    readonly address: number,
    private readonly log: LdapLog,
    shared?: { buf: Uint8Array; ptr: number; end: number; tag: number },
  ) {
    if (shared !== undefined) {
      this.buf = shared.buf;
      this.ptr = shared.ptr;
      this.end = shared.end;
      this.tag = shared.tag;
      return;
    }
    this.buf = new Uint8Array(contents.length + 1);
    this.buf.set(contents, 0);
    this.ptr = 0;
    this.end = contents.length;
    this.tag = 0;
  }

  copy(): BerElement {
    return new BerElement(this.buf, this.address, this.log, {
      buf: this.buf, ptr: this.ptr, end: this.end, tag: this.tag,
    });
  }

  assign(other: BerElement): void {
    this.ptr = other.ptr;
    this.end = other.end;
    this.tag = other.tag;
  }

  remaining(): number {
    return this.end - this.ptr;
  }

  setRemainingBytes(length: number): void {
    this.end = this.ptr + length;
  }

  contentsFromStart(): Uint8Array {
    return this.buf.slice(0, this.buf.length - 1);
  }

  private tagAndRest(): { tag: number; start: number; rest: number } {
    let ptr = this.ptr;
    let rest = this.end - ptr;
    if (rest <= 0) return { tag: LBER_DEFAULT, start: ptr, rest };
    let tag = this.tag;
    if (ptr === 0) tag = this.buf[ptr];
    ptr++;
    rest--;
    if ((tag & LBER_BIG_TAG_MASK) !== LBER_BIG_TAG_MASK) return { tag, start: ptr, rest };
    do {
      if (rest <= 0) break;
      tag = tag * 256 + (this.buf[ptr++] & 0xff);
      rest--;
      if ((tag & LBER_MORE_TAG_MASK) === 0) return { tag, start: ptr, rest };
    } while (tag <= 0xffffffffffff / 256);
    return { tag: LBER_DEFAULT, start: ptr, rest };
  }

  peekElement(): { tag: number; value: BerValue } {
    const head = this.tagAndRest();
    let rest = head.rest;
    let ptr = head.start;
    if (head.tag === LBER_DEFAULT || rest === 0) return { tag: LBER_DEFAULT, value: { start: ptr, length: 0 } };
    let len = this.buf[ptr++];
    rest--;
    if ((len & 0x80) !== 0) {
      len &= 0x7f;
      if (len - 1 > LEN_SIZEOF - 1 || len === 0 || rest < len) return { tag: LBER_DEFAULT, value: { start: ptr, length: 0 } };
      rest -= len;
      let i = len;
      len = this.buf[ptr++] & 0xff;
      while (--i > 0) {
        len = len * 256 + (this.buf[ptr++] & 0xff);
      }
    }
    if (len > rest) return { tag: LBER_DEFAULT, value: { start: ptr, length: len } };
    return { tag: head.tag, value: { start: ptr, length: len } };
  }

  skipElement(): { tag: number; value: BerValue } {
    const element = this.peekElement();
    if (element.tag !== LBER_DEFAULT) {
      this.ptr = element.value.start + element.value.length;
      this.tag = this.buf[this.ptr];
    }
    return element;
  }

  skipTag(): { tag: number; length: number } {
    const element = this.peekElement();
    this.ptr = element.value.start;
    this.tag = this.buf[this.ptr];
    return { tag: element.tag, length: element.value.length };
  }

  peekTag(): { tag: number; length: number } {
    const element = this.peekElement();
    return { tag: element.tag, length: element.value.length };
  }

  getInt(): { tag: number; value: number } {
    const element = this.skipElement();
    if (element.tag === LBER_DEFAULT) return { tag: LBER_DEFAULT, value: 0 };
    if (element.value.length > 4) return { tag: LBER_DEFAULT, value: 0 };
    let value = 0;
    const { start, length } = element.value;
    if (length > 0) {
      value = ((this.buf[start] & 0xff) ^ 0x80) - 0x80;
      for (let i = 1; i < length; i++) value = (value << 8) | this.buf[start + i];
    }
    return { tag: element.tag, value };
  }

  getStringbv(terminate: boolean): { tag: number; value: BerValue } {
    const element = this.skipElement();
    if (element.tag === LBER_DEFAULT) return element;
    if (terminate) this.buf[element.value.start + element.value.length] = 0;
    return element;
  }

  private getStringbvl(terminate: boolean): number {
    const header = this.skipTag();
    if (header.tag === LBER_DEFAULT) return LBER_DEFAULT;
    const orig = this.ptr;
    const last = orig + header.length;
    let count = 0;
    for (; this.ptr < last; count++) {
      if (this.skipElement().tag === LBER_DEFAULT) break;
    }
    let tag = 0;
    if (this.ptr !== last) {
      count = 0;
      tag = LBER_DEFAULT;
    }
    this.ptr = orig;
    this.tag = this.buf[orig];
    if (count === 0) return tag;
    for (let n = 0; n < count; n++) {
      const element = this.getStringbv(terminate);
      if (element.tag === LBER_DEFAULT) return LBER_DEFAULT;
      tag = element.tag;
    }
    return tag;
  }

  firstElement(): { tag: number; last: number } {
    const header = this.skipTag();
    if (header.tag === LBER_DEFAULT) return { tag: LBER_DEFAULT, last: -1 };
    const last = this.ptr + header.length;
    if (header.length === 0) return { tag: LBER_DEFAULT, last };
    return { tag: this.peekTag().tag, last };
  }

  nextElement(last: number): number {
    if (this.ptr >= last) return LBER_DEFAULT;
    return this.peekTag().tag;
  }

  scanf(fmt: string): number {
    if (this.log.enabled(LdapDebug.TRACE | LdapDebug.BER)) {
      this.log.debug(LdapDebug.TRACE, `ber_scanf fmt (${fmt}) ber:\n`);
      this.dump();
    }
    let rc = 0;
    for (let i = 0; i < fmt.length && rc !== LBER_DEFAULT; i++) {
      switch (fmt[i]) {
        case 'a': case 'A': case 'o': case 'O': case 'b': case 'e': case 'i': case 'm': case 'n': case 's': case 'B':
          rc = this.scanScalar(fmt[i]);
          break;
        case 'l': {
          const peeked = this.peekTag();
          rc = peeked.tag;
          this.lastLength = peeked.length;
          break;
        }
        case 't':
          rc = this.peekTag().tag;
          break;
        case 'T':
          rc = this.skipTag().tag;
          break;
        case 'x':
          rc = this.skipElement().tag;
          break;
        case 'M':
          rc = this.getStringbvl(true);
          break;
        case 'v': case 'V': case 'W':
          rc = this.getStringbvl(false);
          break;
        case '{': case '[':
          switch (fmt[i + 1]) {
            case 'v': case 'V': case 'W': case 'M':
              break;
            default:
              rc = this.skipTag().tag;
              break;
          }
          break;
        case '}': case ']':
          break;
        default:
          this.log.debug(LdapDebug.ANY, `ber_scanf: unknown fmt ${fmt[i]}\n`);
          rc = LBER_DEFAULT;
      }
    }
    return rc;
  }

  private scanScalar(format: string): number {
    switch (format) {
      case 'b': case 'e': case 'i':
        return this.getInt().tag;
      case 'n': {
        const header = this.skipTag();
        return header.length === 0 ? header.tag : LBER_DEFAULT;
      }
      case 'm': {
        const element = this.getStringbv(true);
        this.lastStringBv = element.value;
        return element.tag;
      }
      case 'o': case 'O': case 'a': case 'A': case 's': case 'B':
        return this.skipElement().tag;
      default:
        return LBER_DEFAULT;
    }
  }

  dump(): void {
    const length = this.remaining();
    this.log.debug(
      LdapDebug.BER,
      `ber_dump: buf=${formatPointer(this.address)} ptr=${formatPointer(this.address + this.ptr)} end=${formatPointer(this.address + this.end)} len=${length}\n`,
    );
    this.log.debug(LdapDebug.BER, berBprint(this.buf.slice(this.ptr, this.ptr + length)));
  }
}
