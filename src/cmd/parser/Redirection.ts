import { isCaretEscaped, readToken, skipSpaces } from './Scanner';

export interface RedirectionTarget {
  readonly path: string;
  readonly append: boolean;
}

export interface Redirections {
  readonly command: string;
  readonly stdout: RedirectionTarget | null;
  readonly stderr: RedirectionTarget | null;
  readonly stdin: string | null;
  readonly stderrToStdout: boolean;
  readonly stdoutToStderr: boolean;
}

export function isNullDevice(path: string): boolean {
  return /^nul$/i.test(path);
}

export function extractRedirections(text: string): Redirections {
  let command = '';
  let stdout: RedirectionTarget | null = null;
  let stderr: RedirectionTarget | null = null;
  let stdin: string | null = null;
  let stderrToStdout = false;
  let stdoutToStderr = false;
  let inQuote = false;
  let index = 0;

  while (index < text.length) {
    const character = text[index];
    if (character === '"') { inQuote = !inQuote; command += character; index++; continue; }
    if (inQuote || isCaretEscaped(text, index) || (character !== '>' && character !== '<' && !/\d/.test(character))) {
      command += character;
      index++;
      continue;
    }

    let handle = -1;
    let cursor = index;
    if (/\d/.test(character)) {
      const boundary = index === 0 || /\s/.test(text[index - 1]);
      const next = text[index + 1];
      if (!boundary || (next !== '>' && next !== '<')) { command += character; index++; continue; }
      handle = Number(character);
      cursor = index + 1;
    }
    const direction = text[cursor];
    if (direction === '<' && text[cursor + 1] === '<') {
      command += text.slice(index);
      index = text.length;
      continue;
    }
    const append = direction === '>' && text[cursor + 1] === '>';
    cursor += append ? 2 : 1;
    const duplicate = /^&(\d)/.exec(text.slice(cursor));
    if (duplicate && direction === '>') {
      if (handle === 2 && duplicate[1] === '1') stderrToStdout = true;
      else if ((handle === 1 || handle === -1) && duplicate[1] === '2') stdoutToStderr = true;
      index = cursor + duplicate[0].length;
      continue;
    }
    const targetStart = skipSpaces(text, cursor);
    const token = readToken(text, targetStart);
    const path = token.token.replace(/^"(.*)"$/, '$1');
    if (direction === '<') stdin = path;
    else if (handle === 2) stderr = { path, append };
    else stdout = { path, append };
    index = token.end;
  }

  return { command: command.replace(/\s+$/, ''), stdout, stderr, stdin, stderrToStdout, stdoutToStderr };
}
