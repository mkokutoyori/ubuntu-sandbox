import { expandLine, type Cell, type CellOptions, type ListSpec } from './VimCells';

export interface WindowHost {
  lineCount(): number;
  lineAt(index: number): string;
}

export interface WindowSettings {
  readonly tabstop: number;
  readonly wrap: boolean;
  readonly number: boolean;
  readonly relativenumber: boolean;
  readonly numberwidth: number;
  readonly list: boolean;
  readonly listchars: ListSpec;
  readonly scrolloff: number;
  readonly sidescroll: number;
  readonly sidescrolloff: number;
}

export interface CursorCell {
  readonly row: number;
  readonly col: number;
}

export interface WindowView {
  readonly top: number;
  readonly botLine: number;
  readonly emptyRows: number;
  readonly height: number;
  readonly wraps: boolean;
  readonly textWidth: number;
  readonly leftCol: number;
  rowsOf(index: number): number;
  cursorCorrect(line: number): number;
  cellCount(line: number): number;
  virtColumn(line: number, col: number, onTabEnd: boolean): number;
  charCells(line: number, col: number): { end: number; width: number };
  colAtCell(line: number, cell: number, allowEol: boolean): number;
}

const UNBOUNDED = Number.MAX_SAFE_INTEGER;
const FRACTION_MULT = 16384;

export class VimWindow implements WindowView {
  private rowCount = 24;
  private colCount = 80;
  private topLnum = 1;
  private leftColumn = 0;
  private botLnum = 1;
  private emptyRowCount = 0;
  private readonly cellCache = new Map<string, Cell[]>();
  private cacheKey = '';
  private fraction = 0;
  private fractionRow = -1;
  private botValid = false;
  private botApprox = false;
  private validCursor = -1;
  private redrawing = false;
  private topValid = false;
  private skipCol = 0;
  private wrow = 0;
  private cursorPos = { line: 0, col: 0, tabEnd: true };
  private knownLines: string[] = [];

  constructor(private readonly host: WindowHost, private readonly settings: () => WindowSettings) {}

  get rows(): number { return this.rowCount; }
  get cols(): number { return this.colCount; }
  get height(): number { return Math.max(1, this.rowCount - 1); }
  get top(): number { return this.topLnum - 1; }
  get leftCol(): number { return this.leftColumn; }
  get skipColumn(): number { return this.skipCol; }
  get skipRows(): number {
    if (this.skipCol === 0) return 0;
    const width = this.textWidth;
    return this.skipCol >= width ? Math.floor((this.skipCol - width) / width) + 1 : 0;
  }
  get wraps(): boolean { return this.settings().wrap; }
  get defaultScroll(): number { return Math.max(1, Math.floor(this.height / 2)); }

  setSize(rows: number, cols: number): void {
    this.rowCount = Math.max(2, rows);
    this.colCount = Math.max(1, cols);
  }

  resize(rows: number, cols: number, cursorLine: number, cursorCol: number, onTabEnd: boolean): void {
    const previousHeight = this.height;
    const previousRow = this.cursorCell(cursorLine, cursorCol, onTabEnd)?.row ?? 0;
    const nextHeight = Math.max(1, rows - 1);
    const nextWidth = Math.max(1, cols);
    if (nextHeight === previousHeight && nextWidth === this.colCount) return;
    this.cursorPos = { line: cursorLine, col: cursorCol, tabEnd: onTabEnd };
    this.rowCount = Math.max(2, rows);
    if (nextHeight !== previousHeight) {
      if (previousRow !== this.fractionRow && previousHeight > 1) {
        this.fraction = Math.floor((previousRow * FRACTION_MULT + FRACTION_MULT / 2) / previousHeight);
      }
      this.skipCol = 0;
      this.scrollToFraction(cursorLine, cursorCol, onTabEnd);
      this.cursColumns(cursorLine);
      this.fractionRow = this.cursorCell(cursorLine, cursorCol, onTabEnd)?.row ?? this.fractionRow;
      this.invalidateBotline();
    }
    if (nextWidth !== this.colCount) {
      this.colCount = nextWidth;
      this.topValid = false;
      this.invalidateBotline();
      this.cursColumns(cursorLine);
    }
    this.topValid = false;
    this.invalidateBotline();
  }

