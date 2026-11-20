import { RADIUS_ATTR, type RadiusAttribute } from '@/network/radius/types';
import { isKnownGoodName, type KnownGoodItem } from '@/network/radius/KnownGoodPassword';
import type { ConfPair, ConfSection } from './FreeradiusConf';
import { usersPairToAttribute, requestViewOf, type PacketFacts, type ViewContext } from './UsersFileParser';
import { formatRadiusAttribute } from '@/network/radius/attributeText';
import { expandTemplate } from './Xlat';

export type ModuleResult = 'reject' | 'fail' | 'ok' | 'handled' | 'invalid' | 'userlock' | 'notfound' | 'noop' | 'updated';
export type AttributeList = 'request' | 'control' | 'reply';

export interface UnlangContext extends ViewContext {
  nowMs: number;
  request: RadiusAttribute[];
  control: Map<string, string>;
  knownGood: KnownGoodItem[];
  reply: RadiusAttribute[];
}

export function newContext(username: string, request: readonly RadiusAttribute[], packet: PacketFacts | null = null, nowMs = 0): UnlangContext {
  return { username, strippedName: null, packet, nowMs, request: [...request], overlay: new Map(), control: new Map(), knownGood: [], reply: [] };
}

export function lookup(context: UnlangContext, list: AttributeList, name: string): string | number | undefined {
  const key = name.toLowerCase();
  if (list === 'request') return requestViewOf(context, () => [])(key);
  if (list === 'control') return context.control.get(key);
  return context.reply.find((attribute) => attribute.type === key)?.value;
}

interface Operand { kind: 'attribute'; list: AttributeList; name: string }
interface Literal { kind: 'literal'; value: string; regex?: RegExp; template?: boolean }
type Term = Operand | Literal;

export type Condition =
  | { kind: 'or' | 'and'; left: Condition; right: Condition }
  | { kind: 'not'; inner: Condition }
  | { kind: 'compare'; left: Term; op: string; right: Term }
  | { kind: 'exists'; term: Term };

export interface Assignment { list: AttributeList; name: string; op: string; value: Term; file: string; line: number }

export type Statement =
  | { kind: 'module'; name: string; file: string; line: number }
  | { kind: 'return'; result: ModuleResult }
  | { kind: 'update'; list: AttributeList; assignments: Assignment[] }
  | { kind: 'if'; branches: Array<{ keyword: 'if' | 'elsif' | 'else'; text: string; condition: Condition | null; body: Statement[] }> }
  | { kind: 'typed'; name: string; body: Statement[]; file: string; line: number };

export class UnlangError extends Error {}

const RESULT_KEYWORDS = new Set<string>(['ok', 'reject', 'noop', 'fail', 'handled', 'invalid', 'userlock', 'notfound', 'updated']);
const STOPPING = new Set<ModuleResult>(['reject', 'fail', 'userlock', 'invalid', 'handled']);
const UNSUPPORTED = new Set(['switch', 'case', 'foreach', 'redundant', 'load-balance', 'redundant-load-balance', 'group', 'return', 'break', 'map']);
const LIST_ALIASES: Record<string, AttributeList> = { request: 'request', control: 'control', config: 'control', reply: 'reply' };

function fail(file: string, line: number, message: string): never {
  throw new UnlangError(`${file}[${line}]: ${message}`);
}

function parseReference(text: string, defaultList: AttributeList, file: string, line: number): Operand {
  const body = text.replace(/^&/, '');
  const colon = body.indexOf(':');
  if (colon > 0) {
    const list = LIST_ALIASES[body.slice(0, colon)];
    if (list === undefined) fail(file, line, `The attribute list "${body.slice(0, colon)}" is not implemented in this simulator`);
    return { kind: 'attribute', list, name: body.slice(colon + 1) };
  }
  return { kind: 'attribute', list: defaultList, name: body };
}

function tokenizeCondition(text: string, file: string, line: number): string[] {
  const tokens: string[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (/\s/.test(char)) { index++; continue; }
    if (text.startsWith('%{', index)) fail(file, line, 'An expansion outside a string is not implemented in this simulator');
    if (char === '"' || char === "'") {
      let end = index + 1;
      while (end < text.length && text[end] !== char) end += text[end] === '\\' ? 2 : 1;
      if (end >= text.length) fail(file, line, 'Unterminated string in condition');
      tokens.push(text.slice(index, end + 1));
      index = end + 1;
      continue;
    }
    if (char === '/') {
      let end = index + 1;
      while (end < text.length && text[end] !== '/') end += text[end] === '\\' ? 2 : 1;
      if (end >= text.length) fail(file, line, 'Unterminated regular expression in condition');
      let flags = end + 1;
      while (flags < text.length && /[imsx]/.test(text[flags])) flags++;
      tokens.push(text.slice(index, flags));
      index = flags;
      continue;
    }
    const operator = ['&&', '||', '==', '!=', '<=', '>=', '=~', '!~', '(', ')', '!', '<', '>'].find((candidate) => text.startsWith(candidate, index));
    if (operator !== undefined) { tokens.push(operator); index += operator.length; continue; }
    let end = char === '&' ? index + 1 : index;
    while (end < text.length && !/[\s()!<>=&|]/.test(text[end])) end++;
    if (end === index) end++;
    tokens.push(text.slice(index, end));
    index = end;
  }
  return tokens;
}

