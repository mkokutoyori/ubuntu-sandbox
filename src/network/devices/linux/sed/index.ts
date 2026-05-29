import { tokenizeSed } from './SedLexer';
import { parseSed } from './SedParser';
import { runSedProgram, SedHost, SedResult } from './SedEngine';
import { SedSyntaxError } from './SedAst';

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

export function runSed(options: RunSedOptions): RunSedOutput {
  const { argv, stdin, io } = options;
  let quiet = false;
  let extended = false;
  let inPlace = false;
  let separate = false;
  const scriptParts: string[] = [];
  const files: string[] = [];
  let scriptTaken = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { for (let j = i + 1; j < argv.length; j++) files.push(argv[j]); break; }
    if (a === '-n' || a === '--quiet' || a === '--silent') { quiet = true; continue; }
    if (a === '-E' || a === '-r' || a === '--regexp-extended') { extended = true; continue; }
    if (a === '-s' || a === '--separate') { separate = true; continue; }
    if (a === '-z' || a === '--null-data' || a === '--posix') { continue; }
    if (a === '-e' || a === '--expression') { scriptParts.push(argv[++i] ?? ''); scriptTaken = true; continue; }
    if (a.startsWith('-e')) { scriptParts.push(a.slice(2)); scriptTaken = true; continue; }
    if (a === '-f' || a === '--file') { scriptParts.push(io.readFile(argv[++i] ?? '') ?? ''); scriptTaken = true; continue; }
    if (a.startsWith('-f')) { scriptParts.push(io.readFile(a.slice(2)) ?? ''); scriptTaken = true; continue; }
    if (a === '-i' || a === '--in-place' || a.startsWith('-i') || a.startsWith('--in-place')) { inPlace = true; continue; }
    if (a.startsWith('-') && a.length > 1) {
      // bundled short flags like -ne, -nE
      let recognized = true;
      for (const f of a.slice(1)) {
        if (f === 'n') quiet = true;
        else if (f === 'E' || f === 'r') extended = true;
        else if (f === 's') separate = true;
        else { recognized = false; break; }
      }
      if (recognized) continue;
    }
    if (!scriptTaken) { scriptParts.push(a); scriptTaken = true; continue; }
    files.push(a);
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

  if (inPlace) {
    let code = 0;
    for (const f of files) {
      const content = io.readFile(f) ?? '';
      const r = runOne(content);
      io.writeFile(f, r.output);
      if (r.exitCode) code = r.exitCode;
    }
    return { output: '', exitCode: code, error: null };
  }

  if (separate) {
    const outputs: string[] = [];
    let code = 0;
    for (const f of files) {
      const r = runOne(io.readFile(f) ?? '');
      outputs.push(r.output);
      if (r.exitCode) code = r.exitCode;
    }
    return { output: outputs.join(''), exitCode: code, error: null };
  }

  // Default: concatenate all files into a single stream.
  const combined = files.map(f => io.readFile(f) ?? '').join('');
  const r = runOne(combined);
  return { output: r.output, exitCode: r.exitCode, error: null };
}
