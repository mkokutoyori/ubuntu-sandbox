export function parseFindstrFilter(filter: string): { patterns: string[]; ignoreCase: boolean; invert: boolean; count: boolean } {
  const tokens = filter.split(/\s+/).slice(1);
  let ignoreCase = false;
  let invert = false;
  let count = false;
  let cLiteral: string | null = null;
  const positional: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.toLowerCase() === '/i') { ignoreCase = true; continue; }
    if (t.toLowerCase() === '/v') { invert = true; continue; }
    if (t.toLowerCase() === '/c')  { count = true; continue; }
    if (/^\/c:/i.test(t)) {
      cLiteral = t.slice(3).replace(/^"|"$/g, '');
      continue;
    }
    if (t.startsWith('"')) {
      let str = t.slice(1);
      while (i < tokens.length - 1 && !str.endsWith('"')) { i++; str += ' ' + tokens[i]; }
      if (str.endsWith('"')) str = str.slice(0, -1);
      positional.push(str);
      continue;
    }
    positional.push(t);
  }

  if (cLiteral !== null) return { patterns: [cLiteral], ignoreCase, invert, count };
  // Bareword multi-token form: each token is a separate literal (OR semantics).
  return { patterns: positional, ignoreCase, invert, count };
}

export function applyFindstr(text: string, filterLine: string): string {
  const { patterns, ignoreCase, invert, count } = parseFindstrFilter(filterLine);
  const lines = text.split('\n');
  const matches = (line: string): boolean => {
    const haystack = ignoreCase ? line.toLowerCase() : line;
    return patterns.some(p => haystack.includes(ignoreCase ? p.toLowerCase() : p));
  };
  const filtered = lines.filter(l => invert ? !matches(l) : matches(l));
  return count ? String(filtered.length) : filtered.join('\n');
}
