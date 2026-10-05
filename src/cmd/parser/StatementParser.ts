import {
  findMatchingParenthesis, isCaretEscaped, readToken, readWord, skipSpaces,
} from './Scanner';

export type ChainOperator = '' | '&' | '&&' | '||';

export type IfCondition =
  | { readonly kind: 'exist'; readonly operand: string }
  | { readonly kind: 'defined'; readonly operand: string }
  | { readonly kind: 'errorlevel'; readonly operand: string }
  | { readonly kind: 'cmdextversion'; readonly operand: string }
  | { readonly kind: 'equals'; readonly left: string; readonly right: string }
  | { readonly kind: 'compare'; readonly left: string; readonly operator: string; readonly right: string };

export type ForMode = 'plain' | 'l' | 'd' | 'r' | 'f';

export type Statement =
  | { readonly kind: 'simple'; readonly text: string }
  | { readonly kind: 'group'; readonly body: string; readonly suffix: string }
  | {
    readonly kind: 'if';
    readonly negate: boolean;
    readonly ignoreCase: boolean;
    readonly condition: IfCondition;
    readonly thenBody: string;
    readonly elseBody: string | null;
  }
  | {
    readonly kind: 'for';
    readonly mode: ForMode;
    readonly root: string | null;
    readonly options: string | null;
    readonly variable: string;
    readonly set: string;
    readonly body: string;
  };

export interface Link {
  readonly operator: ChainOperator;
  readonly statement: Statement;
  readonly echoed: string;
}

const COMPARISON_OPERATORS = ['EQU', 'NEQ', 'LSS', 'LEQ', 'GTR', 'GEQ'];

function findEquals(token: string): number {
  let inQuote = false;
  for (let index = 0; index < token.length - 1; index++) {
    if (token[index] === '"') inQuote = !inQuote;
    else if (!inQuote && token[index] === '=' && token[index + 1] === '=') return index;
  }
  return -1;
}

function parseCondition(text: string, start: number): { condition: IfCondition; end: number } | null {
  let cursor = skipSpaces(text, start);
  const first = readToken(text, cursor);
  const keyword = first.token.toLowerCase();
  if (keyword === 'exist' || keyword === 'defined' || keyword === 'errorlevel' || keyword === 'cmdextversion') {
    cursor = skipSpaces(text, first.end);
    const operand = readToken(text, cursor);
    return { condition: { kind: keyword, operand: operand.token }, end: operand.end };
  }
  const equalsAt = findEquals(first.token);
  if (equalsAt >= 0) {
    const left = first.token.slice(0, equalsAt);
    const inline = first.token.slice(equalsAt + 2);
    if (inline !== '') return { condition: { kind: 'equals', left, right: inline }, end: first.end };
    const right = readToken(text, skipSpaces(text, first.end));
    return { condition: { kind: 'equals', left, right: right.token }, end: right.end };
  }
  const second = readToken(text, skipSpaces(text, first.end));
  if (second.token === '==') {
    const right = readToken(text, skipSpaces(text, second.end));
    return { condition: { kind: 'equals', left: first.token, right: right.token }, end: right.end };
  }
  if (second.token.startsWith('==')) {
    return { condition: { kind: 'equals', left: first.token, right: second.token.slice(2) }, end: second.end };
  }
  if (COMPARISON_OPERATORS.includes(second.token.toUpperCase())) {
    const right = readToken(text, skipSpaces(text, second.end));
    return {
      condition: { kind: 'compare', left: first.token, operator: second.token.toUpperCase(), right: right.token },
      end: right.end,
    };
  }
  return null;
}

function readBody(text: string, start: number): { body: string; end: number; grouped: boolean } {
  const cursor = skipSpaces(text, start);
  if (text[cursor] === '(') {
    const close = findMatchingParenthesis(text, cursor);
    if (close < 0) return { body: text.slice(cursor + 1), end: text.length, grouped: true };
    return { body: text.slice(cursor + 1, close), end: close + 1, grouped: true };
  }
  return { body: text.slice(cursor), end: text.length, grouped: false };
}

function parseIf(text: string, start: number): { statement: Statement; end: number } | null {
  let cursor = skipSpaces(text, start);
  let ignoreCase = false;
  let negate = false;
  for (;;) {
    const token = readToken(text, cursor);
    const lowered = token.token.toLowerCase();
    if (lowered === '/i') { ignoreCase = true; cursor = skipSpaces(text, token.end); continue; }
    if (lowered === 'not') { negate = !negate; cursor = skipSpaces(text, token.end); continue; }
    break;
  }
  const parsed = parseCondition(text, cursor);
  if (parsed === null) return null;
  const thenPart = readBody(text, parsed.end);
  let end = thenPart.end;
  let elseBody: string | null = null;
  if (thenPart.grouped) {
    const afterThen = skipSpaces(text, thenPart.end);
    const word = readWord(text, afterThen);
    if (word.word.toLowerCase() === 'else') {
      const elsePart = readBody(text, word.end);
      elseBody = elsePart.body;
      end = elsePart.end;
    }
  }
  return {
    statement: {
      kind: 'if', negate, ignoreCase, condition: parsed.condition, thenBody: thenPart.body, elseBody,
    },
    end,
  };
}

