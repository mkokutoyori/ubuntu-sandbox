import type { Word } from '@/bash/parser/ASTNode';
import { hasMagic } from '@/network/devices/linux/fs/Glob';
import type { Environment } from './Environment';
import { evaluateArithmeticExpression } from './Arithmetic';
import { expandParameter, BashRuntimeError } from './ParameterExpansion';
import type { ParameterHost, ParameterResult } from './ParameterExpansion';
import { isShellOptionEnabled } from './ShellOptions';

export { BashRuntimeError } from './ParameterExpansion';

export type CommandSubstitutionFn = (command: string) => string;
export type HomeForFn = (user: string) => string | null;

export interface GlobOptions {
  readonly dotglob: boolean;
  readonly nocaseglob: boolean;
  readonly globstar: boolean;
}

export type GlobFn = (pattern: string, options: GlobOptions) => string[] | null;

interface Context {
  readonly env: Environment;
  readonly execCmd?: CommandSubstitutionFn;
  readonly homeFor?: HomeForFn;
}

const DEFAULT_IFS = ' \t\n';
const IFS_WHITESPACE = ' \t\n';
const GLOB_METACHARACTERS = /[*?[\]\\]/g;

function escapeGlob(text: string): string {
  return text.replace(GLOB_METACHARACTERS, '\\$&');
}

function fieldSeparators(env: Environment): string {
  return env.get('IFS') ?? DEFAULT_IFS;
}

function joinCharacter(env: Environment): string {
  const ifs = env.get('IFS');
  return ifs === undefined ? ' ' : ifs.slice(0, 1);
}

function expandTilde(source: string, ctx: Context): string {
  if (!source.startsWith('~')) return source;
  const slash = source.indexOf('/');
  const head = slash < 0 ? source : source.slice(0, slash);
  const tail = slash < 0 ? '' : source.slice(slash);
  const user = head.slice(1);
  const { env } = ctx;
  if (user === '') {
    const home = env.get('HOME');
    return home === undefined ? source : home + tail;
  }
  if (user === '+') return (env.get('PWD') ?? source) + (env.get('PWD') === undefined ? '' : tail);
  if (user === '-') return (env.get('OLDPWD') ?? source) + (env.get('OLDPWD') === undefined ? '' : tail);
  if (!/^[A-Za-z_][A-Za-z_0-9]*$/.test(user)) return source;
  const home = ctx.homeFor?.(user);
  return home == null ? source : home + tail;
}

function hostFor(ctx: Context): ParameterHost {
  return {
    env: ctx.env,
    arithmetic: (expression) => evaluateArithmetic(expression, ctx.env, ctx.execCmd),
    operand: (text) => expandOperand(text, ctx, false),
    pattern: (text) => expandOperand(text, ctx, true),
    option: (name) => isShellOptionEnabled(ctx.env, name),
  };
}

function commandOutput(command: string, ctx: Context): string {
  return ctx.execCmd === undefined ? '' : ctx.execCmd(command).replace(/\n+$/, '');
}

interface Scanned {
  readonly result: ParameterResult;
  readonly end: number;
}

function closingBrace(text: string, open: number): number {
  let depth = 0;
  for (let index = open; index < text.length; index++) {
    const character = text[index];
    if (character === '\\') { index++; continue; }
    if (character === "'" ) {
      const close = text.indexOf("'", index + 1);
      if (close < 0) return -1;
      index = close;
      continue;
    }
    if (character === '"') {
      index++;
      while (index < text.length && text[index] !== '"') index += text[index] === '\\' ? 2 : 1;
      continue;
    }
    if (character === '$' && text[index + 1] === '(') {
      const close = closingParenthesis(text, index + 1);
      if (close < 0) return -1;
      index = close;
      continue;
    }
    if (character === '{') depth++;
    else if (character === '}' && --depth === 0) return index;
  }
  return -1;
}

function closingParenthesis(text: string, open: number): number {
  let depth = 0;
  for (let index = open; index < text.length; index++) {
    const character = text[index];
    if (character === '\\') { index++; continue; }
    if (character === "'" || character === '"') {
      const quote = character;
      index++;
      while (index < text.length && text[index] !== quote) index += quote === '"' && text[index] === '\\' ? 2 : 1;
      continue;
    }
    if (character === '(') depth++;
    else if (character === ')' && --depth === 0) return index;
  }
  return -1;
}

function arithmeticEnd(text: string, open: number): number {
  let depth = 0;
  for (let index = open + 2; index < text.length; index++) {
    if (text[index] === '(') depth++;
    else if (text[index] === ')') {
      if (depth > 0) depth--;
      else return text[index + 1] === ')' ? index : -1;
    }
  }
  return -1;
}

