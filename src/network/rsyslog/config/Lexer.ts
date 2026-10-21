export type ObjectType =
  | 'global' | 'timezone' | 'main_queue' | 'module' | 'input' | 'lookup_table' | 'dyn_stats' | 'percentile_stats'
  | 'parser' | 'ratelimit' | 'template' | 'ruleset' | 'property' | 'constant' | 'action';

export type TokenType =
  | 'NAME' | 'FUNC' | 'BEGINOBJ' | 'ENDOBJ' | 'BEGIN_INCLUDE' | 'BEGIN_ACTION' | 'BEGIN_PROPERTY' | 'BEGIN_CONSTANT'
  | 'BEGIN_TPL' | 'BEGIN_RULESET' | 'STOP' | 'SET' | 'RESET' | 'UNSET' | 'CONTINUE' | 'EXISTS' | 'CALL' | 'CALL_INDIRECT'
  | 'LEGACY_ACTION' | 'LEGACY_RULESET' | 'PRIFILT' | 'PROPFILT' | 'BSD_TAG_SELECTOR' | 'BSD_HOST_SELECTOR'
  | 'RELOAD_LOOKUP_TABLE' | 'IF' | 'THEN' | 'ELSE' | 'ELSEIF' | 'FOREACH' | 'ITERATOR_ASSIGNMENT' | 'DO' | 'OR' | 'AND'
  | 'NOT' | 'VAR' | 'STRING' | 'NUMBER' | 'CMP_EQ' | 'CMP_NE' | 'CMP_LE' | 'CMP_GE' | 'CMP_LT' | 'CMP_GT' | 'CMP_CONTAINS'
  | 'CMP_CONTAINSI' | 'CMP_STARTSWITH' | 'CMP_STARTSWITHI' | 'CMP_ENDSWITH' | 'CFSYSLINE' | 'INCLUDECONFIG' | 'CHAR' | 'EOF';

export interface Token {
  readonly type: TokenType;
  readonly text: string;
  readonly line: number;
  readonly file: string;
  readonly objectType?: ObjectType;
  readonly value?: string | number;
}

export interface Diagnostic {
  readonly severity: 'error' | 'warning';
  readonly file: string;
  readonly line: number;
  readonly message: string;
}

type State = 'INITIAL' | 'EXPR' | 'INOBJ' | 'COMMENT' | 'INCALL' | 'IN_PROCEDURE_CALL' | 'ELSE_IF' | 'LINENO' | 'INCL';

interface Rule {
  readonly re: RegExp;
  readonly bol?: boolean;
  readonly run: (match: RegExpExecArray, scanner: ConfigScanner) => Token | null | 'continue';
}

interface Buffer {
  text: string;
  position: number;
  line: number;
  file: string;
  state: State;
}

const HEX = '[0-9a-fA-F]';

function sticky(source: string): RegExp {
  return new RegExp(source, 'iy');
}

export function unescapeConfigText(text: string): string {
  let output = '';
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if (character !== '\\') {
      output += character;
      index++;
      continue;
    }
    index++;
    if (index === text.length) {
      output += '\\';
      break;
    }
    const escaped = text[index];
    switch (escaped) {
      case 'a': output += '\x07'; break;
      case 'b': output += '\b'; break;
      case 'f': output += '\f'; break;
      case 'n': output += '\n'; break;
      case 'r': output += '\r'; break;
      case 't': output += '\t'; break;
      case "'": output += "'"; break;
      case '"': output += '"'; break;
      case '?': output += '?'; break;
      case '$': output += '$'; break;
      case '\\': output += '\\'; break;
      case 'x':
        if (index + 2 < text.length + 0 && new RegExp(`^${HEX}{2}$`).test(text.slice(index + 1, index + 3))) {
          output += String.fromCharCode(Number.parseInt(text.slice(index + 1, index + 3), 16));
          index += 2;
        } else {
          output += String.fromCharCode(
            ((hexValue(text[index + 1]) << 4) + hexValue(text[index + 2])) & 0xff,
          );
          index += 2;
        }
        break;
      case '0': case '1': case '2': case '3': case '4': case '5': case '6': case '7':
        if (/^[0-7]{2}$/.test(text.slice(index + 1, index + 3)) && index + 2 < text.length) {
          output += String.fromCharCode(Number.parseInt(text.slice(index, index + 3), 8) & 0xff);
          index += 2;
        } else {
          output += String.fromCharCode(
            (((escaped.charCodeAt(0) - 48) << 6) + (octalValue(text[index + 1]) << 3) + octalValue(text[index + 2])) & 0xff,
          );
          index += 2;
        }
        break;
      default: output += '?';
    }
    index++;
  }
  return output;
}

