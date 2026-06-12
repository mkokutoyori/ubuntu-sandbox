/**
 * cmd.exe argument splitting — single source shared by WindowsPC and
 * CmdSubShell. Double quotes group and are stripped; no escape character.
 */
export function splitCmdArgs(line: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inQuote = false;
  for (const ch of line) {
    if (ch === '"') {
      inQuote = !inQuote;
    } else if (ch === ' ' && !inQuote) {
      if (current) { parts.push(current); current = ''; }
    } else {
      current += ch;
    }
  }
  if (current) parts.push(current);
  return parts;
}
