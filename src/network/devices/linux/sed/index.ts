import { tokenizeSed } from './SedLexer';
import { parseSed } from './SedParser';
import { runSedProgram, SedHost, SedResult } from './SedEngine';
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
  exitCode: number;
  error: string | null;
}

function backupName(path: string, suffix: string): string {
  if (!suffix.includes('*')) return `${path}${suffix}`;
  const slash = path.lastIndexOf('/');
  const directory = slash < 0 ? '' : path.slice(0, slash + 1);
  const base = slash < 0 ? path : path.slice(slash + 1);
  const name = suffix.replace(/\*/g, base);
  return name.includes('/') ? name : `${directory}${name}`;
}

export function runSed(options: RunSedOptions): RunSedOutput {
  const { argv, stdin, io } = options;
  const parsed = parseSedArguments(argv);
  if (parsed.kind === 'text') return { output: '', exitCode: parsed.exitCode, error: parsed.text };
  const { quiet, extended, separate, inPlace, backupSuffix } = parsed.line;
  const scriptParts: string[] = [];
  const files = [...parsed.line.operands];
  for (const script of parsed.line.scripts) {
    if (script.kind === 'text') { scriptParts.push(script.value); continue; }
    const text = io.readFile(script.value);
    if (text === null) return { output: '', exitCode: 1, error: `sed: couldn't open file ${script.value}: No such file or directory` };
    scriptParts.push(text);
  }
  if (scriptParts.length === 0) {
    const first = files.shift();
    if (first === undefined) return { output: '', exitCode: 1, error: SED_USAGE };
    scriptParts.push(first);
  }

  const script = scriptParts.join('\n');

  let program;
  try {
    program = parseSed(tokenizeSed(script), { extended });
  } catch (e) {
    if (e instanceof SedSyntaxError) return { output: '', exitCode: 2, error: e.message };
    throw e;
  }

  const host: SedHost = {
    readFile: (p) => io.readFile(p),
    appendFile: (p, content) => io.appendFile(p, content),
  };

  const runOne = (input: string): SedResult =>
    runSedProgram(program, input, { quiet, inputEndsNewline: input.endsWith('\n'), host });

  if (files.length === 0) {
    const r = runOne(stdin);
    return { output: r.output, exitCode: r.exitCode, error: null };
  }

  const unreadable: string[] = [];
  const readable = files.filter((f) => {
    if (io.readFile(f) !== null) return true;
    unreadable.push(`sed: can't read ${f}: No such file or directory`);
    return false;
  });
  const finish = (output: string, code: number): RunSedOutput => ({
    output: unreadable.map((line) => `${line}\n`).join('') + output,
    exitCode: unreadable.length > 0 && code === 0 ? 2 : code,
    error: null,
  });

  if (inPlace) {
    let code = 0;
    for (const f of readable) {
      const content = io.readFile(f) ?? '';
      const r = runOne(content);
      if (backupSuffix !== '') io.writeFile(backupName(f, backupSuffix), content);
      io.writeFile(f, r.output);
      if (r.exitCode) code = r.exitCode;
    }
    return finish('', code);
  }

  if (separate) {
    const outputs: string[] = [];
    let code = 0;
    for (const f of readable) {
      const r = runOne(io.readFile(f) ?? '');
      outputs.push(r.output);
      if (r.exitCode) code = r.exitCode;
    }
    return finish(outputs.join(''), code);
  }

  const combined = readable.map(f => io.readFile(f) ?? '').join('');
  const r = runOne(combined);
  return finish(r.output, r.exitCode);
}