function hexValue(character: string | undefined): number {
  if (character === undefined) return 0;
  const code = character.charCodeAt(0);
  if (code < 65) return code - 48;
  if (code < 97) return code - 55;
  return code - 87;
}

function octalValue(character: string | undefined): number {
  return character === undefined ? 0 : character.charCodeAt(0) - 48;
}

export function expandBackticks(parameter: string, environment: (name: string) => string | undefined, readFile: (path: string) => string | null, report: (message: string) => void): string {
  if (parameter.startsWith('echo ')) {
    const rest = parameter.slice(5);
    let output = '';
    let index = 0;
    while (index < rest.length) {
      if (rest[index] === '$') {
        if (rest[index + 1] === '{') {
          const close = rest.indexOf('}', index + 2);
          const end = close < 0 ? rest.length : close;
          output += environment(rest.slice(index + 2, end)) ?? '';
          index = close < 0 ? rest.length : close + 1;
        } else {
          let end = index + 1;
          while (end < rest.length && /[A-Za-z0-9_]/.test(rest[end])) end++;
          output += environment(rest.slice(index + 1, end)) ?? '';
          index = end;
        }
      } else {
        output += rest[index++];
      }
    }
    return output;
  }
  if (parameter.startsWith('cat ')) {
    const content = readFile(parameter.slice(4));
    if (content === null) {
      report(`file could not be accessed for \`${parameter}\``);
      return '/* file could not be accessed - see error messages */';
    }
    return content;
  }
  report(`invalid backtick parameter \`${parameter}\` - replaced by empty string ("")`);
  return '';
}

const OBJECT_KEYWORDS: ReadonlyArray<readonly [string, TokenType, ObjectType]> = [
  ['main_queue', 'BEGINOBJ', 'main_queue'], ['timezone', 'BEGINOBJ', 'timezone'], ['parser', 'BEGINOBJ', 'parser'],
  ['global', 'BEGINOBJ', 'global'], ['template', 'BEGIN_TPL', 'template'], ['ruleset', 'BEGIN_RULESET', 'ruleset'],
  ['property', 'BEGIN_PROPERTY', 'property'], ['constant', 'BEGIN_CONSTANT', 'constant'], ['input', 'BEGINOBJ', 'input'],
  ['module', 'BEGINOBJ', 'module'], ['lookup_table', 'BEGINOBJ', 'lookup_table'], ['dyn_stats', 'BEGINOBJ', 'dyn_stats'],
  ['percentile_stats', 'BEGINOBJ', 'percentile_stats'], ['ratelimit', 'BEGINOBJ', 'ratelimit'],
];

export interface ScannerEnvironment {
  environment(name: string): string | undefined;
  readFile(path: string): string | null;
  report(diagnostic: Diagnostic): void;
}

export class ConfigScanner {
  private readonly stack: Buffer[] = [];
  private readonly pending: Token[] = [];
  private commentReturn: State = 'INITIAL';
  private readonly rules: Record<State, Rule[]>;
  private current: Buffer | null = null;

  constructor(private readonly host: ScannerEnvironment) {
    this.rules = this.buildRules();
  }

  get fileName(): string {
    return this.current?.file ?? '';
  }

  get lineNumber(): number {
    return this.current?.line ?? 0;
  }

  isOpen(file: string): boolean {
    return this.stack.some((buffer) => buffer.file === file) || this.current?.file === file;
  }

  pushText(text: string, file: string): void {
    if (this.current !== null) this.stack.push(this.current);
    this.current = { text: preprocess(text), position: 0, line: 1, file, state: 'INITIAL' };
  }

  error(message: string): void {
    this.host.report({ severity: 'error', file: this.fileName, line: this.lineNumber, message });
  }

