export function isCaretEscaped(text: string, index: number): boolean {
  let carets = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === '^'; cursor--) carets++;
  return carets % 2 === 1;
}

export function findMatchingParenthesis(text: string, openIndex: number): number {
  let depth = 0;
  let inQuote = false;
  for (let index = openIndex; index < text.length; index++) {
    const character = text[index];
    if (character === '"') { inQuote = !inQuote; continue; }
    if (inQuote || isCaretEscaped(text, index)) continue;
    if (character === '(') depth++;
    else if (character === ')') {
      depth--;
      if (depth === 0) return index;
    }
  }
  return -1;
}

export function parenthesisBalance(text: string): number {
  let depth = 0;
  let inQuote = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === '"') { inQuote = !inQuote; continue; }
    if (inQuote || isCaretEscaped(text, index)) continue;
    if (character === '(') depth++;
    else if (character === ')') depth--;
  }
  return depth;
}

export function skipSpaces(text: string, index: number): number {
  let cursor = index;
  while (cursor < text.length && (text[cursor] === ' ' || text[cursor] === '\t')) cursor++;
  return cursor;
}

export function readToken(text: string, index: number): { token: string; end: number } {
  let cursor = index;
  let inQuote = false;
  while (cursor < text.length) {
    const character = text[cursor];
    if (character === '"') inQuote = !inQuote;
    else if (!inQuote && (character === ' ' || character === '\t' || character === '\n')) break;
    cursor++;
  }
  return { token: text.slice(index, cursor), end: cursor };
}

export function readWord(text: string, index: number): { word: string; end: number } {
  let cursor = index;
  while (cursor < text.length && /[A-Za-z]/.test(text[cursor])) cursor++;
  return { word: text.slice(index, cursor), end: cursor };
}

export function stripCarets(text: string): string {
  let result = '';
  let inQuote = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === '"') inQuote = !inQuote;
    if (!inQuote && character === '^' && index + 1 < text.length) {
      index++;
      result += text[index];
      continue;
    }
    result += character;
  }
  return result;
}

export function splitUnits(lines: readonly string[]): string[] {
  const units: string[] = [];
  let index = 0;
  while (index < lines.length) {
    let text = lines[index].replace(/\r$/, '');
    index++;
    while (text.endsWith('^') && !isCaretEscaped(text, text.length - 1) && index < lines.length) {
      text = text.slice(0, -1) + lines[index].replace(/\r$/, '');
      index++;
    }
    const opening = text.replace(/^[\s@]+/, '');
    if (/^(if|for)\b/i.test(opening) || opening.startsWith('(')) {
      let balance = parenthesisBalance(text);
      while (balance > 0 && index < lines.length) {
        const next = lines[index].replace(/\r$/, '');
        text += `\n${next}`;
        balance += parenthesisBalance(next);
        index++;
      }
    }
    units.push(text);
  }
  return units;
}