  private scrollToFraction(cursorLine: number, cursorCol: number, onTabEnd: boolean): void {
    const height = this.height;
    if (height > 0 && (height < this.lineCount || this.topLnum > 1)) {
      let lnum = Math.max(1, cursorLine + 1);
      let wrow = Math.floor((this.fraction * height - 1) / FRACTION_MULT);
      let lineSize = this.rowsToColumn(cursorLine, cursorCol, onTabEnd);
      let sline = wrow - lineSize;
      if (sline >= 0) {
        const rows = this.fullRows(lnum);
        if (sline > height - rows) {
          sline = height - rows;
          wrow -= rows - lineSize;
        }
      }
      if (sline < 0) {
        wrow = lineSize;
        if (wrow >= height && this.textWidth > 0) {
          this.skipCol += this.textWidth;
          wrow--;
          while (wrow >= height) {
            this.skipCol += this.textWidth;
            wrow--;
          }
        }
      } else if (sline > 0) {
        while (sline > 0 && lnum > 1) {
          lnum--;
          lineSize = this.plines(lnum);
          sline -= lineSize;
        }
        if (sline < 0) {
          lnum++;
          wrow -= lineSize + sline;
        } else if (sline > 0) {
          lnum = 1;
          wrow -= sline;
        }
      }
      this.setTopline(Math.max(1, Math.min(lnum, this.lineCount)));
      this.fractionRow = wrow;
    }
    this.invalidateBotline();
  }

  private rowsToColumn(cursorLine: number, cursorCol: number, onTabEnd: boolean): number {
    if (!this.settings().wrap) return 0;
    const { start, end } = this.cursorSpan(cursorLine, cursorCol, false);
    const text = this.host.lineAt(cursorLine);
    const col = text[cursorCol] === '\t' && onTabEnd && !this.settings().list ? end : start;
    const width = this.textWidth;
    return col > width ? Math.floor((col - width) / width) + 1 : 0;
  }

  setTop(index: number): void {
    this.setTopline(Math.max(1, Math.min(index + 1, Math.max(1, this.lineCount))));
  }

  private setTopline(lnum: number): void {
    this.botLnum = Math.min(this.botLnum + lnum - this.topLnum, this.lineCount + 1);
    this.topLnum = lnum;
    this.botValid = false;
    this.topValid = false;
  }

  setLeftCol(column: number): void {
    this.leftColumn = Math.max(0, column);
  }

  private get lineCount(): number { return this.host.lineCount(); }

  get numberColumn(): number {
    const s = this.settings();
    if (!s.number && !s.relativenumber) return 0;
    let count = s.relativenumber && !s.number ? this.height : this.lineCount;
    let digits = 0;
    do { count = Math.floor(count / 10); digits++; } while (count > 0);
    return Math.max(digits, s.numberwidth - 1) + 1;
  }

  get textWidth(): number { return Math.max(1, this.colCount - this.numberColumn); }

  private cellOptions(): CellOptions {
    const s = this.settings();
    return { tabstop: s.tabstop, list: s.list, listchars: s.listchars, wrapWidth: s.wrap ? this.textWidth : null };
  }

  cellsOf(index: number): readonly Cell[] {
    const options = this.cellOptions();
    const signature = `${options.tabstop}|${options.list}|${JSON.stringify(options.listchars)}|${options.wrapWidth}`;
    if (signature !== this.cacheKey) {
      this.cellCache.clear();
      this.cacheKey = signature;
    }
    const text = this.host.lineAt(index);
    let cells = this.cellCache.get(text);
    if (!cells) {
      cells = expandLine(text, options);
      if (this.cellCache.size > 4096) this.cellCache.clear();
      this.cellCache.set(text, cells);
    }
    return cells;
  }

  lineWidth(index: number): number {
    const s = this.settings();
    return this.cellsOf(index).length + (s.list && s.listchars.eol !== null ? 1 : 0);
  }

  private fullRows(lnum: number): number {
    if (!this.settings().wrap) return 1;
    const width = this.lineWidth(lnum - 1);
    const available = this.textWidth;
    return width <= available ? 1 : Math.ceil(width / available);
  }

  private plines(lnum: number): number { return Math.min(this.fullRows(lnum), this.height); }

  private plinesCorrectTopline(lnum: number): number {
    const rows = lnum === this.topLnum ? this.fullRows(lnum) - this.skipRows : this.fullRows(lnum);
    return Math.min(rows, this.height);
  }

  rowsOf(index: number): number { return this.fullRows(index + 1); }

  private get so(): number { return Math.max(0, this.settings().scrolloff); }

