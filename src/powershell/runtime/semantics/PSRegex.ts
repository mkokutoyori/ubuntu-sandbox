export interface RegexOptions {
  readonly ignoreCase: boolean;
  readonly multiline?: boolean;
  readonly singleline?: boolean;
  readonly extended?: boolean;
  readonly simpleMatch?: boolean;
}

const INLINE_FLAGS = /^\(\?([imsx]+)\)/;

export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
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
  const parts: string[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  regex.lastIndex = 0;
  while ((match = regex.exec(text)) !== null) {
    if (limit > 0 && parts.length >= limit - 1) break;
    if (match[0] === '') {
      if (match.index >= text.length) break;
      if (match.index === last) {
        regex.lastIndex += 1;
        continue;
      }
    }
    parts.push(text.slice(last, match.index));
    for (let g = 1; g < match.length; g++) if (match[g] !== undefined) parts.push(match[g]);
    last = match.index + match[0].length;
    if (match[0] === '') regex.lastIndex += 1;
  }
  parts.push(text.slice(last));
  return parts;
}
