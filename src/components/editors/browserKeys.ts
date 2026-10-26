import type { EditorKeyInput } from '@/network/devices/linux/editors/EditorKeyInput';
import { keyOfShortcutLabel } from '@/network/devices/linux/editors/nano/NanoMouse';

export interface BrowserKeyEvent {
  readonly key: string;
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  getModifierState?(name: string): boolean;
}

const PUNCTUATION_BY_CODE: Readonly<Record<string, readonly [string, string]>> = {
  Minus: ['-', '_'], Equal: ['=', '+'], BracketLeft: ['[', '{'], BracketRight: [']', '}'], Backslash: ['\\', '|'],
  Semicolon: [';', ':'], Quote: ["'", '"'], Comma: [',', '<'], Period: ['.', '>'], Slash: ['/', '?'], Backquote: ['`', '~'],
};

function producesNoUsableCharacter(key: string): boolean {
  if (key === 'Dead') return true;
  const characters = [...key];
  return characters.length === 1 && characters[0].codePointAt(0)! > 127;
}

function physicalKey(e: BrowserKeyEvent): string | null {
  const letter = /^Key([A-Z])$/.exec(e.code);
  if (letter !== null) return e.shiftKey ? letter[1] : letter[1].toLowerCase();
  const digit = /^Digit([0-9])$/.exec(e.code);
  if (digit !== null) return digit[1];
  const punctuation = PUNCTUATION_BY_CODE[e.code];
  return punctuation === undefined ? null : punctuation[e.shiftKey ? 1 : 0];
}

function metaKeyOf(e: BrowserKeyEvent): string {
  if (producesNoUsableCharacter(e.key)) return physicalKey(e) ?? e.key;
  const digit = /^Digit([0-9])$/.exec(e.code);
  if (digit !== null && !e.shiftKey && !/^[0-9]$/.test(e.key)) return digit[1];
  return e.key;
}

export function editorKeyOf(e: BrowserKeyEvent): EditorKeyInput {
  if (e.getModifierState?.('AltGraph') === true) return { key: e.key, ctrl: false, shift: e.shiftKey, alt: false };
  if (e.altKey && !e.ctrlKey) return { key: metaKeyOf(e), ctrl: false, shift: e.shiftKey, alt: true };
  return { key: e.key, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey };
}

const BAR_LABEL = /(?:\^\S|M-\S|Sh-Tab|F[0-9]{1,2})(?= )/g;

interface BarLabel {
  readonly row: number;
  readonly at: number;
  readonly text: string;
}

function labelsOf(rows: readonly string[]): BarLabel[] {
  return rows.flatMap((text, row) => [...text.matchAll(BAR_LABEL)].map((match) => ({ row, at: match.index!, text: match[0] })));
}

function pitchOf(labels: readonly BarLabel[]): number | null {
  const gaps = labels.flatMap((label) => {
    const next = labels.filter((other) => other.row === label.row && other.at > label.at).map((other) => other.at - label.at);
    return next.length === 0 ? [] : [Math.min(...next)];
  });
  return gaps.length === 0 ? null : Math.min(...gaps);
}

export function barShortcutAt(rows: readonly string[], row: number, x: number): EditorKeyInput | null {
  const labels = labelsOf(rows);
  const pitch = pitchOf(labels);
  const here = labels.filter((label) => label.row === row && label.at <= x).pop();
  if (here === undefined) return null;
  if (pitch !== null && x >= here.at + pitch) return null;
  return keyOfShortcutLabel(here.text);
}
