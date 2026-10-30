import { ZlibError, deflateRawDecompress, gzipDecompress, zlibDecompress } from '@/network/rsyslog/Zlib';

export const ACCEPT_ENCODING_VALUE = 'deflate, gzip';
export const MAX_DECODED_BYTES = 16 * 1024 * 1024;

const MAX_CODINGS = 5;
const PROCESSING_FAILED = 'Error while processing content unencoding: ';

export type ContentCodingResult =
  | { readonly ok: true; readonly body: Uint8Array }
  | { readonly ok: false; readonly message: string };

type Decoder = (body: Uint8Array, limit: number) => Uint8Array;

function inflateDeflate(body: Uint8Array, limit: number): Uint8Array {
  try {
    return zlibDecompress(body, limit);
  } catch (error) {
    if (error instanceof ZlibError && error.message === 'inflated data exceeds limit') throw error;
    return deflateRawDecompress(body, limit);
  }
}

const DECODERS: ReadonlyMap<string, Decoder> = new Map<string, Decoder>([
  ['identity', (body) => body],
  ['none', (body) => body],
  ['deflate', inflateDeflate],
  ['gzip', gzipDecompress],
  ['x-gzip', gzipDecompress],
]);

function listedCodings(header: string): string[] {
  return header.split(',').map((name) => name.trim().toLowerCase()).filter((name) => name.length > 0);
}

export function decodeContentCodings(
  body: Uint8Array, header: string | undefined, limit = MAX_DECODED_BYTES,
): ContentCodingResult {
  if (header === undefined) return { ok: true, body };
  const names = listedCodings(header);
  if (names.length >= MAX_CODINGS) {
    return { ok: false, message: `Reject response due to more than ${MAX_CODINGS} content encodings` };
  }
  if (names.length === 0) return { ok: true, body };
  if (body.length === 0) return { ok: true, body };

  const decoders: Decoder[] = [];
  for (const name of names) {
    const decoder = DECODERS.get(name);
    if (decoder === undefined) {
      return {
        ok: false,
        message: `Unrecognized content encoding type. libcurl understands ${ACCEPT_ENCODING_VALUE} content encodings.`,
      };
    }
    decoders.push(decoder);
  }

  let current = body;
  try {
    for (let index = decoders.length - 1; index >= 0; index--) current = decoders[index](current, limit);
  } catch (error) {
    const reason = error instanceof ZlibError ? error.message : 'Unknown failure within decompression software.';
    return { ok: false, message: `${PROCESSING_FAILED}${reason}` };
  }
  return { ok: true, body: current };
}
