/**
 * cmd.exe command-line tokenisation.
 *
 * Single source of truth for splitting a cmd.exe line into arguments,
 * shared by WindowsPC (root cmd execution path) and CmdSubShell (nested
 * `cmd` sessions). Both used to carry an identical private copy
 * (`parseCommandLine` / `splitArgs`) — a quoting fix in one silently
 * missed the other.
 *
 * Semantics (faithful to cmd.exe argument splitting, simplified):
 *   - double quotes group words: `echo "a b"` → ['echo', 'a b'];
 *   - quotes toggle in-place and are stripped: `a"b c"d` → ['ab cd'];
 *   - there is NO escape character (cmd.exe has no backslash escaping
 *     at this level — `\` is a path separator).
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
