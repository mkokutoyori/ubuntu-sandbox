export interface ConfigSource {
  readFile(path: string): string | null;
  listDirectory(path: string): ReadonlyArray<{ readonly name: string }> | null;
}

export interface ConfigAssignment {
  readonly file: string;
  readonly line: number;
  readonly section: string;
  readonly key: string;
  readonly value: string;
}

export interface ConfigSpec {
  readonly mainFile: string;
  readonly dropInName: string;
  readonly sections: Readonly<Record<string, readonly string[]>>;
}

export interface ConfigReadout {
  readonly assignments: ConfigAssignment[];
  readonly diagnostics: string[];
}

const DROP_IN_DIRECTORIES = [
  '/etc/systemd',
  '/run/systemd',
  '/usr/local/lib/systemd',
  '/usr/lib/systemd',
] as const;

const BOOLEAN_TRUE = new Set(['1', 'yes', 'y', 'true', 't', 'on']);
const BOOLEAN_FALSE = new Set(['0', 'no', 'n', 'false', 'f', 'off']);

export function parseBoolean(text: string): boolean | null {
  const lower = text.toLowerCase();
  if (BOOLEAN_TRUE.has(lower)) return true;
  if (BOOLEAN_FALSE.has(lower)) return false;
  return null;
}

function logicalLines(text: string): Array<{ readonly number: number; readonly text: string }> {
  const lines: Array<{ readonly number: number; readonly text: string }> = [];
  const physical = text.split('\n');
  for (let index = 0; index < physical.length; index++) {
    let joined = physical[index];
    const first = index + 1;
    while (joined.endsWith('\\') && index + 1 < physical.length) {
      index++;
      joined = `${joined.slice(0, -1)} ${physical[index]}`;
    }
    lines.push({ number: first, text: joined });
  }
  return lines;
}

function parseFile(path: string, text: string, spec: ConfigSpec, out: ConfigReadout): void {
  let section: string | null = null;
  let known = false;
  for (const { number, text: raw } of logicalLines(text)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    const where = `${path}:${number}`;
    if (line.startsWith('[')) {
      if (!line.endsWith(']')) {
        out.diagnostics.push(`${where}: Invalid section header '${line}'`);
        continue;
      }
      section = line.slice(1, -1);
      known = section in spec.sections;
      if (!known) out.diagnostics.push(`${where}: Unknown section '${section}'. Ignoring.`);
      continue;
    }
    if (section === null) {
      out.diagnostics.push(`${where}: Assignment outside of section. Ignoring.`);
      continue;
    }
    if (!known) continue;
    const equals = line.indexOf('=');
    if (equals < 0) {
      out.diagnostics.push(`${where}: Missing '=', ignoring line.`);
      continue;
    }
    const key = line.slice(0, equals).trim();
    const value = line.slice(equals + 1).trim();
    if (!spec.sections[section].includes(key)) {
      out.diagnostics.push(`${where}: Unknown key name '${key}' in section '${section}', ignoring.`);
      continue;
    }
    out.assignments.push({ file: path, line: number, section, key, value });
  }
}

export function readSystemdConfig(source: ConfigSource, spec: ConfigSpec): ConfigReadout {
  const readout: ConfigReadout = { assignments: [], diagnostics: [] };
  const main = source.readFile(spec.mainFile);
  if (main !== null) parseFile(spec.mainFile, main, spec, readout);
  const chosen = new Map<string, string>();
  for (const base of DROP_IN_DIRECTORIES) {
    const directory = `${base}/${spec.dropInName}`;
    for (const entry of source.listDirectory(directory) ?? []) {
      if (!entry.name.endsWith('.conf') || chosen.has(entry.name)) continue;
      chosen.set(entry.name, `${directory}/${entry.name}`);
    }
  }
  for (const name of [...chosen.keys()].sort()) {
    const path = chosen.get(name) as string;
    const text = source.readFile(path);
    if (text !== null) parseFile(path, text, spec, readout);
  }
  return readout;
}
