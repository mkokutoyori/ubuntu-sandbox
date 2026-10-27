export type Newline = 'always' | 'terminal' | 'never';

export interface Chunk {
  readonly fd: 1 | 2;
  readonly text: string;
  readonly newline: Newline;
  readonly ambiguous: boolean;
}

function terminated(text: string): string {
  return text.length === 0 || text.endsWith('\n') ? text : `${text}\n`;
}

export class OutputLog {
  private readonly chunks: Chunk[] = [];

  write(fd: 1 | 2, text: string, newline: Newline = 'never', ambiguous = false): void {
    if (text !== '') this.chunks.push({ fd, text, newline, ambiguous });
  }

  split(index: number): { before: OutputLog; after: OutputLog } {
    const before = new OutputLog();
    const after = new OutputLog();
    this.chunks.forEach((chunk, position) => (position < index ? before : after).chunks.push(chunk));
    return { before, after };
  }

  entries(): readonly Chunk[] {
    return this.chunks;
  }

  stream(fd: 1 | 2): string {
    return this.chunks.filter((chunk) => chunk.fd === fd).map((chunk) => (chunk.newline === 'never' ? chunk.text : terminated(chunk.text))).join('');
  }

  terminal(excluded: ReadonlySet<1 | 2> = new Set()): string {
    return this.chunks
      .filter((chunk) => !excluded.has(chunk.fd))
      .map((chunk) => (chunk.newline === 'never' ? chunk.text : terminated(chunk.text))).join('');
  }
}
