import { base64ToBytes, bytesToBase64, bytesToFileText, fileTextToBytes } from '@/crypto/encoding';
import { getoptDiagnostic, shortOptions, type LongOption } from '../commands/Getopt';
import { Streams, docsResult, quoteLocale, quotef, readFailureText, usageFailure, type CoreutilsIO, type CoreutilsRun } from './CoreutilsKit';

const LONG_OPTIONS: readonly LongOption[] = [
  { name: 'decode', letter: 'd', takesArgument: false },
  { name: 'ignore-garbage', letter: 'i', takesArgument: false },
  { name: 'wrap', letter: 'w', takesArgument: true },
  { name: 'help', letter: 'H', takesArgument: false },
  { name: 'version', letter: 'V', takesArgument: false },
];

const ALPHABET = /[A-Za-z0-9+/]/;

function decode(text: string, ignoreGarbage: boolean): { bytes: number[]; failed: boolean } {
  const out: number[] = [];
  let pending = '';
  let padding = 0;
  let failed = false;
  const flush = (): void => {
    if (pending.length === 0) return;
    const padded = pending.padEnd(4, 'A');
    const bytes = base64ToBytes(padded);
    const count = Math.floor((pending.length * 6) / 8);
    out.push(...Array.from(bytes).slice(0, count));
  };
  for (const ch of text) {
    if (ch === '\n') continue;
    if (ch === '=') { padding += 1; continue; }
    if (!ALPHABET.test(ch)) {
      if (ignoreGarbage) continue;
      failed = true;
      break;
    }
    if (padding > 0) { failed = true; break; }
    pending += ch;
    if (pending.length === 4) { flush(); pending = ''; }
  }
  if (!failed) {
    const needed = pending.length === 0 ? 0 : 4 - pending.length;
    if (pending.length === 1 || (pending.length > 0 && padding < needed) || (pending.length === 0 && padding > 0)) failed = true;
  }
  flush();
  return { bytes: out, failed };
}

export function runBase64(args: readonly string[], io: CoreutilsIO): CoreutilsRun {
  let decodeMode = false;
  let ignoreGarbage = false;
  let wrap = 76;
  const operands: string[] = [];
  const streams = new Streams();
  for (const item of shortOptions(args, 'diw:', LONG_OPTIONS)) {
    if (item.kind === 'operand') { operands.push(item.value); continue; }
    if (item.kind !== 'option') return usageFailure('base64', getoptDiagnostic('base64', item));
    switch (item.letter) {
      case 'H': return docsResult('base64', 'help');
      case 'V': return docsResult('base64', 'version');
      case 'd': decodeMode = true; break;
      case 'i': ignoreGarbage = true; break;
      case 'w': {
        const text = item.argument ?? '';
        if (!/^\d+$/.test(text)) {
          streams.diagnostic(`base64: invalid wrap size: ${quoteLocale(text)}`);
          streams.exitCode = 1;
          return streams.result();
        }
        wrap = Number(text);
        break;
      }
      default: break;
    }
  }
  if (operands.length > 1) return usageFailure('base64', `base64: extra operand ${quoteLocale(operands[1])}`);
  const name = operands[0] ?? '-';
  const read = name === '-' ? { kind: 'ok' as const, text: io.stdin ?? '' } : io.read(name);
  if (read.kind !== 'ok') {
    streams.diagnostic(`base64: ${quotef(name)}: ${readFailureText(read)}`);
    streams.exitCode = 1;
    return streams.result();
  }
  if (decodeMode) {
    const result = decode(read.text, ignoreGarbage);
    streams.stdout(bytesToFileText(Uint8Array.from(result.bytes)));
    if (result.failed) {
      streams.diagnostic('base64: invalid input');
      streams.exitCode = 1;
    }
    return streams.result();
  }
  const encoded = bytesToBase64(fileTextToBytes(read.text));
  if (encoded === '') return streams.result();
  if (wrap === 0) { streams.stdout(encoded); return streams.result(); }
  const lines: string[] = [];
  for (let at = 0; at < encoded.length; at += wrap) lines.push(encoded.slice(at, at + wrap));
  streams.stdout(`${lines.join('\n')}\n`);
  return streams.result();
}