  get botLine(): number { this.validateBotline(); return this.botLnum - 1; }
  get emptyRows(): number { this.validateBotline(); return this.emptyRowCount; }

  private compBotline(): void {
    let lnum = this.topLnum;
    let done = 0;
    const height = this.height;
    for (; lnum <= this.lineCount; lnum++) {
      const n = this.plinesCorrectTopline(lnum);
      if (done + n > height) break;
      done += n;
    }
    this.botLnum = lnum;
    this.emptyRowCount = done === 0 ? 0 : height - done;
    this.botValid = true;
    this.botApprox = true;
  }

  private validateBotline(): void {
    if (!this.botValid) this.compBotline();
  }

  private invalidateBotline(): void {
    this.botValid = false;
    this.botApprox = false;
  }

  relativePosition(): 'All' | 'Top' | 'Bot' | number {
    this.validateBotline();
    const above = this.topLnum - 1;
    const below = this.lineCount - this.botLnum + 1;
    if (below <= 0) return above === 0 ? 'All' : 'Bot';
    if (above === 0) return 'Top';
    return Math.floor((above * 100) / (above + below));
  }

  private checkTopOffset(cursor: number): boolean {
    const so = this.so;
    if (cursor < this.topLnum + so) {
      let lnum = cursor;
      let n = 0;
      while (n < so) {
        lnum--;
        const height = lnum < 1 ? UNBOUNDED : this.plines(lnum);
        if (lnum < this.topLnum) break;
        n += height;
      }
      if (n < so) return true;
    }
    return false;
  }

  follow(cursorLine: number, cursorCol = 0, onTabEnd = true): void {
    this.cursorPos = { line: cursorLine, col: cursorCol, tabEnd: onTabEnd };
    const previousCount = this.knownLines.length;
    const change = this.firstChange();
    if (change !== null) {
      if (change.line < cursorLine || (change.line === cursorLine && change.col <= cursorCol)) this.topValid = false;
      if (this.botLnum >= change.line + 1) {
        if (this.lineCount < previousCount) this.invalidateBotline();
        else this.botValid = false;
      }
    }
    this.updateTopline(cursorLine);
    this.cursColumns(cursorLine);
    this.redraw(cursorLine);
    this.cursColumns(cursorLine);
    this.wrow = this.cursorCell(cursorLine, cursorCol, onTabEnd)?.row ?? this.wrow;
  }

  private setFraction(): void {
    if (this.height > 1) this.fraction = Math.floor((this.wrow * FRACTION_MULT + FRACTION_MULT / 2) / this.height);
  }

  private firstChange(): { line: number; col: number } | null {
    const count = this.lineCount;
    const known = this.knownLines;
    const limit = Math.max(count, known.length);
    for (let index = 0; index < limit; index++) {
      if (index < count && index < known.length && this.host.lineAt(index) === known[index]) continue;
      const now = index < count ? this.host.lineAt(index) : '';
      const before = index < known.length ? known[index] : '';
      let col = 0;
      while (col < now.length && col < before.length && now[col] === before[col]) col++;
      this.knownLines = Array.from({ length: count }, (_, line) => this.host.lineAt(line));
      return { line: index, col };
    }
    return null;
  }

  redraw(cursorLine: number): void {
    const stale = this.botLnum;
    this.compBotline();
    if (!this.redrawing && this.botLnum !== stale) {
      this.redrawing = true;
      this.topValid = false;
      this.updateTopline(cursorLine);
      this.redrawing = false;
      this.compBotline();
    }
    this.validCursor = cursorLine;
  }

