const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

function fnv1a32(input: string, seed: number = FNV_OFFSET_BASIS): number {
  let hash = seed >>> 0;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash >>> 0;
}

export function simulatedDigest(input: string): string {
  const h1 = fnv1a32(input);
  const h2 = fnv1a32(input, h1 || FNV_OFFSET_BASIS);
  const h3 = fnv1a32(`${h2}${input}`);
  const h4 = fnv1a32(`${h1}${input}${h2}`);
  return [h1, h2, h3, h4].map((h) => h.toString(16).padStart(8, '0')).join('');
}

export function simulatedKeyTag(input: string): number {
  return fnv1a32(input) & 0xffff;
}
