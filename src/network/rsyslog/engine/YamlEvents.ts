export type YamlEvent =
  | { readonly type: 'mapping-start' }
  | { readonly type: 'mapping-end' }
  | { readonly type: 'sequence-start' }
  | { readonly type: 'sequence-end' }
  | { readonly type: 'scalar'; readonly value: string };

export interface YamlParse {
  readonly events: YamlEvent[];
  readonly problem: string | null;
}

interface Line {
  indent: number;
  text: string;
}

class YamlProblem extends Error {}

const DOCUMENT_MARKER = /^(---|\.\.\.)(\s|$)/;

function stripComment(text: string): string {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const character = text[i];
    if (quote !== null) {
      if (character === '\\' && quote === '"') i++;
      else if (character === quote) {
        if (quote === "'" && text[i + 1] === "'") i++;
        else quote = null;
      }
    } else if (character === '"' || character === "'") {
      if (i === 0 || /[\s[{,:-]/.test(text[i - 1])) quote = character;
    } else if (character === '#' && (i === 0 || /\s/.test(text[i - 1]))) {
      return text.slice(0, i);
    }
  }
  return text;
}

function splitLines(source: string): Line[] {
  const lines: Line[] = [];
  for (const raw of source.split(/\r?\n/)) {
    const stripped = stripComment(raw).replace(/\s+$/, '');
    if (stripped.trim().length === 0) continue;
    if (DOCUMENT_MARKER.test(stripped)) continue;
    const indentation = /^ */.exec(stripped)?.[0].length ?? 0;
    if (stripped[indentation] === '\t') throw new YamlProblem('found character that cannot start any token');
    lines.push({ indent: indentation, text: stripped.slice(indentation) });
  }
  return lines;
}

function keySeparator(text: string): number {
  let quote: string | null = null;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const character = text[i];
    if (quote !== null) {
      if (character === '\\' && quote === '"') i++;
      else if (character === quote) {
        if (quote === "'" && text[i + 1] === "'") i++;
        else quote = null;
      }
    } else if ((character === '"' || character === "'") && (i === 0 || /[\s[{,]/.test(text[i - 1]))) quote = character;
    else if (character === '[' || character === '{') depth++;
    else if (character === ']' || character === '}') depth--;
    else if (character === ':' && depth === 0 && (i + 1 === text.length || /\s/.test(text[i + 1]))) return i;
  }
  return -1;
}

function unescapeDouble(body: string): string {
  return body.replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|.)/g, (_, code: string) => {
    if (code[0] === 'x' && code.length === 3) return String.fromCharCode(Number.parseInt(code.slice(1), 16));
    if (code[0] === 'u' && code.length === 5) return String.fromCharCode(Number.parseInt(code.slice(1), 16));
    switch (code) {
      case 'n': return '\n';
      case 't': return '\t';
      case 'r': return '\r';
      case '0': return '\0';
      case '"': return '"';
      case '\\': return '\\';
      case '/': return '/';
      default: return code;
    }
  });
}