  warning(message: string): void {
    this.host.report({ severity: 'warning', file: this.fileName, line: this.lineNumber, message });
  }

  private pop(): boolean {
    const previous = this.stack.pop();
    if (previous === undefined) return false;
    this.current = previous;
    return true;
  }

  next(): Token {
    const queued = this.pending.shift();
    if (queued !== undefined) return queued;
    for (;;) {
      const buffer = this.current;
      if (buffer === null) return { type: 'EOF', text: '', line: 0, file: '' };
      if (buffer.position >= buffer.text.length) {
        if (!this.pop()) {
          const last = { type: 'EOF' as const, text: '', line: buffer.line, file: buffer.file };
          this.current = null;
          return last;
        }
        continue;
      }
      const result = this.scanOne(buffer);
      if (result === 'continue' || result === null) continue;
      return result;
    }
  }

  private scanOne(buffer: Buffer): Token | null | 'continue' {
    const atLineStart = buffer.position === 0 || buffer.text[buffer.position - 1] === '\n';
    let best: { rule: Rule; match: RegExpExecArray } | null = null;
    for (const rule of this.rules[buffer.state]) {
      if (rule.bol === true && !atLineStart) continue;
      rule.re.lastIndex = buffer.position;
      const match = rule.re.exec(buffer.text);
      if (match === null || match.index !== buffer.position) continue;
      if (match[0].length === 0) continue;
      if (best === null || match[0].length > best.match[0].length) best = { rule, match };
    }
    if (best === null) {
      const character = buffer.text[buffer.position];
      this.reportInvalidCharacter(buffer, character);
      this.advance(buffer, character);
      return 'continue';
    }
    this.advance(buffer, best.match[0]);
    return best.rule.run(best.match, this);
  }

  private reportInvalidCharacter(buffer: Buffer, character: string): void {
    switch (buffer.state) {
      case 'INOBJ':
        this.error(`invalid character '${character}' in object definition - is there an invalid escape sequence somewhere?`);
        break;
      case 'INCALL':
        this.error(`invalid character '${character}' in 'call' statement- is there an invalid escape sequence somewhere?`);
        break;
      case 'INITIAL':
        this.error(`invalid character '${character}' - is there an invalid escape sequence somewhere?`);
        break;
      default:
        this.error(`invalid character '${character}' in expression - is there an invalid escape sequence somewhere?`);
    }
  }

  private advance(buffer: Buffer, consumed: string): void {
    buffer.position += consumed.length;
    for (const character of consumed) if (character === '\n') buffer.line++;
  }

  private setState(state: State): void {
    if (this.current !== null) this.current.state = state;
  }

  private token(type: TokenType, text: string, extra: Partial<Token> = {}): Token {
    return { type, text, line: this.current?.line ?? 0, file: this.current?.file ?? '', ...extra };
  }

