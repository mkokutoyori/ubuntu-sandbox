export const ENCINFO_SUFFIX = '.encinfo';
export const FILETYPE_NAME = 'rsyslog-enrcyption-info';
export const MAX_RECORD_TYPE_LENGTH = 31;
export const MAX_RECORD_VALUE_LENGTH = 1023;

const FILETYPE_RECORD = `FILETYPE:${FILETYPE_NAME}\n`;

export function encryptionInfoPath(logFile: string): string {
  return `${logFile}${ENCINFO_SUFFIX}`;
}

export function fileTypeRecord(): string {
  return FILETYPE_RECORD;
}

export function hexOf(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function ivRecord(iv: Uint8Array): string {
  return `IV:${hexOf(iv)}\n`;
}

export function endRecord(offset: number): string {
  return `END:${offset}\n`;
}

export function hasFileType(text: string): boolean {
  return text.slice(0, FILETYPE_RECORD.length) === FILETYPE_RECORD;
}

export type RecordResult =
  | { readonly kind: 'record'; readonly type: string; readonly value: string }
  | { readonly kind: 'eof' }
  | { readonly kind: 'invalid' };

export class EncryptionInfoReader {
  private at: number;

  constructor(private readonly text: string, start = 0) {
    this.at = start;
  }

  get position(): number {
    return this.at;
  }

  skipFileType(): boolean {
    if (!hasFileType(this.text)) return false;
    this.at = FILETYPE_RECORD.length;
    return true;
  }

  atEnd(): boolean {
    return this.at >= this.text.length;
  }

  nextRecord(): RecordResult {
    if (this.at >= this.text.length) return { kind: 'eof' };
    let index = this.at;
    let type = '';
    while (index < this.text.length && type.length < MAX_RECORD_TYPE_LENGTH && this.text[index] !== ':') type += this.text[index++];
    if (this.text[index] !== ':') return { kind: 'invalid' };
    index++;
    let value = '';
    while (index < this.text.length && value.length < MAX_RECORD_VALUE_LENGTH && this.text[index] !== '\n') value += this.text[index++];
    if (this.text[index] !== '\n') return { kind: 'invalid' };
    this.at = index + 1;
    return { kind: 'record', type, value };
  }

  nextIv(length: number): Uint8Array | null {
    const record = this.nextRecord();
    if (record.kind !== 'record' || record.type !== 'IV') return null;
    if (record.value.length / 2 !== length) return null;
    const iv = new Uint8Array(length);
    for (let index = 0; index < record.value.length; index++) {
      const digit = record.value[index];
      let nibble: number;
      if (digit >= '0' && digit <= '9') nibble = digit.charCodeAt(0) - 48;
      else if (digit >= 'a' && digit <= 'f') nibble = digit.charCodeAt(0) - 87;
      else return null;
      if (index % 2 === 0) iv[index >> 1] = nibble << 4;
      else iv[index >> 1] |= nibble;
    }
    return iv;
  }

  nextEnd():
    | { readonly kind: 'end'; readonly offset: number }
    | { readonly kind: 'eof' }
    | { readonly kind: 'other'; readonly type: string }
    | { readonly kind: 'invalid' } {
    const record = this.nextRecord();
    if (record.kind === 'eof') return { kind: 'eof' };
    if (record.kind === 'invalid') return { kind: 'invalid' };
    if (record.type !== 'END') return { kind: 'other', type: record.type };
    return { kind: 'end', offset: Number.parseInt(record.value, 10) || 0 };
  }
}
