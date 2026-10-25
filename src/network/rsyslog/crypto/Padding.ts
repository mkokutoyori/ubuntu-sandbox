export function removeProviderPadding(buffer: Uint8Array): Uint8Array {
  let source = 0;
  while (source < buffer.length && buffer[source] === 0) source++;
  let destination = source;
  const out = Uint8Array.from(buffer);
  for (; source < buffer.length; source++) if (buffer[source] !== 0) out[destination++] = buffer[source];
  return out.subarray(0, destination);
}

export function removeToolPadding(buffer: Uint8Array): Uint8Array {
  const first = buffer.indexOf(0);
  if (first < 0) return buffer;
  const out = Uint8Array.from(buffer);
  let destination = first;
  for (let source = first; source < buffer.length; source++) if (buffer[source] !== 0) out[destination++] = buffer[source];
  return out.subarray(0, destination);
}
