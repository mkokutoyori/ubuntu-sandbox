export const MESS_REALDEBUG = 1;
export const MESS_DEBUG = 2;
export const MESS_VERBOSE = 3;
export const MESS_NORMAL = 4;
export const MESS_ERROR = 5;
export const MESS_FATAL = 6;

export class LogrotateFatal extends Error {}

export class MessageLog {
  private threshold = MESS_NORMAL;
  private mirror: ((text: string) => void) | null = null;
  private chunks: string[] = [];

  setLevel(level: number): void { this.threshold = level; }

  setMirror(writer: ((text: string) => void) | null): void { this.mirror = writer; }

  write(text: string): void { this.chunks.push(text); }

  message(level: number, text: string): void {
    const prefix = level >= MESS_ERROR ? 'error: ' : '';
    if (level >= this.threshold) this.chunks.push(`${prefix}${text}`);
    this.mirror?.(`${prefix}${text}`);
    if (level === MESS_FATAL) throw new LogrotateFatal(text);
  }

  debug(text: string): void { this.message(MESS_DEBUG, text); }

  normal(text: string): void { this.message(MESS_NORMAL, text); }

  verbose(text: string): void { this.message(MESS_VERBOSE, text); }

  error(text: string): void { this.message(MESS_ERROR, text); }

  output(): string { return this.chunks.join(''); }
}
