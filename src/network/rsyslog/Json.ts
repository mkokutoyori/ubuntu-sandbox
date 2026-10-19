import type { JsonValue } from './Message';

export function jsonEscape(text: string, escapeAll: boolean): string {
  let output = '';
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    const code = text.charCodeAt(index);
    const safe = (code >= 0x30 && code <= 0x5b) || (code >= 0x23 && code <= 0x2e) || code >= 0x5d || code === 0x20 || code === 0x21;
    if (safe) { output += character; continue; }
    switch (character) {
      case '"': output += '\\"'; break;
      case '/': output += '\\/'; break;
      case '\\': {
        const next = text[index + 1];
        if (!escapeAll && next !== undefined && '"/\\bfnrtu'.includes(next)) {
          output += `\\${next}`;
          index++;
        } else output += '\\\\';
        break;
      }
      case '\b': output += '\\b'; break;
      case '\f': output += '\\f'; break;
      case '\n': output += '\\n'; break;
      case '\r': output += '\\r'; break;
      case '\t': output += '\\t'; break;
      default: output += `\\u${code.toString(16).toUpperCase().padStart(4, '0')}`;
    }
  }
  return output;
}

function quote(text: string): string {
  return `"${jsonEscape(text, true)}"`;
}

export function jsonText(value: JsonValue, plain = false): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return quote(value);
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) {
    if (value.length === 0) return plain ? '[]' : '[ ]';
    const items = value.map((item) => jsonText(item, plain));
    return plain ? `[${items.join(',')}]` : `[ ${items.join(', ')} ]`;
  }
  const entries = Object.entries(value).map(([key, item]) => `${quote(key)}${plain ? ':' : ': '}${jsonText(item, plain)}`);
  if (entries.length === 0) return plain ? '{}' : '{ }';
  return plain ? `{${entries.join(',')}}` : `{ ${entries.join(', ')} }`;
}

export function jsonToString(value: JsonValue): string {
  if (typeof value === 'string') return value;
  return jsonText(value);
}

export function jsonPathSegments(path: string): string[] {
  return path.split('!').filter((segment) => segment.length > 0);
}

export function jsonGet(root: JsonValue, path: string): JsonValue | undefined {
  let current: JsonValue | undefined = root;
  for (const segment of jsonPathSegments(path)) {
    if (current === null || typeof current !== 'object') return undefined;
    if (Array.isArray(current)) {
      const bracket = /^\[(\d+)\]$/.exec(segment);
      current = bracket === null ? undefined : current[Number(bracket[1])];
    } else {
      current = (current as { [key: string]: JsonValue })[segment];
    }
    if (current === undefined) return undefined;
  }
  return current;
}

export function jsonSet(root: { [key: string]: JsonValue }, path: string, value: JsonValue): void {
  const segments = jsonPathSegments(path);
  if (segments.length === 0) return;
  let current: { [key: string]: JsonValue } = root;
  for (const segment of segments.slice(0, -1)) {
    const next = current[segment];
    if (next === undefined || next === null || typeof next !== 'object' || Array.isArray(next)) {
      const created: { [key: string]: JsonValue } = {};
      current[segment] = created;
      current = created;
    } else {
      current = next as { [key: string]: JsonValue };
    }
  }
  current[segments[segments.length - 1]] = value;
}

export function jsonUnset(root: { [key: string]: JsonValue }, path: string): void {
  const segments = jsonPathSegments(path);
  if (segments.length === 0) return;
  let current: JsonValue | undefined = root;
  for (const segment of segments.slice(0, -1)) {
    if (current === null || current === undefined || typeof current !== 'object' || Array.isArray(current)) return;
    current = (current as { [key: string]: JsonValue })[segment];
  }
  if (current !== null && current !== undefined && typeof current === 'object' && !Array.isArray(current)) {
    delete (current as { [key: string]: JsonValue })[segments[segments.length - 1]];
  }
}
