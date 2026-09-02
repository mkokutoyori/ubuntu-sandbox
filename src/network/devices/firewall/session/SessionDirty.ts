export type SessionDirtyMode = 'check-all' | 'check-new' | 'check-policy-option';

export function isSessionDirtyMode(value: string): value is SessionDirtyMode {
  return value === 'check-all' || value === 'check-new'
    || value === 'check-policy-option';
}
