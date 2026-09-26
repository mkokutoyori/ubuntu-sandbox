export interface ShellWords {
  words: string[];
  unterminatedQuote: boolean;
}

const ESCAPABLE_IN_DOUBLE_QUOTES = new Set(['$', '`', '"', '\\', '\n']);

export function splitShellWords(text: string): ShellWords {
  const words: string[] = [];
  let current = '';
  let inWord = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
      continue;
    }
    if (ch === '\\' && i + 1 < text.length) {
      const next = text[i + 1];
      i++;
      if (next === '\n') continue;
      if (quote === '"' && !ESCAPABLE_IN_DOUBLE_QUOTES.has(next)) current += ch;
      current += next;
      inWord = true;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; inWord = true; continue; }
    if (ch === ' ' || ch === '\t' || ch === '\n') {
      if (inWord) { words.push(current); current = ''; inWord = false; }
      continue;
    }
    current += ch;
    inWord = true;
  }
  if (inWord) words.push(current);
  return { words, unterminatedQuote: quote !== null };
}
