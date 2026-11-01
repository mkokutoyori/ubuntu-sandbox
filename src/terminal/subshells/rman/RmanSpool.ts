import type { VfsAdapter } from './integration/IRmanOracleContext';

const SPOOL_TO = /^SPOOL\s+LOG\s+TO\s+(?:'([^']+)'|"([^"]+)"|(\S+?))(\s+APPEND)?\s*;?$/i;
const SPOOL_OFF = /^SPOOL\s+LOG\s+OFF\s*;?$/i;

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

export class RmanSpool {
  private path: string | null = null;
  private written = '';

  constructor(private readonly vfs: VfsAdapter) {}

  isCommand(line: string): boolean {
    return SPOOL_TO.test(line) || SPOOL_OFF.test(line);
  }

  apply(line: string): string | null {
    if (SPOOL_OFF.test(line)) {
      this.path = null;
      this.written = '';
      return null;
    }
    const match = SPOOL_TO.exec(line);
    if (match === null) return null;
    const path = match[1] ?? match[2] ?? match[3];
    const previous = match[4] !== undefined && this.vfs.fileExists(path) ? this.readExisting(path) : '';
    this.path = path;
    this.written = previous;
    return this.flush();
  }

  record(lines: readonly string[]): string | null {
    if (this.path === null || lines.length === 0) return null;
    this.written += `${lines.join('\n')}\n`;
    return this.flush();
  }

  private readExisting(path: string): string {
    const read = this.vfs.readFile(path);
    return read.ok === true ? decode(read.value) : '';
  }

  private flush(): string | null {
    if (this.path === null) return null;
    const result = this.vfs.writeFile(this.path, encode(this.written));
    if (result.ok === true) return null;
    this.path = null;
    return result.error.message;
  }
}
