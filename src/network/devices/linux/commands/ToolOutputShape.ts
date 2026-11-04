import type { ToolOutput } from '../kerberos/Krb5ToolOutput';

function trimmedFinalNewline(chunks: ToolOutput['chunks']): ToolOutput['chunks'] {
  const last = chunks[chunks.length - 1];
  if (last === undefined || !last.text.endsWith('\n')) return chunks;
  return [...chunks.slice(0, -1), { fd: last.fd, text: last.text.slice(0, -1) }];
}

export function commandResultOf(result: ToolOutput) {
  return {
    output: result.stdout.replace(/\n$/, ''),
    stderr: result.stderr.replace(/\n$/, ''),
    interleaved: result.combined.replace(/\n$/, ''),
    chunks: trimmedFinalNewline(result.chunks),
    exitCode: result.exitCode,
  };
}

export function completeLinesResultOf(result: ToolOutput) {
  return {
    output: result.stdout,
    ...(result.stderr === '' ? {} : { stderr: result.stderr, interleaved: result.combined, chunks: result.chunks }),
    exitCode: result.exitCode,
  };
}
