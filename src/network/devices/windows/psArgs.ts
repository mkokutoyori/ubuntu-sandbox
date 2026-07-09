export function parsePSArgs(args: string[]): Map<string, string> {
  const merged: string[] = [];
  let buf = '';
  let inQuote = false;
  for (const tok of args) {
    if (inQuote) {
      buf += ' ' + tok;
      if (tok.endsWith('"') || tok.endsWith("'")) {
        inQuote = false;
        merged.push(buf);
        buf = '';
      }
    } else if ((tok.startsWith('"') && !tok.endsWith('"')) || (tok.startsWith("'") && !tok.endsWith("'"))) {
      inQuote = true;
      buf = tok;
    } else {
      merged.push(tok);
    }
  }
  if (buf) merged.push(buf);

  const result = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < merged.length; i++) {
    if (merged[i].startsWith('-') && i + 1 < merged.length && !merged[i + 1].startsWith('-')) {
      result.set(merged[i].substring(1).toLowerCase(), merged[i + 1].replace(/^["']|["']$/g, ''));
      i++;
    } else if (merged[i].startsWith('-')) {
      result.set(merged[i].substring(1).toLowerCase(), 'true');
    } else {
      positional.push(merged[i].replace(/^["']|["']$/g, ''));
    }
  }
  if (positional.length > 0) result.set('_positional', positional[0]);
  return result;
}
