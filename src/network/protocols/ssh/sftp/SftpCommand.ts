/**
 * SftpCommand — discriminated union of interactive SFTP verbs.
 *
 * Mirrors the OpenSSH `sftp` client REPL. Parsed once by SftpCommandScript
 * and executed by SftpInteractiveSession against a pair of ISftpFileSystem
 * (local + remote). The verb set covers every command the simulator's
 * cross-equipment SSH suite exercises and the everyday interactive batch
 * (put/get/ls/cd/pwd/mkdir/rmdir/rm/chmod/lcd/lls/lpwd/rename/bye).
 */

export type SftpCommand =
  | { readonly verb: 'put';    readonly local: string; readonly remote: string }
  | { readonly verb: 'get';    readonly remote: string; readonly local: string }
  | { readonly verb: 'ls';     readonly path: string | null }
  | { readonly verb: 'cd';     readonly path: string }
  | { readonly verb: 'pwd' }
  | { readonly verb: 'mkdir';  readonly path: string }
  | { readonly verb: 'rmdir';  readonly path: string }
  | { readonly verb: 'rm';     readonly path: string }
  | { readonly verb: 'chmod';  readonly mode: number; readonly path: string }
  | { readonly verb: 'rename'; readonly src: string; readonly dst: string }
  | { readonly verb: 'lcd';    readonly path: string }
  | { readonly verb: 'lls';    readonly path: string | null }
  | { readonly verb: 'lpwd' }
  | { readonly verb: 'bye' };

export interface SftpCommandParseError {
  readonly kind: 'parse';
  readonly line: string;
  readonly reason: string;
}

const tokenize = (line: string): string[] => {
  const out: string[] = [];
  let buf = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) { quote = null; continue; }
      buf += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (/\s/.test(c)) { if (buf) { out.push(buf); buf = ''; } continue; }
    buf += c;
  }
  if (buf) out.push(buf);
  return out;
};

/**
 * Parse a single sftp REPL line into a SftpCommand. Comments (#…) and
 * blank lines return null; unknown verbs return a parse error so the
 * caller can decide whether to abort the script or skip the line.
 */
export function parseSftpLine(rawLine: string): SftpCommand | SftpCommandParseError | null {
  const line = rawLine.replace(/#.*$/, '').trim();
  if (!line) return null;
  const tokens = tokenize(line);
  const verb = tokens[0]?.toLowerCase() ?? '';
  const args = tokens.slice(1);

  switch (verb) {
    case 'put': {
      if (args.length === 0) return { kind: 'parse', line, reason: 'put: missing source' };
      return { verb: 'put', local: args[0], remote: args[1] ?? args[0] };
    }
    case 'get': {
      if (args.length === 0) return { kind: 'parse', line, reason: 'get: missing source' };
      return { verb: 'get', remote: args[0], local: args[1] ?? args[0] };
    }
    case 'ls':    return { verb: 'ls',   path: args[0] ?? null };
    case 'lls':   return { verb: 'lls',  path: args[0] ?? null };
    case 'cd':    return { verb: 'cd',   path: args[0] ?? '/' };
    case 'lcd':   return { verb: 'lcd',  path: args[0] ?? '/' };
    case 'pwd':   return { verb: 'pwd' };
    case 'lpwd':  return { verb: 'lpwd' };
    case 'mkdir':
      if (!args[0]) return { kind: 'parse', line, reason: 'Usage: mkdir path' };
      return { verb: 'mkdir', path: args[0] };
    case 'rmdir':
      if (!args[0]) return { kind: 'parse', line, reason: 'Usage: rmdir path' };
      return { verb: 'rmdir', path: args[0] };
    case 'rm':
    case 'delete':
      if (!args[0]) return { kind: 'parse', line, reason: 'Usage: rm path' };
      return { verb: 'rm', path: args[0] };
    case 'chmod': {
      const mode = Number.parseInt(args[0] ?? '', 8);
      if (Number.isNaN(mode)) return { kind: 'parse', line, reason: 'chmod: invalid mode' };
      if (!args[1]) return { kind: 'parse', line, reason: 'Usage: chmod mode path' };
      return { verb: 'chmod', mode, path: args[1] };
    }
    case 'rename':
    case 'mv':
      if (args.length < 2) return { kind: 'parse', line, reason: 'rename: needs two args' };
      return { verb: 'rename', src: args[0], dst: args[1] };
    case 'bye':
    case 'quit':
    case 'exit':
      return { verb: 'bye' };
    default:
      return { kind: 'parse', line, reason: `Invalid command: ${verb}` };
  }
}
