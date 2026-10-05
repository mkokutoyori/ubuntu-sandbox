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

const COMMAND_WORD_THEN_SWITCH = /^([A-Za-z][A-Za-z0-9_-]*)(\/.*)$/;
const PATH_COMMAND_THEN_PATH = /^(cd|chdir|dir)([.\\].*)$/i;
const ECHO_THEN_TEXT = /^(echo)\.(.*)$/i;

export function separateCommandWord(parts: string[]): string[] {
  const [first, ...rest] = parts;
  if (first === undefined) return parts;
  const switchAfter = COMMAND_WORD_THEN_SWITCH.exec(first);
  if (switchAfter) return [switchAfter[1], switchAfter[2], ...rest];
  const pathAfter = PATH_COMMAND_THEN_PATH.exec(first);
  if (pathAfter) return [pathAfter[1], pathAfter[2], ...rest];
  const textAfter = ECHO_THEN_TEXT.exec(first);
  if (textAfter) return [textAfter[1], textAfter[2], ...rest];
  return parts;
}
