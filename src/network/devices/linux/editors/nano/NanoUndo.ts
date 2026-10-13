export type UndoKind =
  | 'ADD' | 'ENTER' | 'BACK' | 'DEL' | 'JOIN' | 'REPLACE' | 'SPLIT' | 'ZAP' | 'CUT' | 'CUT_TO_EOF' | 'PASTE' | 'INSERT'
  | 'COUPLE' | 'INDENT' | 'UNINDENT' | 'COMMENT' | 'UNCOMMENT';

export type LastAction = UndoKind | 'OTHER' | 'COPY';

export interface UndoPosition {
  readonly line: number;
  readonly col: number;
}

export interface UndoItem {
  kind: UndoKind;
  readonly before: string[];
  after: string[] | null;
  headLine: number;
  headX: number;
  tailLine: number;
  tailX: number;
  readonly cursorBefore: UndoPosition;
  cursorAfter: UndoPosition;
  readonly rowBefore: number;
  rowAfter: number;
  readonly message: string | null;
}

export interface UndoRestore {
  readonly lines: string[];
  readonly cursor: UndoPosition;
  readonly row: number | null;
  readonly message: string | null;
}

const NAMES: Readonly<Record<UndoKind, string | null>> = {
  ADD: 'addition',
  ENTER: 'line break',
  BACK: 'deletion',
  DEL: 'deletion',
  JOIN: 'line join',
  REPLACE: 'replacement',
  SPLIT: 'addition',
  ZAP: 'erasure',
  CUT: 'cut',
  CUT_TO_EOF: 'cut',
  PASTE: 'paste',
  INSERT: 'insertion',
  COUPLE: null,
  INDENT: 'indent',
  UNINDENT: 'unindent',
  COMMENT: 'comment',
  UNCOMMENT: 'uncomment',
};

export class NanoUndoStack {
  private items: UndoItem[] = [];
  private applied = 0;
  private savedAt = 0;
  lastAction: LastAction = 'OTHER';

  get top(): UndoItem | null {
    return this.applied > 0 ? this.items[this.applied - 1] : null;
  }

  get modified(): boolean {
    return this.applied !== this.savedAt;
  }

  get depth(): number {
    return this.applied;
  }

  markSaved(): void {
    this.savedAt = this.applied;
    this.lastAction = 'OTHER';
  }

  begin(kind: UndoKind, lines: readonly string[], cursor: UndoPosition, row = 0, message: string | null = null): UndoItem {
    this.items.length = this.applied;
    if (this.savedAt > this.applied) this.savedAt = -1;
    const item: UndoItem = {
      kind,
      before: [...lines],
      after: null,
      headLine: cursor.line,
      headX: cursor.col,
      tailLine: cursor.line,
      tailX: cursor.col,
      cursorBefore: cursor,
      cursorAfter: cursor,
      rowBefore: row,
      rowAfter: row,
      message,
    };
    this.items.push(item);
    this.applied = this.items.length;
    this.lastAction = kind;
    return item;
  }

  finish(cursor: UndoPosition, row?: number): void {
    const item = this.top;
    if (item === null) return;
    item.cursorAfter = cursor;
    item.tailLine = cursor.line;
    item.tailX = cursor.col;
    if (row !== undefined) item.rowAfter = row;
  }

  beginTyping(lines: readonly string[], cursor: UndoPosition, row: number): void {
    const top = this.top;
    if (this.lastAction === 'ADD' && top !== null && top.tailLine === cursor.line && top.tailX === cursor.col) return;
    this.begin('ADD', lines, cursor, row);
  }

  beginDeletion(
    kind: 'BACK' | 'DEL',
    lines: readonly string[],
    at: UndoPosition,
    characterLength: number,
    before: UndoPosition,
  ): void {
    const top = this.top;
    if (this.lastAction === kind && top !== null && at.line === top.headLine) {
      if (at.col === top.headX) return;
      if (at.col === top.headX - characterLength) {
        top.headX = at.col;
        return;
      }
    }
    const item = this.begin(kind, lines, before);
    item.headLine = at.line;
    item.headX = at.col;
    item.tailLine = before.line;
    item.tailX = before.col;
  }

  beginJoin(lines: readonly string[], before: UndoPosition): void {
    this.begin('JOIN', lines, before);
  }

  continuesCut(kind: 'CUT' | 'ZAP', keep: boolean): boolean {
    return this.lastAction === kind && keep && this.top !== null;
  }

  convertTopToSplit(cursorAfter: UndoPosition): void {
    const item = this.top;
    if (item === null) return;
    item.kind = 'SPLIT';
    item.cursorAfter = cursorAfter;
    item.tailLine = cursorAfter.line;
    item.tailX = cursorAfter.col;
    this.lastAction = 'SPLIT';
  }

  abandonTop(): void {
    if (this.applied === 0) return;
    this.items.length = this.applied - 1;
    this.applied = this.items.length;
    this.lastAction = 'OTHER';
  }

  undo(current: readonly string[], rowNow: number): UndoRestore | null {
    const item = this.top;
    if (item === null) return null;
    item.after = [...current];
    item.rowAfter = rowNow;
    this.applied--;
    this.lastAction = 'OTHER';
    return {
      lines: [...item.before],
      cursor: item.cursorBefore,
      row: item.kind === 'COUPLE' ? item.rowBefore : null,
      message: item.kind === 'COUPLE' ? item.message : NAMES[item.kind],
    };
  }

  redo(): UndoRestore | null {
    if (this.applied >= this.items.length) return null;
    const item = this.items[this.applied];
    this.applied++;
    this.lastAction = 'OTHER';
    return {
      lines: [...(item.after ?? item.before)],
      cursor: item.cursorAfter,
      row: item.kind === 'COUPLE' ? item.rowAfter : null,
      message: item.kind === 'COUPLE' ? item.message : NAMES[item.kind],
    };
  }
}
