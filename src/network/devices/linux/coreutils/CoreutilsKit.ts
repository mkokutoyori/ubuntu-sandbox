import { bytesToFileText, fileTextToBytes } from '@/crypto/encoding';
import { COREUTILS_DOCS } from './CoreutilsDocs';

export interface CoreutilsRun {
  readonly stdout: string;
  readonly stderr: string;
  readonly interleaved: string;
  readonly exitCode: number;
}

export type FileRead =
  | { readonly kind: 'ok'; readonly text: string }
  | { readonly kind: 'missing' }
  | { readonly kind: 'directory' }
  | { readonly kind: 'denied' }
  | { readonly kind: 'loop' };

export interface CoreutilsIO {
  readonly stdin: string | undefined;
  read(name: string): FileRead;
  readBytes?(name: string, count: number): string | null;
  write?(name: string, text: string): boolean;
}

export class Streams {
  private out = '';
  private err = '';
  private both = '';
  exitCode = 0;

  stdout(text: string): void {
    this.out += text;
    this.both += text;
  }

  stderr(text: string): void {
    this.err += text;
    this.both += text;
  }

  diagnostic(line: string): void {
    this.stderr(`${line}\n`);
  }

  result(): CoreutilsRun {
    return { stdout: this.out, stderr: this.err, interleaved: this.both, exitCode: this.exitCode };
  }
}

export function readFailureText(read: FileRead): string {
  switch (read.kind) {
    case 'directory': return 'Is a directory';
    case 'denied': return 'Permission denied';
    case 'loop': return 'Too many levels of symbolic links';
    default: return 'No such file or directory';
  }
}

export function usageFailure(program: string, line: string | null): CoreutilsRun {
  const streams = new Streams();
  if (line !== null) streams.diagnostic(line);
  streams.diagnostic(`Try '${program} --help' for more information.`);
  streams.exitCode = 1;
  return streams.result();
}

export function docsResult(program: string, which: 'help' | 'version'): CoreutilsRun {
  const streams = new Streams();
  streams.stdout(`${COREUTILS_DOCS[program][which]}\n`);
  return streams.result();
}

export function asDispatch(run: CoreutilsRun): { output: string; exitCode: number; stderr?: string; interleaved?: string } {
  if (run.stderr === '') return { output: run.stdout, exitCode: run.exitCode };
  return { output: run.stdout, exitCode: run.exitCode, stderr: run.stderr, interleaved: run.interleaved };
}

let curlyQuotes = true;

export function useLocaleQuotes(locale: string): void {
  curlyQuotes = /utf-?8/i.test(locale);
}

export const quoteLocale = (text: string): string => (curlyQuotes ? `‘${text}’` : `'${text}'`);
export const quoteShell = (text: string): string => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(text) ? `'${text}'` : `'${text.replace(/'/g, `'\\''`)}'`);

export const quotef = (text: string): string => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`);

const SUFFIX_FACTORS: Readonly<Record<string, number>> = {
  b: 512, kB: 1000, KB: 1000, k: 1024, K: 1024, KiB: 1024, MB: 1000 ** 2, M: 1024 ** 2, MiB: 1024 ** 2, GB: 1000 ** 3, G: 1024 ** 3, GiB: 1024 ** 3,
  TB: 1000 ** 4, T: 1024 ** 4, TiB: 1024 ** 4, PB: 1000 ** 5, P: 1024 ** 5, PiB: 1024 ** 5, EB: 1000 ** 6, E: 1024 ** 6, EiB: 1024 ** 6,
  ZB: 1000 ** 7, Z: 1024 ** 7, ZiB: 1024 ** 7, YB: 1000 ** 8, Y: 1024 ** 8, YiB: 1024 ** 8,
};

export function parseSizeWithSuffix(text: string): number | null {
  const match = /^(\d+)([A-Za-z]*)$/.exec(text);
  if (match === null) return null;
  if (match[2] === '') return Number(match[1]);
  const factor = SUFFIX_FACTORS[match[2]];
  return factor === undefined ? null : Number(match[1]) * factor;
}

export function toBytes(text: string): Buffer {
  return Buffer.from(fileTextToBytes(text));
}

export function fromBytes(bytes: Uint8Array): string {
  return bytesToFileText(bytes);
}

export function utf8Bytes(text: string): number {
  return fileTextToBytes(text).length;
}

export function takeBytes(text: string, count: number, fromEnd = false): string {
  const buffer = toBytes(text);
  return fromBytes(fromEnd ? buffer.subarray(Math.max(0, buffer.length - count)) : buffer.subarray(0, count));
}
