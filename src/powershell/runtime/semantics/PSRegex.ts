export interface RegexOptions {
  readonly ignoreCase: boolean;
  readonly multiline?: boolean;
  readonly singleline?: boolean;
  readonly extended?: boolean;
  readonly simpleMatch?: boolean;
  readonly explicitCapture?: boolean;
}

const INLINE_FLAGS = /^\(\?([imsx]+)\)/;

export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
}

function withoutUnnamedGroups(source: string): string {
  let out = '';
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === '\\') { out += c + (source[i + 1] ?? ''); i++; continue; }
    if (inClass) { if (c === ']') inClass = false; out += c; continue; }
    if (c === '[') { inClass = true; out += c; continue; }
    out += c === '(' && source[i + 1] !== '?' ? '(?:' : c;
  }
  return out;
}

function translatePattern(pattern: string): string {
  return pattern
    .replace(/\(\?'([A-Za-z_][\w]*)'/g, '(?<$1>')
    .replace(/\\A/g, '^')
    .replace(/\\Z/g, '(?=\\n?$)')
    .replace(/\\z/g, '$')
    .replace(/\(\?<([A-Za-z_]\w*)-[A-Za-z_]\w*>/g, '(?<$1>');
}

export function compileRegex(pattern: string, options: RegexOptions, extraFlags = ''): RegExp {
  let source = pattern;
  let ignoreCase = options.ignoreCase;
  let multiline = options.multiline === true;
  let singleline = options.singleline === true;
  let extended = options.extended === true;
  if (options.simpleMatch !== true) {
    for (;;) {
      const inline = INLINE_FLAGS.exec(source);
      if (inline === null) break;
      if (inline[1].includes('i')) ignoreCase = true;
      if (inline[1].includes('m')) multiline = true;
      if (inline[1].includes('s')) singleline = true;
      if (inline[1].includes('x')) extended = true;
      source = source.slice(inline[0].length);
    }
    source = translatePattern(source);
    if (options.explicitCapture === true) source = withoutUnnamedGroups(source);
    if (extended) source = source.replace(/\\#/g, '\u0000').replace(/#.*$/gm, '').replace(/\s+/g, '').replace(/\u0000/g, '\\#');
  } else {
    source = escapeRegex(source);
  }
  let flags = extraFlags;
  if (ignoreCase) flags += 'i';
  if (multiline) flags += 'm';
  if (singleline) flags += 's';
  return new RegExp(source, flags);
}

export function expandReplacement(template: string, match: RegExpExecArray | string[], groups: Record<string, string> | undefined, input: string, index: number): string {
  let out = '';
  for (let i = 0; i < template.length; i++) {
    const ch = template[i];
    if (ch !== '$' || i === template.length - 1) {
      out += ch;
      continue;
    }
    const next = template[i + 1];
    if (next === '$') { out += '$'; i += 1; continue; }
    if (next === '&') { out += match[0]; i += 1; continue; }
    if (next === '`') { out += input.slice(0, index); i += 1; continue; }
    if (next === "'") { out += input.slice(index + match[0].length); i += 1; continue; }
    if (next === '_') { out += input; i += 1; continue; }
    if (next === '{') {
      const close = template.indexOf('}', i + 2);
      if (close > 0) {
        const name = template.slice(i + 2, close);
        const value = /^\d+$/.test(name) ? match[Number(name)] : groups?.[name];
        if (value !== undefined || /^\d+$/.test(name) || (groups !== undefined && name in groups)) {
          out += value ?? '';
          i = close;
          continue;
        }
      }
    }
    const digits = /^\d{1,2}/.exec(template.slice(i + 1));
    if (digits !== null) {
      const group = Number(digits[0]);
      if (group < match.length) {
        out += match[group] ?? '';
        i += digits[0].length;
        continue;
      }
    }
    out += ch;
  }
  return out;
}

export function regexReplace(
  text: string, pattern: string, replacement: string | ((match: RegExpExecArray) => string), options: RegexOptions,
): string {
  const regex = compileRegex(pattern, options, 'g');
  return text.replace(regex, (...args: unknown[]) => {
    const lastIsGroups = typeof args[args.length - 1] === 'object' && args[args.length - 1] !== null;
    const groups = lastIsGroups ? args[args.length - 1] as Record<string, string> : undefined;
    const tail = lastIsGroups ? 3 : 2;
    const index = args[args.length - tail] as number;
    const matchParts = args.slice(0, args.length - tail) as string[];
    const exec = Object.assign([...matchParts], { index, input: text, groups }) as unknown as RegExpExecArray;
    return typeof replacement === 'function'
      ? replacement(exec)
      : expandReplacement(replacement, exec, groups, text, index);
  });
}

export function regexSplit(text: string, pattern: string, limit: number, options: RegexOptions): string[] {
  const regex = compileRegex(pattern, options, 'g');
  const matches: RegExpExecArray[] = [];
  let match: RegExpExecArray | null;
  regex.lastIndex = 0;
  while ((match = regex.exec(text)) !== null) {
    if (match[0] === '') {
      if (match.index >= text.length) break;
      regex.lastIndex += 1;
      if (match.index === 0) continue;
    }
    matches.push(match);
  }
  const count = Math.abs(limit);
  if (count === 1) return [text];
  const chosen = count === 0 ? matches : limit > 0 ? matches.slice(0, count - 1) : matches.slice(Math.max(0, matches.length - (count - 1)));
  const parts: string[] = [];
  let last = 0;
  for (const hit of chosen) {
    parts.push(text.slice(last, hit.index));
    for (let g = 1; g < hit.length; g++) if (hit[g] !== undefined) parts.push(hit[g]);
    last = hit.index + hit[0].length;
  }
  parts.push(text.slice(last));
  return parts;
}
