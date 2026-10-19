import { posixToJsSource } from '@/network/devices/linux/regex/PosixRegex';
import { formatTimestamp3164, syslogTimeFromEpochMs } from '@/network/syslog/codec/SyslogTime';
import { jsonDeepCopy, jsonGet, jsonToString } from '../Json';
import type { JsonValue, RsyslogMessage } from '../Message';
import { baseProperty, type PropertyDescriptor, type RenderContext } from '../Properties';
import { renderTemplate, type Template } from '../Template';
import type { Expr } from './Ast';
import { decodePriorityFilter, priorityMaskMatches } from './Filters';

export type Value =
  | { readonly t: 'S'; readonly s: string }
  | { readonly t: 'N'; readonly n: number }
  | { readonly t: 'J'; readonly j: JsonValue };

export class ScriptState {
  scriptError = 0;
  previousSuspended = false;
  callDepth = 0;
}

export const SCRIPT_OK = 0;
export const SCRIPT_INVALID = 1;

export interface EvaluationEnvironment {
  readonly render: RenderContext;
  readonly state: ScriptState;
  readonly maxLine: number;
  readonly caseSensitiveVariables: boolean;
  template(name: string): Template | undefined;
  environment(name: string): string | undefined;
  random(): number;
  warn(message: string): void;
}

export interface FunctionSignature {
  readonly name: string;
  readonly min: number;
  readonly max: number;
  prepare?(args: Expr[], report: (message: string) => void): unknown;
  call(args: Expr[], prepared: unknown, message: RsyslogMessage, env: EvaluationEnvironment): Value;
}

const str = (s: string): Value => ({ t: 'S', s });
const num = (n: number): Value => ({ t: 'N', n });

export function valueToNumber(value: Value): { n: number; ok: boolean } {
  switch (value.t) {
    case 'N': return { n: value.n, ok: true };
    case 'S': return stringToNumber(value.s);
    default: return { n: jsonToInteger(value.j), ok: true };
  }
}

function stringToNumber(text: string): { n: number; ok: boolean } {
  if (text.length === 0) return { n: 0, ok: true };
  let index = 0;
  let sign = 1;
  if (text[0] === '-') {
    sign = -1;
    index = 1;
  }
  let magnitude = 0;
  while (index < text.length && text[index] >= '0' && text[index] <= '9') {
    magnitude = magnitude * 10 + (text.charCodeAt(index) - 48);
    index++;
  }
  return { n: magnitude * sign, ok: index === text.length };
}

function jsonToInteger(json: JsonValue): number {
  if (json === null) return 0;
  if (typeof json === 'number') return Math.trunc(json);
  if (typeof json === 'boolean') return json ? 1 : 0;
  if (typeof json === 'string') {
    const match = /^\s*[+-]?\d+/.exec(json);
    return match === null ? 0 : Number.parseInt(match[0], 10);
  }
  return 0;
}

export function valueToString(value: Value): string {
  switch (value.t) {
    case 'S': return value.s;
    case 'N': return String(value.n);
    default: return value.j === null ? '' : jsonToString(value.j);
  }
}

function truthy(value: Value): boolean {
  return valueToNumber(value).n !== 0;
}

