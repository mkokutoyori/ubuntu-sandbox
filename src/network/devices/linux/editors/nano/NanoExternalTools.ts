export interface LintMessage {
  readonly filename: string;
  readonly line: number;
  readonly column: number;
  readonly text: string;
}

class Strtok {
  private position = 0;

  constructor(private readonly text: string) {}

  next(delimiters: string): string | null {
    while (this.position < this.text.length && delimiters.includes(this.text[this.position])) this.position++;
    if (this.position >= this.text.length) return null;
    const start = this.position;
    while (this.position < this.text.length && !delimiters.includes(this.text[this.position])) this.position++;
    const token = this.text.slice(start, this.position);
    if (this.position < this.text.length) this.position++;
    return token;
  }
}

function toInteger(text: string): number {
  const match = /^[ \t\n\v\f\r]*([+-]?\d+)/.exec(text);
  return match === null ? 0 : Number.parseInt(match[1], 10);
}

export function argumentList(command: string, filename: string): string[] {
  return [...command.split(' ').filter((element) => element !== ''), filename];
}

export function shellCommandLine(argv: readonly string[]): string {
  return argv.map((word) => `'${word.replaceAll("'", "'\\''")}'`).join(' ');
}

function parseOneMessage(line: string): { skipped: boolean; message: LintMessage | null } {
  const spacer = line.indexOf(' ');
  const tokens = new Strtok(line);
  const filename = tokens.next(':');
  if (filename === null || spacer < 0) return { skipped: false, message: null };
  const lineString = tokens.next(':');
  if (lineString === null) return { skipped: false, message: null };
  const columnString = tokens.next(' ');
  if (columnString === null) return { skipped: false, message: null };
  const lineNumber = toInteger(lineString);
  let columnNumber = toInteger(columnString);
  if (lineNumber <= 0) return { skipped: true, message: null };
  if (columnNumber <= 0) {
    columnNumber = 1;
    const split = new Strtok(lineString);
    split.next(',');
    const second = split.next(',');
    if (second !== null) columnNumber = toInteger(second);
  }
  return { skipped: false, message: { filename, line: lineNumber, column: columnNumber, text: line.slice(spacer + 1) } };
}

export function parseLintOutput(output: string): LintMessage[] {
  const messages: LintMessage[] = [];
  let lineStart = 0;
  let afterSkippedLine = false;
  for (let scan = 0; scan < output.length; scan++) {
    if (output[scan] !== '\r' && output[scan] !== '\n') continue;
    if (afterSkippedLine) {
      afterSkippedLine = false;
      lineStart = scan + 1;
      continue;
    }
    if (lineStart !== scan) {
      const parsed = parseOneMessage(output.slice(lineStart, scan));
      if (parsed.message !== null) messages.push(parsed.message);
      if (parsed.skipped) {
        afterSkippedLine = true;
        continue;
      }
    }
    lineStart = scan + 1;
  }
  return messages;
}