function scanDollar(text: string, at: number, ctx: Context): Scanned | null {
  const next = text[at + 1];
  if (next === undefined) return null;
  if (next === '(' && text[at + 2] === '(') {
    const end = arithmeticEnd(text, at + 1);
    if (end >= 0) {
      const value = evaluateArithmetic(text.slice(at + 3, end), ctx.env, ctx.execCmd);
      return { result: { kind: 'text', text: value }, end: end + 2 };
    }
  }
  if (next === '(') {
    const close = closingParenthesis(text, at + 1);
    if (close < 0) return null;
    return { result: { kind: 'text', text: commandOutput(text.slice(at + 2, close), ctx) }, end: close + 1 };
  }
  if (next === '{') {
    const close = closingBrace(text, at + 1);
    if (close < 0) throw new BashRuntimeError(`${text.slice(at)}: bad substitution`);
    return { result: expandParameter(text.slice(at + 2, close), hostFor(ctx)), end: close + 1 };
  }
  const identifier = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(at + 1));
  if (identifier !== null) {
    return { result: expandParameter(identifier[0], hostFor(ctx)), end: at + 1 + identifier[0].length };
  }
  if (/[0-9]/.test(next) || '@*#?$!-'.includes(next)) {
    return { result: expandParameter(next, hostFor(ctx)), end: at + 2 };
  }
  return null;
}

function backtickEnd(text: string, open: number): number {
  for (let index = open + 1; index < text.length; index++) {
    if (text[index] === '\\') index++;
    else if (text[index] === '`') return index;
  }
  return -1;
}

function backtickCommand(raw: string): string {
  return raw.replace(/\\([$`\\])/g, '$1');
}

function listAsText(result: ParameterResult, env: Environment): string {
  if (result.kind === 'text') return result.text;
  return result.items.join(result.star ? joinCharacter(env) : ' ');
}

interface Sink {
  text(value: string): void;
  parameter(result: ParameterResult): void;
}

function walkDoubleQuoted(content: string, ctx: Context, sink: Sink): void {
  let literal = '';
  const flush = (): void => {
    if (literal !== '') sink.text(literal);
    literal = '';
  };
  for (let index = 0; index < content.length; index++) {
    const character = content[index];
    if (character === '\\' && index + 1 < content.length) {
      const next = content[index + 1];
      if ('$`"\\'.includes(next)) { literal += next; index++; continue; }
      if (next === '\n') { index++; continue; }
      literal += character;
      continue;
    }
    if (character === '$') {
      const scanned = scanDollar(content, index, ctx);
      if (scanned !== null) {
        flush();
        sink.parameter(scanned.result);
        index = scanned.end - 1;
        continue;
      }
    }
    if (character === '`') {
      const end = backtickEnd(content, index);
      if (end > 0) {
        flush();
        sink.text(commandOutput(backtickCommand(content.slice(index + 1, end)), ctx));
        index = end;
        continue;
      }
    }
    literal += character;
  }
  flush();
}

function expandOperand(text: string, ctx: Context, pattern: boolean): string {
  let out = '';
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === '\\' && index + 1 < text.length) {
      out += pattern ? `\\${text[index + 1]}` : text[index + 1];
      index++;
      continue;
    }
    if (character === "'") {
      const close = text.indexOf("'", index + 1);
      if (close > 0) {
        const quoted = text.slice(index + 1, close);
        out += pattern ? escapeGlob(quoted) : quoted;
        index = close;
        continue;
      }
    }
    if (character === '"') {
      let close = index + 1;
      while (close < text.length && text[close] !== '"') close += text[close] === '\\' ? 2 : 1;
      if (close < text.length) {
        let quoted = '';
        walkDoubleQuoted(text.slice(index + 1, close), ctx, {
          text: (value) => { quoted += value; },
          parameter: (result) => { quoted += listAsText(result, ctx.env); },
        });
        out += pattern ? escapeGlob(quoted) : quoted;
        index = close;
        continue;
      }
    }
    if (character === '$') {
      const scanned = scanDollar(text, index, ctx);
      if (scanned !== null) {
        out += listAsText(scanned.result, ctx.env);
        index = scanned.end - 1;
        continue;
      }
    }
    if (character === '`') {
      const end = backtickEnd(text, index);
      if (end > 0) {
        out += commandOutput(backtickCommand(text.slice(index + 1, end)), ctx);
        index = end;
        continue;
      }
    }
    if (character === '~' && index === 0) {
      const slash = text.indexOf('/');
      const head = slash < 0 ? text : text.slice(0, slash);
      const expanded = expandTilde(head, ctx);
      out += expanded;
      index = head.length - 1;
      continue;
    }
    out += character;
  }
  return out;
}

