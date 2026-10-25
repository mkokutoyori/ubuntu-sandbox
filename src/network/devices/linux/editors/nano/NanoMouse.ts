import type { EditorKeyInput } from '../EditorKeyInput';
import { menuLayout, shownEntryCount, type MenuEntry, type MenuOptions, type NanoMenuName } from './NanoMenus';

export const WHEEL_STEP = 3;

const ARROWS: Readonly<Record<string, string>> = { '◂': 'ArrowLeft', '▸': 'ArrowRight', '▴': 'ArrowUp', '▾': 'ArrowDown' };

const NAMED_CONTROL: Readonly<Record<string, string>> = { '^I': 'Tab', '^M': 'Enter' };

function plainKey(key: string, mods: Partial<EditorKeyInput>): EditorKeyInput {
  return { key, ctrl: false, shift: false, alt: false, ...mods };
}

export function keyOfShortcutLabel(label: string): EditorKeyInput | null {
  const named = NAMED_CONTROL[label];
  if (named !== undefined) return plainKey(named, {});
  if (label === 'M-Bsp') return plainKey('Backspace', { alt: true });
  if (label === '^Del') return plainKey('Delete', { ctrl: true });
  if (label === '^/') return plainKey('_', { ctrl: true });
  if (label.length !== 2 && label.length !== 3) return null;
  const control = label.startsWith('^');
  const meta = label.startsWith('M-');
  if (!control && !meta) return null;
  const rest = label.slice(control ? 1 : 2);
  const arrow = ARROWS[rest];
  if (arrow !== undefined) return plainKey(arrow, control ? { ctrl: true } : { alt: true });
  if ([...rest].length !== 1) return null;
  return plainKey(control ? rest.toLowerCase() : rest, control ? { ctrl: true } : { alt: true });
}

export function clickedShortcut(cols: number, menu: NanoMenuName, options: MenuOptions, footerRow: number, x: number): MenuEntry | null {
  const { entries, slots } = menuLayout(menu, options);
  const number = shownEntryCount(cols, slots);
  const width = number < 5 ? Math.floor(cols / 2) : Math.floor(cols / Math.floor((number + 1) / 2));
  if (width === 0) return null;
  let index = Math.floor(x / width) * 2 + footerRow;
  if (index > number && x % width < cols % width) index -= 2;
  if (index > number || index < 1) return null;
  return entries[index - 1] ?? null;
}

export type YesNoChoice = 'y' | 'n' | 'a' | 'cancel';

export function clickedYesNo(cols: number, withAll: boolean, footerRow: number, x: number): YesNoChoice | null {
  const width = cols < 32 ? Math.floor(cols / 2) : 16;
  if (footerRow <= 0 || x >= width * 2) return null;
  const column = Math.floor(x / width);
  const line = footerRow - 1;
  if (column === 0) return line === 0 ? 'y' : 'n';
  if (line === 0) return withAll ? 'a' : null;
  return 'cancel';
}
