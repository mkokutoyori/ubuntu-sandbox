import { parseSec } from './SystemdTime';
import { parseSize } from './ParseSize';

export interface ConfigSource {
  readFile(path: string): string | null;
  listDirectory(path: string): ReadonlyArray<{ readonly name: string }> | null;
}

export interface ConfigDiagnostic {
  readonly priority: number;
  readonly file: string;
  readonly line: number;
  readonly message: string;
}

export interface ConfigPosition {
  readonly file: string;
  readonly line: number;
  readonly section: string;
  readonly key: string;
}

export type ConfigWarn = (text: string, priority?: number, located?: boolean) => void;

export type ConfigHandler = (value: string, at: ConfigPosition, warn: ConfigWarn) => void;

export interface ConfigSpec {
  readonly mainFile: string;
  readonly dropInName: string;
  readonly sections: readonly string[];
  readonly ignoredSections?: readonly string[];
  readonly knownKeys?: ReadonlySet<string>;
  readonly handlers: ReadonlyMap<string, ConfigHandler>;
}

const LOG_ERR = 3;
const LOG_WARNING = 4;
const DROP_IN_ROOTS = ['/etc/systemd', '/run/systemd', '/usr/local/lib/systemd', '/usr/lib/systemd'] as const;
const BOOLEAN_TRUE = new Set(['1', 'yes', 'y', 'true', 't', 'on']);
const BOOLEAN_FALSE = new Set(['0', 'no', 'n', 'false', 'f', 'off']);
const COMMENTS = '#;';
const BYTE_ORDER_MARK = '﻿';

export function parseBoolean(text: string): boolean | null {
  const lower = text.toLowerCase();
  if (BOOLEAN_TRUE.has(lower)) return true;
  if (BOOLEAN_FALSE.has(lower)) return false;
  return null;
}

interface LogicalLine {
  readonly line: number;
  readonly text: string;
}

export function logicalLines(text: string): LogicalLine[] {
  const physical = text.split('\n');
  if (physical[physical.length - 1] === '') physical.pop();
  const out: LogicalLine[] = [];
  let bomSeen = false;
  let continuation: string | null = null;
  let lastLine = 0;
  physical.forEach((buffer, index) => {
    lastLine = index + 1;
    const trimmed = buffer.replace(/^[ \t\n\r]+/, '');
    if (trimmed !== '' && COMMENTS.includes(trimmed[0])) return;
    let current = buffer;
    if (!bomSeen && current.startsWith(BYTE_ORDER_MARK)) {
      current = current.slice(1);
      bomSeen = true;
    }
    const joined = continuation === null ? current : continuation + current;
    let escaped = false;
    for (const character of joined) escaped = escaped ? false : character === '\\';
    if (escaped) {
      continuation = `${joined.slice(0, -1)} `;
      return;
    }
    continuation = null;
    out.push({ line: index + 1, text: joined });
  });
  if (continuation !== null) out.push({ line: lastLine, text: continuation });
  return out;
}

type LineKind =
  | { kind: 'empty' }
  | { kind: 'section'; name: string }
  | { kind: 'invalid-section'; text: string }
  | { kind: 'assignment'; key: string; value: string }
  | { kind: 'missing-equals' }
  | { kind: 'missing-key' };

function classifyLine(raw: string): LineKind {
  const text = raw.trim();
  if (text === '') return { kind: 'empty' };
  if (text.startsWith('[')) return text.endsWith(']') ? { kind: 'section', name: text.slice(1, -1) } : { kind: 'invalid-section', text };
  const equals = text.indexOf('=');
  if (equals < 0) return { kind: 'missing-equals' };
  if (equals === 0) return { kind: 'missing-key' };
  return { kind: 'assignment', key: text.slice(0, equals).trim(), value: text.slice(equals + 1).trim() };
}

class FileParser {
  private section: string | null = null;
  private sectionIgnored = false;

  constructor(private readonly file: string, private readonly spec: ConfigSpec, private readonly out: ConfigDiagnostic[]) {}

  private diagnostic(line: number, priority: number, message: string, located = true): void {
    this.out.push({ priority, file: this.file, line, message: located ? `${this.file}:${line}: ${message}` : message });
  }