function variableValue(prop: PropertyDescriptor, message: RsyslogMessage, env: EvaluationEnvironment): Value {
  if (prop.id === 'cee' || prop.id === 'local-var' || prop.id === 'global-var') {
    const root = prop.id === 'cee' ? message.cee : prop.id === 'local-var' ? message.localVariables : env.render.globalVariables;
    if (prop.name === '' || prop.name === '!') return { t: 'J', j: jsonDeepCopy(root) };
    const found = jsonGet(root, prop.name, env.caseSensitiveVariables);
    if (found === undefined) return str('');
    if (found === null) return str('');
    if (typeof found === 'string') return str(found);
    return { t: 'J', j: jsonDeepCopy(found) };
  }
  return str(baseProperty(prop, message, env.render, { format: 'default', utc: false }));
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function stringArrayCompare(left: string, array: string[], op: string): boolean {
  switch (op) {
    case 'CMP_EQ': return array.includes(left);
    case 'CMP_NE': return !array.includes(left);
    case 'CMP_STARTSWITH': return array.some((item) => left.startsWith(item));
    case 'CMP_STARTSWITHI': return array.some((item) => left.toLowerCase().startsWith(item.toLowerCase()));
    case 'CMP_ENDSWITH': return array.some((item) => left.length >= item.length && left.endsWith(item));
    case 'CMP_CONTAINS': return array.some((item) => left.includes(item));
    case 'CMP_CONTAINSI': return array.some((item) => left.toLowerCase().includes(item.toLowerCase()));
    default: return false;
  }
}

function equals(left: Value, rightExpr: Expr, message: RsyslogMessage, env: EvaluationEnvironment): boolean {
  if (left.t === 'S' || left.t === 'J') {
    const leftText = valueToString(left);
    if (rightExpr.k === 'str') return leftText === rightExpr.value;
    if (rightExpr.k === 'arr') return stringArrayCompare(leftText, rightExpr.values, 'CMP_EQ');
    const right = evaluate(rightExpr, message, env);
    if (right.t === 'S') return leftText === right.s;
    const leftNumber = valueToNumber(left);
    if (leftNumber.ok) return leftNumber.n === valueToNumber(right).n;
    return leftText === valueToString(right);
  }
  const right = evaluate(rightExpr, message, env);
  if (right.t === 'S') {
    const rightNumber = valueToNumber(right);
    if (rightNumber.ok) return left.n === rightNumber.n;
    return right.s === valueToString(left);
  }
  return left.n === valueToNumber(right).n;
}

function strcmpLike(expr: Extract<Expr, { k: 'bin' }>, message: RsyslogMessage, env: EvaluationEnvironment): number {
  const left = evaluate(expr.l, message, env);
  const right = evaluate(expr.r, message, env);
  const leftNumber = valueToNumber(left);
  if (leftNumber.ok) {
    const rightNumber = valueToNumber(right);
    if (rightNumber.ok) return leftNumber.n - rightNumber.n;
  }
  return compareStrings(valueToString(left), valueToString(right));
}

function concat(left: Value, rightExpr: Expr, message: RsyslogMessage, env: EvaluationEnvironment): string {
  const leftText = valueToString(left);
  if (rightExpr.k === 'arr') return leftText + rightExpr.values[0];
  return leftText + valueToString(evaluate(rightExpr, message, env));
}

function arithmetic(expr: Extract<Expr, { k: 'bin' }>, message: RsyslogMessage, env: EvaluationEnvironment): Value {
  const left = valueToNumber(evaluate(expr.l, message, env)).n;
  const right = valueToNumber(evaluate(expr.r, message, env)).n;
  switch (expr.op) {
    case '+': return num(left + right);
    case '-': return num(left - right);
    case '*': return num(left * right);
    case '/': return num(right === 0 ? 0 : Math.trunc(left / right));
    default: return num(right === 0 ? 0 : left % right);
  }
}

export function evaluate(expr: Expr, message: RsyslogMessage, env: EvaluationEnvironment): Value {
  switch (expr.k) {
    case 'num': return num(expr.value);
    case 'str': return str(expr.value);
    case 'arr': return str(expr.values[0] ?? '');
    case 'var': return variableValue(expr.prop, message, env);
    case 'exists': return num(variableExists(expr.prop, message, env) ? 1 : 0);
    case 'not': return num(truthy(evaluate(expr.r, message, env)) ? 0 : 1);
    case 'neg': return num(-valueToNumber(evaluate(expr.r, message, env)).n);
    case 'func': return callFunction(expr, message, env);
    case 'bin': break;
  }
  switch (expr.op) {
    case 'OR': return num(truthy(evaluate(expr.l, message, env)) || truthy(evaluate(expr.r, message, env)) ? 1 : 0);
    case 'AND': return num(truthy(evaluate(expr.l, message, env)) && truthy(evaluate(expr.r, message, env)) ? 1 : 0);
    case 'CMP_EQ': return num(equals(evaluate(expr.l, message, env), expr.r, message, env) ? 1 : 0);
    case 'CMP_NE': return num(equals(evaluate(expr.l, message, env), expr.r, message, env) ? 0 : 1);
    case 'CMP_LE': return num(strcmpLike(expr, message, env) <= 0 ? 1 : 0);
    case 'CMP_GE': return num(strcmpLike(expr, message, env) >= 0 ? 1 : 0);
    case 'CMP_LT': return num(strcmpLike(expr, message, env) < 0 ? 1 : 0);
    case 'CMP_GT': return num(strcmpLike(expr, message, env) > 0 ? 1 : 0);
    case 'CMP_STARTSWITH':
    case 'CMP_STARTSWITHI':
    case 'CMP_ENDSWITH':
    case 'CMP_CONTAINS':
    case 'CMP_CONTAINSI': {
      const left = valueToString(evaluate(expr.l, message, env));
      if (expr.r.k === 'arr') return num(stringArrayCompare(left, expr.r.values, expr.op) ? 1 : 0);
      const right = expr.r.k === 'str' ? expr.r.value : valueToString(evaluate(expr.r, message, env));
      switch (expr.op) {
        case 'CMP_STARTSWITH': return num(left.startsWith(right) ? 1 : 0);
        case 'CMP_STARTSWITHI': return num(left.toLowerCase().startsWith(right.toLowerCase()) ? 1 : 0);
        case 'CMP_ENDSWITH': return num(left.length >= right.length && left.endsWith(right) ? 1 : 0);
        case 'CMP_CONTAINS': return num(left.includes(right) ? 1 : 0);
        default: return num(left.toLowerCase().includes(right.toLowerCase()) ? 1 : 0);
      }
    }
    case '&': return str(concat(evaluate(expr.l, message, env), expr.r, message, env));
    default: return arithmetic(expr, message, env);
  }
}

export function evaluateBoolean(expr: Expr, message: RsyslogMessage, env: EvaluationEnvironment): boolean {
  return truthy(evaluate(expr, message, env));
}

function variableExists(prop: PropertyDescriptor, message: RsyslogMessage, env: EvaluationEnvironment): boolean {
  if (prop.id !== 'cee' && prop.id !== 'local-var' && prop.id !== 'global-var') return false;
  const root = prop.id === 'cee' ? message.cee : prop.id === 'local-var' ? message.localVariables : env.render.globalVariables;
  if (prop.name === '' || prop.name === '!') return true;
  return jsonGet(root, prop.name, env.caseSensitiveVariables) !== undefined;
}

export interface CompiledRegex {
  readonly matcher: RegExp;
}

function compileEre(pattern: string, ignoreCase: boolean, report: (message: string) => void): CompiledRegex | null {
  try {
    const source = posixToJsSource(pattern, { extended: true, ignoreCase });
    return { matcher: new RegExp(source, `d${ignoreCase ? 'i' : ''}u`) };
  } catch (error) {
    report(`cannot compile regex '${pattern}': ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function regexPrepare(ignoreCase: boolean) {
  return (args: Expr[], report: (message: string) => void): CompiledRegex | null => {
    if (args[1].k !== 'str') {
      report('param 2 of re_match/extract() must be a constant string');
      return null;
    }
    return compileEre(args[1].value, ignoreCase, report);
  };
}

function textOf(arg: Expr, message: RsyslogMessage, env: EvaluationEnvironment): string {
  return valueToString(evaluate(arg, message, env));
}

function numberOf(arg: Expr, message: RsyslogMessage, env: EvaluationEnvironment): number {
  return valueToNumber(evaluate(arg, message, env)).n;
}

function extractField(text: string, delimiter: string, wanted: number): string | null {
  if (delimiter.length === 1) {
    let current = 1;
    let position = 0;
    while (position < text.length && current < wanted) {
      while (position < text.length && text[position] !== delimiter) position++;
      if (text[position] === delimiter) {
        position++;
        current++;
      }
    }
    if (current !== wanted) return null;
    let end = position;
    while (end < text.length && text[end] !== delimiter) end++;
    return text.slice(position, end);
  }
  return null;
}

function extractFieldByString(text: string, delimiter: string, wanted: number): string | null {
  let current = 1;
  let position = 0;
  while (current < wanted) {
    const found = text.indexOf(delimiter, position);
    if (found < 0) return null;
    position = found + delimiter.length;
    current++;
  }
  const end = text.indexOf(delimiter, position);
  return end < 0 ? text.slice(position) : text.slice(position, end);
}

function replaceAll(text: string, find: string, replacement: string, env: EvaluationEnvironment): string | null {
  const limit = env.maxLine;
  const chunks: string[] = [];
  let length = 0;
  let index = 0;
  if (find.length === 0) {
    return replacement.length > limit ? null : replacement + text;
  }
  while (index <= text.length) {
    const found = text.indexOf(find, index);
    if (found < 0) {
      chunks.push(text.slice(index));
      length += text.length - index;
      break;
    }
    chunks.push(text.slice(index, found), replacement);
    length += found - index + replacement.length;
    index = found + find.length;
    if (length > limit) return null;
  }
  return length > limit ? null : chunks.join('');
}

const BOOL_FALSE = new Set(['no', 'off', 'false']);

function boolText(value: string): number {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed === '0' || BOOL_FALSE.has(trimmed.toLowerCase())) return 0;
  return 1;
}

function ipv4ToNumber(text: string): number {
  const octets = [0, 0, 0, 0];
  let cycle = 0;
  let previousDot = false;
  let startBlank = false;
  let endBlank = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character >= '0' && character <= '9') {
      if (endBlank) return -1;
      previousDot = false;
      startBlank = false;
      octets[cycle] = octets[cycle] * 10 + (character.charCodeAt(0) - 48);
    } else if (character === ' ') {
      previousDot = false;
      if (index === 0 || startBlank) startBlank = true;
      else endBlank = true;
    } else if (character === '.') {
      if (endBlank) return -1;
      startBlank = false;
      if (previousDot) return -1;
      previousDot = true;
      cycle++;
      if (cycle > 3) return -1;
    } else return -1;
  }
  if (cycle !== 3) return -1;
  return octets[0] * 256 ** 3 + octets[1] * 256 ** 2 + octets[2] * 256 + octets[3];
}

function decodeBase64(input: string): string {
  const cleaned = input.replace(/[\s=]/g, '');
  if (cleaned.length === 0 || /[^A-Za-z0-9+/]/.test(cleaned)) return '';
  let bits = 0;
  let accumulated = 0;
  let output = '';
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  for (const character of cleaned) {
    accumulated = (accumulated << 6) | alphabet.indexOf(character);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output += String.fromCharCode((accumulated >> bits) & 0xff);
    }
  }
  return output;
}

function formatUnixTime(seconds: number, format: string): string | null {
  const time = syslogTimeFromEpochMs(seconds * 1000, 0, 0);
  if (format === 'date-rfc3164') return formatTimestamp3164(time, false);
  if (format === 'date-rfc3339') {
    const pad = (value: number): string => String(value).padStart(2, '0');
    return `${time.year}-${pad(time.month)}-${pad(time.day)}T${pad(time.hour)}:${pad(time.minute)}:${pad(time.second)}Z`;
  }
  return null;
}

const SIGNATURES: FunctionSignature[] = [
  { name: 'strlen', min: 1, max: 1, call: (a, _p, m, e) => num(a[0].k === 'str' ? a[0].value.length : textOf(a[0], m, e).length) },
  { name: 'getenv', min: 1, max: 1, call: (a, _p, m, e) => str(e.environment(textOf(a[0], m, e)) ?? '') },
  {
    name: 'num2ipv4', min: 1, max: 1,
    call: (a, _p, m, e) => {
      const value = valueToNumber(evaluate(a[0], m, e));
      if (!value.ok || value.n < 0 || value.n > 4294967295) return str('-1');
      const octets: number[] = [];
      let rest = value.n;
      for (let index = 0; index < 4; index++) {
        octets.unshift(rest % 256);
        rest = Math.floor(rest / 256);
      }
      return str(octets.join('.'));
    },
  },
  {
    name: 'int2hex', min: 1, max: 1,
    call: (a, _p, m, e) => {
      const value = valueToNumber(evaluate(a[0], m, e));
      if (!value.ok) return str('NAN');
      return str((value.n < 0 ? BigInt.asUintN(64, BigInt(value.n)) : BigInt(value.n)).toString(16));
    },
  },
  {
    name: 'substring', min: 3, max: 3,
    call: (a, _p, m, e) => {
      const source = textOf(a[0], m, e);
      const startNumber = numberOf(a[1], m, e);
      const lengthNumber = numberOf(a[2], m, e);
      let start = startNumber < 0 ? 0 : startNumber > 2147483647 ? source.length : startNumber;
      let length = Math.max(-2147483648, Math.min(2147483647, lengthNumber));
      if (start >= source.length) {
        start = 0;
        length = 0;
      } else {
        if (length < 0) length = Math.max(0, source.length + length);
        if (length > source.length - start) length = source.length - start;
      }
      return str(source.slice(start, start + length));
    },
  },
  { name: 'ltrim', min: 1, max: 1, call: (a, _p, m, e) => str(textOf(a[0], m, e).replace(/^ +/, '')) },
  {
    name: 'rtrim', min: 1, max: 1,
    call: (a, _p, m, e) => {
      const text = textOf(a[0], m, e);
      let end = text.length - 1;
      while (end > 0 && text[end] === ' ') end--;
      return str(end > 0 || text[0] !== ' ' ? text.slice(0, end + 1) : '');
    },
  },
  { name: 'tolower', min: 1, max: 1, call: (a, _p, m, e) => str(textOf(a[0], m, e).replace(/[A-Z]/g, (c) => c.toLowerCase())) },
  { name: 'toupper', min: 1, max: 1, call: (a, _p, m, e) => str(textOf(a[0], m, e).replace(/[a-z]/g, (c) => c.toUpperCase())) },
  { name: 'cstr', min: 1, max: 1, call: (a, _p, m, e) => str(textOf(a[0], m, e)) },
  { name: 'cnum', min: 1, max: 1, call: (a, _p, m, e) => num(a[0].k === 'num' ? a[0].value : numberOf(a[0], m, e)) },
  {
    name: 'cbool', min: 1, max: 1,
    call: (a, _p, m, e) => {
      if (a[0].k === 'num') return num(a[0].value !== 0 ? 1 : 0);
      if (a[0].k === 'str') return num(boolText(a[0].value));
      const value = evaluate(a[0], m, e);
      return num(value.t === 'N' ? (value.n !== 0 ? 1 : 0) : boolText(valueToString(value)));
    },
  },
  { name: 'ip42num', min: 1, max: 1, call: (a, _p, m, e) => num(ipv4ToNumber(textOf(a[0], m, e))) },
  { name: 'ipv42num', min: 1, max: 1, call: (a, _p, m, e) => num(ipv4ToNumber(textOf(a[0], m, e))) },
  {
    name: 're_match', min: 2, max: 2, prepare: regexPrepare(false),
    call: (a, p, m, e) => num((p as CompiledRegex | null)?.matcher.test(textOf(a[0], m, e)) === true ? 1 : 0),
  },
  {
    name: 're_match_i', min: 2, max: 2, prepare: regexPrepare(true),
    call: (a, p, m, e) => num((p as CompiledRegex | null)?.matcher.test(textOf(a[0], m, e)) === true ? 1 : 0),
  },
  { name: 're_extract', min: 5, max: 5, prepare: regexPrepare(false), call: (a, p, m, e) => reExtract(a, p as CompiledRegex | null, m, e) },
  { name: 're_extract_i', min: 5, max: 5, prepare: regexPrepare(true), call: (a, p, m, e) => reExtract(a, p as CompiledRegex | null, m, e) },
  {
    name: 'field', min: 3, max: 3,
    call: (a, _p, m, e) => {
      const text = textOf(a[0], m, e);
      const delimiterValue = evaluate(a[1], m, e);
      const wanted = numberOf(a[2], m, e);
      const found = delimiterValue.t === 'S'
        ? extractFieldByString(text, delimiterValue.s, wanted)
        : extractField(text, String.fromCharCode(valueToNumber(delimiterValue).n & 0xff), wanted);
      return str(found ?? '***FIELD NOT FOUND***');
    },
  },
  {
    name: 'exec_template', min: 1, max: 1,
    prepare: (args, report) => {
      if (args[0].k !== 'str') report('exec_template: parameter must be a constant string');
      return args[0].k === 'str' ? args[0].value : null;
    },
    call: (_a, p, m, e) => {
      const template = typeof p === 'string' ? e.template(p) : undefined;
      return str(template === undefined ? '' : renderTemplate(template, m, e.render));
    },
  },
  {
    name: 'prifilt', min: 1, max: 1,
    prepare: (args, report) => (args[0].k === 'str' ? decodePriorityFilter(args[0].value, report) : null),
    call: (_a, p, m) => num(Array.isArray(p) && priorityMaskMatches(p as number[], m.facility, m.severity) ? 1 : 0),
  },
  {
    name: 'replace', min: 3, max: 3,
    call: (a, _p, m, e) => {
      const result = replaceAll(textOf(a[0], m, e), textOf(a[1], m, e), textOf(a[2], m, e), e);
      if (result === null) e.warn(`RainerScript replace()/wrap() result exceeds maxMessageSize (${e.maxLine} bytes); returning an empty string (further warnings suppressed)`);
      return str(result ?? '');
    },
  },
  {
    name: 'wrap', min: 2, max: 3,
    call: (a, _p, m, e) => {
      let source = textOf(a[0], m, e);
      const wrapper = textOf(a[1], m, e);
      if (a.length === 3) {
        const escaped = replaceAll(source, wrapper, textOf(a[2], m, e), e);
        if (escaped === null) return str('');
        source = escaped;
      }
      if (wrapper.length > e.maxLine / 2 || source.length > e.maxLine - 2 * wrapper.length) return str('');
      return str(wrapper + source + wrapper);
    },
  },
  {
    name: 'random', min: 1, max: 1,
    call: (a, _p, m, e) => {
      const value = valueToNumber(evaluate(a[0], m, e));
      if (!value.ok || value.n === 0) return num(0);
      return num(e.random() % Math.abs(value.n));
    },
  },
  {
    name: 'format_time', min: 2, max: 2,
    call: (a, _p, m, e) => {
      const source = evaluate(a[0], m, e);
      const seconds = valueToNumber(source);
      const formatted = seconds.ok ? formatUnixTime(seconds.n, textOf(a[1], m, e)) : null;
      return str(formatted ?? valueToString(source).slice(0, 63));
    },
  },
  { name: 'script_error', min: 0, max: 0, call: (_a, _p, _m, e) => num(e.state.scriptError) },
  { name: 'previous_action_suspended', min: 0, max: 0, call: (_a, _p, _m, e) => num(e.state.previousSuspended ? 1 : 0) },
  { name: 'b64_decode', min: 1, max: 1, call: (a, _p, m, e) => str(decodeBase64(textOf(a[0], m, e))) },
  {
    name: 'parse_json', min: 2, max: 2,
    call: (a, _p, m, e) => {
      const text = textOf(a[0], m, e);
      const container = textOf(a[1], m, e);
      try {
        const parsed = JSON.parse(text) as JsonValue;
        const name = container.startsWith('$') ? container.slice(1) : container;
        const path = name.replace(/^[!]/, '');
        if (path === '') Object.assign(m.cee, parsed as object);
        else m.cee[path] = parsed;
        e.state.scriptError = SCRIPT_OK;
        return num(SCRIPT_OK);
      } catch {
        e.state.scriptError = SCRIPT_INVALID;
        return num(SCRIPT_INVALID);
      }
    },
  },
  {
    name: 'get_property', min: 2, max: 2,
    call: (a, _p, m, e) => {
      if (a[0].k === 'str') {
        e.state.scriptError = SCRIPT_INVALID;
        return str('');
      }
      const source = evaluate(a[0], m, e);
      const key = evaluate(a[1], m, e);
      e.state.scriptError = SCRIPT_OK;
      if (source.t === 'S') return source;
      if (source.t === 'N') return str('');
      const json = source.j;
      if (json !== null && typeof json === 'object' && !Array.isArray(json)) {
        const name = valueToString(key);
        if (name === '') return source;
        const found = jsonGet(json, name, false);
        if (found === undefined) {
          e.state.scriptError = SCRIPT_INVALID;
          return str('');
        }
        if (typeof found === 'string') return str(found);
        if (typeof found === 'number') return num(Math.trunc(found));
        if (typeof found === 'boolean') return num(found ? 1 : 0);
        return found === null ? str('') : { t: 'J', j: found };
      }
      if (Array.isArray(json)) {
        const index = valueToNumber(key);
        if (!index.ok || index.n < 0 || index.n >= json.length) {
          e.state.scriptError = SCRIPT_INVALID;
          return str('');
        }
        const element = json[index.n];
        if (typeof element === 'string') return str(element);
        if (typeof element === 'number') return num(Math.trunc(element));
        if (typeof element === 'boolean') return num(element ? 1 : 0);
        return element === null ? str('') : { t: 'J', j: element };
      }
      if (typeof json === 'number') return num(Math.trunc(json));
      if (typeof json === 'boolean') return num(json ? 1 : 0);
      if (typeof json === 'string') return str(json);
      return str('');
    },
  },
];

function reExtract(args: Expr[], compiled: CompiledRegex | null, message: RsyslogMessage, env: EvaluationEnvironment): Value {
  const text = textOf(args[0], message, env);
  const wanted = numberOf(args[2], message, env);
  const submatch = numberOf(args[3], message, env);
  const noMatch = (): Value => str(valueToString(evaluate(args[4], message, env)));
  if (compiled === null || submatch >= 50) return noMatch();
  let offset = 0;
  let attempt = 0;
  for (;;) {
    const result = compiled.matcher.exec(text.slice(offset)) as (RegExpExecArray & { indices?: ([number, number] | undefined)[] }) | null;
    if (result === null) return noMatch();
    if (attempt === wanted) {
      const span = result.indices?.[submatch];
      if (span === undefined) return noMatch();
      return str(text.slice(offset + span[0], offset + span[1]));
    }
    const end = result.index + result[0].length;
    if (end === 0) {
      if (offset >= text.length) return noMatch();
      offset++;
    } else offset += end;
    attempt++;
  }
}

const SIGNATURE_TABLE = new Map(SIGNATURES.map((signature) => [signature.name, signature]));

export function functionSignature(name: string): FunctionSignature | undefined {
  return SIGNATURE_TABLE.get(name);
}

export function checkFunctionCall(name: string, argumentCount: number): string | null {
  const signature = SIGNATURE_TABLE.get(name);
  if (signature === undefined) return `function '${name}' not found`;
  if (signature.min === signature.max) {
    return argumentCount === signature.max ? null : `number of parameters for ${name}() must be ${signature.max} but is ${argumentCount}.`;
  }
  if (argumentCount < signature.min) return `number of parameters for ${name}() must be at least ${signature.min} but is ${argumentCount}.`;
  if (argumentCount > signature.max) return `number of parameters for ${name}() must be at most ${signature.max} but is ${argumentCount}.`;
  return null;
}

const PREPARED = new WeakMap<object, unknown>();

function callFunction(expr: Extract<Expr, { k: 'func' }>, message: RsyslogMessage, env: EvaluationEnvironment): Value {
  const signature = SIGNATURE_TABLE.get(expr.name);
  if (signature === undefined || checkFunctionCall(expr.name, expr.args.length) !== null) return str('');
  let prepared: unknown;
  if (PREPARED.has(expr)) prepared = PREPARED.get(expr);
  else {
    prepared = signature.prepare?.(expr.args, () => undefined);
    PREPARED.set(expr, prepared);
  }
  return signature.call(expr.args, prepared, message, env);
}

export function prepareFunctions(expr: Expr, report: (message: string) => void): void {
  switch (expr.k) {
    case 'func': {
      const signature = SIGNATURE_TABLE.get(expr.name);
      if (signature !== undefined && checkFunctionCall(expr.name, expr.args.length) === null) {
        PREPARED.set(expr, signature.prepare?.(expr.args, report));
      }
      for (const arg of expr.args) prepareFunctions(arg, report);
      break;
    }
    case 'bin':
      prepareFunctions(expr.l, report);
      prepareFunctions(expr.r, report);
      break;
    case 'not':
    case 'neg':
      prepareFunctions(expr.r, report);
      break;
    default:
  }
}
