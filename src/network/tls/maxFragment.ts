export const MAX_FRAGMENT_LENGTHS: readonly number[] = [512, 1024, 2048, 4096];

export const DEFAULT_MAX_FRAGMENT = 16384;

export function isValidMaxFragmentLength(value: number | undefined): value is number {
  return value !== undefined && MAX_FRAGMENT_LENGTHS.includes(value);
}