  private updateTopline(cursorLine: number): void {
    const cursor = cursorLine + 1;
    this.checkCursorMoved(cursorLine);
    if (this.topValid) return;
    if (this.lineCount === 1 && this.host.lineAt(0) === '') {
      this.topLnum = 1;
      this.botLnum = 2;
      this.botValid = true;
      this.botApprox = true;
      this.topValid = true;
      return;
    }
    this.topLnum = Math.max(1, Math.min(this.topLnum, this.lineCount));
    const oldTop = this.topLnum;
    const so = this.so;
    let checkBot = false;
    let checkTop = false;
    if (this.topLnum > 1 || this.skipCol > 0) {
      if (cursor < this.topLnum) checkTop = true;
      else if (this.checkTopOffset(cursor)) checkTop = true;
      else if (this.skipCol > 0 && cursor === this.topLnum) {
        const { start } = this.cursorSpan(cursorLine, this.cursorPos.col, false);
        if (this.skipCol + this.markerOverlap() > start) checkTop = true;
      }
    }
    if (checkTop) {
      const half = Math.max(2, Math.floor(this.height / 2) - 1);
      const n = this.topLnum + so - cursor;
      if (n >= half) {
        this.scrollCursorHalfway(cursor, false);
      } else {
        this.scrollCursorTop(cursor, 1, false);
        checkBot = true;
      }
    } else {
      checkBot = true;
    }
    if (checkBot) {
      if (!this.botApprox) this.validateBotline();
      if (this.botLnum <= this.lineCount) {
        if (cursor < this.botLnum) {
          if (cursor >= this.botLnum - so) {
            let n = this.emptyRowCount;
            let lnum = cursor;
            let height = 0;
            while (lnum < this.botLnum) {
              n += height;
              if (n >= so) break;
              lnum++;
              height = lnum > this.lineCount ? UNBOUNDED : this.plines(lnum);
            }
            if (n >= so) checkBot = false;
          } else {
            checkBot = false;
          }
        }
        if (checkBot) {
          const toScroll = cursor - this.botLnum + 1 + so;
          if (toScroll <= this.height + 1) this.scrollCursorBot(cursor, 1, false);
          else this.scrollCursorHalfway(cursor, false);
        }
      }
    }
    this.topValid = true;
    if (this.topLnum !== oldTop) this.skipCol = 0;
  }

  private markerOverlap(): number {
    const s = this.settings();
    if (s.list && s.listchars.precedes !== null) return 1;
    const extra2 = this.numberColumn;
    return extra2 > 3 ? 0 : 3 - extra2;
  }

  private cursColumns(cursorLine: number): void {
    this.updateTopline(cursorLine);
    const settings = this.settings();
    if (!settings.wrap) {
      this.skipCol = 0;
      return;
    }
    const width1 = this.textWidth;
    const width2 = width1;
    const height = this.height;
    const so = this.so;
    const cursor = cursorLine + 1;
    const { virt } = this.cursorSpan(cursorLine, this.cursorPos.col, this.cursorPos.tabEnd);
    let wrow = 0;
    for (let lnum = this.topLnum; lnum < cursor; lnum++) wrow += this.plinesCorrectTopline(lnum);
    let wcol = virt + this.numberColumn;
    let subtracted = false;
    if (cursor === this.topLnum && this.skipCol > 0 && wcol >= this.skipCol) {
      wcol -= this.skipCol <= width1 ? width2 : width2 * (Math.floor((this.skipCol - width1) / width2) + 1);
      subtracted = true;
    }
    if (wcol >= this.cols) {
      const n = Math.floor((wcol - this.cols) / width2) + 1;
      wcol -= n * width2;
      wrow += n;
    }
    const previous = this.skipCol;
    let lines = 0;
    const tall = (): boolean => {
      lines = this.fullRows(cursor);
      return lines - 1 >= height;
    };
    if ((wrow >= height || ((previous > 0 || wrow + so >= height) && tall())) && cursor === this.topLnum) {
      let extra = 0;
      if (this.skipCol + so * width2 > virt) extra = 1;
      if (lines === 0) lines = this.fullRows(cursor);
      lines--;
      let n = lines > wrow + so ? wrow + so : lines;
      if (n >= height + Math.trunc(this.skipCol / width2) - so) extra += 2;
      if (extra === 3 || height <= so * 2) {
        n = Math.trunc(virt / width2);
        n = n > Math.trunc(height / 2) ? n - Math.trunc(height / 2) : 0;
        if (n > lines - height + 1) n = lines - height + 1;
        this.skipCol = n > 0 ? width1 + (n - 1) * width2 : 0;
      } else if (extra === 1) {
        extra = Math.trunc((this.skipCol + so * width2 - virt + width2 - 1) / width2);
        if (extra > 0) {
          if (extra * width2 > this.skipCol) extra = Math.trunc(this.skipCol / width2);
          this.skipCol -= extra * width2;
        }
      } else if (extra === 2) {
        let endcol = (n - height + 1) * width2;
        while (endcol > virt) endcol -= width2;
        if (endcol > this.skipCol) this.skipCol = endcol;
      }
      wrow -= subtracted ? Math.trunc((this.skipCol - previous) / width2) : Math.trunc(this.skipCol / width2);
      if (wrow >= height) {
        const more = wrow - height + 1;
        this.skipCol += more * width2;
        wrow -= more;
      }
    } else {
      this.skipCol = 0;
    }
    if (this.skipCol !== previous) this.invalidateBotline();
  }

