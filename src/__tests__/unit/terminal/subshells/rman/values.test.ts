/**
 * Value Objects — Scn, RmanTag, BackupKey, DbId.
 *
 * Each is immutable (Object.freeze) and constructed via named factories
 * that return Result<VO, RmanError> when validation can fail.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Scn } from '@/terminal/subshells/rman/values/Scn';
import { RmanTag } from '@/terminal/subshells/rman/values/RmanTag';
import { BackupKey } from '@/terminal/subshells/rman/values/BackupKey';
import { DbId } from '@/terminal/subshells/rman/values/DbId';

describe('Scn', () => {
  it('Scn.of(number) returns ok for a non-negative integer', () => {
    const r = Scn.of(1_892_354);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.value).toBe(1_892_354);
  });

  it('Scn.of(string) parses base-10 integers', () => {
    const r = Scn.of('1234567');
    expect(r.ok).toBe(true);
  });

  it('Scn.of(negative) returns err SCN_INVALID', () => {
    const r = Scn.of(-1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('SCN_INVALID');
  });

  it('Scn.of(NaN) returns err SCN_INVALID', () => {
    const r = Scn.of('not-a-number');
    expect(r.ok).toBe(false);
  });

  it('Scn comparisons', () => {
    const a = Scn.of(10);
    const b = Scn.of(20);
    if (a.ok && b.ok) {
      expect(Scn.gt(b.value, a.value)).toBe(true);
      expect(Scn.gte(a.value, a.value)).toBe(true);
    }
  });

  it('Scn.ZERO is a valid sentinel', () => {
    expect(Scn.ZERO.value).toBe(0);
    expect(Scn.toString(Scn.ZERO)).toBe('0');
  });

  it('Scn instances are frozen', () => {
    const r = Scn.of(1);
    if (r.ok) expect(Object.isFrozen(r.value)).toBe(true);
  });
});

describe('RmanTag', () => {
  it('generate produces TAG<yyyymmdd>T<hhmmss>', () => {
    const tag = RmanTag.generate(new Date('2026-05-06T14:30:22Z'));
    expect(tag.label).toMatch(/^TAG\d{8}T\d{6}$/);
  });

  it('of(label) normalises to uppercase', () => {
    expect(RmanTag.of('mytag').label).toBe('MYTAG');
  });

  it('tags are frozen', () => {
    expect(Object.isFrozen(RmanTag.of('x'))).toBe(true);
  });
});

describe('BackupKey', () => {
  beforeEach(() => { BackupKey._reset(); });

  it('next() returns monotonically increasing bsKey + bpKey', () => {
    const a = BackupKey.next();
    const b = BackupKey.next();
    expect(a.bsKey).toBe(1);
    expect(b.bsKey).toBe(2);
    expect(a.bpKey).toBe(1);
    expect(b.bpKey).toBe(2);
  });

  it('keys are frozen with copy=1', () => {
    const k = BackupKey.next();
    expect(Object.isFrozen(k)).toBe(true);
    expect(k.copy).toBe(1);
  });

  it('toString formats as BS:<n>/BP:<m>', () => {
    const k = BackupKey.next();
    expect(BackupKey.toString(k)).toMatch(/^BS:\d+\/BP:\d+$/);
  });
});

describe('DbId', () => {
  it('of(value, name) uppercases the name', () => {
    const id = DbId.of(42, 'orcl');
    expect(id.value).toBe(42);
    expect(id.name).toBe('ORCL');
  });

  it('DEFAULT is the Oracle simulation DBID', () => {
    expect(DbId.DEFAULT.value).toBe(1234567890);
    expect(DbId.DEFAULT.name).toBe('ORCL');
    expect(Object.isFrozen(DbId.DEFAULT)).toBe(true);
  });

  it('toString formats as NAME (DBID=value)', () => {
    expect(DbId.toString(DbId.DEFAULT)).toBe('ORCL (DBID=1234567890)');
  });
});
