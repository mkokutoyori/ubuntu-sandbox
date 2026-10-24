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

export type ConfigHandler = (value: string, at: ConfigPosition, warn: (text: string, priority?: number) => void) => void;

export interface ConfigSpec {
  readonly mainFile: string;
  readonly dropInName: string;
  readonly sections: readonly string[];
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

class FileParser {
  private section: string | null = null;
  private sectionIgnored = false;
  private continuation: string | null = null;

  constructor(private readonly file: string, private readonly spec: ConfigSpec, private readonly out: ConfigDiagnostic[]) {}

  private diagnostic(line: number, priority: number, message: string): void {
    this.out.push({ priority, file: this.file, line, message: `${this.file}:${line}: ${message}` });
  }

  parse(text: string): void {
    const physical = text.split('\n');
    if (physical[physical.length - 1] === '') physical.pop();
    let bomSeen = false;
    let lastLine = 0;
    physical.forEach((buffer, index) => {
      lastLine = index + 1;
      const line = index + 1;
      const trimmed = buffer.replace(/^[ \t\n\r]+/, '');
      if (trimmed !== '' && COMMENTS.includes(trimmed[0])) return;
      let current = buffer;
      if (!bomSeen && current.startsWith(BYTE_ORDER_MARK)) {
        current = current.slice(1);
        bomSeen = true;
      }
      const joined = this.continuation === null ? current : this.continuation + current;
      let escaped = false;
      for (const character of joined) escaped = escaped ? false : character === '\\';
      if (escaped) {
        this.continuation = `${joined.slice(0, -1)} `;
        return;
      }
      this.continuation = null;
      this.parseLine(line, joined);
    });
    if (this.continuation !== null) this.parseLine(lastLine, this.continuation);
  }

  private parseLine(line: number, raw: string): void {
    const text = raw.trim();
    if (text === '') return;
    if (text.startsWith('[')) {
      if (!text.endsWith(']')) {
        this.diagnostic(line, LOG_ERR, `Invalid section header '${text}'`);
        return;
      }
      const name = text.slice(1, -1);
      if (!this.spec.sections.includes(name)) {
        if (!name.startsWith('X-')) this.diagnostic(line, LOG_WARNING, `Unknown section '${name}'. Ignoring.`);
        this.section = null;
        this.sectionIgnored = true;
      } else {
        this.section = name;
        this.sectionIgnored = false;
      }
      return;
    }
    if (this.section === null) {
      if (!this.sectionIgnored) this.diagnostic(line, LOG_WARNING, 'Assignment outside of section. Ignoring.');
      return;
    }
    const equals = text.indexOf('=');
    if (equals < 0) {
      this.diagnostic(line, LOG_WARNING, "Missing '=', ignoring line.");
      return;
    }
    if (equals === 0) {
      this.diagnostic(line, LOG_WARNING, "Missing key name before '=', ignoring line.");
      return;
    }
    const key = text.slice(0, equals).trim();
    const value = text.slice(equals + 1).trim();
    const handler = this.spec.handlers.get(`${this.section}.${key}`);
    if (handler === undefined) {
      if (!key.startsWith('X-')) this.diagnostic(line, LOG_WARNING, `Unknown key name '${key}' in section '${this.section}', ignoring.`);
      return;
    }
    handler(value, { file: this.file, line, section: this.section, key }, (message, priority = LOG_WARNING) => this.diagnostic(line, priority, message));
  }
}

export function readSystemdConfig(source: ConfigSource, spec: ConfigSpec): ConfigDiagnostic[] {
  const diagnostics: ConfigDiagnostic[] = [];
  const main = source.readFile(spec.mainFile);
  if (main !== null) new FileParser(spec.mainFile, spec, diagnostics).parse(main);
  const chosen = new Map<string, string>();
  for (const root of DROP_IN_ROOTS) {
    const directory = `${root}/${spec.dropInName}`;
    for (const entry of source.listDirectory(directory) ?? []) {
      if (!entry.name.endsWith('.conf') || chosen.has(entry.name)) continue;
      chosen.set(entry.name, `${directory}/${entry.name}`);
    }
  }
  for (const name of [...chosen.keys()].sort()) {
    const path = chosen.get(name) as string;
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
