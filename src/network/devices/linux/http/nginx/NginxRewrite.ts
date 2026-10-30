import { compileNginxRegex } from './NginxRegex';
import { parseReturn, type NginxReturnRule } from './NginxReturn';
import {
  expandNginxVariables, isBuiltInNginxVariable, namedCaptureGroups, unknownNginxVariable, type NginxVariableContext,
} from './NginxVariables';

export interface NginxRewriteDirective {
  readonly name: string;
  readonly args: readonly string[];
  readonly block?: readonly NginxRewriteDirective[];
}

export type NginxCondition =
  | { readonly kind: 'truthy'; readonly variable: string }
  | { readonly kind: 'equal'; readonly variable: string; readonly value: string; readonly negate: boolean }
  | { readonly kind: 'regex'; readonly variable: string; readonly regex: RegExp; readonly negate: boolean }
  | { readonly kind: 'file'; readonly test: 'f' | 'd' | 'e' | 'x'; readonly negate: boolean; readonly path: string };

export type RewriteFlag = '' | 'last' | 'break' | 'redirect' | 'permanent';

export type NginxRewriteOp =
  | { readonly kind: 'set'; readonly variable: string; readonly value: string }
  | { readonly kind: 'if'; readonly condition: NginxCondition; readonly ops: readonly NginxRewriteOp[] }
  | {
    readonly kind: 'rewrite'; readonly regex: RegExp; readonly replacement: string; readonly addArgs: boolean;
    readonly stops: boolean; readonly flag: RewriteFlag; readonly status: 0 | 301 | 302;
  }
  | { readonly kind: 'return'; readonly rule: NginxReturnRule }
  | { readonly kind: 'break' };

export interface RewriteState {
  uri: string;
  args: string;
  uriChanged: boolean;
  readonly vars: Map<string, string>;
  captures: Map<string, string>;
}

export interface RewriteEnv {
  context(state: RewriteState): NginxVariableContext;
  fileTest(test: 'f' | 'd' | 'e' | 'x', path: string): boolean;
}

export type RewriteResult =
  | { readonly kind: 'end' }
  | { readonly kind: 'stop' }
  | { readonly kind: 'return'; readonly rule: NginxReturnRule }
  | { readonly kind: 'redirect'; readonly status: 301 | 302; readonly location: string };

export const NGINX_REWRITE_DIRECTIVES: ReadonlySet<string> = new Set(['set', 'rewrite', 'break']);

const SCRIPT_PARENTS: readonly string[] = ['server', 'location', 'if'];
const IF_PARENTS: readonly string[] = ['server', 'location'];
const FILE_TESTS = /^(!?)-([fdex])$/;
const VARIABLE_NAME = /^[A-Za-z0-9_]+$/;
const FLAGS: ReadonlySet<string> = new Set(['last', 'break', 'redirect', 'permanent']);
const ABSOLUTE_START = /^(https?:\/\/|\$scheme)/;

function unknownIn(templates: readonly string[], declared: ReadonlySet<string> = new Set()): string | null {
  for (const template of templates) {
    const unknown = unknownNginxVariable(template, declared);
    if (unknown !== null) return unknown;
  }
  return null;
}