  scrollCursorTop(cursor: number, minScroll: number, always: boolean): void {
    const off = this.so;
    const height = this.height;
    let scrolled = 0;
    let extra = 0;
    let used = this.plines(cursor);
    if (cursor < this.topLnum) scrolled = used;
    let top = cursor - 1;
    let bot = cursor + 1;
    let newTop = top + 1;
    while (top > 0) {
      const i = this.plines(top);
      if (top < this.topLnum) scrolled += i;
      if ((newTop >= this.topLnum || scrolled > minScroll) && extra >= off) break;
      used += i;
      if (extra + i <= off && bot < this.lineCount) used += this.plines(bot);
      if (used > height) break;
      extra += i;
      newTop = top;
      top--;
      bot++;
    }
    if (used > height) {
      this.scrollCursorHalfway(cursor, false);
    } else {
      const previousTop = this.topLnum;
      if (newTop < this.topLnum || always) this.topLnum = newTop;
      if (this.topLnum > cursor) this.topLnum = cursor;
      if (this.topLnum !== previousTop) {
        this.invalidateBotline();
        this.skipCol = 0;
      }
      this.topValid = true;
    }
  }

  scrollCursorBot(cursor: number, minScroll: number, setTopBot: boolean): void {
    const so = this.so;
    const height = this.height;
    let used: number;
    let scrolled = 0;
    let extra = 0;
    const previous = { top: this.topLnum, bot: this.botLnum, empty: this.emptyRowCount, valid: this.botValid, approx: this.botApprox };
    if (setTopBot) {
      used = 0;
      this.botLnum = cursor + 1;
      for (this.topLnum = this.botLnum; this.topLnum > 1;) {
        const lnum = this.topLnum - 1;
        const lineHeight = this.fullRows(lnum);
        if (used + lineHeight > height) break;
        used += lineHeight;
        this.topLnum = lnum;
      }
      this.emptyRowCount = used === 0 ? 0 : height - used;
      this.botValid = true;
      this.botApprox = true;
    } else {
      this.validateBotline();
    }
    used = this.plines(cursor);
    if (cursor >= this.botLnum) {
      scrolled = used;
      if (cursor === this.botLnum) scrolled -= this.emptyRowCount;
    }
    let loff = cursor;
    let boff = cursor;
    while (loff > 1) {
      if ((((scrolled <= 0 || scrolled >= minScroll) && extra >= so) || boff + 1 > this.lineCount) && loff <= this.botLnum) break;
      loff--;
      const loffHeight = this.plines(loff);
      used += loffHeight;
      if (used > height) break;
      if (loff >= this.botLnum) {
        scrolled += loffHeight;
        if (loff === this.botLnum) scrolled -= this.emptyRowCount;
      }
      if (boff < this.lineCount) {
        boff++;
        const boffHeight = this.plines(boff);
        used += boffHeight;
        if (used > height) break;
        if (extra < so || scrolled < minScroll) {
          extra += boffHeight;
          if (boff >= this.botLnum) {
            scrolled += boffHeight;
            if (boff === this.botLnum) scrolled -= this.emptyRowCount;
          }
        }
      }
    }
    let toScroll: number;
    if (scrolled <= 0) {
      toScroll = 0;
    } else if (used > height) {
      toScroll = used;
    } else {
      toScroll = 0;
      let lnum = this.topLnum - 1;
      let i = 0;
      while (i < scrolled && lnum < this.botLnum) {
        lnum++;
        i += lnum > this.lineCount ? UNBOUNDED : this.plines(lnum);
        toScroll++;
      }
      if (i < scrolled) toScroll = 9999;
    }
    if (toScroll >= height && toScroll > minScroll) this.scrollCursorHalfway(cursor, false, true);
    else if (toScroll > 0) this.shiftUp(toScroll);
    if (setTopBot && this.topLnum === previous.top) {
      this.botLnum = previous.bot;
      this.emptyRowCount = previous.empty;
      this.botValid = previous.valid;
      this.botApprox = previous.approx;
    }
    this.topValid = true;
  }

