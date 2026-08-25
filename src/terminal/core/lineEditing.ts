export type LineEditAction =
  | 'start' | 'end' | 'back' | 'forward' | 'delete'
  | 'history-prev' | 'history-next';

export interface EditedLine {
  readonly text: string;
  readonly caret: number;
}

const BINDINGS: Readonly<Record<string, LineEditAction>> = Object.freeze({
  a: 'start',
  e: 'end',
  b: 'back',
  f: 'forward',
  d: 'delete',
  p: 'history-prev',
  n: 'history-next',
});

export function lineEditActionFor(event: {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly altKey?: boolean;
  readonly metaKey?: boolean;
  readonly shiftKey?: boolean;
}): LineEditAction | null {
  if (!event.ctrlKey || event.altKey === true || event.metaKey === true) return null;
  if (event.shiftKey === true) return null;
  return BINDINGS[event.key.toLowerCase()] ?? null;
}

export function movesCaretOnly(action: LineEditAction): boolean {
  return action === 'start' || action === 'end'
    || action === 'back' || action === 'forward';
}

export function applyLineEdit(
  action: LineEditAction, text: string, caret: number,
): EditedLine {
  const at = Math.max(0, Math.min(caret, text.length));

  switch (action) {
    case 'start': return { text, caret: 0 };
    case 'end': return { text, caret: text.length };
    case 'back': return { text, caret: Math.max(0, at - 1) };
    case 'forward': return { text, caret: Math.min(text.length, at + 1) };
    case 'delete':
      return at >= text.length
        ? { text, caret: at }
        : { text: text.slice(0, at) + text.slice(at + 1), caret: at };
    default: return { text, caret: at };
  }
}