export function parseCondition(args: readonly string[]): NginxCondition | string {
  const tokens = [...args];
  if (tokens.length === 0 || !tokens[0].startsWith('(')) return `invalid condition "${tokens[0] ?? ''}"`;
  const last = tokens.length - 1;
  if (!tokens[last].endsWith(')')) return `invalid condition "${tokens[last]}"`;
  tokens[0] = tokens[0].slice(1);
  tokens[last] = tokens[last].slice(0, -1);
  const words = tokens.filter((token) => token !== '');
  if (words.length === 0) return `invalid condition "${args[0]}"`;

  const first = words[0];
  if (first.length > 1 && first.startsWith('$')) {
    if (words.length !== 1 && words.length !== 3) return `invalid condition "${first}"`;
    const variable = first.slice(1);
    if (words.length === 1) return { kind: 'truthy', variable };
    const operator = words[1];
    const operand = words[2];
    if (operator === '=' || operator === '!=') {
      const unknown = unknownIn([operand]);
      return unknown === null ? { kind: 'equal', variable, value: operand, negate: operator === '!=' } : `unknown "${unknown}" variable`;
    }
    if (operator === '~' || operator === '~*' || operator === '!~' || operator === '!~*') {
      const compiled = compileNginxRegex(operand, operator.endsWith('*'));
      return typeof compiled === 'string' ? compiled : { kind: 'regex', variable, regex: compiled, negate: operator.startsWith('!') };
    }
    return `unexpected "${operator}" in condition`;
  }
  const test = FILE_TESTS.exec(first);
  if (test !== null) {
    if (words.length !== 2) return `invalid condition "${first}"`;
    const unknown = unknownIn([words[1]]);
    return unknown === null
      ? { kind: 'file', test: test[2] as 'f' | 'd' | 'e' | 'x', negate: test[1] === '!', path: words[1] }
      : `unknown "${unknown}" variable`;
  }
  return `invalid condition "${first}"`;
}

export function checkRewriteDirective(
  name: string, args: readonly string[], parent: string | null, declared: ReadonlySet<string>,
): string | null {
  if (name === 'if') {
    if (parent === null || !IF_PARENTS.includes(parent)) return '"if" directive is not allowed here';
    const parsed = parseCondition(args);
    return typeof parsed === 'string' ? parsed : null;
  }
  if (parent === null || !SCRIPT_PARENTS.includes(parent)) return `"${name}" directive is not allowed here`;
  if (name === 'return') return null;
  if (name === 'break') return args.length === 0 ? null : 'invalid number of arguments in "break" directive';
  if (name === 'set') {
    if (args.length !== 2) return 'invalid number of arguments in "set" directive';
    if (!args[0].startsWith('$') || args[0].length < 2) return `invalid variable name "${args[0]}"`;
    const variable = args[0].slice(1);
    if (!VARIABLE_NAME.test(variable)) return `invalid variable name "${args[0]}"`;
    if (isBuiltInNginxVariable(variable)) return `the duplicate "${variable}" variable`;
    const unknown = unknownIn([args[1]], declared);
    return unknown === null ? null : `unknown "${unknown}" variable`;
  }
  if (args.length < 2 || args.length > 3) return 'invalid number of arguments in "rewrite" directive';
  if (args[1] === '') return 'empty replacement';
  if (args[2] !== undefined && !FLAGS.has(args[2])) return `invalid parameter "${args[2]}"`;
  const compiled = compileNginxRegex(args[0], false);
  if (typeof compiled === 'string') return compiled;
  const unknown = unknownIn([args[1]], new Set([...declared, ...namedCaptureGroups(args[0])]));
  return unknown === null ? null : `unknown "${unknown}" variable`;
}

export function declaredUserVariables(tree: readonly NginxRewriteDirective[]): ReadonlySet<string> {
  const names = new Set<string>();
  const walk = (nodes: readonly NginxRewriteDirective[]): void => {
    for (const node of nodes) {
      if (node.name === 'set' && node.args[0]?.startsWith('$')) names.add(node.args[0].slice(1));
      if (node.block !== undefined) walk(node.block);
    }
  };
  walk(tree);
  return names;
}

