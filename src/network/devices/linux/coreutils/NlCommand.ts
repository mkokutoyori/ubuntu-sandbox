import { numberLines, parseNumbering } from '../commands/coreutils/NumberLines';
import { InputQueue, Streams, docsResult, quotef, readFailureText, usageFailure, type CoreutilsIO, type CoreutilsRun } from './CoreutilsKit';

function toLines(content: string): string[] {
  const lines = content.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function runNl(args: readonly string[], io: CoreutilsIO): CoreutilsRun {
  if (args.includes('--help')) return docsResult('nl', 'help');
  if (args.includes('--version')) return docsResult('nl', 'version');
  const parsed = parseNumbering(args);
  const streams = new Streams();
  if ('error' in parsed) {
    if (parsed.usage === true) return usageFailure('nl', parsed.error);
    streams.diagnostic(parsed.error);
    streams.exitCode = 1;
    return streams.result();
  }
  const queue = new InputQueue(io);
  const contents: string[] = [];
  for (const name of parsed.plan.files.length === 0 ? ['-'] : parsed.plan.files) {
    const read = queue.read(name);
    if (read.kind !== 'ok') {
      streams.diagnostic(`nl: ${quotef(name)}: ${readFailureText(read)}`);
      streams.exitCode = 1;
      continue;
    }
    contents.push(read.text);
  }
  const body = numberLines(parsed.plan, contents, toLines);
  const endsWithNewline = contents.some((content) => content.endsWith('\n'));
  streams.stdout(body + (body !== '' && endsWithNewline ? '\n' : ''));
  return streams.result();
}
