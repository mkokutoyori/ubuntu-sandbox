export type YesNoAnswer = 'yes' | 'no' | 'all' | 'cancel';

export interface YesNoKey {
  readonly key: string;
  readonly ctrl?: boolean;
  readonly alt?: boolean;
}

export function yesNoAnswer(input: YesNoKey, withAll: boolean): YesNoAnswer | null {
  const key = input.key.toLowerCase();
  if (input.key === 'Escape' || (input.ctrl && key === 'c')) return 'cancel';
  if (input.ctrl) {
    if (key === 'n' || key === 'q') return 'no';
    if (key === 'y') return 'yes';
    return withAll && key === 'a' ? 'all' : null;
  }
  if (input.key.length !== 1) return null;
  if (key === 'y') return 'yes';
  if (key === 'n') return 'no';
  return withAll && key === 'a' ? 'all' : null;
}