  scrollCursorHalfway(cursor: number, atEnd: boolean, preferAbove = false): void {
    const height = this.height;
    let above = 0;
    let below = 0;
    let used = this.plines(cursor);
    let topline = cursor;
    let loff = cursor;
    let boff = cursor;
    while (topline > 1) {
      let done = false;
      for (let round = 1; round <= 2 && !done; round++) {
        const addBelow = preferAbove ? round === 2 && below < above : round === 1 && below <= above;
        const addAbove = preferAbove ? round === 1 && below >= above : round === 1 && below > above;
        if (addBelow) {
          if (boff < this.lineCount) {
            boff++;
            used += this.plines(boff);
            if (used > height) {
              done = true;
              break;
            }
            below += this.plines(boff);
          } else {
            below++;
            if (atEnd) used++;
          }
        }
        if (addAbove) {
          loff--;
          used += loff < 1 ? UNBOUNDED : this.plines(loff);
          if (used > height) {
            done = true;
            break;
          }
          above += this.plines(loff);
          topline = loff;
        }
      }
      if (done) break;
    }
    this.topLnum = topline;
    this.invalidateBotline();
    this.topValid = true;
  }

  private shiftUp(count: number): void {
    this.topLnum += count;
    this.botLnum += count;
    if (this.topLnum > this.lineCount) this.topLnum = this.lineCount;
    if (this.botLnum > this.lineCount + 1) this.botLnum = this.lineCount + 1;
    this.botValid = false;
  }

  scrollTop(cursorLine: number, always: boolean): void {
    this.scrollCursorTop(cursorLine + 1, 0, always);
    this.setFraction();
  }

  scrollBottom(cursorLine: number): void {
    this.scrollCursorBot(cursorLine + 1, 0, true);
    this.setFraction();
  }

  scrollMiddle(cursorLine: number): void {
    this.scrollCursorHalfway(cursorLine + 1, true);
    this.setFraction();
  }

  invalidateTop(): void {
    this.topValid = false;
  }

  private checkCursorMoved(cursorLine: number): void {
    if (cursorLine === this.validCursor) return;
    this.validCursor = cursorLine;
    this.topValid = false;
    this.invalidateBotline();
  }

  private validateBotlineFor(cursorLine: number): void {
    if (this.botValid) return;
    this.checkCursorMoved(cursorLine);
    this.compBotline();
  }

  cursorCorrect(cursorLine: number): number {
    const so = this.so;
    const height = this.height;
    let aboveWanted = so;
    let belowWanted = so;
    if (this.topLnum === 1) {
      aboveWanted = 0;
      belowWanted = Math.min(belowWanted, Math.floor(height / 2));
    }
    this.validateBotlineFor(cursorLine);
    if (this.botLnum === this.lineCount + 1) {
      belowWanted = 0;
      aboveWanted = Math.min(aboveWanted, Math.floor((height - 1) / 2));
    }
    const cln = cursorLine + 1;
    if (cln >= this.topLnum + aboveWanted && cln < this.botLnum - belowWanted) return cursorLine;
    this.topValid = true;
    let topline = this.topLnum;
    let botline = this.botLnum - 1;
    let above = 0;
    let below = 0;
    while ((above < aboveWanted || below < belowWanted) && topline < botline) {
      if (below < belowWanted && (below <= above || above >= aboveWanted)) {
        below += this.plines(botline);
        botline--;
      }
      if (above < aboveWanted && (above < below || below >= belowWanted)) {
        above += this.plines(topline);
        topline++;
      }
    }
    let result = cln;
    if (topline === botline || botline === 0) {
      result = topline;
    } else if (topline > botline) {
      result = botline;
    } else {
      if (cln < topline && this.topLnum > 1) result = topline;
      if (cln > botline && this.botLnum <= this.lineCount) result = botline;
    }
    return result - 1;
  }

  scrollLines(up: boolean, count: number, cursorLine: number): number {
    const previousTop = this.topLnum;
    let cursor = cursorLine;
    if (up) {
      this.shiftUp(count);
      cursor = Math.max(cursor, this.topLnum - 1);
    } else {
      cursor = this.shiftDown(count, cursor);
    }
    if (this.so > 0) {
      cursor = this.cursorCorrect(cursor);
      this.checkCursorMoved(cursor);
      this.topValid = true;
      if (this.topLnum === previousTop) {
        if (up) {
          if (!(cursor > cursorLine) && cursor < this.lineCount - 1) cursor++;
        } else if (!(cursor < cursorLine) && previousTop !== 1 && cursor > 0) {
          cursor--;
        }
        this.checkCursorMoved(cursor);
        this.topValid = true;
      }
    }
    return cursor;
  }

