/**
 * FTP (RFC 959 §3.4.2) — `MODE C`'s native compressed encoding. This is
 * not a general-purpose codec like gzip/DEFLATE (cf. `PRD-FTP-SFTP.md`
 * §2.2, which keeps that class of thing out of scope) — it's a small,
 * fully RFC-specified run-length scheme, simple enough to be bit-exact:
 * a one-byte descriptor precedes each segment. The top two bits select
 * the segment kind; the low six bits are a 0-63 count.
 *
 *   00cccccc          -> `cccccc` literal bytes follow verbatim
 *   01cccccc <byte>   -> the following byte, repeated `cccccc` times
 *   10cccccc          -> `cccccc` filler bytes (0x00), nothing follows
 *   11cccccc          -> reserved (RFC 959); rejected on decode
 *
 * Strings here are treated the same binary-transparent way the rest of
 * `network/ftp` treats file content (`FtpServerSession.ts`'s STOR/RETR):
 * one JS UTF-16 code unit per byte, 0-255.
 */

const enum Descriptor {
  Regular = 0b00,
  Replicated = 0b01,
  Filler = 0b10,
  Reserved = 0b11,
}

/** Low six bits of the descriptor byte: counts of 0-63 (RFC 959 §3.4.2). */
const MAX_COUNT = 63;
/** Below this run length, a literal encoding is at least as compact as descriptor+value. */
const MIN_RUN_FOR_REPLICATION = 3;

export function encodeCompressedMode(data: string): string {
  let out = '';
  let i = 0;
  const n = data.length;
  while (i < n) {
    const runLen = runLengthAt(data, i);
    if (runLen >= MIN_RUN_FOR_REPLICATION) {
      out += String.fromCharCode((Descriptor.Replicated << 6) | runLen);
      out += data[i];
      i += runLen;
      continue;
    }

    let literalLen = 0;
    let j = i;
    while (j < n && literalLen < MAX_COUNT && runLengthAt(data, j) < MIN_RUN_FOR_REPLICATION) {
      j++;
      literalLen++;
    }
    out += String.fromCharCode((Descriptor.Regular << 6) | literalLen);
    out += data.slice(i, i + literalLen);
    i += literalLen;
  }
  return out;
}

export function decodeCompressedMode(encoded: string): string | null {
  let out = '';
  let i = 0;
  const n = encoded.length;
  while (i < n) {
    const descriptor = encoded.charCodeAt(i);
    const type = (descriptor >> 6) & 0b11;
    const count = descriptor & 0b111111;
    i++;
    switch (type) {
      case Descriptor.Regular:
        if (i + count > n) return null;
        out += encoded.slice(i, i + count);
        i += count;
        break;
      case Descriptor.Replicated:
        if (i >= n) return null;
        out += encoded[i].repeat(count);
        i++;
        break;
      case Descriptor.Filler:
        out += '\x00'.repeat(count);
        break;
      default:
        return null;
    }
  }
  return out;
}

/** How many bytes starting at `i` share `data[i]`'s value, capped at `MAX_COUNT`. */
function runLengthAt(data: string, i: number): number {
  const ch = data.charCodeAt(i);
  let len = 1;
  while (i + len < data.length && data.charCodeAt(i + len) === ch && len < MAX_COUNT) len++;
  return len;
}