function opOf(node: NginxRewriteDirective): NginxRewriteOp | null {
  const { name, args } = node;
  if (name === 'break') return { kind: 'break' };
  if (name === 'return') {
    const rule = parseReturn(args);
    return typeof rule === 'string' ? null : { kind: 'return', rule };
  }
  if (name === 'set') return { kind: 'set', variable: args[0].slice(1), value: args[1] };
  if (name === 'if') {
    const condition = parseCondition(args);
    return typeof condition === 'string' ? null : { kind: 'if', condition, ops: buildRewriteOps(node.block ?? []) };
  }
  if (name === 'rewrite') {
    const compiled = compileNginxRegex(args[0], false);
    if (typeof compiled === 'string') return null;
    const trailingQuestion = args[1].endsWith('?');
    const replacement = trailingQuestion ? args[1].slice(0, -1) : args[1];
    const absolute = ABSOLUTE_START.test(replacement);
    const flag = (args[2] ?? '') as RewriteFlag;
    const redirect = absolute || flag === 'redirect' || flag === 'permanent';
    return {
      kind: 'rewrite', regex: compiled, replacement, addArgs: !trailingQuestion, flag,
      stops: absolute || flag !== '', status: redirect ? (flag === 'permanent' ? 301 : 302) : 0,
    };
  }
  return null;
}

export function buildRewriteOps(block: readonly NginxRewriteDirective[]): NginxRewriteOp[] {
  const ops: NginxRewriteOp[] = [];
  for (const node of block) {
    const op = opOf(node);
    if (op !== null) ops.push(op);
  }
  return ops;
}

function captureMap(match: RegExpExecArray): Map<string, string> {
  const captures = new Map<string, string>();
  match.forEach((group, index) => { if (index > 0) captures.set(String(index), group ?? ''); });
  for (const [name, group] of Object.entries(match.groups ?? {})) captures.set(name, group ?? '');
  return captures;
}

function truthy(value: string): boolean {
  return value !== '' && value !== '0';
}

function conditionHolds(condition: NginxCondition, state: RewriteState, env: RewriteEnv): boolean {
  const context = env.context(state);
  if (condition.kind === 'file') {
    const found = env.fileTest(condition.test, expandNginxVariables(condition.path, context));
    return condition.negate ? !found : found;
  }
  const value = expandNginxVariables(`$${condition.variable}`, context);
  if (condition.kind === 'truthy') return truthy(value);
  if (condition.kind === 'equal') {
    const same = value === expandNginxVariables(condition.value, context);
    return condition.negate ? !same : same;
  }
  const match = condition.regex.exec(value);
  if (match !== null) state.captures = captureMap(match);
  return condition.negate ? match === null : match !== null;
}

function applyRewrite(op: Extract<NginxRewriteOp, { kind: 'rewrite' }>, state: RewriteState, env: RewriteEnv): RewriteResult | null {
  const match = op.regex.exec(state.uri);
  if (match === null) return null;
  state.captures = captureMap(match);
  const expanded = expandNginxVariables(op.replacement, env.context(state));
  const question = expanded.indexOf('?');
  const path = question < 0 ? expanded : expanded.slice(0, question);
  let args = question < 0 ? state.args : expanded.slice(question + 1);
  if (question >= 0 && op.addArgs && state.args !== '') args = args === '' ? state.args : `${args}&${state.args}`;
  if (question < 0 && !op.addArgs) args = '';

  if (op.status !== 0) {
    const tail = op.addArgs && state.args !== '' ? `${question < 0 ? '?' : '&'}${state.args}` : '';
    return { kind: 'redirect', status: op.status, location: expanded + tail };
  }
  state.uri = path;
  state.args = args;
  state.uriChanged = op.flag !== 'break';
  return op.stops ? { kind: 'stop' } : null;
}

export function runRewriteOps(ops: readonly NginxRewriteOp[], state: RewriteState, env: RewriteEnv): RewriteResult {
  for (const op of ops) {
    if (op.kind === 'set') {
      state.vars.set(op.variable, expandNginxVariables(op.value, env.context(state)));
    } else if (op.kind === 'return') {
      return { kind: 'return', rule: op.rule };
    } else if (op.kind === 'break') {
      state.uriChanged = false;
      return { kind: 'stop' };
    } else if (op.kind === 'if') {
      if (!conditionHolds(op.condition, state, env)) continue;
      const inner = runRewriteOps(op.ops, state, env);
      if (inner.kind !== 'end') return inner;
    } else {
      const outcome = applyRewrite(op, state, env);
      if (outcome !== null) return outcome;
    }
  }
  return { kind: 'end' };
}
