/**
 * DbId — Oracle database identifier value object.
 *
 * Combines the numeric DBID with the uppercase db_name. DEFAULT is the
 * simulator's canonical ORCL instance.
 */

export interface DbId {
  readonly _tag:  'DbId';
  readonly value: number;
  readonly name:  string;
}

export const DbId = {
  of(value: number, name: string): DbId {
    return Object.freeze({ _tag: 'DbId' as const, value, name: name.toUpperCase() });
  },
  DEFAULT: Object.freeze({ _tag: 'DbId' as const, value: 1234567890, name: 'ORCL' }) as DbId,
  toString: (d: DbId): string => `${d.name} (DBID=${d.value})`,
};
