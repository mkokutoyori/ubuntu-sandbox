import type { ICompletionSource } from './types';

export function ghostRemainder(input: string, source: ICompletionSource): string | null {
  if (input.trim().length === 0) return null;
  const found = source.query({ line: input });
  if (found === null || found.candidates.length !== 1) return null;
  const completed = found.base + (found.candidates[0] ?? '');
  if (completed.length <= input.length) return null;
  if (!completed.toLowerCase().startsWith(input.toLowerCase())) return null;
  return completed.slice(input.length);
}
