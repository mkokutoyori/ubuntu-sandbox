/**
 * cmd.exe argument splitting — single source shared by WindowsPC and
 * CmdSubShell. Double quotes group and are stripped; no escape character.
 */
export function splitCmdArgs(line: string, keepQuotes = false): string[] {
  const parts: string[] = [];
  let current = '';
  let inQuote = false;
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') {
      inQuote = !inQuote;
      quoted = true;
      if (keepQuotes) current += ch;
    } else if (ch === ' ' && !inQuote) {
      if (current || quoted) { parts.push(current); current = ''; quoted = false; }
    } else {
      current += ch;
    }
  }
  if (current || quoted) parts.push(current);
  return parts;
}