  private buildRules(): Record<State, Rule[]> {
    const word = (value: string, state: State | null, type: TokenType): Rule => ({
      re: sticky(value),
      run: (match, scanner) => {
        if (state !== null) scanner.setState(state);
        return scanner.token(type, match[0]);
      },
    });
    const single = (character: string): Rule => ({
      re: sticky(character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      run: (match, scanner) => scanner.token('CHAR', match[0]),
    });
    const stringRule = (source: string, build: (inner: string, scanner: ConfigScanner) => string): Rule => ({
      re: sticky(source),
      run: (match, scanner) => {
        const inner = match[0].slice(1, -1);
        return scanner.token('STRING', match[0], { value: build(inner, scanner) });
      },
    });
    const skip: Rule = { re: sticky('[ \\t\\n]'), run: () => 'continue' };

    const initial: Rule[] = [
      word('if', 'EXPR', 'IF'),
      word('foreach', 'EXPR', 'FOREACH'),
      { re: sticky('reload_lookup_table'), run: (_m, s) => { s.setState('IN_PROCEDURE_CALL'); return s.token('RELOAD_LOOKUP_TABLE', 'reload_lookup_table'); } },
      single('&'), single('{'), single('}'),
      word('stop', null, 'STOP'),
      { re: sticky('else'), run: (_m, s) => { s.setState('ELSE_IF'); return 'continue'; } },
      { re: sticky('call'), run: (_m, s) => { s.setState('INCALL'); return s.token('CALL', 'call'); } },
      word('call_indirect', 'EXPR', 'CALL_INDIRECT'),
      word('set', 'EXPR', 'SET'), word('reset', 'EXPR', 'RESET'), word('unset', 'EXPR', 'UNSET'),
      word('continue', null, 'CONTINUE'),
      {
        re: sticky('preprocfilelinenumber\\('),
        run: (_m, s) => { s.setState('LINENO'); return 'continue'; },
      },
    ];
    for (const [keyword, type, objectType] of OBJECT_KEYWORDS) {
      initial.push({
        re: sticky(`${keyword}[ \\n\\t]*\\(`),
        run: (match, s) => { s.setState('INOBJ'); return s.token(type, match[0], { objectType }); },
      });
    }
    initial.push(
      { re: sticky('include[ \\n\\t]*\\('), run: (m, s) => { s.setState('INOBJ'); return s.token('BEGIN_INCLUDE', m[0]); } },
      { re: sticky('action[ \\n\\t]*\\('), run: (m, s) => { s.setState('INOBJ'); return s.token('BEGIN_ACTION', m[0]); } },
      {
        re: sticky('[ \\t]*:\\$?[a-z\\-]+[ ]*,[ ]*!?[a-z]+[ ]*,[ ]*"(?:\\\\"|[^"])*"'),
        bol: true,
        run: (m, s) => s.token('PROPFILT', m[0].replace(/^[ \t]+/, '')),
      },
      {
        re: sticky('[ \\t]*[*a-z][*a-z]*[0-7]*[.,][,!=;.*a-z0-7]+'),
        bol: true,
        run: (m, s) => s.token('PRIFILT', m[0].replace(/^[ \t]+/, '')),
      },
    );
    const legacyActionPatterns = [
      '~', '\\*', '-\\/[^*\\n][^\\n]*', '\\/[^*\\n][^\\n]*', ':[a-z0-9]+:[^\\n]*', '[|.\\-@^?~>][^\\n]+', '[a-z0-9_][a-z0-9_\\-+,;]*',
    ];
    for (const pattern of legacyActionPatterns) {
      initial.push({ re: sticky(pattern), run: (m, s) => s.token('LEGACY_ACTION', m[0]) });
    }
    initial.push(
      {
        re: sticky('\\$[a-z]+[^\\n]*'),
        run: (m, s) => {
          const text = m[0];
          if (/^\$includeconfig /i.test(text)) {
            s.pushBack(text.length - 14);
            s.setState('INCL');
            return 'continue';
          }
          if (/^\$ruleset /i.test(text)) return s.token('LEGACY_RULESET', text);
          return s.token('CFSYSLINE', text);
        },
      },
      { re: sticky('![^ \\t\\n]+[ \\t]*(?=\\n|$)'), run: (m, s) => s.token('BSD_TAG_SELECTOR', m[0]) },
      { re: sticky('[+-]\\*[ \\t\\n]*#[^\\n]*'), run: (m, s) => s.token('BSD_HOST_SELECTOR', m[0]) },
      { re: sticky('[+-]\\*[ \\t\\n]*(?=\\n|$)'), run: (m, s) => s.token('BSD_HOST_SELECTOR', m[0]) },
      { re: sticky('[ \\t]*[+-][a-z0-9.:-]+[ \\t]*(?=\\n|$)'), bol: true, run: (m, s) => s.token('BSD_HOST_SELECTOR', m[0]) },
      { re: sticky('#[^\\n]*\\n'), run: () => 'continue' },
      { re: sticky('/\\*'), run: (_m, s) => { s.commentReturn = 'INITIAL'; s.setState('COMMENT'); return 'continue'; } },
      skip,
    );

    const environment = this.host;
    const backtick = (inner: string, scanner: ConfigScanner): string =>
      expandBackticks(unescapeConfigText(inner), (n) => environment.environment(n), (p) => environment.readFile(p), (m) => scanner.error(m));

    const expr: Rule[] = [
      { re: sticky('\\('), run: (m, s) => s.token('CHAR', m[0]) },
      { re: sticky('then'), run: (m, s) => { s.setState('INITIAL'); return s.token('THEN', m[0]); } },
      { re: sticky('do'), run: (m, s) => { s.setState('INITIAL'); return s.token('DO', m[0]); } },
      { re: sticky(';'), run: (m, s) => { s.setState('INITIAL'); return s.token('CHAR', m[0]); } },
      word('or', null, 'OR'), word('and', null, 'AND'), word('not', null, 'NOT'),
      single('='), single(','), single('*'), single('/'), single('%'), single('+'), single('&'), single('-'), single('['), single(']'), single(')'),
      word('==', null, 'CMP_EQ'), word('<=', null, 'CMP_LE'), word('>=', null, 'CMP_GE'),
      word('!=', null, 'CMP_NE'), word('<>', null, 'CMP_NE'), word('<', null, 'CMP_LT'), word('>', null, 'CMP_GT'),
      word('contains', null, 'CMP_CONTAINS'), word('in', null, 'ITERATOR_ASSIGNMENT'), word('contains_i', null, 'CMP_CONTAINSI'),
      word('startswith', null, 'CMP_STARTSWITH'), word('startswith_i', null, 'CMP_STARTSWITHI'), word('endswith', null, 'CMP_ENDSWITH'),
      { re: sticky('0[0-7]+'), run: (m, s) => s.token('NUMBER', m[0], { value: Number.parseInt(m[0], 8) }) },
      { re: sticky('0x[0-9a-f]+'), run: (m, s) => s.token('NUMBER', m[0], { value: Number.parseInt(m[0], 16) }) },
      { re: sticky('(?:[1-9][0-9]*|0)'), run: (m, s) => s.token('NUMBER', m[0], { value: Number.parseInt(m[0], 10) }) },
      { re: sticky('\\$[$!./]?[@a-z_]*[!@a-z0-9\\-_.\\[\\]]*'), run: (m, s) => s.token('VAR', m[0], { value: m[0].slice(1) }) },
      stringRule(`'(?:[^'\\\\]|\\\\['"\\\\$bntr]|\\\\x${HEX}${HEX}|\\\\[0-7][0-7][0-7])*'`, (inner) => unescapeConfigText(inner)),
      stringRule(`\`(?:[^\`\\\\]|\\\\['\`"\\\\bntr]|\\\\x${HEX}${HEX}|\\\\[0-7][0-7][0-7])*\``, backtick),
      stringRule(`"(?:[^"\\\\$]|\\\\["'\\\\$bntr]|\\\\x${HEX}${HEX}|\\\\[0-7][0-7][0-7])*"`, (inner) => unescapeConfigText(inner)),
      {
        re: sticky(`"(?:[^"\\\\]|\\\\["'\\\\$bntr]|\\\\x${HEX}${HEX}|\\\\[0-7][0-7][0-7])*"`),
        run: (m, s) => { s.error(`$-sign in double quotes must be escaped, problem string is: ${m[0]}`); return 'continue'; },
      },
      { re: sticky('/\\*'), run: (_m, s) => { s.commentReturn = 'EXPR'; s.setState('COMMENT'); return 'continue'; } },
      skip,
      { re: sticky('exists'), run: (m, s) => s.token('EXISTS', m[0]) },
      { re: sticky('[a-z][a-z0-9_]*'), run: (m, s) => s.token('FUNC', m[0], { value: m[0] }) },
    ];

    const inobj: Rule[] = [
      { re: sticky('\\)'), run: (m, s) => { s.setState('INITIAL'); return s.token('ENDOBJ', m[0]); } },
      { re: sticky('[a-z][a-z0-9_.]*'), run: (m, s) => s.token('NAME', m[0], { value: m[0] }) },
      single(','), single('['), single(']'), single('='),
      stringRule(`"(?:[^"\\\\]|\\\\['"?\\\\abfnrtv]|\\\\x${HEX}${HEX}|\\\\[0-7]{1,3})*"`, (inner) => unescapeConfigText(inner)),
      stringRule(`\`(?:[^\`\\\\]|\\\\['\`?\\\\abfnrtv]|\\\\x${HEX}${HEX}|\\\\[0-7]{1,3})*\``, backtick),
      { re: sticky('/\\*'), run: (_m, s) => { s.commentReturn = 'INOBJ'; s.setState('COMMENT'); return 'continue'; } },
      { re: sticky('#[^\\n]*'), run: () => 'continue' },
      { re: sticky('[ \\n\\t]'), run: () => 'continue' },
    ];

    const comment: Rule[] = [
      { re: sticky('\\*/'), run: (_m, s) => { s.setState(s.commentReturn); return 'continue'; } },
      { re: sticky('(?:[^*]|\\n)+|.'), run: () => 'continue' },
    ];

    const incall: Rule[] = [
      { re: sticky('[ \\t\\n]'), run: () => 'continue' },
      { re: sticky('[a-z][a-z0-9\\-_.]*'), run: (m, s) => { s.setState('INITIAL'); return s.token('NAME', m[0], { value: m[0] }); } },
    ];

    const procedureCall: Rule[] = [
      { re: sticky('\\('), run: (m, s) => s.token('CHAR', m[0]) },
      stringRule(`'(?:[^'\\\\]|\\\\['"\\\\$bntr]|\\\\x${HEX}${HEX}|\\\\[0-7][0-7][0-7])*'`, (inner) => unescapeConfigText(inner)),
      stringRule(`"(?:[^"\\\\$]|\\\\["'\\\\$bntr]|\\\\x${HEX}${HEX}|\\\\[0-7][0-7][0-7])*"`, (inner) => unescapeConfigText(inner)),
      { re: sticky(','), run: (m, s) => s.token('CHAR', m[0]) },
      { re: sticky('\\)'), run: (m, s) => { s.setState('INITIAL'); return s.token('CHAR', m[0]); } },
      { re: sticky('[ \\t\\n]*'), run: () => 'continue' },
    ];

    const elseIf: Rule[] = [
      { re: sticky('[ \\t\\r\\n]+'), run: () => 'continue' },
      { re: sticky('/\\*'), run: (_m, s) => { s.commentReturn = 'ELSE_IF'; s.setState('COMMENT'); return 'continue'; } },
      { re: sticky('#[^\\n]*\\n'), run: () => 'continue' },
      { re: sticky('if'), run: (m, s) => { s.setState('EXPR'); return s.token('ELSEIF', m[0]); } },
      { re: sticky('.'), run: (_m, s) => { s.pushBack(1); s.setState('INITIAL'); return s.token('ELSE', 'else'); } },
    ];

    const lineno: Rule[] = [
      { re: sticky('[0-9]+'), run: (m, s) => { s.setLine(Number.parseInt(m[0], 10) - 1); return 'continue'; } },
      { re: sticky('\\)'), run: (_m, s) => { s.setState('INITIAL'); return 'continue'; } },
      { re: sticky('.|\\n'), run: () => 'continue' },
    ];

    const incl: Rule[] = [
      { re: sticky('[^ \\t\\n]+'), run: (m, s) => { s.setState('INITIAL'); return s.token('INCLUDECONFIG', m[0], { value: m[0] }); } },
      { re: sticky('.|\\n'), run: () => 'continue' },
    ];

    return {
      INITIAL: initial, EXPR: expr, INOBJ: inobj, COMMENT: comment, INCALL: incall, IN_PROCEDURE_CALL: procedureCall,
      ELSE_IF: elseIf, LINENO: lineno, INCL: incl,
    };
  }

  private setLine(line: number): void {
    if (this.current !== null) this.current.line = line;
  }

  private pushBack(count: number): void {
    if (this.current !== null) this.current.position -= count;
  }
}

export function preprocess(source: string): string {
  const lines = source.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  let output = '';
  let continuation = false;
  let emitLineNumber = false;
  let lineNumber = 0;
  for (const raw of lines) {
    lineNumber++;
    if (emitLineNumber) {
      emitLineNumber = false;
      output += `PreprocFileLineNumber(${lineNumber})\n`;
    }
    let start = 0;
    if (continuation) while (start < raw.length && /\s/.test(raw[start])) start++;
    let end = raw.length - 1;
    while (end >= start && /\s/.test(raw[end])) end--;
    if (end >= 0) {
      if (raw[end] === '\\') {
        end--;
        continuation = true;
      } else {
        if (continuation) emitLineNumber = true;
        continuation = false;
      }
      output += raw.slice(start, end + 1);
    }
    if (!continuation) output += '\n';
  }
  return output;
}