  private shiftDown(count: number, cursorLine: number): number {
    for (let done = 0; done < count; done++) {
      if (this.topLnum === 1) break;
      this.topLnum--;
      this.botLnum--;
      this.invalidateBotline();
    }
    let cursor = cursorLine + 1;
    let row = 0;
    for (let lnum = this.topLnum; lnum < cursor; lnum++) row += this.plines(lnum);
    let last = row + this.plines(cursor) - 1;
    while (last >= this.height && cursor > 1) {
      last -= this.plines(cursor);
      cursor--;
    }
    return cursor - 1;
  }

  halfPage(down: boolean, amount: number, cursorLine: number): number {
    const height = this.height;
    let n = Math.min(amount, height);
    let cursor = cursorLine + 1;
    this.updateTopline(cursorLine);
    this.validateBotline();
    let room = this.emptyRowCount;
    let scrolled = 0;
    if (down) {
      while (n > 0 && this.botLnum <= this.lineCount) {
        let i = this.plines(this.topLnum);
        n -= i;
        if (n < 0 && scrolled > 0) break;
        this.topLnum++;
        scrolled += i;
        room += i;
        do {
          i = this.plines(this.botLnum);
          if (i > room) break;
          this.botLnum++;
          room -= i;
        } while (this.botLnum <= this.lineCount);
        if (cursor < this.lineCount) cursor++;
      }
      if (n > 0) cursor = Math.min(this.lineCount, cursor + n);
    } else {
      while (n > 0 && this.topLnum > 1) {
        const i = this.plines(this.topLnum - 1);
        n -= i;
        if (n < 0 && scrolled > 0) break;
        this.topLnum--;
        this.invalidateBotline();
        scrolled += i;
        if (cursor > 1) cursor--;
      }
      if (n > 0) cursor = cursor <= n ? 1 : cursor - n;
    }
    return this.cursorCorrect(cursor - 1);
  }

  private scrollOverlap(start: number, step: 1 | -1): number {
    const minHeight = this.height - 2;
    const heightOf = (lnum: number): number => (lnum < 1 || lnum > this.lineCount ? UNBOUNDED : this.plines(lnum));
    const h1 = heightOf(start);
    if (h1 > minHeight) return start;
    const second = start + step;
    const h2 = heightOf(second);
    if (h2 === UNBOUNDED || h2 + h1 > minHeight) return start;
    const third = second + step;
    const h3 = heightOf(third);
    if (h3 === UNBOUNDED || h3 + h2 > minHeight) return start;
    const fourth = third + step;
    const h4 = heightOf(fourth);
    if (h4 === UNBOUNDED || h4 + h3 + h2 > minHeight || h3 + h2 + h1 > minHeight) return second;
    return third;
  }

  onePage(forward: boolean, count: number, cursorLine: number): { cursor: number; failed: boolean } {
    let cursor = cursorLine + 1;
    let failed = false;
    const oldTopline = this.topLnum;
    for (let remaining = count; remaining > 0; remaining--) {
      this.validateBotline();
      const so = this.so;
      const atEnd = forward ? this.topLnum >= this.lineCount - so && this.botLnum > this.lineCount : this.topLnum === 1;
      if (atEnd) {
        failed = true;
        break;
      }
      if (forward) {
        if (this.botLnum > this.lineCount) {
          this.topLnum = this.lineCount;
        } else {
          this.topLnum = this.scrollOverlap(this.botLnum, -1);
          cursor = this.topLnum;
          this.invalidateBotline();
        }
      } else {
        let loff = this.scrollOverlap(this.topLnum - 1, 1);
        if (loff >= this.lineCount) loff = this.lineCount;
        cursor = loff;
        let n = 0;
        while (n <= this.height && loff >= 1) {
          loff--;
          n = loff < 1 ? UNBOUNDED : n + this.plines(loff);
        }
        if (loff < 1) {
          this.topLnum = 1;
          this.invalidateBotline();
        } else {
          loff += 2;
          if (loff >= this.topLnum) {
            this.topLnum--;
            this.compBotline();
            cursor = this.botLnum - 1;
          } else {
            this.topLnum = loff;
            this.invalidateBotline();
          }
        }
      }
    }
    const corrected = this.cursorCorrect(cursor - 1);
    if (!failed && forward && this.checkTopOffset(corrected + 1)) {
      this.scrollCursorTop(corrected + 1, 1, false);
      if (this.topLnum <= oldTopline && oldTopline < this.lineCount) this.topLnum = oldTopline + 1;
    }
    return { cursor: corrected, failed };
  }

