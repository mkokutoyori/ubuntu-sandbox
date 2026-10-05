import { base64ToBytes, bytesToBase64 } from '@/crypto/encoding';
import { fileDigestHex, fileDigestName } from '@/crypto/hash';
import { cmdCertreq, type CertReqContext } from './WinCertReq';

export interface CertutilContext extends CertReqContext {
  readonly files: {
    read(path: string): string | null;
    write(path: string, content: string): boolean;
    normalize(path: string): string;
  };
  setExitCode(code: number): void;
}

const INVALID_PARAMETER = { code: 0x80070057, detail: 'WIN32: 87 ERROR_INVALID_PARAMETER', message: 'The parameter is incorrect.' };
const FILE_NOT_FOUND = { code: 0x80070002, detail: 'WIN32: 2 ERROR_FILE_NOT_FOUND', message: 'The system cannot find the file specified.' };
const BAD_ALGORITHM = { code: 0x80090008, detail: '-2146893816 NTE_BAD_ALGID', message: 'Invalid algorithm specified.' };
const INVALID_DATA = { code: 0x8007000d, detail: 'WIN32: 13 ERROR_INVALID_DATA', message: 'The data is invalid.' };

type Failure = typeof INVALID_PARAMETER;

const BEGIN = '-----BEGIN CERTIFICATE-----';
const END = '-----END CERTIFICATE-----';

function failed(ctx: CertutilContext, verb: string, failure: Failure): string {
  ctx.setExitCode(failure.code | 0);
  const hex = `0x${failure.code.toString(16)}`;
  return `CertUtil: -${verb} command FAILED: ${hex} (${failure.detail})\nCertUtil: ${failure.message}`;
}

function completed(ctx: CertutilContext, verb: string, lines: readonly string[]): string {
  ctx.setExitCode(0);
  return [...lines, `CertUtil: -${verb} command completed successfully.`].join('\n');
}

function hashFile(ctx: CertutilContext, args: readonly string[]): string {
  const [file, algorithm = 'SHA1', ...extra] = args;
  if (file === undefined || extra.length > 0) return failed(ctx, 'hashfile', INVALID_PARAMETER);
  const content = ctx.files.read(ctx.files.normalize(file));
  if (content === null) return failed(ctx, 'hashfile', FILE_NOT_FOUND);
  const digest = fileDigestName(algorithm);
  if (digest === null) return failed(ctx, 'hashfile', BAD_ALGORITHM);
  return completed(ctx, 'hashfile', [`${digest} hash of ${file}:`, fileDigestHex(digest, content)]);
}

function encodeFile(ctx: CertutilContext, args: readonly string[]): string {
  if (args.length !== 2) return failed(ctx, 'encode', INVALID_PARAMETER);
  const content = ctx.files.read(ctx.files.normalize(args[0]));
  if (content === null) return failed(ctx, 'encode', FILE_NOT_FOUND);
  const bytes = new TextEncoder().encode(content);
  const encoded = bytesToBase64(bytes);
  const body = encoded.match(/.{1,64}/g) ?? [];
  const output = `${[BEGIN, ...body, END].join('\r\n')}\r\n`;
  if (!ctx.files.write(ctx.files.normalize(args[1]), output)) return failed(ctx, 'encode', FILE_NOT_FOUND);
  return completed(ctx, 'encode', [`Input Length = ${bytes.length}`, `Output Length = ${output.length}`]);
}

function decodeFile(ctx: CertutilContext, args: readonly string[]): string {
  if (args.length !== 2) return failed(ctx, 'decode', INVALID_PARAMETER);
  const content = ctx.files.read(ctx.files.normalize(args[0]));
  if (content === null) return failed(ctx, 'decode', FILE_NOT_FOUND);
  const body = content.split(/\r?\n/).filter(line => line.trim() !== '' && !line.startsWith('-----')).join('');
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(body.replace(/\s+/g, ''));
  } catch {
    return failed(ctx, 'decode', INVALID_DATA);
  }
  if (!ctx.files.write(ctx.files.normalize(args[1]), new TextDecoder().decode(bytes))) return failed(ctx, 'decode', FILE_NOT_FOUND);
  return completed(ctx, 'decode', [`Input Length = ${content.length}`, `Output Length = ${bytes.length}`]);
}

export function cmdCertutil(ctx: CertutilContext, args: string[]): string {
  const verb = args[0]?.replace(/^[-/]/, '').toLowerCase();
  switch (verb) {
    case 'hashfile': return hashFile(ctx, args.slice(1));
    case 'encode': return encodeFile(ctx, args.slice(1));
    case 'decode': return decodeFile(ctx, args.slice(1));
    case 'submit': {
      ctx.setExitCode(0);
      return cmdCertreq(ctx, args);
    }
    default: return failed(ctx, verb ?? '?', INVALID_PARAMETER);
  }
}