function parseFor(text: string, start: number): { statement: Statement; end: number } | null {
  let cursor = skipSpaces(text, start);
  let mode: ForMode = 'plain';
  let root: string | null = null;
  let options: string | null = null;
  while (text[cursor] === '/') {
    const flag = readToken(text, cursor);
    const letter = flag.token.slice(1).toLowerCase();
    cursor = skipSpaces(text, flag.end);
    if (letter === 'l' || letter === 'd') mode = letter;
    else if (letter === 'r') {
      mode = 'r';
      if (text[cursor] !== '%') {
        const rootToken = readToken(text, cursor);
        root = rootToken.token.replace(/^"(.*)"$/, '$1');
        cursor = skipSpaces(text, rootToken.end);
      }
    } else if (letter === 'f') {
      mode = 'f';
      if (text[cursor] === '"') {
        const close = text.indexOf('"', cursor + 1);
        if (close < 0) return null;
        options = text.slice(cursor + 1, close);
        cursor = skipSpaces(text, close + 1);
      }
    } else return null;
  }
  if (text[cursor] !== '%') return null;
  const variableMatch = /^%%?(.)/.exec(text.slice(cursor));
  if (!variableMatch) return null;
  const variable = variableMatch[1];
  cursor = skipSpaces(text, cursor + variableMatch[0].length);
  const inWord = readWord(text, cursor);
  if (inWord.word.toLowerCase() !== 'in') return null;
  cursor = skipSpaces(text, inWord.end);
  if (text[cursor] !== '(') return null;
  const close = findMatchingParenthesis(text, cursor);
  if (close < 0) return null;
  const set = text.slice(cursor + 1, close);
  cursor = skipSpaces(text, close + 1);
  const doWord = readWord(text, cursor);
  if (doWord.word.toLowerCase() !== 'do') return null;
  const body = readBody(text, doWord.end);
  return { statement: { kind: 'for', mode, root, options, variable, set, body: body.body }, end: body.end };
}

function readSimpleSegment(text: string, start: number): number {
  let inQuote = false;
  for (let index = start; index < text.length; index++) {
    const character = text[index];
    if (character === '"') { inQuote = !inQuote; continue; }
    if (inQuote || isCaretEscaped(text, index)) continue;
    if (character === '&' && text[index - 1] !== '>' && text[index - 1] !== '<') return index;
    if (character === '|' && text[index + 1] === '|') return index;
  }
  return text.length;
}

function readOperator(text: string, start: number): { operator: ChainOperator; end: number } {
  const cursor = skipSpaces(text, start);
  if (text.startsWith('&&', cursor)) return { operator: '&&', end: cursor + 2 };
  if (text.startsWith('||', cursor)) return { operator: '||', end: cursor + 2 };
  if (text[cursor] === '&') return { operator: '&', end: cursor + 1 };
  return { operator: '', end: cursor };
}

export function parseLine(text: string): Link[] {
  const links: Link[] = [];
  let cursor = 0;
  let operator: ChainOperator = '';
  while (cursor < text.length) {
    cursor = skipSpaces(text, cursor);
    let silent = false;
    while (text[cursor] === '@') { silent = true; cursor = skipSpaces(text, cursor + 1); }
    if (cursor >= text.length) break;
    const origin = cursor;
    let statement: Statement | null = null;
    let end = cursor;

    if (text[cursor] === '(') {
      const close = findMatchingParenthesis(text, cursor);
      const stop = close < 0 ? text.length : close + 1;
      const tail = readSimpleSegment(text, stop);
      statement = { kind: 'group', body: text.slice(cursor + 1, close < 0 ? text.length : close), suffix: text.slice(stop, tail).trim() };
      end = tail;
    } else {
      const word = readWord(text, cursor);
      const keyword = word.word.toLowerCase();
      if (keyword === 'if' && /^\s/.test(text.slice(word.end, word.end + 1))) {
        const parsed = parseIf(text, word.end);
        if (parsed) { statement = parsed.statement; end = parsed.end; }
      } else if (keyword === 'for' && /^\s/.test(text.slice(word.end, word.end + 1))) {
        const parsed = parseFor(text, word.end);
        if (parsed) { statement = parsed.statement; end = parsed.end; }
      }
      if (statement === null) {
        end = readSimpleSegment(text, cursor);
        statement = { kind: 'simple', text: text.slice(cursor, end).trim() };
      }
    }
    links.push({ operator, statement, echoed: silent ? '' : text.slice(origin, end).trim() });
    const next = readOperator(text, end);
    operator = next.operator;
    cursor = next.end;
    if (operator === '') break;
  }
  return links;
}
