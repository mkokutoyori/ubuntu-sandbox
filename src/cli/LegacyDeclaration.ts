import type { CommandSpec } from './CommandTable';

export type LegacyAction = (args: string[], rawLine: string) => string;

export interface LegacyOptions {
  readonly modes: readonly string[];
  readonly minPrivilege: number;
}

export function legacySpec(
  path: string, description: string, action: LegacyAction, options: LegacyOptions,
): CommandSpec {
  const keywords = path.trim().split(/\s+/).filter(Boolean);

  return {
    id: keywords.join('-'),
    path: [...keywords, { name: 'rest', type: 'REST' as const, optional: true }],
    description,
    modes: options.modes,
    minPrivilege: options.minPrivilege,
    run: (_session, args) => {
      const tail = (args.rest ?? '').trim();
      const positional = tail.length === 0 ? [] : tail.split(/\s+/);
      return action(positional, [path, tail].filter(Boolean).join(' '));
    },
  };
}

export function legacyFamily(
  rows: ReadonlyArray<readonly [string, string, LegacyAction]>,
  options: LegacyOptions,
): CommandSpec[] {
  return rows.map(([path, description, action]) =>
    legacySpec(path, description, action, options));
}
