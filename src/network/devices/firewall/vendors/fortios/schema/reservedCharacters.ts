export const RESERVED_CHARACTERS = Object.freeze(
  ['<', '>', '(', ')', '#', "'", '"'] as const);

export function reservedCharacterIn(value: string): string | null {
  for (const character of RESERVED_CHARACTERS) {
    if (value.includes(character)) return character;
  }
  return null;
}

export function reservedCharacterHint(character: string): string {
  return `\`${character}\` is a reserved character and is not permitted here.`;
}
