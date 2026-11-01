export interface PatternMatcher {
  lastIndex: number;
  exec(text: string): RegExpExecArray | null;
}

type Node =
  | { kind: 'atom'; source: string; zeroWidth: boolean }
  | { kind: 'empty' }
  | { kind: 'cat'; parts: Node[] }
  | { kind: 'alt'; branches: Node[] }
  | { kind: 'group'; index: number; body: Node }
  | { kind: 'repeat'; body: Node; min: number; max: number; lazy: boolean };

type Instruction =
  | { op: 'char'; matcher: RegExp }
  | { op: 'assert'; matcher: RegExp }
  | { op: 'split'; first: number; second: number }
  | { op: 'jump'; to: number }
  | { op: 'save'; slot: number }
  | { op: 'mark'; slot: number }
  | { op: 'progress'; slot: number }
  | { op: 'match' };

class Unsupported extends Error {}

const MAX_PROGRAM = 6000;

class Parser {
  private at = 0;
  groups = 0;

  constructor(private readonly source: string, private readonly unicode: boolean) {}

  parse(): Node {
    const node = this.alternation();
    if (this.at < this.source.length) throw new Unsupported();
    return node;
  }

  private alternation(): Node {
    const branches = [this.sequence()];
    while (this.source[this.at] === '|') {
      this.at++;
      branches.push(this.sequence());
    }
    return branches.length === 1 ? branches[0] : { kind: 'alt', branches };
  }

  private sequence(): Node {
    const parts: Node[] = [];
    while (this.at < this.source.length && this.source[this.at] !== '|' && this.source[this.at] !== ')') parts.push(this.quantified());
    if (parts.length === 0) return { kind: 'empty' };
    return parts.length === 1 ? parts[0] : { kind: 'cat', parts };
  }

  private quantified(): Node {
    const body = this.atom();
    const character = this.source[this.at];
    let min = -1;
    let max = -1;
    if (character === '*') { min = 0; max = Infinity; this.at++; }
    else if (character === '+') { min = 1; max = Infinity; this.at++; }
    else if (character === '?') { min = 0; max = 1; this.at++; }
    else if (character === '{') {
      const braces = /^\{(\d+)(,(\d*))?\}/.exec(this.source.slice(this.at));
      if (braces === null) return body;
      min = Number(braces[1]);
      max = braces[2] === undefined ? min : braces[3] === '' ? Infinity : Number(braces[3]);
      this.at += braces[0].length;
    } else {
      return body;
    }
    if (body.kind === 'atom' && body.zeroWidth) throw new Unsupported();
    let lazy = false;
    if (this.source[this.at] === '?') { lazy = true; this.at++; }
    return { kind: 'repeat', body, min, max, lazy };
  }

  private atom(): Node {
    const start = this.at;
    const character = this.source[this.at];
    if (character === '(') return this.group();
    if (character === '[') {
      this.at++;
      while (this.at < this.source.length && this.source[this.at] !== ']') this.at += this.source[this.at] === '\\' ? 2 : 1;
      if (this.at >= this.source.length) throw new Unsupported();
      this.at++;
      return { kind: 'atom', source: this.source.slice(start, this.at), zeroWidth: false };
    }
    if (character === '\\') {
      const next = this.source[this.at + 1];
      if (next === undefined || /[1-9k]/.test(next)) throw new Unsupported();
      if (next === 'b' || next === 'B') {
        this.at += 2;
        return { kind: 'atom', source: this.source.slice(start, this.at), zeroWidth: true };
      }
      if ((next === 'p' || next === 'P') && this.source[this.at + 2] === '{') this.at = this.source.indexOf('}', this.at) + 1;
      else if (next === 'u' && this.source[this.at + 2] === '{') this.at = this.source.indexOf('}', this.at) + 1;
      else if (next === 'u') this.at += 6;
      else if (next === 'x') this.at += 4;
      else if (next === 'c') this.at += 3;
      else this.at += 2;
      if (this.at <= start) throw new Unsupported();
      return { kind: 'atom', source: this.source.slice(start, this.at), zeroWidth: false };
    }
    if (character === '^' || character === '$') {
      this.at++;
      return { kind: 'atom', source: character, zeroWidth: true };
    }
    if (character === '*' || character === '+' || character === '?' || character === '{') throw new Unsupported();
    const code = this.source.codePointAt(this.at)!;
    this.at += this.unicode && code > 0xffff ? 2 : 1;
    return { kind: 'atom', source: this.source.slice(start, this.at), zeroWidth: false };
  }

