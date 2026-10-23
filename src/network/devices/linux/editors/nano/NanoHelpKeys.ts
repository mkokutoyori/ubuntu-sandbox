import type { EditorKeyInput } from '../EditorKeyInput';

export type HelpAction =
  | 'scroll-up' | 'scroll-down' | 'page-up' | 'page-down' | 'first-line' | 'last-line'
  | 'search-forward' | 'search-backward' | 'find-next' | 'find-previous' | 'refresh' | 'exit' | 'unbound';

const CONTROL_ACTIONS: Readonly<Record<string, HelpAction>> = {
  l: 'refresh', x: 'exit', g: 'exit', c: 'exit',
  w: 'search-forward', q: 'search-backward',
  p: 'scroll-up', n: 'scroll-down', y: 'page-up', v: 'page-down',
};

const META_ACTIONS: Readonly<Record<string, HelpAction>> = {
  '\\': 'first-line', '/': 'last-line', q: 'find-previous', w: 'find-next',
  ' ': 'page-down', '-': 'scroll-up', _: 'scroll-up', '+': 'scroll-down', '=': 'scroll-down',
};

const NAMED_ACTIONS: Readonly<Record<string, HelpAction>> = {
  ArrowUp: 'scroll-up', ArrowDown: 'scroll-down', PageUp: 'page-up', PageDown: 'page-down',
  Home: 'first-line', End: 'last-line', Backspace: 'page-up',
};

const PLAIN_ACTIONS: Readonly<Record<string, HelpAction>> = {
  b: 'page-up', '-': 'page-up', ' ': 'page-down', w: 'search-forward', '/': 'search-forward',
  e: 'exit', q: 'exit', x: 'exit',
};

const PRESERVE_UNBOUND: ReadonlySet<string> = new Set(['l', 'q']);

export function helpAction(input: EditorKeyInput, preserve = false): HelpAction {
  const key = input.key;
  if (input.alt) {
    if (key === 'ArrowUp') return 'scroll-up';
    if (key === 'ArrowDown') return 'scroll-down';
    return key.length === 1 ? META_ACTIONS[key.toLowerCase()] ?? 'unbound' : 'unbound';
  }
  if (input.ctrl && preserve && PRESERVE_UNBOUND.has(key.toLowerCase())) return 'unbound';
  if (input.ctrl) return key.length === 1 ? CONTROL_ACTIONS[key.toLowerCase()] ?? 'unbound' : NAMED_ACTIONS[key] ?? 'unbound';
  if (key.length === 1) {
    if (key === 'N') return 'find-previous';
    if (key === 'n') return 'find-next';
    return PLAIN_ACTIONS[key.toLowerCase()] ?? 'unbound';
  }
  return NAMED_ACTIONS[key] ?? 'unbound';
}

const CURSOR_MOTIONS: Readonly<Record<string, string>> = { ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown' };
const CONTROL_CURSOR_MOTIONS: Readonly<Record<string, string>> = { p: 'ArrowUp', n: 'ArrowDown' };

export function helpCursorMotion(input: EditorKeyInput): EditorKeyInput | null {
  if (input.alt) return null;
  const named = input.ctrl ? undefined : CURSOR_MOTIONS[input.key];
  const control = input.ctrl && input.key.length === 1 ? CONTROL_CURSOR_MOTIONS[input.key.toLowerCase()] : undefined;
  const key = named ?? control;
  return key === undefined ? null : { key, ctrl: false, shift: false, alt: false };
}

const NAMED_CONTROL_CODES: Readonly<Record<string, number>> = { Enter: 13, Tab: 9 };

export function unboundKeyMessage(input: EditorKeyInput): string {
  const key = input.key;
  const function_ = /^F(\d+)$/.exec(key);
  if (function_ !== null && Number(function_[1]) >= 1 && Number(function_[1]) <= 24) return `Unbound key: F${function_[1]}`;
  if (key === 'Escape') return 'Unbindable key: ^[';
  const named = NAMED_CONTROL_CODES[key];
  if (named !== undefined) return `Unbound key: ^${String.fromCharCode(named + 0x40)}`;
  if (key.length !== 1) return 'Unbound key';
  const code = key.charCodeAt(0);
  if (input.alt) return code < 0x20 ? `Unbindable key: M-^${String.fromCharCode(code + 0x40)}` : `Unbound key: M-${key.toUpperCase()}`;
  if (input.ctrl) return `Unbound key: ^${key === ' ' ? '@' : key.toUpperCase()}`;
  return `Unbound key: ${key}`;
}
