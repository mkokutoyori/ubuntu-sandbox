export interface ParsedArgv {
  readonly ok: boolean;
  readonly argv: string[];
}

const isSpace = (char: string): boolean => char === ' ' || char === '\t' || char === '\n' || char === '\v' || char === '\f' || char === '\r';

export function poptParseArgvString(input: string): ParsedArgv {
  const argv: string[] = [];
  let current = '';
  let quote = '';
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quote === char) {
      quote = '';
    } else if (quote !== '') {
      if (char === '\\') {
        i++;
        if (i >= input.length) return { ok: false, argv: [] };
        if (input[i] !== quote) current += '\\';
      }
      current += input[i];
    } else if (isSpace(char)) {
      if (current !== '') {
        argv.push(current);
        current = '';
      }
    } else if (char === '"' || char === '\'') {
      quote = char;
    } else if (char === '\\') {
      i++;
      if (i >= input.length) return { ok: false, argv: [] };
      current += input[i];
    } else {
      current += char;
    }
  }
  if (current !== '') argv.push(current);
  return { ok: true, argv };
}
