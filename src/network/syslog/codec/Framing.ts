export const DEFAULT_MAX_MESSAGE_LENGTH = 8192;

export function frameOctetCounted(message: string): string {
  return `${new TextEncoder().encode(message).length} ${message}`;
}

export function frameNonTransparent(message: string, trailer = '\n'): string {
  return message + trailer;
}

export class SyslogStreamDecoder {
  private buffer = '';

  constructor(
    private readonly onMessage: (message: string) => void,
    private readonly trailer: string = '\n',
    private readonly maxLength: number = DEFAULT_MAX_MESSAGE_LENGTH,
  ) {}

  push(data: string): void {
    this.buffer += data;
    for (;;) {
      const counted = /^(\d+) /.exec(this.buffer);
      if (counted !== null && this.buffer[0] !== '<') {
        const length = Number(counted[1]);
        const start = counted[0].length;
        const encoded = new TextEncoder().encode(this.buffer.slice(start));
        if (encoded.length < length) return;
        const message = new TextDecoder().decode(encoded.slice(0, length));
        this.buffer = new TextDecoder().decode(encoded.slice(length));
        this.onMessage(message);
        continue;
      }
      const end = this.buffer.indexOf(this.trailer);
      if (end < 0) {
        if (this.buffer.length > this.maxLength) {
          this.onMessage(this.buffer.slice(0, this.maxLength));
          this.buffer = this.buffer.slice(this.maxLength);
          continue;
        }
        return;
      }
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + this.trailer.length);
      if (line.length > 0) this.onMessage(line);
    }
  }
}
