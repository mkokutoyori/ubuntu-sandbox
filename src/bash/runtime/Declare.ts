import type { Command } from '@/bash/parser/ASTNode';
import { functionDefinition } from '@/bash/interpreter/Unparse';
import type { Environment, VariableAttributes, VariableDescription, VariableKind } from './Environment';

export type DeclarationCommand = 'declare' | 'typeset' | 'local' | 'readonly' | 'export';

export interface DeclarationFlags {
  kind?: VariableKind;
  set: Partial<VariableAttributes>;
  clear: Partial<VariableAttributes>;
  global: boolean;
  print: boolean;
  functions: boolean;
  functionNames: boolean;
  nameref: boolean;
  invalid: string | null;
  names: string[];
}

export interface DeclareResult {
  output: string;
  stderr: string;
  exitCode: number;
}

const ATTRIBUTE_LETTERS: Readonly<Record<string, keyof VariableAttributes>> = {
  i: 'integer', l: 'lowercase', u: 'uppercase', c: 'capitalize', r: 'readonly', x: 'exported', t: 'trace',
};

const LISTING_ORDER = ['a', 'A', 'f', 'i', 'n', 'r', 't', 'x', 'c', 'l', 'u'] as const;

export function parseDeclarationFlags(args: readonly string[], command: DeclarationCommand): DeclarationFlags {
  const flags: DeclarationFlags = {
    set: {}, clear: {}, global: false, print: false, functions: false, functionNames: false, nameref: false, invalid: null, names: [],
  };
  if (command === 'readonly') flags.set.readonly = true;
  if (command === 'export') flags.set.exported = true;
  let parsing = true;
  for (const arg of args) {
    if (!parsing || !/^[-+]./.test(arg)) {
      flags.names.push(arg);
      continue;
    }
    if (arg === '--') { parsing = false; continue; }
    const enable = arg[0] === '-';
    for (const letter of arg.slice(1)) {
      if (letter === 'a') flags.kind = 'indexed';
      else if (letter === 'A') flags.kind = 'associative';
      else if (letter === 'g') flags.global = true;
      else if (letter === 'p') flags.print = true;
      else if (letter === 'f') flags.functions = true;
      else if (letter === 'F') { flags.functions = true; flags.functionNames = true; }
      else if (letter === 'n' && command === 'export') flags.clear.exported = false;
      else if (letter === 'n') flags.nameref = enable;
      else if (letter === 'I') continue;
      else if (letter in ATTRIBUTE_LETTERS) (enable ? flags.set : flags.clear)[ATTRIBUTE_LETTERS[letter]] = enable ? true : false;
      else if (flags.invalid === null) flags.invalid = arg;
    }
  }
  return flags;
}

function quoteValue(value: string): string {
  if (/[\x00-\x08\x0a-\x1f\x7f]/.test(value)) {
    const escaped = value.replace(/[\\']/g, (c) => `\\${c}`).replace(/\n/g, '\\n').replace(/\t/g, '\\t').replace(/\r/g, '\\r')
      .replace(/[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f]/g, (c) => `\\${c.charCodeAt(0).toString(8).padStart(3, '0')}`);
    return `$'${escaped}'`;
  }
  return `"${value.replace(/[\\"$`]/g, (c) => `\\${c}`)}"`;
}

function keyText(key: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(key) ? key : quoteValue(key);
}

function letters(description: VariableDescription): string {
  const present = new Set<string>();
  if (description.kind === 'indexed') present.add('a');
  if (description.kind === 'associative') present.add('A');
  if (description.nameref !== undefined) present.add('n');
  for (const [letter, attribute] of Object.entries(ATTRIBUTE_LETTERS)) if (description.attributes[attribute]) present.add(letter);
  return LISTING_ORDER.filter((letter) => present.has(letter)).join('');
}

export function declarationLine(description: VariableDescription): string {
  const flags = letters(description);
  const head = `declare -${flags === '' ? '-' : flags} ${description.name}`;
  if (description.nameref !== undefined) return `${head}=${quoteValue(description.nameref)}`;
  if (description.kind === 'indexed') {
    if (description.indexed.length === 0) return head;
    return `${head}=(${description.indexed.map(([index, value]) => `[${index}]=${quoteValue(value)}`).join(' ')})`;
  }
  if (description.kind === 'associative') {
    if (description.associative.length === 0) return head;
    return `${head}=(${description.associative.map(([key, value]) => `[${keyText(key)}]=${quoteValue(value)} `).join('')})`;
  }
  return description.value === undefined ? head : `${head}=${quoteValue(description.value)}`;
}