interface Segment {
  readonly text: string;
  readonly active: boolean;
}

interface Field {
  readonly segments: Segment[];
  keep: boolean;
}

class Fields {
  private readonly fields: Field[] = [];
  private current: Field | null = null;

  constructor(private readonly env: Environment, private readonly splitting: boolean) {}

  private open(): Field {
    if (this.current === null) {
      this.current = { segments: [], keep: false };
      this.fields.push(this.current);
    }
    return this.current;
  }

  private end(): void {
    this.current = null;
  }

  literal(text: string): void {
    if (text !== '') this.open().segments.push({ text, active: true });
  }

  quoted(text: string): void {
    const field = this.open();
    field.keep = true;
    if (text !== '') field.segments.push({ text, active: false });
  }

  quotedList(items: readonly string[]): void {
    if (!this.splitting) {
      this.quoted(items.join(' '));
      return;
    }
    items.forEach((item, index) => {
      if (index > 0) this.end();
      this.quoted(item);
    });
  }

  splittable(text: string): void {
    if (text === '') return;
    const separators = fieldSeparators(this.env);
    if (!this.splitting || separators === '') {
      this.literal(text);
      return;
    }
    const whitespace = (character: string): boolean => IFS_WHITESPACE.includes(character) && separators.includes(character);
    const separator = (character: string): boolean => separators.includes(character);
    let buffer = '';
    const flush = (): void => {
      this.literal(buffer);
      buffer = '';
    };
    for (let index = 0; index < text.length; index++) {
      const character = text[index];
      if (!separator(character)) {
        buffer += character;
        continue;
      }
      flush();
      let cursor = index;
      if (whitespace(character)) {
        while (cursor < text.length && whitespace(text[cursor])) cursor++;
        let delimited = false;
        if (cursor < text.length && separator(text[cursor]) && !whitespace(text[cursor])) {
          delimited = true;
          cursor++;
          while (cursor < text.length && whitespace(text[cursor])) cursor++;
        }
        if (this.current !== null) this.end();
        else if (delimited) this.emptyField();
      } else {
        cursor++;
        while (cursor < text.length && whitespace(text[cursor])) cursor++;
        if (this.current !== null) this.end();
        else this.emptyField();
      }
      index = cursor - 1;
    }
    flush();
  }

  private emptyField(): void {
    this.fields.push({ segments: [], keep: true });
  }

  splittableList(items: readonly string[]): void {
    items.forEach((item, index) => {
      if (index > 0) this.end();
      this.splittable(item);
    });
  }

  parameter(result: ParameterResult, quoted: boolean): void {
    if (result.kind === 'text') {
      if (quoted) this.quoted(result.text);
      else this.splittable(result.text);
      return;
    }
    if (!result.star) {
      if (quoted) this.quotedList(result.items);
      else this.splittableList(result.items);
      return;
    }
    const joined = result.items.join(joinCharacter(this.env));
    if (quoted) this.quoted(joined);
    else this.splittable(joined);
  }

  words(): Field[] {
    return this.fields.filter((field) => field.keep || field.segments.length > 0);
  }

  text(): string {
    return this.fields.map((field) => field.segments.map((segment) => segment.text).join('')).join('');
  }

  pattern(): string {
    return this.fields.map(globPattern).join('');
  }
}

function variableBody(name: string, modifier: string | undefined): string {
  return modifier === '#' ? `#${name}` : name + (modifier ?? '');
}

function addLiteral(raw: string, fields: Fields): void {
  let run = '';
  for (let index = 0; index < raw.length; index++) {
    if (raw[index] === '\\' && index + 1 < raw.length) {
      if (run !== '') fields.literal(run);
      run = '';
      fields.quoted(raw[index + 1]);
      index++;
      continue;
    }
    run += raw[index];
  }
  if (run !== '') fields.literal(run);
}

