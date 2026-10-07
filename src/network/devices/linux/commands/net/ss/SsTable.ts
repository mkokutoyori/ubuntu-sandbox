export const COLUMN = {
  NETID: 0, STATE: 1, RECVQ: 2, SENDQ: 3, ADDR: 4, SERV: 5, RADDR: 6, RSERV: 7, EXT: 8, PROC: 9, MAX: 10,
} as const;

type Alignment = 'left' | 'right';

interface Column {
  readonly align: Alignment;
  readonly header: string;
  readonly leftDelimiter: string;
  disabled: boolean;
  width: number;
  maxLength: number;
}

function newColumns(): Column[] {
  const define = (align: Alignment, header: string, leftDelimiter: string): Column => ({
    align, header, leftDelimiter, disabled: false, width: 0, maxLength: 0,
  });
  return [
    define('left', 'Netid', ''),
    define('left', 'State', ' '),
    define('left', 'Recv-Q', ' '),
    define('left', 'Send-Q', ' '),
    define('right', 'Local Address:', ' '),
    define('left', 'Port', ''),
    define('right', 'Peer Address:', ' '),
    define('left', 'Port', ''),
    define('left', 'Process', ''),
    define('left', '', ''),
  ];
}

export class SsTable {
  private readonly columns = newColumns();
  private readonly tokens: string[] = [];
  private current = 0;
  private pending = '';
  private started = false;

  disable(column: number): void {
    this.columns[column].disabled = true;
  }

  out(text: string): void {
    if (this.columns[this.current].disabled) return;
    this.started = true;
    this.pending += text;
  }

  private flush(): void {
    const column = this.columns[this.current];
    if (column.disabled) return;
    if (this.pending.length > column.maxLength) column.maxLength = this.pending.length;
    this.tokens.push(this.pending);
    this.pending = '';
  }

  next(): void {
    this.flush();
    this.current = this.current === COLUMN.MAX - 1 ? 0 : this.current + 1;
  }

  set(column: number): void {
    while (this.current !== column) this.next();
  }

  printHeader(): void {
    while (this.current !== COLUMN.MAX - 1) {
      if (!this.columns[this.current].disabled) this.out(this.columns[this.current].header);
      this.next();
    }
  }

  private calculateWidths(screenWidth: number | null): void {
    const limit = screenWidth ?? Number.MAX_SAFE_INTEGER;
    let first = true;
    for (const column of this.columns) {
      if (column.disabled) continue;
      column.width = !first && column.maxLength > 0
        ? column.maxLength + column.leftDelimiter.length : column.maxLength;
      column.width = Math.min(column.width, limit);
      if (column.width > 0) first = false;
    }
    if (screenWidth === null) return;

    let lineStart = -1;
    let length = 0;
    let lineColumns = 0;
    for (let index = 0; index < COLUMN.MAX; index++) {
      const column = this.columns[index];
      if (column.width === 0) continue;
      lineColumns++;
      length += column.width;
      let last = true;
      for (let after = index + 1; after < COLUMN.MAX; after++) {
        if (this.columns[after].width > 0) {
          last = false;
          break;
        }
      }
      if (!last && length < screenWidth) continue;
      let end = index;
      if (length !== screenWidth) {
        if (length > screenWidth) {
          length -= column.width;
          end--;
          lineColumns--;
        }
        const padding = screenWidth - length;
        const spacing = Math.floor(padding / lineColumns);
        let remainder = padding % lineColumns;
        for (let spread = end; spread > lineStart; spread--) {
          if (this.columns[spread].width === 0) continue;
          this.columns[spread].width += spacing;
          if (remainder > 0) {
            this.columns[spread].width++;
            remainder--;
          }
        }
      }
      lineStart = end;
      length = 0;
      lineColumns = 0;
      index = end;
    }
  }

  render(screenWidth: number | null): string {
    if (!this.started) return '';
    this.calculateWidths(screenWidth);
    let output = '';
    let lineStarted = false;
    let index = 0;
    while (index < COLUMN.MAX - 1 && this.columns[index].width === 0) index++;
    for (const token of [...this.tokens, this.pending]) {
      const column = this.columns[index];
      let printed = 0;
      if (lineStarted) {
        output += column.leftDelimiter;
        printed = column.leftDelimiter.length;
      }
      lineStarted = true;
      if (column.width > 0 && column.align === 'right') {
        const spaces = column.width - token.length - printed;
        if (spaces > 0) {
          output += ' '.repeat(spaces);
          printed += spaces;
        }
      }
      output += token;
      printed += token.length;
      if (column.width > 0 && column.align === 'left') {
        const spaces = column.width - printed;
        if (spaces > 0) output += ' '.repeat(spaces);
      }
      do {
        if (index === COLUMN.MAX - 1) {
          output += '\n';
          index = 0;
          lineStarted = false;
        } else {
          index++;
        }
      } while (this.columns[index].disabled);
    }
    if (lineStarted) output += '\n';
    return output;
  }
}
