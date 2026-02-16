/**
 * Shell parser: tokenizes input, handles quotes, pipes, redirections, &&, ||, ;
 */

export interface Redirection {
  type: '>' | '>>' | '2>' | '2>>' | '<';
  target: string;
}

export interface ParsedCommand {
  args: string[];       // command + arguments (quotes stripped, escapes resolved)
  redirections: Redirection[];
  stdinRedirect?: string; // < file
  mergeStderr: boolean;   // 2>&1
}

export interface PipelineSegment {
  commands: ParsedCommand[];  // single command in this pipe segment
}

export interface CommandChain {
  pipeline: PipelineSegment[];  // commands connected by |
  operator: '&&' | '||' | ';' | '';  // how this chain connects to next
}

/**
 * Tokenize input respecting quotes and escapes.
 */
export function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (let i = 0; i < input.length; i++) {
    const c = input[i];

    if (escaped) {
      current += c;
      escaped = false;
      continue;
    }

    if (c === '\\' && !inSingle) {
      escaped = true;
      continue;
    }

    if (c === "'" && !inDouble) {
      if (inSingle) {
        // Inside single quotes: only close if next char is NOT a word char (handle apostrophes like It's)
        const next = input[i + 1];
        if (next && /\w/.test(next)) {
          // Treat as literal apostrophe
          current += c;
          continue;
        }
      }
      inSingle = !inSingle;
      continue;
    }

    if (c === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }

    if (!inSingle && !inDouble && /\s/.test(c)) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += c;
  }

  if (current.length > 0) tokens.push(current);
  return tokens;
}

/**
 * Split input by chain operators (&&, ||, ;) respecting quotes.
 */
export function splitChains(input: string): CommandChain[] {
  const chains: CommandChain[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (let i = 0; i < input.length; i++) {
    const c = input[i];

    if (escaped) { current += c; escaped = false; continue; }
    if (c === '\\' && !inSingle) { escaped = true; current += c; continue; }
    if (c === "'" && !inDouble) {
      if (inSingle) {
        const next = input[i + 1];
        if (next && /\w/.test(next)) { current += c; continue; }
      }
      inSingle = !inSingle; current += c; continue;
    }
    if (c === '"' && !inSingle) { inDouble = !inDouble; current += c; continue; }

    if (!inSingle && !inDouble) {
      if (c === '&' && input[i + 1] === '&') {
        if (current.trim()) {
          chains.push({ pipeline: parsePipeline(current.trim()), operator: '&&' });
        }
        current = '';
        i++; // skip second &
        continue;
      }
      if (c === '|' && input[i + 1] === '|') {
        if (current.trim()) {
          chains.push({ pipeline: parsePipeline(current.trim()), operator: '||' });
        }
        current = '';
        i++;
        continue;
      }
      if (c === ';') {
        if (current.trim()) {
          chains.push({ pipeline: parsePipeline(current.trim()), operator: ';' });
        }
        current = '';
        continue;
      }
    }

    current += c;
  }

  if (current.trim()) {
    chains.push({ pipeline: parsePipeline(current.trim()), operator: '' });
  }

  return chains;
}

/**
 * Split a command string by | (pipe) respecting quotes.
 */
function parsePipeline(input: string): PipelineSegment[] {
  const segments: PipelineSegment[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (let i = 0; i < input.length; i++) {
    const c = input[i];

    if (escaped) { current += c; escaped = false; continue; }
    if (c === '\\' && !inSingle) { escaped = true; current += c; continue; }
    if (c === "'" && !inDouble) {
      if (inSingle) {
        const next = input[i + 1];
        if (next && /\w/.test(next)) { current += c; continue; }
      }
      inSingle = !inSingle; current += c; continue;
    }
    if (c === '"' && !inSingle) { inDouble = !inDouble; current += c; continue; }

    if (!inSingle && !inDouble && c === '|') {
      // Make sure it's not ||
      if (input[i + 1] === '|') {
        current += c;
        continue;
      }
      if (current.trim()) {
        segments.push({ commands: [parseRedirections(current.trim())] });
      }
      current = '';
      continue;
    }

    current += c;
  }

  if (current.trim()) {
    segments.push({ commands: [parseRedirections(current.trim())] });
  }

  return segments;
}

/**
 * Parse a single command, extracting redirections.
 */
function parseRedirections(input: string): ParsedCommand {
  const tokens = tokenize(input);
  const args: string[] = [];
  const redirections: Redirection[] = [];
  let stdinRedirect: string | undefined;
  let mergeStderr = false;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];

    // Handle 2>&1
    if (t === '2>&1') {
      mergeStderr = true;
      continue;
    }

    // Handle 2>/dev/null or 2> file
    if (t === '2>' || t === '2>>') {
      const target = tokens[++i];
      if (target) redirections.push({ type: t as '2>' | '2>>', target });
      continue;
    }
    if (t.startsWith('2>')) {
      const target = t.slice(2);
      redirections.push({ type: '2>', target });
      continue;
    }

    // Handle > file, >> file
    if (t === '>' || t === '>>') {
      const target = tokens[++i];
      if (target) redirections.push({ type: t as '>' | '>>', target });
      continue;
    }
    if (t.startsWith('>>')) {
      redirections.push({ type: '>>', target: t.slice(2) });
      continue;
    }
    if (t.startsWith('>') && t.length > 1) {
      redirections.push({ type: '>', target: t.slice(1) });
      continue;
    }

    // Handle < file (stdin redirect)
    if (t === '<') {
      stdinRedirect = tokens[++i];
      continue;
    }
    if (t.startsWith('<') && t.length > 1) {
      stdinRedirect = t.slice(1);
      continue;
    }

    // Strip trailing & (background - we ignore it)
    if (t === '&') continue;

    args.push(t);
  }

  return { args, redirections, stdinRedirect, mergeStderr };
}

/**
 * Interpret escape sequences for echo -e.
 */
export function interpretEscapes(s: string): string {
  return s
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\r/g, '\r')
    .replace(/\\0/g, '\0')
    .replace(/\\\\/g, '\\');
}
