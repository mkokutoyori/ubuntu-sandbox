import type { EditorKeyInput } from '../EditorKeyInput';

export type NanoKeyContext = 'edit' | 'prompt' | 'help';

const EDIT_FUNCTION_KEYS: Readonly<Record<string, string>> = {
  F1: 'g', F2: 'x', F3: 'o', F4: 'j', F5: 'r', F6: 'w', F7: 'y', F8: 'v', F9: 'k', F10: 'u', F11: 'c',
};

const PROMPT_FUNCTION_KEYS: Readonly<Record<string, string>> = { F1: 'g', F9: 'k', F10: 'u' };

const HELP_FUNCTION_KEYS: Readonly<Record<string, string>> = { F1: 'x', F2: 'x', F6: 'w', F7: 'y', F8: 'v' };

const FUNCTION_KEYS: Readonly<Record<NanoKeyContext, Readonly<Record<string, string>>>> = {
  edit: EDIT_FUNCTION_KEYS,
  prompt: PROMPT_FUNCTION_KEYS,
  help: HELP_FUNCTION_KEYS,
};

export function canonicalNanoKey(input: EditorKeyInput, context: NanoKeyContext): EditorKeyInput {
  if (input.ctrl && !input.alt && (input.key === '/' || input.key === '-')) return { ...input, key: '_' };
  if (input.ctrl || input.alt) return input;
  const letter = FUNCTION_KEYS[context][input.key];
  return letter === undefined ? input : { key: letter, ctrl: true, shift: false, alt: false };
}