function parseCondition(text: string, file: string, line: number): Condition {
  const tokens = tokenizeCondition(text, file, line);
  let position = 0;
  const peek = (): string | undefined => tokens[position];
  const term = (): Term => {
    const token = tokens[position++];
    if (token === undefined) fail(file, line, 'Syntax error in condition: unexpected end');
    if (token.startsWith('"') || token.startsWith("'")) {
      const text = token.slice(1, -1).replace(/\\(.)/g, '$1');
      checkTemplate(text, file, line);
      return { kind: 'literal', value: text, ...(token.startsWith('"') && text.includes('%{') ? { template: true } : {}) };
    }
    if (token.startsWith('/')) {
      const close = token.lastIndexOf('/');
      return { kind: 'literal', value: token, regex: new RegExp(token.slice(1, close), token.slice(close + 1).replace(/[xs]/g, '')) };
    }
    if (token.startsWith('&')) return parseReference(token, 'request', file, line);
    if (/^-?\d+$/.test(token)) return { kind: 'literal', value: token };
    if (token in RADIUS_ATTR || /^[A-Za-z][\w-]*:[A-Za-z]/.test(token) || tokens[position] !== undefined && ['==', '!=', '<', '>', '<=', '>=', '=~', '!~'].includes(tokens[position]) && position === 1) {
      return parseReference(token, 'request', file, line);
    }
    return { kind: 'literal', value: token };
  };
  const primary = (): Condition => {
    if (peek() === '(') {
      position++;
      const inner = or();
      if (tokens[position++] !== ')') fail(file, line, 'Syntax error in condition: missing )');
      return inner;
    }
    const left = term();
    const op = peek();
    if (op !== undefined && ['==', '!=', '<', '>', '<=', '>=', '=~', '!~'].includes(op)) {
      position++;
      return { kind: 'compare', left, op, right: term() };
    }
    return { kind: 'exists', term: left };
  };
  const not = (): Condition => {
    if (peek() === '!') { position++; return { kind: 'not', inner: not() }; }
    return primary();
  };
  const and = (): Condition => {
    let left = not();
    while (peek() === '&&') { position++; left = { kind: 'and', left, right: not() }; }
    return left;
  };
  const or = (): Condition => {
    let left = and();
    while (peek() === '||') { position++; left = { kind: 'or', left, right: and() }; }
    return left;
  };
  const result = or();
  if (position < tokens.length) fail(file, line, `Syntax error in condition: unexpected "${tokens[position]}"`);
  return result;
}

function valueOf(context: UnlangContext, term: Term): string | number | undefined {
  if (term.kind !== 'literal') return lookup(context, term.list, term.name);
  if (term.template !== true) return term.value;
  return expandTemplate(term.value, (name) => {
    const colon = name.indexOf(':');
    const list = colon > 0 ? LIST_ALIASES[name.slice(0, colon)] : undefined;
    const found = list === undefined ? lookup(context, 'request', name) : lookup(context, list, name.slice(colon + 1));
    return found === undefined ? undefined : String(found);
  }, context.nowMs, (value) => value);
}

