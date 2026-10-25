export function lz4DecompressBlock(source: Uint8Array, outputSize: number): Uint8Array | null {
  const output = new Uint8Array(outputSize);
  let read = 0;
  let written = 0;
  while (read < source.length) {
    const token = source[read++];
    let literals = token >> 4;
    if (literals === 15) {
      let extra: number;
      do {
        if (read >= source.length) return null;
        extra = source[read++];
        literals += extra;
      } while (extra === 255);
    }
    if (read + literals > source.length || written + literals > outputSize) return null;
    output.set(source.subarray(read, read + literals), written);
    read += literals;
    written += literals;
    if (read === source.length) break;
    if (read + 2 > source.length) return null;
    const offset = source[read] | (source[read + 1] << 8);
    read += 2;
    if (offset === 0 || offset > written) return null;
    let length = token & 15;
    if (length === 15) {
      let extra: number;
      do {
        if (read >= source.length) return null;
        extra = source[read++];
        length += extra;
      } while (extra === 255);
    }
    length += 4;
    if (written + length > outputSize) return null;
    for (let copied = 0; copied < length; copied++, written++) output[written] = output[written - offset];
  }
  return written === outputSize ? output : null;
}
