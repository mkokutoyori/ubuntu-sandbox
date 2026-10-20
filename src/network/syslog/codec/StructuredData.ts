export interface StructuredDataElement {
  readonly id: string;
  readonly params: ReadonlyArray<readonly [string, string]>;
}

const SD_NAME_FORBIDDEN = /[\s=\]"\u0000- \u007f-￿]/;

export function isValidSdName(name: string): boolean {
  return name.length >= 1 && name.length <= 32 && !SD_NAME_FORBIDDEN.test(name);
}

export function escapeParamValue(value: string): string {
  return value.replace(/[\\"\]]/g, (character) => `\\${character}`);
}

export function formatStructuredData(elements: readonly StructuredDataElement[]): string {
  if (elements.length === 0) return '-';
  return elements
    .map((element) => `[${element.id}${element.params.map(([name, value]) => ` ${name}="${escapeParamValue(value)}"`).join('')}]`)
    .join('');
}

export interface ParsedStructuredData {
  readonly elements: readonly StructuredDataElement[];
  readonly consumed: number;
}

export function parseStructuredData(text: string, start = 0): ParsedStructuredData | null {
  if (text[start] === '-') return { elements: [], consumed: 1 };
  const elements: StructuredDataElement[] = [];
  const seen = new Set<string>();
  let position = start;
  while (text[position] === '[') {
    position++;
    const idStart = position;
    while (position < text.length && !/[\s\]=]/.test(text[position])) position++;
    const id = text.slice(idStart, position);
    if (!isValidSdName(id) || seen.has(id)) return null;
    seen.add(id);
    const params: Array<readonly [string, string]> = [];
    while (text[position] === ' ') {
      position++;
      const nameStart = position;
      while (position < text.length && !/[\s\]="]/.test(text[position])) position++;
      const name = text.slice(nameStart, position);
      if (!isValidSdName(name) || text[position] !== '=' || text[position + 1] !== '"') return null;
      position += 2;
      let value = '';
      for (;;) {
        if (position >= text.length) return null;
        const character = text[position];
        if (character === '"') { position++; break; }
        if (character === '\\' && /["\\\]]/.test(text[position + 1] ?? '')) {
          value += text[position + 1];
          position += 2;
          continue;
        }
        value += character;
        position++;
      }
      params.push([name, value]);
    }
    if (text[position] !== ']') return null;
    position++;
    elements.push({ id, params });
  }
  return elements.length === 0 ? null : { elements, consumed: position - start };
}