const TEMPLATE_FUNCTION = /%\{([A-Za-z0-9_-]+):(?!-)/g;

function checkTemplate(text: string, file: string, line: number): void {
  for (const match of text.matchAll(TEMPLATE_FUNCTION)) {
    if (LIST_ALIASES[match[1]] === undefined) fail(file, line, `The expansion function "%{${match[1]}:...}" is not implemented in this simulator`);
  }
}

export function evaluate(condition: Condition, context: UnlangContext): boolean {
  if (condition.kind === 'or' || condition.kind === 'and') {
    const pair = condition as Extract<Condition, { kind: 'or' | 'and' }>;
    return condition.kind === 'or' ? evaluate(pair.left, context) || evaluate(pair.right, context) : evaluate(pair.left, context) && evaluate(pair.right, context);
  }
  if (condition.kind === 'not') return !evaluate((condition as Extract<Condition, { kind: 'not' }>).inner, context);
  if (condition.kind === 'exists') {
    const term = (condition as Extract<Condition, { kind: 'exists' }>).term;
    if (term.kind === 'attribute') return valueOf(context, term) !== undefined;
    return (term as Literal).value !== '' && (term as Literal).value !== '0';
  }
  const compare = condition as Extract<Condition, { kind: 'compare' }>;
  const left = valueOf(context, compare.left);
  const right = valueOf(context, compare.right);
  if (left === undefined || right === undefined) return false;
  const a = String(left);
  const b = String(right);
  const regex = compare.right.kind === 'literal' ? (compare.right as Literal).regex : undefined;
  switch (compare.op) {
    case '==': return a === b;
    case '!=': return a !== b;
    case '<': return Number(a) < Number(b);
    case '>': return Number(a) > Number(b);
    case '<=': return Number(a) <= Number(b);
    case '>=': return Number(a) >= Number(b);
    case '=~': return regex !== undefined && regex.test(a);
    default: return regex !== undefined && !regex.test(a);
  }
}

function assignmentOf(pair: ConfPair, defaultList: AttributeList): Assignment {
  const target = parseReference(pair.name, defaultList, pair.file, pair.line);
  if (!['=', ':=', '+='].includes(pair.op)) fail(pair.file, pair.line, `The operator "${pair.op}" in update is not implemented in this simulator`);
  if (pair.value.includes('`')) fail(pair.file, pair.line, 'A backtick expansion is not implemented in this simulator');
  checkTemplate(pair.value, pair.file, pair.line);
  const key = target.name.toLowerCase();
  if (target.list !== 'control' && !(key in RADIUS_ATTR)) fail(pair.file, pair.line, `Unknown attribute "${target.name}"`);
  const value: Term = !pair.quoted && pair.value.startsWith('&') ? parseReference(pair.value, 'request', pair.file, pair.line) : { kind: 'literal', value: pair.value, ...(pair.quoted && pair.value.includes('%{') ? { template: true } : {}) };
  return { list: target.list, name: target.name, op: pair.op, value, file: pair.file, line: pair.line };
}

export function parseStatements(section: ConfSection, knownModule: (name: string, file: string, line: number) => string | null): Statement[] {
  const statements: Statement[] = [];
  let pending: Extract<Statement, { kind: 'if' }> | null = null;
  for (const item of section.items) {
    if (!('items' in item)) {
      pending = null;
      if (item.op !== '=' || item.value !== '') fail(item.file, item.line, `The unlang statement "${item.name} ${item.op} ${item.value}" is not implemented in this simulator`);
      if (RESULT_KEYWORDS.has(item.name)) { statements.push({ kind: 'return', result: item.name as ModuleResult }); continue; }
      const resolved = knownModule(item.name, item.file, item.line);
      if (resolved !== null) statements.push({ kind: 'module', name: resolved, file: item.file, line: item.line });
      continue;
    }
    if (item.name1 === 'if') {
      pending = { kind: 'if', branches: [{ keyword: 'if', text: item.name2 ?? '', condition: parseCondition(item.name2 ?? '', item.file, item.line), body: parseStatements(item, knownModule) }] };
      statements.push(pending);
    } else if (item.name1 === 'elsif' || item.name1 === 'else') {
      if (pending === null) fail(item.file, item.line, `"${item.name1}" without a preceding "if"`);
      pending.branches.push({ keyword: item.name1, text: item.name2 ?? '', condition: item.name1 === 'else' ? null : parseCondition(item.name2 ?? '', item.file, item.line), body: parseStatements(item, knownModule) });
      if (item.name1 === 'else') pending = null;
    } else if (item.name1 === 'update') {
      pending = null;
      const list = LIST_ALIASES[item.name2 ?? ''];
      if (list === undefined) fail(item.file, item.line, `The attribute list "${item.name2 ?? ''}" in update is not implemented in this simulator`);
      statements.push({ kind: 'update', list, assignments: item.pairs.map((pair) => assignmentOf(pair, list)) });
    } else if (UNSUPPORTED.has(item.name1)) {
      fail(item.file, item.line, `The unlang construct "${item.name1}" is not implemented in this simulator`);
    } else if (item.name1.endsWith('-Type')) {
      pending = null;
      statements.push({ kind: 'typed', name: `${item.name1} ${item.name2 ?? ''}`.trim(), body: parseStatements(item, knownModule), file: item.file, line: item.line });
    } else fail(item.file, item.line, `Unknown section "${item.name1}" in ${section.name1}`);
  }
  return statements;
}

export function moduleNames(statements: readonly Statement[], into: Set<string>): void {
  for (const statement of statements) {
    if (statement.kind === 'module') into.add(statement.name);
    else if (statement.kind === 'if') for (const branch of statement.branches) moduleNames(branch.body, into);
    else if (statement.kind === 'typed') moduleNames(statement.body, into);
  }
}

export interface ModuleOutcome { result: ModuleResult; messages: string[] }

export interface UnlangHost {
  runModule(name: string, context: UnlangContext): ModuleOutcome;
}

function sourceText(assignment: Assignment, context: UnlangContext): string {
  const resolved = valueOf(context, assignment.value);
  const value = assignment.value.kind === 'attribute' ? (resolved === undefined ? '' : `"${resolved}"`) : `"${resolved}"`;
  return `&${assignment.list}:${assignment.name} ${assignment.op} ${value}`;
}

function applyAssignment(context: UnlangContext, assignment: Assignment): void {
  const raw = valueOf(context, assignment.value);
  if (raw === undefined) return;
  const key = assignment.name.toLowerCase();
  const value = String(raw);
  if (assignment.list === 'control') {
    if (assignment.op === '=' && context.control.has(key)) return;
    context.control.set(key, value);
    if (isKnownGoodName(key)) {
      context.knownGood = assignment.op === '+=' ? [...context.knownGood, { name: key, value }] : [...context.knownGood.filter((item) => item.name !== key), { name: key, value }];
    }
    return;
  }
  const attribute = usersPairToAttribute({ name: assignment.name, op: ':=', value, tag: null });
  if (attribute === null) throw new UnlangError(`${assignment.file}[${assignment.line}]: Failed to parse value for "${assignment.name}"`);
  const store = assignment.list === 'reply' ? context.reply : context.request;
  const exists = store.some((known) => known.type === attribute.type);
  if (assignment.op === '=' && exists) return;
  if (assignment.op === ':=') for (let at = store.length - 1; at >= 0; at--) if (store[at].type === attribute.type) store.splice(at, 1);
  store.push(attribute);
}

export function priorityResult(results: readonly ModuleResult[]): ModuleResult {
  for (const candidate of ['reject', 'userlock', 'fail', 'invalid', 'handled', 'updated', 'ok', 'notfound', 'noop'] as ModuleResult[]) if (results.includes(candidate)) return candidate;
  return 'noop';
}

export function run(statements: readonly Statement[], context: UnlangContext, host: UnlangHost, lines: string[], depth: number): { result: ModuleResult; stopped: boolean } {
  const indent = (text: string, extra = 0): void => { lines.push(`${'  '.repeat(depth + extra)}${text}`); };
  const results: ModuleResult[] = [];
  for (const statement of statements) {
    if (statement.kind === 'return') {
      indent(`[${statement.result}] = ${statement.result}`);
      results.push(statement.result);
      if (STOPPING.has(statement.result)) return { result: priorityResult(results), stopped: true };
    } else if (statement.kind === 'module') {
      const outcome = host.runModule(statement.name, context);
      for (const message of outcome.messages) indent(message, 1);
      indent(`[${statement.name}] = ${outcome.result}`);
      results.push(outcome.result);
      if (STOPPING.has(outcome.result)) return { result: priorityResult(results), stopped: true };
    } else if (statement.kind === 'update') {
      indent(`update ${statement.list} {`);
      for (const assignment of statement.assignments) {
        applyAssignment(context, assignment);
        indent(sourceText(assignment, context), 1);
      }
      indent(`} # update ${statement.list} = noop`);
      results.push('noop');
    } else if (statement.kind === 'if') {
      let taken = false;
      for (const branch of statement.branches) {
        if (taken) break;
        if (branch.keyword === 'else') {
          indent('else {');
          const inner = run(branch.body, context, host, lines, depth + 1);
          indent(`} # else = ${inner.result}`);
          results.push(inner.result);
          taken = true;
          if (inner.stopped) return { result: priorityResult(results), stopped: true };
          continue;
        }
        indent(`${branch.keyword} (${branch.text}) {`);
        const truth = evaluate(branch.condition!, context);
        indent(`${branch.keyword} (${branch.text})  -> ${truth ? 'TRUE' : 'FALSE'}`);
        if (!truth) continue;
        taken = true;
        const inner = run(branch.body, context, host, lines, depth + 1);
        indent(`} # ${branch.keyword} (${branch.text}) = ${inner.result}`);
        results.push(inner.result);
        if (inner.stopped) return { result: priorityResult(results), stopped: true };
      }
    }
  }
  return { result: priorityResult(results), stopped: false };
}

export function describeAttribute(attribute: RadiusAttribute): string {
  return formatRadiusAttribute(attribute);
}
