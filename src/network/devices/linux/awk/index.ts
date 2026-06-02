import { AwkParser } from './AwkParser';
import { AwkInterpreter, AwkHost, AwkInputRecord, AwkRuntimeError } from './AwkInterpreter';
import { AwkSyntaxError } from './AwkLexer';

export type { AwkHost } from './AwkInterpreter';

export interface AwkSource {
  filename: string;
  content: string;
}

export interface RunAwkOptions {
  program: string;
  fieldSep?: string;
  assignments?: Record<string, string>;
  sources: AwkSource[];
  host?: AwkHost | null;
}

export interface AwkFileWrite {
  path: string;
  content: string;
  append: boolean;
}

export interface RunAwkResult {
  output: string;
  error: string | null;
  exitCode: number;
  fileWrites: AwkFileWrite[];
}

export function runAwk(options: RunAwkOptions): RunAwkResult {
  let program;
  try {
    program = AwkParser.parse(options.program);
  } catch (e) {
    if (e instanceof AwkSyntaxError) return { output: '', error: e.message, exitCode: 2, fileWrites: [] };
    throw e;
  }

  const vars: Record<string, string> = { ...(options.assignments ?? {}) };
  if (options.fieldSep !== undefined) vars.FS = options.fieldSep;

  const records = buildRecords(options.sources);
  const interpreter = new AwkInterpreter(program, options.host ?? null, vars);

  try {
    const result = interpreter.run(records);
    const fileWrites: AwkFileWrite[] = [...result.files.entries()].map(([path, v]) => ({
      path, content: v.content, append: v.append,
    }));
    return { output: result.output, error: null, exitCode: result.exitCode, fileWrites };
  } catch (e) {
    if (e instanceof AwkRuntimeError) return { output: '', error: e.message, exitCode: 2, fileWrites: [] };
    if (e instanceof RangeError) return { output: '', error: 'awk: program nesting too deep', exitCode: 2, fileWrites: [] };
    throw e;
  }
}

function buildRecords(sources: AwkSource[]): AwkInputRecord[] {
  const records: AwkInputRecord[] = [];
  for (const src of sources) {
    const lines = src.content.split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    for (const line of lines) records.push({ text: line, filename: src.filename });
  }
  return records;
}
