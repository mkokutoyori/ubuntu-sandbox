export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

class Reader {
  position = 0;

  constructor(readonly text: string) {}

  skip(): void {
    for (;;) {
      while (this.position < this.text.length && ' \t\r\n'.includes(this.text[this.position])) this.position++;
      if (this.text.startsWith('/*', this.position)) {
        const end = this.text.indexOf('*/', this.position + 2);
        if (end < 0) throw new Error('unterminated comment');
        this.position = end + 2;
      } else if (this.text.startsWith('//', this.position)) {
        const end = this.text.indexOf('\n', this.position);
        this.position = end < 0 ? this.text.length : end + 1;
      } else return;
    }
  }

  peek(): string {
    return this.text[this.position] ?? '';
  }
}

function parseString(reader: Reader): string {
  const quote = reader.text[reader.position++];
  let out = '';
  for (;;) {
    if (reader.position >= reader.text.length) throw new Error('unterminated string');
    const c = reader.text[reader.position++];
    if (c === quote) return out;
    if (c !== '\\') {
      out += c;
      continue;
    }
    const escape = reader.text[reader.position++];
    switch (escape) {
      case 'n': out += '\n'; break;
      case 't': out += '\t'; break;
      case 'r': out += '\r'; break;
      case 'b': out += '\b'; break;
      case 'f': out += '\f'; break;
      case '/': case '\\': case '"': case "'": out += escape; break;
      case 'u': {
        const hex = reader.text.slice(reader.position, reader.position + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error('bad unicode escape');
        out += String.fromCharCode(parseInt(hex, 16));
        reader.position += 4;
        break;
      }
      default: throw new Error('bad escape');
    }
  }
}

const NUMBER = /^-?(?:\d+)(?:\.\d+)?(?:[eE][+-]?\d+)?/;

function parseValue(reader: Reader): JsonValue {
  reader.skip();
  const c = reader.peek();
  if (c === '{') {
    reader.position++;
    const object: { [key: string]: JsonValue } = {};
    reader.skip();
    if (reader.peek() === '}') {
      reader.position++;
      return object;
    }
    for (;;) {
      reader.skip();
      if (reader.peek() !== '"' && reader.peek() !== "'") throw new Error('object key expected');
      const key = parseString(reader);
      reader.skip();
      if (reader.peek() !== ':') throw new Error('colon expected');
      reader.position++;
      object[key] = parseValue(reader);
      reader.skip();
      const next = reader.text[reader.position++];
      if (next === '}') return object;
      if (next !== ',') throw new Error('comma expected');
    }
  }
  if (c === '[') {
    reader.position++;
    const array: JsonValue[] = [];
    reader.skip();
    if (reader.peek() === ']') {
      reader.position++;
      return array;
    }
    for (;;) {
      array.push(parseValue(reader));
      reader.skip();
      const next = reader.text[reader.position++];
      if (next === ']') return array;
      if (next !== ',') throw new Error('comma expected');
    }
  }
  if (c === '"' || c === "'") return parseString(reader);
  const rest = reader.text.slice(reader.position);
  for (const [literal, value] of [['true', true], ['false', false], ['null', null]] as const) {
    if (rest.slice(0, literal.length).toLowerCase() === literal) {
      reader.position += literal.length;
      return value;
    }
  }
  if (/^nan/i.test(rest)) {
    reader.position += 3;
    return Number.NaN;
  }
  const infinity = /^-?infinity/i.exec(rest);
  if (infinity !== null) {
    reader.position += infinity[0].length;
    return infinity[0].startsWith('-') ? -Infinity : Infinity;
  }
  const number = NUMBER.exec(rest);
  if (number === null) throw new Error('unexpected character');
  reader.position += number[0].length;
  return Number(number[0]);
}

export function parseJsonC(text: string): JsonValue | undefined {
  try {
    const reader = new Reader(text);
    reader.skip();
    if (reader.position >= text.length) return undefined;
    return parseValue(reader);
  } catch {
    return undefined;
  }
}

export function jsonGetString(value: JsonValue | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : jsonNumberText(value);
  return JSON.stringify(value);
}

function jsonNumberText(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (!Number.isFinite(value)) return value > 0 ? 'Infinity' : '-Infinity';
  return String(value);
}

export function jsonGetInt64(value: JsonValue | undefined): number {
  let n = 0;
  if (typeof value === 'number') n = Number.isNaN(value) ? 0 : Math.trunc(value);
  else if (typeof value === 'boolean') n = value ? 1 : 0;
  else if (typeof value === 'string') {
    const match = /^\s*[+-]?\d+/.exec(value);
    n = match === null ? 0 : Number(match[0].trim());
  }
  return Math.max(-9223372036854775808, Math.min(9223372036854775807, n));
}

export function jsonGetInt(value: JsonValue | undefined): number {
  let n = 0;
  if (typeof value === 'number') n = Number.isNaN(value) ? 0 : Math.trunc(value);
  else if (typeof value === 'boolean') n = value ? 1 : 0;
  else if (typeof value === 'string') {
    const match = /^\s*[+-]?\d+/.exec(value);
    n = match === null ? 0 : Number(match[0].trim());
  }
  return Math.max(-2147483648, Math.min(2147483647, n));
}
