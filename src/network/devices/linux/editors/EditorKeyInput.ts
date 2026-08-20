/** A single keystroke fed into an editor engine, decoupled from DOM KeyboardEvent. */
export interface EditorKeyInput {
  /** Same semantics as KeyboardEvent.key: 'a', 'Enter', 'Escape', 'ArrowUp', 'Backspace', 'Delete', 'Home', 'End', 'F1'... */
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
}

export function editorKey(key: string, mods: Partial<Omit<EditorKeyInput, 'key'>> = {}): EditorKeyInput {
  return { key, ctrl: false, shift: false, alt: false, ...mods };
}
