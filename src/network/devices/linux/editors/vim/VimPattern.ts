export function compileVimPattern(pattern: string, ignoreCase: boolean): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\') {
      // \%xHH — a specific byte value (2 hex digits), e.g. \%x00 for NUL.
      if (pattern[i + 1] === '%' && pattern[i + 2] === 'x' && /^[0-9a-fA-F]{2}$/.test(pattern.slice(i + 3, i + 5))) {
        out += `\\x${pattern.slice(i + 3, i + 5)}`;
        i += 4;
        continue;
      }
      // \%uHHHH — a specific Unicode codepoint (4 hex digits), e.g. \%ufeff for a BOM.
      if (pattern[i + 1] === '%' && pattern[i + 2] === 'u' && /^[0-9a-fA-F]{4}$/.test(pattern.slice(i + 3, i + 7))) {
        out += `\\u${pattern.slice(i + 3, i + 7)}`;
        i += 6;
        continue;
      }
      const next = pattern[i + 1];
      i++;
      switch (next) {
        case '(': out += '('; break;
        case ')': out += ')'; break;
        case '+': out += '+'; break;
        case '?': out += '?'; break;
        case '|': out += '|'; break;
        case '{': out += '{'; break;
        case '}': out += '}'; break;
        case '<': out += '\\b(?=\\w)'; break;
        case '>': out += '(?<=\\w)\\b'; break;
        case '.': out += '\\.'; break;
        case '\\': out += '\\\\'; break;
        case '/': out += '/'; break;
        case 'r': out += '\\r'; break; // carriage return
        default: out += next !== undefined ? (/[a-zA-Z0-9]/.test(next) ? next : '\\' + next) : '\\\\';
      }
      continue;
    }
    if (c === '(' || c === ')' || c === '{' || c === '}' || c === '+' || c === '?' || c === '|') {
      out += '\\' + c; // literal in vim's default magic mode
      continue;
    }
    out += c; // . * ^ $ [ ] pass through — same meaning in both dialects
  }
  return new RegExp(out, ignoreCase ? 'i' : undefined);
}