function doubleQuotedText(word: Extract<Word, { type: 'DoubleQuotedWord' }>, ctx: Context, fields: Fields): void {
  fields.quoted('');
  for (const part of word.parts) {
    const sink: Sink = {
      text: (value) => fields.quoted(value),
      parameter: (result) => fields.parameter(result, true),
    };
    switch (part.type) {
      case 'text':
        walkDoubleQuoted(part.value, ctx, sink);
        break;
      case 'variable':
        sink.parameter(expandParameter(variableBody(part.name, part.modifier), hostFor(ctx)));
        break;
      case 'special':
        sink.parameter(expandParameter(part.name, hostFor(ctx)));
        break;
      case 'command':
        sink.text(commandOutput(part.command, ctx));
        break;
      case 'arithmetic':
        sink.text(evaluateArithmetic(part.expression, ctx.env, ctx.execCmd));
        break;
    }
  }
}

function addWord(word: Word, ctx: Context, fields: Fields, leading: boolean): void {
  switch (word.type) {
    case 'LiteralWord': {
      const raw = leading && word.value.startsWith('~') ? expandTilde(word.value, ctx) : word.value;
      addLiteral(raw, fields);
      return;
    }
    case 'SingleQuotedWord':
      fields.quoted(word.value);
      return;
    case 'DoubleQuotedWord':
      doubleQuotedText(word, ctx, fields);
      return;
    case 'VariableRef':
      fields.parameter(expandParameter(variableBody(word.name, word.modifier), hostFor(ctx)), false);
      return;
    case 'CommandSubstitution':
      fields.splittable(commandOutput(word.command, ctx));
      return;
    case 'ArithmeticSubstitution':
      fields.splittable(evaluateArithmetic(word.expression, ctx.env, ctx.execCmd));
      return;
    case 'CompoundWord':
      word.parts.forEach((part, index) => addWord(part, ctx, fields, leading && index === 0));
      return;
    default:
      return;
  }
}

export function expandWord(
  word: Word,
  env: Environment,
  execCmd?: CommandSubstitutionFn,
  homeFor?: HomeForFn,
): string {
  const fields = new Fields(env, false);
  addWord(word, { env, execCmd, homeFor }, fields, true);
  return fields.text();
}

export function expandPattern(
  word: Word,
  env: Environment,
  execCmd?: CommandSubstitutionFn,
  homeFor?: HomeForFn,
): string {
  const fields = new Fields(env, false);
  addWord(word, { env, execCmd, homeFor }, fields, true);
  return fields.pattern();
}

type Atom = { readonly kind: 'char'; readonly character: string } | { readonly kind: 'raw'; readonly text: string } | { readonly kind: 'part'; readonly word: Word };

function toAtoms(word: Word): Atom[] {
  if (word.type === 'CompoundWord') return word.parts.flatMap(toAtoms);
  if (word.type !== 'LiteralWord') return [{ kind: 'part', word }];
  const atoms: Atom[] = [];
  for (let index = 0; index < word.value.length; index++) {
    if (word.value[index] === '\\' && index + 1 < word.value.length) {
      atoms.push({ kind: 'raw', text: word.value.slice(index, index + 2) });
      index++;
    } else {
      atoms.push({ kind: 'char', character: word.value[index] });
    }
  }
  return atoms;
}

function fromAtoms(atoms: readonly Atom[]): Word {
  const parts: Word[] = [];
  let run = '';
  const flush = (): void => {
    if (run !== '') parts.push({ type: 'LiteralWord', value: run });
    run = '';
  };
  for (const atom of atoms) {
    if (atom.kind === 'char') run += atom.character;
    else if (atom.kind === 'raw') run += atom.text;
    else { flush(); parts.push(atom.word); }
  }
  flush();
  if (parts.length === 0) return { type: 'LiteralWord', value: '' };
  return parts.length === 1 ? parts[0] : { type: 'CompoundWord', parts };
}

const isChar = (atom: Atom, character: string): boolean => atom.kind === 'char' && atom.character === character;