  private group(): Node {
    const start = this.at;
    const head = this.source.slice(this.at, this.at + 4);
    if (head.startsWith('(?:')) {
      this.at += 3;
      const body = this.alternation();
      this.expectClose();
      return body;
    }
    if (head.startsWith('(?=') || head.startsWith('(?!') || head.startsWith('(?<=') || head.startsWith('(?<!')) {
      this.at = this.closingParenthesis(start);
      this.groups += this.capturesWithin(this.source.slice(start + 1, this.at - 1));
      return { kind: 'atom', source: this.source.slice(start, this.at), zeroWidth: true };
    }
    const named = /^\(\?<[A-Za-z_]\w*>/.exec(this.source.slice(this.at));
    if (named === null && head.startsWith('(?')) throw new Unsupported();
    this.at += named === null ? 1 : named[0].length;
    const index = ++this.groups;
    const body = this.alternation();
    this.expectClose();
    return { kind: 'group', index, body };
  }

  private capturesWithin(text: string): number {
    let count = 0;
    for (let at = 0; at < text.length; at++) {
      const character = text[at];
      if (character === '\\') at++;
      else if (character === '[') {
        at++;
        while (at < text.length && text[at] !== ']') at += text[at] === '\\' ? 2 : 1;
      } else if (character === '(' && (text[at + 1] !== '?' || /^\(\?<[A-Za-z_]/.test(text.slice(at)))) count++;
    }
    return count;
  }

  private expectClose(): void {
    if (this.source[this.at] !== ')') throw new Unsupported();
    this.at++;
  }

  private closingParenthesis(from: number): number {
    let depth = 0;
    for (let at = from; at < this.source.length; at++) {
      const character = this.source[at];
      if (character === '\\') at++;
      else if (character === '[') {
        at++;
        while (at < this.source.length && this.source[at] !== ']') at += this.source[at] === '\\' ? 2 : 1;
      } else if (character === '(') depth++;
      else if (character === ')' && --depth === 0) return at + 1;
    }
    throw new Unsupported();
  }
}

export function starHeight(source: string, unicode: boolean): number {
  try {
    const parser = new Parser(source, unicode);
    return heightOf(parser.parse());
  } catch (failure) {
    if (failure instanceof Unsupported) return 0;
    throw failure;
  }
}

function heightOf(node: Node): number {
  switch (node.kind) {
    case 'cat': return Math.max(0, ...node.parts.map(heightOf));
    case 'alt': return Math.max(0, ...node.branches.map(heightOf));
    case 'group': return heightOf(node.body);
    case 'repeat': return heightOf(node.body) + (node.max === Infinity ? 1 : 0);
    default: return 0;
  }
}

class Compiler {
  readonly program: Instruction[] = [];

  private loops = 0;

  constructor(private readonly matcherFor: (source: string) => RegExp, private readonly slotBase: number) {}

  private compileIteration(body: Node): void {
    const slot = this.slotBase + this.loops++;
    this.emit({ op: 'mark', slot });
    this.compile(body);
    this.emit({ op: 'progress', slot });
  }

  emit(instruction: Instruction): number {
    if (this.program.length >= MAX_PROGRAM) throw new Unsupported();
    this.program.push(instruction);
    return this.program.length - 1;
  }

  compile(node: Node): void {
    switch (node.kind) {
      case 'empty': return;
      case 'atom':
        this.emit({ op: node.zeroWidth ? 'assert' : 'char', matcher: this.matcherFor(node.source) });
        return;
      case 'cat':
        node.parts.forEach((part) => this.compile(part));
        return;
      case 'alt': {
        const jumps: number[] = [];
        node.branches.forEach((branch, index) => {
          if (index < node.branches.length - 1) {
            const split = this.emit({ op: 'split', first: 0, second: 0 });
            (this.program[split] as { first: number }).first = this.program.length;
            this.compile(branch);
            jumps.push(this.emit({ op: 'jump', to: 0 }));
            (this.program[split] as { second: number }).second = this.program.length;
          } else {
            this.compile(branch);
          }
        });
        jumps.forEach((jump) => { (this.program[jump] as { to: number }).to = this.program.length; });
        return;
      }
      case 'group':
        this.emit({ op: 'save', slot: node.index * 2 });
        this.compile(node.body);
        this.emit({ op: 'save', slot: node.index * 2 + 1 });
        return;
      case 'repeat':
        this.repeat(node);
    }
  }

  private repeat(node: Extract<Node, { kind: 'repeat' }>): void {
    for (let count = 0; count < node.min; count++) this.compile(node.body);
    if (node.max === Infinity) {
      const split = this.emit({ op: 'split', first: 0, second: 0 });
      const bodyStart = this.program.length;
      this.compileIteration(node.body);
      this.emit({ op: 'jump', to: split });
      const exit = this.program.length;
      this.program[split] = node.lazy ? { op: 'split', first: exit, second: bodyStart } : { op: 'split', first: bodyStart, second: exit };
      return;
    }
    const splits: number[] = [];
    for (let count = node.min; count < node.max; count++) {
      splits.push(this.emit({ op: 'split', first: 0, second: 0 }));
      this.compileIteration(node.body);
    }
    const exit = this.program.length;
    splits.forEach((split) => {
      const bodyStart = split + 1;
      this.program[split] = node.lazy ? { op: 'split', first: exit, second: bodyStart } : { op: 'split', first: bodyStart, second: exit };
    });
  }
}

interface Thread {
  readonly pc: number;
  readonly captures: readonly (number | undefined)[];
}

export class LinearRegExp implements PatternMatcher {
  lastIndex = 0;

  private constructor(private readonly program: readonly Instruction[], private readonly groups: number, private readonly wantsIndices: boolean) {}

  static compile(source: string, flags: string): LinearRegExp | null {
    try {
      const unicode = flags.includes('u');
      const parser = new Parser(source, unicode);
      const tree = parser.parse();
      const atomFlags = flags.replace(/[gyd]/g, '') + 'y';
      const cache = new Map<string, RegExp>();
      const compiler = new Compiler((atom) => {
        let matcher = cache.get(atom);
        if (matcher === undefined) {
          matcher = new RegExp(atom, atomFlags);
          cache.set(atom, matcher);
        }
        return matcher;
      }, (parser.groups + 1) * 2);
      compiler.compile(tree);
      compiler.emit({ op: 'match' });
      return new LinearRegExp(compiler.program, parser.groups, flags.includes('d'));
    } catch (failure) {
      if (failure instanceof Unsupported || failure instanceof SyntaxError) return null;
      throw failure;
    }
  }

  exec(text: string): RegExpExecArray | null {
    for (let start = this.lastIndex; start <= text.length; start++) {
      const captures = this.run(text, start);
      if (captures !== null) return this.result(text, start, captures);
      const code = text.codePointAt(start);
      if (code !== undefined && code > 0xffff) start++;
    }
    return null;
  }

  private result(text: string, start: number, captures: readonly (number | undefined)[]): RegExpExecArray {
    const end = captures[1]!;
    const found: (string | undefined)[] = [text.slice(start, end)];
    const indices: ([number, number] | undefined)[] = [[start, end]];
    for (let group = 1; group <= this.groups; group++) {
      const from = captures[group * 2];
      const to = captures[group * 2 + 1];
      if (from === undefined || to === undefined) {
        found.push(undefined);
        indices.push(undefined);
      } else {
        found.push(text.slice(from, to));
        indices.push([from, to]);
      }
    }
    const result = Object.assign(found, { index: start, input: text }) as unknown as RegExpExecArray & { indices?: unknown };
    if (this.wantsIndices) result.indices = indices;
    return result;
  }

  private run(text: string, start: number): readonly (number | undefined)[] | null {
    const size = this.program.length;
    const buckets = new Map<number, Thread[]>();
    buckets.set(start, [{ pc: 0, captures: [start, undefined] }]);
    let matched: readonly (number | undefined)[] | null = null;
    const positions = new Set<number>([start]);
    while (positions.size > 0) {
      const position = Math.min(...positions);
      positions.delete(position);
      const incoming = buckets.get(position) ?? [];
      buckets.delete(position);
      const seen = new Uint8Array(size);
      const queue: Thread[] = [];
      const add = (thread: Thread): void => {
        const stack: Thread[] = [thread];
        const ordered: Thread[] = [];
        while (stack.length > 0) {
          const current = stack.pop()!;
          if (seen[current.pc] === 1) continue;
          seen[current.pc] = 1;
          const instruction = this.program[current.pc];
          switch (instruction.op) {
            case 'jump': stack.push({ pc: instruction.to, captures: current.captures }); break;
            case 'split':
              stack.push({ pc: instruction.second, captures: current.captures });
              stack.push({ pc: instruction.first, captures: current.captures });
              break;
            case 'save':
            case 'mark': {
              const next = [...current.captures];
              next[instruction.slot] = position;
              stack.push({ pc: current.pc + 1, captures: next });
              break;
            }
            case 'progress':
              if (current.captures[instruction.slot] !== position) stack.push({ pc: current.pc + 1, captures: current.captures });
              break;
            case 'assert': {
              instruction.matcher.lastIndex = position;
              const found = instruction.matcher.exec(text);
              if (found !== null && found.index === position) stack.push({ pc: current.pc + 1, captures: current.captures });
              break;
            }
            default: ordered.push(current);
          }
        }
        queue.push(...ordered);
      };
      for (const thread of incoming) add(thread);
      for (const thread of queue) {
        const instruction = this.program[thread.pc];
        if (instruction.op === 'match') {
          const captures = [...thread.captures];
          captures[1] = position;
          matched = captures;
          break;
        }
        if (instruction.op !== 'char') continue;
        instruction.matcher.lastIndex = position;
        const found = instruction.matcher.exec(text);
        if (found === null || found.index !== position) continue;
        const advance = position + Math.max(found[0].length, 1);
        const waiting = buckets.get(advance) ?? [];
        waiting.push({ pc: thread.pc + 1, captures: thread.captures });
        buckets.set(advance, waiting);
        positions.add(advance);
      }
    }
    return matched;
  }
}
