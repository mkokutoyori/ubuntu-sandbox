const MAX_BUFFERED_CHARS = 1 << 20;

export class JsonMessageAssembler {
  private buffer = '';
  private scanned = 0;
  private begin = 0;
  private depth = 0;
  private inString = false;
  private escaped = false;

  push(chunk: string): Array<Record<string, unknown>> {
    this.buffer += chunk;
    const messages: Array<Record<string, unknown>> = [];
    for (let end = this.endOfObject(); end >= 0; end = this.endOfObject()) {
      const message = parseObject(this.buffer.slice(this.begin, end + 1));
      this.buffer = this.buffer.slice(end + 1);
      this.restartScan();
      if (message !== null) messages.push(message);
    }
    if (this.buffer.length > MAX_BUFFERED_CHARS) {
      this.buffer = '';
      this.restartScan();
    }
    return messages;
  }

  private endOfObject(): number {
    for (; this.scanned < this.buffer.length; this.scanned++) {
      const char = this.buffer[this.scanned];
      if (this.depth === 0) {
        if (char === '{') {
          this.begin = this.scanned;
          this.depth = 1;
        }
      } else if (this.inString) {
        if (this.escaped) this.escaped = false;
        else if (char === '\\') this.escaped = true;
        else if (char === '"') this.inString = false;
      } else if (char === '"') {
        this.inString = true;
      } else if (char === '{') {
        this.depth++;
      } else if (char === '}' && --this.depth === 0) {
        return this.scanned;
      }
    }
    return -1;
  }

  private restartScan(): void {
    this.scanned = 0;
    this.begin = 0;
    this.depth = 0;
    this.inString = false;
    this.escaped = false;
  }
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}
