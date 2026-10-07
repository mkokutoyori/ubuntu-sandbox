export type RandomSource = (length: number) => Uint8Array;

export const systemRandom: RandomSource = (length) => globalThis.crypto.getRandomValues(new Uint8Array(length));
