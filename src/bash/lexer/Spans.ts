export function closingSingleQuote(text: string, open: number): number {
  return text.indexOf("'", open + 1);
}

export function closingBacktick(text: string, open: number): number {
  for (let index = open + 1; index < text.length; index++) {
    if (text[index] === '\\') index++;
    else if (text[index] === '`') return index;
  }
  return -1;
}

export function closingDoubleQuote(text: string, open: number): number {
  for (let index = open + 1; index < text.length; index++) {
    const character = text[index];
    if (character === '\\') { index++; continue; }
    if (character === '"') return index;
    if (character === '$' && text[index + 1] === '(') {
      const close = closingParenthesis(text, index + 1);
      if (close < 0) return -1;
      index = close;
    } else if (character === '$' && text[index + 1] === '{') {
      const close = closingBrace(text, index + 1);
      if (close < 0) return -1;
      index = close;
    } else if (character === '`') {
      const close = closingBacktick(text, index);
      if (close < 0) return -1;
      index = close;
    }
  }
  return -1;
}

function skipQuoted(text: string, index: number): number {
  const character = text[index];
  if (character === "'") return closingSingleQuote(text, index);
  if (character === '"') return closingDoubleQuote(text, index);
  return closingBacktick(text, index);
}

export function closingBrace(text: string, open: number): number {
  let depth = 0;
  for (let index = open; index < text.length; index++) {
    const character = text[index];
    if (character === '\\') { index++; continue; }
    if (character === "'" || character === '"' || character === '`') {
      const close = skipQuoted(text, index);
      if (close < 0) return -1;
      index = close;
      continue;
    }
    if (character === '$' && text[index + 1] === '(') {
      const close = closingParenthesis(text, index + 1);
      if (close < 0) return -1;
      index = close;
      continue;
    }
    if (character === '$' && text[index + 1] === '{') { depth++; index++; continue; }
    if (index === open && character === '{') { depth++; continue; }
    if (character === '}' && --depth === 0) return index;
  }
  return -1;
}

export function closingParenthesis(text: string, open: number): number {
  let depth = 0;
  for (let index = open; index < text.length; index++) {
    const character = text[index];
    if (character === '\\') { index++; continue; }
    if (character === "'" || character === '"' || character === '`') {
      const close = skipQuoted(text, index);
      if (close < 0) return -1;
      index = close;
      continue;
    }
    if (character === '#' && (index === 0 || /\s/.test(text[index - 1]))) {
      const newline = text.indexOf('\n', index);
      if (newline < 0) return -1;
      index = newline;
      continue;
    }
    if (character === '$' && text[index + 1] === '{') {
      const close = closingBrace(text, index + 1);
      if (close < 0) return -1;
      index = close;
      continue;
    }
    if (character === '(') depth++;
    else if (character === ')' && --depth === 0) return index;
  }
  return -1;
}