function sequenceItems(body: string): string[] | null {
  const numeric = /^(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?$/.exec(body);
  if (numeric !== null) {
    const [, from, to, stepText] = numeric;
    const width = (/^-?0\d/.test(from) || /^-?0\d/.test(to)) ? Math.max(from.replace('-', '').length, to.replace('-', '').length) : 0;
    const start = Number(from);
    const finish = Number(to);
    let step = Math.abs(Number(stepText ?? '1')) || 1;
    step = start <= finish ? step : -step;
    const items: string[] = [];
    for (let value = start; step > 0 ? value <= finish : value >= finish; value += step) {
      const digits = String(Math.abs(value)).padStart(width, '0');
      items.push(value < 0 ? `-${digits}` : digits);
    }
    return items;
  }
  const letters = /^([A-Za-z])\.\.([A-Za-z])(?:\.\.(-?\d+))?$/.exec(body);
  if (letters !== null) {
    const start = letters[1].charCodeAt(0);
    const finish = letters[2].charCodeAt(0);
    let step = Math.abs(Number(letters[3] ?? '1')) || 1;
    step = start <= finish ? step : -step;
    const items: string[] = [];
    for (let code = start; step > 0 ? code <= finish : code >= finish; code += step) items.push(String.fromCharCode(code));
    return items;
  }
  return null;
}

function braceExpand(atoms: readonly Atom[]): Atom[][] {
  for (let open = 0; open < atoms.length; open++) {
    if (!isChar(atoms[open], '{') || (open > 0 && isChar(atoms[open - 1], '$'))) continue;
    let depth = 0;
    let close = -1;
    const commas: number[] = [];
    for (let index = open; index < atoms.length; index++) {
      if (isChar(atoms[index], '{')) depth++;
      else if (isChar(atoms[index], '}') && --depth === 0) { close = index; break; }
      else if (isChar(atoms[index], ',') && depth === 1) commas.push(index);
    }
    if (close < 0) continue;
    const prefix = atoms.slice(0, open);
    const suffix = atoms.slice(close + 1);
    let alternatives: Atom[][] | null = null;
    if (commas.length > 0) {
      const bounds = [open, ...commas, close];
      alternatives = bounds.slice(0, -1).map((from, index) => [...atoms.slice(from + 1, bounds[index + 1])]);
    } else {
      const body = atoms.slice(open + 1, close);
      if (body.every((atom) => atom.kind === 'char')) {
        const items = sequenceItems(body.map((atom) => (atom as { character: string }).character).join(''));
        if (items !== null) alternatives = items.map((item) => [...item].map((character): Atom => ({ kind: 'char', character })));
      }
    }
    if (alternatives === null) continue;
    const results: Atom[][] = [];
    for (const alternative of alternatives) {
      for (const inner of braceExpand(alternative)) {
        for (const tail of braceExpand(suffix)) results.push([...prefix, ...inner, ...tail]);
      }
    }
    return results;
  }
  return [[...atoms]];
}

function braceAlternatives(word: Word, env: Environment): Word[] {
  const atoms = toAtoms(word);
  if (!atoms.some((atom) => isChar(atom, '{'))) return [word];
  const expanded = braceExpand(atoms);
  return expanded.length === 1 && expanded[0].length === atoms.length ? [word] : expanded.map(fromAtoms);
}

function globPattern(field: Field): string {
  return field.segments.map((segment) => (segment.active ? segment.text : escapeGlob(segment.text))).join('');
}

function plainText(field: Field): string {
  return field.segments.map((segment) => segment.text).join('');
}

function unescapedGlob(pattern: string): string {
  return pattern.replace(/\\(.)/gs, '$1');
}

function globOptions(env: Environment): GlobOptions {
  return {
    dotglob: isShellOptionEnabled(env, 'dotglob'),
    nocaseglob: isShellOptionEnabled(env, 'nocaseglob'),
    globstar: isShellOptionEnabled(env, 'globstar'),
  };
}

function globField(field: Field, env: Environment, glob: GlobFn | undefined): string[] {
  const text = plainText(field);
  if (glob === undefined || isShellOptionEnabled(env, 'noglob')) return [text];
  const pattern = globPattern(field);
  if (!hasMagic(pattern)) return [text];
  const hits = glob(pattern, globOptions(env));
  if (hits === null) return [text];
  if (hits.length > 0) return hits;
  if (isShellOptionEnabled(env, 'failglob')) throw new BashRuntimeError(`no match: ${unescapedGlob(pattern)}`);
  return isShellOptionEnabled(env, 'nullglob') ? [] : [text];
}

export function expandWords(
  words: Word[],
  env: Environment,
  execCmd?: CommandSubstitutionFn,
  glob?: GlobFn,
  homeFor?: HomeForFn,
): string[] {
  const ctx: Context = { env, execCmd, homeFor };
  const result: string[] = [];
  for (const word of words) {
    for (const alternative of braceAlternatives(word, env)) {
      const fields = new Fields(env, true);
      addWord(alternative, ctx, fields, true);
      for (const field of fields.words()) result.push(...globField(field, env, glob));
    }
  }
  return result;
}

export function evaluateArithmetic(expr: string, env: Environment, execCmd?: CommandSubstitutionFn): string {
  const ctx: Context = { env, execCmd };
  const expanded = expr.includes('$') || expr.includes('`') ? expandOperand(expr, ctx, false) : expr;
  return String(evaluateArithmeticExpression(expanded, env));
}