  cellAt(row: number, col: number): { line: number; cell: number } | null {
    if (row < 0 || row >= this.height) return null;
    let remaining = row;
    const textColumn = Math.max(0, col - this.numberColumn);
    const wrap = this.settings().wrap;
    for (let lnum = this.topLnum; lnum <= this.lineCount; lnum++) {
      const skipped = lnum === this.topLnum ? this.skipRows : 0;
      const rows = this.fullRows(lnum) - skipped;
      if (remaining < rows) {
        return { line: lnum - 1, cell: wrap ? (remaining + skipped) * this.textWidth + textColumn : this.leftColumn + textColumn };
      }
      remaining -= rows;
    }
    return { line: this.lineCount - 1, cell: wrap ? textColumn : this.leftColumn + textColumn };
  }

  cursorCell(cursorLine: number, cursorCol: number, onTabEnd: boolean): CursorCell | null {
    if (cursorLine + 1 < this.topLnum) return null;
    let row = 0;
    for (let lnum = this.topLnum; lnum <= cursorLine; lnum++) row += this.plinesCorrectTopline(lnum);
    const { virt } = this.cursorSpan(cursorLine, cursorCol, onTabEnd);
    const width = this.textWidth;
    if (this.settings().wrap) {
      row += Math.floor(virt / width) - (cursorLine + 1 === this.topLnum ? this.skipRows : 0);
      if (row >= this.height) return null;
      return { row, col: this.numberColumn + (virt % width) };
    }
    return { row, col: this.numberColumn + virt - this.leftColumn };
  }

  cellCount(line: number): number { return this.cellsOf(line).length; }

  virtColumn(line: number, col: number, onTabEnd: boolean): number {
    return this.cursorSpan(line, col, onTabEnd).virt;
  }

  charCells(line: number, col: number): { end: number; width: number } {
    const { start, end } = this.cursorSpan(line, col, false);
    return { end, width: this.host.lineAt(line)[col] === '\t' ? 1 : end - start + 1 };
  }

  colAtCell(line: number, cell: number, allowEol: boolean): number {
    const cells = this.cellsOf(line);
    const text = this.host.lineAt(line);
    if (cells.length === 0) return 0;
    if (cell >= cells.length) return allowEol ? text.length : Math.max(0, text.length - 1);
    let index = Math.max(0, cell);
    while (index < cells.length && cells[index].col < 0) index++;
    if (index >= cells.length) return allowEol ? text.length : Math.max(0, text.length - 1);
    return cells[index].col;
  }

  cursorSpan(cursorLine: number, cursorCol: number, onTabEnd: boolean): { start: number; end: number; virt: number } {
    const cells = this.cellsOf(cursorLine);
    const text = this.host.lineAt(cursorLine);
    if (cursorCol >= text.length) return { start: cells.length, end: cells.length, virt: cells.length };
    let start = -1;
    let end = -1;
    for (let i = 0; i < cells.length; i++) {
      if (cells[i].col === cursorCol) {
        if (start < 0) start = i;
        end = i;
      }
    }
    if (start < 0) return { start: cells.length, end: cells.length, virt: cells.length };
    const atTabEnd = text[cursorCol] === '\t' && onTabEnd && !this.settings().list;
    return { start, end, virt: atTabEnd ? end : start };
  }

  followColumn(cursorLine: number, cursorCol: number, onTabEnd: boolean): void {
    const s = this.settings();
    if (s.wrap) {
      this.leftColumn = 0;
      return;
    }
    const { start, end, virt } = this.cursorSpan(cursorLine, cursorCol, onTabEnd);
    const width = this.textWidth;
    const siso = Math.max(0, s.sidescrolloff);
    const offLeft = start - this.leftColumn - siso;
    const offRight = end - (this.leftColumn + width - siso) + 1;
    if (offLeft < 0 || offRight > 0) {
      const diff = offLeft < 0 ? -offLeft : offRight;
      let next: number;
      if (s.sidescroll === 0 || diff >= Math.floor(width / 2) || offRight >= offLeft) {
        next = virt - Math.floor(width / 2);
      } else {
        const step = Math.max(diff, s.sidescroll);
        next = offLeft < 0 ? this.leftColumn - step : this.leftColumn + step;
      }
      this.leftColumn = Math.max(0, next);
    }
  }
}
