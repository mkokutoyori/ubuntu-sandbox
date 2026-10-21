import { posixToJsSource } from '@/network/devices/linux/regex/PosixRegex';
import type { Stmt } from '../config/Ast';
import { evaluate, evaluateBoolean, valueToString, type EvaluationEnvironment, type Value } from '../config/Expressions';
import { priorityMaskMatches } from '../config/Filters';
import { jsonDeepCopy, jsonSet, jsonUnset } from '../Json';
import type { JsonValue, RsyslogMessage } from '../Message';
import { baseProperty } from '../Properties';
import type { ActionDefinition } from './Config';

export interface Sleep {
  readonly sleepMs: number;
}

export type ExecResult = 'continue' | 'stop';

export interface ExecutionServices {
  readonly env: EvaluationEnvironment;
  runAction(definition: ActionDefinition, message: RsyslogMessage): Generator<Sleep, void>;
  callRuleset(name: string, message: RsyslogMessage, depth: number): Generator<Sleep, ExecResult>;
  log(text: string): void;
  reloadLookupTable(name: string, stubIfReloadFails: string | null): void;
}

const MAX_CALL_DEPTH = 1024;

const REGEX_CACHE = new WeakMap<object, RegExp | null>();

function compilePropertyRegex(statement: Extract<Stmt, { k: 'propfilt' }>, services: ExecutionServices): RegExp | null {
  if (REGEX_CACHE.has(statement)) return REGEX_CACHE.get(statement) ?? null;
  let compiled: RegExp | null = null;
  try {
    compiled = new RegExp(posixToJsSource(statement.value, { extended: statement.operation === 'ereregex' }), 'u');
  } catch (error) {
    services.log(`Error in regular expression: ${error instanceof Error ? error.message : String(error)}\n`);
  }
  REGEX_CACHE.set(statement, compiled);
  return compiled;
}

function propertyText(statement: Extract<Stmt, { k: 'propfilt' }>, message: RsyslogMessage, services: ExecutionServices): string {
  return baseProperty(statement.prop, message, services.env.render, { format: 'default', utc: false });
}

function evaluatePropertyFilter(statement: Extract<Stmt, { k: 'propfilt' }>, message: RsyslogMessage, services: ExecutionServices): boolean {
  if (statement.prop.id === 'invalid') return false;
  const value = propertyText(statement, message, services);
  let result: boolean;
  switch (statement.operation) {
    case 'contains': result = value.includes(statement.value); break;
    case 'isempty': result = value.length === 0; break;
    case 'isequal': result = value === statement.value; break;
    case 'startswith': result = value.startsWith(statement.value); break;
    case 'endswith': result = value.endsWith(statement.value); break;
    default: {
      const matcher = compilePropertyRegex(statement, services);
      result = matcher !== null && matcher.test(value);
    }
  }
  return statement.negated ? !result : result;
}

function valueToJson(value: Value): JsonValue {
  switch (value.t) {
    case 'S': return value.s;
    case 'N': return value.n;
    default: return jsonDeepCopy(value.j);
  }
}

function rootOf(name: string, message: RsyslogMessage, services: ExecutionServices): { [key: string]: JsonValue } {
  switch (name[0]) {
    case '.': return message.localVariables;
    case '/': return services.env.render.globalVariables;
    default: return message.cee;
  }
}

export function setVariable(name: string, value: JsonValue, reset: boolean, message: RsyslogMessage, services: ExecutionServices): void {
  jsonSet(rootOf(name, message, services), name.slice(1), value, reset, services.env.caseSensitiveVariables);
}

export function unsetVariable(name: string, message: RsyslogMessage, services: ExecutionServices): void {
  jsonUnset(rootOf(name, message, services), name.slice(1), services.env.caseSensitiveVariables);
}

function* iterate(statement: Extract<Stmt, { k: 'foreach' }>, message: RsyslogMessage, services: ExecutionServices, depth: number): Generator<Sleep, ExecResult> {
  const collection = evaluate(statement.collection, message, services.env);
  if (collection.t !== 'J' || collection.j === null || typeof collection.j !== 'object') return 'continue';
  const variable = statement.variable;
  const root = collection.j;
  const items: JsonValue[] = Array.isArray(root)
    ? root
    : Object.entries(root).map(([key, entry]) => ({ key, value: entry }));
  if (items.length === 0) return 'continue';
  for (const item of items) {
    setVariable(variable, jsonDeepCopy(item), true, message, services);
    const result = yield* executeStatements(statement.body, message, services, depth);
    if (result === 'stop') return 'stop';
  }
  unsetVariable(variable, message, services);
  return 'continue';
}

export function* executeStatements(statements: readonly Stmt[], message: RsyslogMessage, services: ExecutionServices, depth = 0): Generator<Sleep, ExecResult> {
  for (const statement of statements) {
    switch (statement.k) {
      case 'nop': break;
      case 'stop': return 'stop';
      case 'act':
        yield* services.runAction(statement.action as ActionDefinition, message);
        break;
      case 'set':
        setVariable(statement.variable, valueToJson(evaluate(statement.expr, message, services.env)), statement.reset, message, services);
        break;
      case 'unset':
        unsetVariable(statement.variable, message, services);
        break;
      case 'call': {
        if (depth >= MAX_CALL_DEPTH) {
          services.log(`ruleset call nesting limit of ${MAX_CALL_DEPTH} reached; call to ruleset '${statement.name}' ignored to avoid runaway recursion`);
          break;
        }
        if ((yield* services.callRuleset(statement.name, message, depth + 1)) === 'stop') return 'stop';
        break;
      }
      case 'callIndirect': {
        const name = valueToString(evaluate(statement.expr, message, services.env));
        if (depth >= MAX_CALL_DEPTH) break;
        if ((yield* services.callRuleset(name, message, depth + 1)) === 'stop') return 'stop';
        break;
      }
      case 'if': {
        const branch = evaluateBoolean(statement.expr, message, services.env) ? statement.then : statement.else;
        if (branch !== null && (yield* executeStatements(branch, message, services, depth)) === 'stop') return 'stop';
        break;
      }
      case 'foreach':
        if ((yield* iterate(statement, message, services, depth)) === 'stop') return 'stop';
        break;
      case 'prifilt':
        if (priorityMaskMatches(statement.mask, message.facility, message.severity)
          && (yield* executeStatements(statement.then, message, services, depth)) === 'stop') return 'stop';
        break;
      case 'propfilt':
        if (evaluatePropertyFilter(statement, message, services)
          && (yield* executeStatements(statement.then, message, services, depth)) === 'stop') return 'stop';
        break;
      case 'reloadLookupTable':
        if (statement.table !== undefined) services.reloadLookupTable(statement.table, statement.stub ?? null);
        break;
    }
  }
  return 'continue';
}
