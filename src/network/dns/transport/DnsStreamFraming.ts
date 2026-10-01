export const DNS_STREAM_MAX_MESSAGE = 0xffff;

export function frameDnsMessage(message: Uint8Array): Uint8Array {
  if (message.length > DNS_STREAM_MAX_MESSAGE) {
    throw new RangeError(`DNS message of ${message.length} octets exceeds the 16-bit length prefix`);
  }
  const framed = new Uint8Array(message.length + 2);
  framed[0] = message.length >>> 8;
  framed[1] = message.length & 0xff;
  framed.set(message, 2);
  return framed;
}

export class DnsStreamReader {
  private pending = new Uint8Array(0);

  push(chunk: Uint8Array): Uint8Array[] {
    const merged = new Uint8Array(this.pending.length + chunk.length);
    merged.set(this.pending, 0);
    merged.set(chunk, this.pending.length);

    const messages: Uint8Array[] = [];
    let offset = 0;
    while (merged.length - offset >= 2) {
      const length = (merged[offset] << 8) | merged[offset + 1];
      if (merged.length - offset - 2 < length) break;
      messages.push(merged.slice(offset + 2, offset + 2 + length));
      offset += 2 + length;
    }
    this.pending = merged.slice(offset);
    return messages;
  }
}

export function unframeDnsMessage(bytes: Uint8Array): Uint8Array | null {
  const [first] = new DnsStreamReader().push(bytes);
  return first ?? null;
}
