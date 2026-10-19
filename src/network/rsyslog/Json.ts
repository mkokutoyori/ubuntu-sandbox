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

type JsonObject = { [key: string]: JsonValue };

function isObject(value: JsonValue | undefined): value is JsonObject {
  return value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function findKey(object: JsonObject, key: string, caseSensitive: boolean): string | undefined {
  if (key in object) return key;
  if (caseSensitive) return undefined;
  const folded = key.toLowerCase();
  return Object.keys(object).find((candidate) => candidate.toLowerCase() === folded);
}

const ARRAY_ELEMENT = /^(.*)\[(\d+)\]$/;

export function extractVariable(object: JsonObject, key: string, caseSensitive: boolean): JsonValue | undefined {
  const element = ARRAY_ELEMENT.exec(key);
  if (element !== null) {
    const base = findKey(object, element[1], caseSensitive);
    const container = base === undefined ? undefined : object[base];
    if (Array.isArray(container)) {
      const index = Number(element[2]);
      return index < container.length ? container[index] : undefined;
    }
  }
  const found = findKey(object, key, caseSensitive);
  return found === undefined ? undefined : object[found];
}

export function jsonGet(root: JsonValue, path: string, caseSensitive = false): JsonValue | undefined {
  let current: JsonValue | undefined = root;
  for (const segment of jsonPathSegments(path)) {
    if (!isObject(current)) return undefined;
    current = extractVariable(current, segment, caseSensitive);
    if (current === undefined) return undefined;
  }
  return current;
}

export type VariableOutcome = 'ok' | 'invalid-set-operation' | 'not-found';

export function jsonSet(root: JsonObject, path: string, value: JsonValue, forceReset = false, caseSensitive = false): VariableOutcome {
  const segments = jsonPathSegments(path);
  if (segments.length === 0) {
    if (!isObject(value)) return 'invalid-set-operation';
    for (const [key, entry] of Object.entries(value)) {
      const existing = findKey(root, key, caseSensitive);
      root[existing ?? key] = entry;
    }
    return 'ok';
  }
  let parent: JsonObject = root;
  for (const segment of segments.slice(0, -1)) {
    const next = extractVariable(parent, segment, caseSensitive);
    if (next === undefined) {
      const created: JsonObject = {};
      parent[segment] = created;
      parent = created;
    } else if (isObject(next)) {
      parent = next;
    } else return 'invalid-set-operation';
  }
  const leaf = segments[segments.length - 1];
  const leafKey = findKey(parent, leaf, caseSensitive);
  const existing = leafKey === undefined ? undefined : parent[leafKey];
  const target = leafKey ?? leaf;
  if (forceReset || existing === undefined) {
    parent[target] = value;
  } else if (isObject(value)) {
    if (isObject(existing)) {
      for (const [key, entry] of Object.entries(value)) {
        const inner = findKey(existing, key, caseSensitive);
        existing[inner ?? key] = entry;
      }
    } else parent[target] = value;
  } else {
    if (isObject(existing)) return 'invalid-set-operation';
    parent[target] = value;
  }
  return 'ok';
}

export function jsonUnset(root: JsonObject, path: string, caseSensitive = false): VariableOutcome {
  const segments = jsonPathSegments(path);
  if (segments.length === 0) {
    for (const key of Object.keys(root)) delete root[key];
    return 'ok';
  }
  let parent: JsonValue | undefined = root;
  for (const segment of segments.slice(0, -1)) {
    if (!isObject(parent)) return 'not-found';
    parent = extractVariable(parent, segment, caseSensitive);
  }
  if (!isObject(parent)) return 'not-found';
  const leafKey = findKey(parent, segments[segments.length - 1], caseSensitive);
  if (leafKey === undefined) return 'not-found';
  delete parent[leafKey];
  return 'ok';
}

export function jsonDeepCopy(value: JsonValue): JsonValue {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(jsonDeepCopy);
  const copy: JsonObject = {};
  for (const [key, entry] of Object.entries(value)) copy[key] = jsonDeepCopy(entry);
  return copy;
}