  parse(text: string): void {
    for (const { line, text: content } of logicalLines(text)) this.parseLine(line, content);
  }

  private parseLine(line: number, raw: string): void {
    const parsed = classifyLine(raw);
    if (parsed.kind === 'empty') return;
    if (parsed.kind === 'invalid-section') {
      this.diagnostic(line, LOG_ERR, `Invalid section header '${parsed.text}'`);
      return;
    }
    if (parsed.kind === 'section') {
      if (!this.spec.sections.includes(parsed.name)) {
        if (!parsed.name.startsWith('X-') && this.spec.ignoredSections?.includes(parsed.name) !== true) this.diagnostic(line, LOG_WARNING, `Unknown section '${parsed.name}'. Ignoring.`);
        this.section = null;
        this.sectionIgnored = true;
      } else {
        this.section = parsed.name;
        this.sectionIgnored = false;
      }
      return;
    }
    if (this.section === null) {
      if (!this.sectionIgnored) this.diagnostic(line, LOG_WARNING, 'Assignment outside of section. Ignoring.');
      return;
    }
    if (parsed.kind === 'missing-equals') {
      this.diagnostic(line, LOG_WARNING, "Missing '=', ignoring line.");
      return;
    }
    if (parsed.kind === 'missing-key') {
      this.diagnostic(line, LOG_WARNING, "Missing key name before '=', ignoring line.");
      return;
    }
    const { key, value } = parsed;
    const handler = this.spec.handlers.get(`${this.section}.${key}`);
    if (handler === undefined) {
      if (this.spec.knownKeys?.has(`${this.section}.${key}`) === true) return;
      if (!key.startsWith('X-')) this.diagnostic(line, LOG_WARNING, `Unknown key name '${key}' in section '${this.section}', ignoring.`);
      return;
    }
    handler(value, { file: this.file, line, section: this.section, key }, (message, priority = LOG_WARNING, located = true) => this.diagnostic(line, priority, message, located));
  }
}

export interface Assignment {
  readonly section: string;
  readonly key: string;
  readonly value: string;
  readonly line: number;
}

export function assignmentsOf(text: string): Assignment[] {
  const out: Assignment[] = [];
  let section: string | null = null;
  for (const { line, text: content } of logicalLines(text)) {
    const parsed = classifyLine(content);
    if (parsed.kind === 'section') section = parsed.name;
    else if (parsed.kind === 'assignment' && section !== null) out.push({ section, key: parsed.key, value: parsed.value, line });
  }
  return out;
}

export type UnitBag = Map<string, Map<string, string[]>>;

export interface UnitBagOptions {
  readonly lowerCaseSections?: boolean;
  readonly lowerCaseKeys?: boolean;
}

export function addToUnitBag(bag: UnitBag, file: string, text: string, options: UnitBagOptions = {}, diagnostics: ConfigDiagnostic[] = []): void {
  let current: Map<string, string[]> | null = null;
  const note = (line: number, priority: number, message: string): void => {
    diagnostics.push({ priority, file, line, message: `${file}:${line}: ${message}` });
  };
  for (const { line, text: content } of logicalLines(text)) {
    const parsed = classifyLine(content);
    if (parsed.kind === 'empty') continue;
    if (parsed.kind === 'invalid-section') {
      note(line, LOG_ERR, `Invalid section header '${parsed.text}'`);
      continue;
    }
    if (parsed.kind === 'section') {
      const name = options.lowerCaseSections === true ? parsed.name.trim().toLowerCase() : parsed.name.trim();
      current = bag.get(name) ?? new Map<string, string[]>();
      bag.set(name, current);
      continue;
    }
    if (current === null) {
      note(line, LOG_WARNING, 'Assignment outside of section. Ignoring.');
      continue;
    }
    if (parsed.kind === 'missing-equals') {
      note(line, LOG_WARNING, "Missing '=', ignoring line.");
      continue;
    }
    if (parsed.kind === 'missing-key') {
      note(line, LOG_WARNING, "Missing key name before '=', ignoring line.");
      continue;
    }
    const key = options.lowerCaseKeys === true ? parsed.key.toLowerCase() : parsed.key;
    const bucket = current.get(key) ?? [];
    bucket.push(parsed.value);
    current.set(key, bucket);
  }
}