function scalarOf(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('"')) {
    if (trimmed.length < 2 || !trimmed.endsWith('"')) throw new YamlProblem('found unexpected end of stream while scanning a quoted scalar');
    return unescapeDouble(trimmed.slice(1, -1));
  }
  if (trimmed.startsWith("'")) {
    if (trimmed.length < 2 || !trimmed.endsWith("'")) throw new YamlProblem('found unexpected end of stream while scanning a quoted scalar');
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

class FlowReader {
  private position = 0;

  constructor(private readonly text: string, private readonly events: YamlEvent[]) {}

  read(): void {
    this.skip();
    this.node();
    this.skip();
    if (this.position < this.text.length) throw new YamlProblem("did not find expected ',' or ']'");
  }

  private skip(): void {
    while (this.position < this.text.length && /\s/.test(this.text[this.position])) this.position++;
  }

  private node(): void {
    const character = this.text[this.position];
    if (character === '[') this.sequence();
    else if (character === '{') this.mapping();
    else this.events.push({ type: 'scalar', value: this.scalar() });
  }

  private scalar(): string {
    const start = this.position;
    const character = this.text[start];
    if (character === '"' || character === "'") {
      this.position++;
      while (this.position < this.text.length && this.text[this.position] !== character) {
        if (character === '"' && this.text[this.position] === '\\') this.position++;
        this.position++;
      }
      if (this.position >= this.text.length) throw new YamlProblem('found unexpected end of stream while scanning a quoted scalar');
      this.position++;
      return scalarOf(this.text.slice(start, this.position));
    }
    while (this.position < this.text.length && !',]}'.includes(this.text[this.position]) && !(this.text[this.position] === ':' && /\s/.test(this.text[this.position + 1] ?? ' '))) this.position++;
    return this.text.slice(start, this.position).trim();
  }

  private sequence(): void {
    this.events.push({ type: 'sequence-start' });
    this.position++;
    this.skip();
    while (this.text[this.position] !== ']') {
      if (this.position >= this.text.length) throw new YamlProblem("did not find expected ',' or ']'");
      this.node();
      this.skip();
      if (this.text[this.position] === ',') {
        this.position++;
        this.skip();
      } else if (this.text[this.position] !== ']') throw new YamlProblem("did not find expected ',' or ']'");
    }
    this.position++;
    this.events.push({ type: 'sequence-end' });
  }

  private mapping(): void {
    this.events.push({ type: 'mapping-start' });
    this.position++;
    this.skip();
    while (this.text[this.position] !== '}') {
      if (this.position >= this.text.length) throw new YamlProblem("did not find expected ',' or '}'");
      this.events.push({ type: 'scalar', value: this.scalar() });
      this.skip();
      if (this.text[this.position] === ':') {
        this.position++;
        this.skip();
        if (',}'.includes(this.text[this.position] ?? '}')) this.events.push({ type: 'scalar', value: '' });
        else this.node();
      } else this.events.push({ type: 'scalar', value: '' });
      this.skip();
      if (this.text[this.position] === ',') {
        this.position++;
        this.skip();
      } else if (this.text[this.position] !== '}') throw new YamlProblem("did not find expected ',' or '}'");
    }
    this.position++;
    this.events.push({ type: 'mapping-end' });
  }
}

class BlockReader {
  private index = 0;

  constructor(private readonly lines: Line[], private readonly events: YamlEvent[]) {}

  read(): void {
    if (this.lines.length === 0) return;
    this.node(this.lines[0].indent);
    if (this.index < this.lines.length) throw new YamlProblem('did not find expected <document start>');
  }

  private current(): Line | undefined {
    return this.lines[this.index];
  }

  private node(indent: number): void {
    const line = this.current() as Line;
    if (line.text === '-' || line.text.startsWith('- ')) this.sequence(indent);
    else if (keySeparator(line.text) >= 0) this.mapping(indent);
    else this.inlineValue(line.text, () => { this.index++; });
  }

  private inlineValue(text: string, consume: () => void): void {
    consume();
    const trimmed = text.trim();
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) new FlowReader(trimmed, this.events).read();
    else this.events.push({ type: 'scalar', value: scalarOf(trimmed) });
  }

  private mapping(indent: number): void {
    this.events.push({ type: 'mapping-start' });
    for (let line = this.current(); line !== undefined && line.indent >= indent; line = this.current()) {
      if (line.indent > indent) throw new YamlProblem('mapping values are not allowed in this context');
      const separator = keySeparator(line.text);
      if (separator < 0) throw new YamlProblem('could not find expected \':\'');
      this.events.push({ type: 'scalar', value: scalarOf(line.text.slice(0, separator)) });
      const rest = line.text.slice(separator + 1).trim();
      if (rest.length > 0) {
        if (keySeparator(rest) >= 0 && !rest.startsWith('"') && !rest.startsWith("'") && !rest.startsWith('[') && !rest.startsWith('{')) {
          throw new YamlProblem('mapping values are not allowed in this context');
        }
        this.inlineValue(rest, () => { this.index++; });
        continue;
      }
      this.index++;
      const next = this.current();
      if (next !== undefined && next.indent > indent) this.node(next.indent);
      else if (next !== undefined && next.indent === indent && (next.text === '-' || next.text.startsWith('- '))) this.sequence(indent);
      else this.events.push({ type: 'scalar', value: '' });
    }
    this.events.push({ type: 'mapping-end' });
  }

  private sequence(indent: number): void {
    this.events.push({ type: 'sequence-start' });
    for (let line = this.current(); line !== undefined && line.indent === indent && (line.text === '-' || line.text.startsWith('- ')); line = this.current()) {
      const rest = line.text.slice(1);
      const content = rest.trimStart();
      if (content.length === 0) {
        this.index++;
        const next = this.current();
        if (next !== undefined && next.indent > indent) this.node(next.indent);
        else this.events.push({ type: 'scalar', value: '' });
        continue;
      }
      const offset = indent + 1 + (rest.length - content.length);
      if (keySeparator(content) >= 0 && !content.startsWith('[') && !content.startsWith('{')) {
        this.lines[this.index] = { indent: offset, text: content };
        this.mapping(offset);
      } else this.inlineValue(content, () => { this.index++; });
    }
    this.events.push({ type: 'sequence-end' });
    const trailing = this.current();
    if (trailing !== undefined && trailing.indent > indent) throw new YamlProblem('did not find expected key');
  }
}

export function yamlEvents(source: string): YamlParse {
  const events: YamlEvent[] = [];
  try {
    new BlockReader(splitLines(source), events).read();
    return { events, problem: null };
  } catch (error) {
    if (error instanceof YamlProblem) return { events, problem: error.message };
    throw error;
  }
}
