import { tokenizeSed } from './SedLexer';
import { parseSed } from './SedParser';
import { runSedProgram, sedWriteTargets, SedHost, SedInput, SedResult } from './SedEngine';
import { SedSyntaxError } from './SedAst';
import { parseSedArguments, SED_USAGE } from './SedOptions';

export type { SedHost } from './SedEngine';

export interface SedFileIO {
  readFile(path: string): string | null;
  writeFile(path: string, content: string): void;
  appendFile(path: string, content: string): void;
}

export interface RunSedOptions {
  argv: string[];
  stdin: string;
  io: SedFileIO;
}

export interface RunSedOutput {
  output: string;
  stderr: string;
  exitCode: number;
  error: string | null;
}

interface ScriptPart {
  readonly text: string;
  readonly start: number;
  readonly source: { readonly kind: 'expression'; readonly index: number } | { readonly kind: 'file'; readonly name: string };
}

function backupName(path: string, suffix: string): string {
  if (!suffix.includes('*')) return `${path}${suffix}`;
  const slash = path.lastIndexOf('/');
  const directory = slash < 0 ? '' : path.slice(0, slash + 1);
  const base = slash < 0 ? path : path.slice(slash + 1);
  const name = suffix.replace(/\*/g, base);
  return name.includes('/') ? name : `${directory}${name}`;
}

function describeSyntaxError(error: SedSyntaxError, parts: readonly ScriptPart[]): string {
  if (error.bare || error.position === null) return `sed: ${error.message}`;
  const locate = error.anchor ?? Math.max(0, error.position - 1);
  const part = [...parts].reverse().find((candidate) => candidate.start <= locate) ?? parts[0];
  const local = error.anchor !== null ? 0 : error.position - part.start;
  if (part.source.kind === 'file') {
    const line = part.text.slice(0, Math.max(0, local)).split('\n').length;
    return `sed: file ${part.source.name} line ${line}: ${error.message}`;
  }
  return `sed: -e expression #${part.source.index}, char ${local}: ${error.message}`;
}

export function runSed(options: RunSedOptions): RunSedOutput {
  const { argv, stdin, io } = options;
  const fail = (error: string, exitCode: number): RunSedOutput => ({ output: '', stderr: '', exitCode, error });
  const parsed = parseSedArguments(argv);
  if (parsed.kind === 'text') return fail(parsed.text, parsed.exitCode);
  const { extended, separate, inPlace, backupSuffix, nullData, sandbox, lineLength } = parsed.line;
  let quiet = parsed.line.quiet;
  const parts: ScriptPart[] = [];
  const files = [...parsed.line.operands];
  let offset = 0;
  let expressions = 0;
  const addPart = (text: string, source: ScriptPart['source']) => {
    parts.push({ text, start: offset, source });
    offset += text.length + 1;
  };
  for (const script of parsed.line.scripts) {
    if (script.kind === 'text') { addPart(script.value, { kind: 'expression', index: ++expressions }); continue; }
    const text = io.readFile(script.value);
    if (text === null) return fail(`sed: couldn't open file ${script.value}: No such file or directory`, 4);
    addPart(text.replace(/\n$/, ''), { kind: 'file', name: script.value });
  }
  if (parts.length === 0) {
    const first = files.shift();
    if (first === undefined) return fail(SED_USAGE, 1);
    addPart(first, { kind: 'expression', index: ++expressions });
  }

  const script = parts.map((part) => part.text).join('\n');
  if (parts[0].text.startsWith('#n')) quiet = true;

  let program;
  try {
    program = parseSed(tokenizeSed(script, { sandbox }), { extended });
  } catch (e) {
    if (e instanceof SedSyntaxError) return fail(describeSyntaxError(e, parts), e.exitCode);
    throw e;
  }

  for (const target of sedWriteTargets(program)) io.writeFile(target, '');

  const host: SedHost = {
    readFile: (p) => io.readFile(p),
    appendFile: (p, content) => io.appendFile(p, content),
  };

  const run = (inputs: readonly SedInput[]): SedResult =>
    runSedProgram(program, inputs, { quiet, host, nullData, lineWrap: lineLength ?? undefined });

  const done = (output: string, stderr: string, exitCode: number): RunSedOutput => ({ output, stderr, exitCode, error: null });

  if (files.length === 0) {
    const r = run([{ name: '-', text: stdin }]);
    return done(r.output, r.stderr, r.exitCode);
  }

  const unreadable: string[] = [];
  const readable = files.filter((f) => {
    if (io.readFile(f) !== null) return true;
    unreadable.push(`sed: can't read ${f}: No such file or directory\n`);
    return false;
  });
  const finish = (output: string, stderr: string, code: number): RunSedOutput =>
    done(output, unreadable.join('') + stderr, unreadable.length > 0 && code === 0 ? 2 : code);

  if (inPlace) {
    let code = 0;
    let stderr = '';
    for (const f of readable) {
      const content = io.readFile(f) ?? '';
      const r = run([{ name: f, text: content }]);
      if (backupSuffix !== '') io.writeFile(backupName(f, backupSuffix), content);
      io.writeFile(f, r.output);
      stderr += r.stderr;
      if (r.exitCode) code = r.exitCode;
    }
    return finish('', stderr, code);
  }

  if (separate) {
    let output = '';
    let stderr = '';
    let code = 0;
    for (const f of readable) {
      const r = run([{ name: f, text: io.readFile(f) ?? '' }]);
      output += r.output;
      stderr += r.stderr;
      if (r.exitCode) code = r.exitCode;
    }
    return finish(output, stderr, code);
  }

  const r = run(readable.map((f) => ({ name: f, text: io.readFile(f) ?? '' })));
  return finish(r.output, r.stderr, r.exitCode);
}