export function parseUnitBag(file: string, text: string, options: UnitBagOptions = {}, diagnostics: ConfigDiagnostic[] = []): UnitBag {
  const bag: UnitBag = new Map();
  addToUnitBag(bag, file, text, options, diagnostics);
  return bag;
}

export function discoverDropIns(source: ConfigSource, directories: readonly string[]): Array<{ name: string; path: string }> {
  const chosen = new Map<string, string>();
  for (const directory of directories) {
    for (const entry of source.listDirectory(directory) ?? []) {
      if (!entry.name.endsWith('.conf') || chosen.has(entry.name)) continue;
      chosen.set(entry.name, `${directory}/${entry.name}`);
    }
  }
  return [...chosen.keys()].sort().map((name) => ({ name, path: chosen.get(name) as string }));
}

export function readSystemdConfig(source: ConfigSource, spec: ConfigSpec): ConfigDiagnostic[] {
  const diagnostics: ConfigDiagnostic[] = [];
  const main = source.readFile(spec.mainFile);
  if (main !== null) new FileParser(spec.mainFile, spec, diagnostics).parse(main);
  for (const { path } of discoverDropIns(source, DROP_IN_ROOTS.map((root) => `${root}/${spec.dropInName}`))) {
    const text = source.readFile(path);
    if (text !== null) new FileParser(path, spec, diagnostics).parse(text);
  }
  return diagnostics;
}

export function booleanHandler(apply: (value: boolean) => void): ConfigHandler {
  return (value, _at, warn) => {
    const parsed = parseBoolean(value);
    if (parsed === null) warn(`Failed to parse boolean value, ignoring: ${value}`);
    else apply(parsed);
  };
}

export function tristateHandler(apply: (value: boolean | null) => void): ConfigHandler {
  return (value, at, warn) => {
    if (value === '') {
      apply(null);
      return;
    }
    const parsed = parseBoolean(value);
    if (parsed === null) warn(`Failed to parse boolean value for ${at.key}=, ignoring: ${value}`);
    else apply(parsed);
  };
}

export function secHandler(apply: (usec: number) => void): ConfigHandler {
  return (value, _at, warn) => {
    const parsed = parseSec(value);
    if (parsed.ok) apply(parsed.usec);
    else warn(`Failed to parse sec value, ignoring: ${value}`);
  };
}

export function unsignedHandler(apply: (value: number) => void): ConfigHandler {
  return (value, _at, warn) => {
    if (/^\s*\+?\d+$/.test(value) && Number(value) <= 0xffffffff) apply(Number(value));
    else warn(`Failed to parse unsigned value, ignoring: ${value}`);
  };
}

export function uint64Handler(apply: (value: number) => void): ConfigHandler {
  return (value, _at, warn) => {
    if (/^\s*\+?\d+$/.test(value) && Number.isSafeInteger(Number(value))) apply(Number(value));
    else warn(`Failed to parse uint64 value, ignoring: ${value}`);
  };
}

export function iecUint64Handler(apply: (bytes: number) => void): ConfigHandler {
  return (value, _at, warn) => {
    const parsed = parseSize(value, 1024);
    if (parsed === null) warn(`Failed to parse size value, ignoring: ${value}`);
    else apply(parsed);
  };
}

export function absolutePathHandler(apply: (path: string | null) => void): ConfigHandler {
  return (value, at, warn) => {
    if (value === '') {
      apply(null);
      return;
    }
    if (!value.startsWith('/')) {
      warn(`${at.key}= path is not absolute, ignoring: ${value}`);
      return;
    }
    apply(value.replace(/\/+/g, '/').replace(/(.)\/$/, '$1'));
  };
}

export function enumHandler<T extends string>(names: readonly T[], failure: string, apply: (value: T) => void): ConfigHandler {
  return (value, _at, warn) => {
    if ((names as readonly string[]).includes(value)) apply(value as T);
    else warn(`${failure}, ignoring: ${value}`);
  };
}