function setStyle(description: VariableDescription): string {
  const plain = (value: string): string => (/^[A-Za-z0-9_@%+=:,./-]*$/.test(value) ? value : /[\x00-\x1f\x7f]/.test(value) ? quoteValue(value) : `'${value.replace(/'/g, `'\\''`)}'`);
  if (description.kind === 'indexed') return `${description.name}=(${description.indexed.map(([index, value]) => `[${index}]=${quoteValue(value)}`).join(' ')})`;
  if (description.kind === 'associative') return `${description.name}=(${description.associative.map(([key, value]) => `[${keyText(key)}]=${quoteValue(value)} `).join('')})`;
  return `${description.name}=${plain(description.value ?? '')}`;
}

function selected(description: VariableDescription, flags: DeclarationFlags): boolean {
  if (flags.kind === 'indexed' && description.kind !== 'indexed') return false;
  if (flags.kind === 'associative' && description.kind !== 'associative') return false;
  for (const [attribute, on] of Object.entries(flags.set) as Array<[keyof VariableAttributes, boolean]>) {
    if (on && !description.attributes[attribute]) return false;
  }
  return true;
}

function listVariables(env: Environment, flags: DeclarationFlags, style: 'declare' | 'set'): string {
  const lines: string[] = [];
  for (const name of env.visibleNames()) {
    const description = env.describe(name);
    if (description === undefined) continue;
    if (description.value === undefined && description.kind === 'scalar' && description.nameref === undefined && !hasAttributes(description)) continue;
    if (!selected(description, flags)) continue;
    lines.push(style === 'declare' ? declarationLine(description) : setStyle(description));
  }
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

function hasAttributes(description: VariableDescription): boolean {
  return Object.values(description.attributes).some(Boolean);
}

function functionListing(functions: ReadonlyMap<string, Command>, flags: DeclarationFlags, names: readonly string[]): DeclareResult {
  let output = '';
  let exitCode = 0;
  const targets = names.length > 0 ? [...names] : [...functions.keys()].sort();
  for (const name of targets) {
    const body = functions.get(name);
    if (body === undefined) {
      exitCode = 1;
      continue;
    }
    output += flags.functionNames ? (names.length > 0 ? `${name}\n` : `declare -f ${name}\n`) : functionDefinition(name, body);
  }
  return { output, stderr: '', exitCode };
}

export function runDeclaration(
  command: DeclarationCommand,
  args: readonly string[],
  env: Environment,
  functions: ReadonlyMap<string, Command>,
): DeclareResult {
  const flags = parseDeclarationFlags(args, command);
  const prefix = `bash: ${command}`;
  if (flags.invalid !== null) {
    return { output: '', stderr: `${prefix}: ${flags.invalid}: invalid option\n${command}: usage: ${command} [-aAfFgilnrtux] [-p] [name[=value] ...]\n`, exitCode: 2 };
  }
  if (command === 'local' && env.getParent() === null) {
    return { output: '', stderr: `${prefix}: can only be used in a function\n`, exitCode: 1 };
  }
  if (flags.functions && command === 'export') return { output: '', stderr: '', exitCode: flags.names.every((name) => functions.has(name)) ? 0 : 1 };
  if (flags.functions) return functionListing(functions, flags, flags.names);
  const printing = flags.print || (flags.names.length === 0 && (command === 'readonly' || command === 'export'));
  if (flags.names.length === 0) {
    if (printing) return { output: listVariables(env, flags, 'declare'), stderr: '', exitCode: 0 };
    if (command === 'declare' || command === 'typeset') {
      return { output: listVariables(env, flags, 'set'), stderr: '', exitCode: 0 };
    }
    return { output: '', stderr: '', exitCode: 0 };
  }
  let output = '';
  let stderr = '';
  let exitCode = 0;
  for (const argument of flags.names) {
    const separator = argument.indexOf('=');
    const append = separator > 0 && argument[separator - 1] === '+';
    const name = separator < 0 ? argument : argument.slice(0, append ? separator - 1 : separator);
    const base = /^([A-Za-z_][A-Za-z0-9_]*)(\[.*\])?$/.exec(name);
    if (base === null) {
      stderr += `${prefix}: \`${argument}': not a valid identifier\n`;
      exitCode = 1;
      continue;
    }
    if (flags.print && separator < 0) {
      const description = env.describe(name);
      if (description === undefined) {
        stderr += `${prefix}: ${name}: not found\n`;
        exitCode = 1;
      } else {
        output += `${declarationLine(description)}\n`;
      }
      continue;
    }
    try {
      const local = command === 'local' || ((command === 'declare' || command === 'typeset') && env.getParent() !== null && !flags.global);
      const attributes = { ...flags.set, ...flags.clear };
      const readonlyNow = attributes.readonly === true;
      const deferred = readonlyNow && separator >= 0;
      if (deferred) delete attributes.readonly;
      env.declare(base[1], flags.kind, attributes, local);
      if (flags.nameref && separator >= 0) {
        env.declareNameref(base[1], argument.slice(separator + 1));
        continue;
      }
      if (separator >= 0) {
        const value = argument.slice(separator + 1);
        if (append) env.appendScalar(base[1], value);
        else env.set(base[1], value);
      }
      if (deferred) env.declare(base[1], undefined, { readonly: true }, false);
    } catch (e) {
      stderr += `${e instanceof Error ? e.message.replace(/^bash: /, `${prefix}: `) : String(e)}\n`;
      exitCode = 1;
    }
  }
  return { output, stderr, exitCode };
}
