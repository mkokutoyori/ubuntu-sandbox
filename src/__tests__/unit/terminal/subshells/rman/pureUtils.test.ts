/**
 * Pure utilities — formatElapsed, formatSize, formatOracleDate,
 * generatePieceName. All deterministic given their inputs (except
 * generatePieceName which uses Math.random and only its prefix is
 * asserted).
 */

import { describe, it, expect } from 'vitest';
import {
  formatElapsed,
  formatSize,
  generatePieceName,
  formatOracleDate,
} from '@/terminal/subshells/rman/core/pureUtils';
import { RmanTag } from '@/terminal/subshells/rman/values/RmanTag';

describe('formatElapsed(ms) → HH:MM:SS', () => {
  it('formats 0ms as 00:00:00', () => expect(formatElapsed(0)).toBe('00:00:00'));
  it('formats 15s', () => expect(formatElapsed(15_000)).toBe('00:00:15'));
  it('formats 1h2m3s', () => expect(formatElapsed(3_723_000)).toBe('01:02:03'));
  it('pads single digits', () => expect(formatElapsed(65_000)).toBe('00:01:05'));
});

describe('formatSize(bytes)', () => {
  it('returns "B" under 1KB', () => expect(formatSize(500)).toBe('500B'));
  it('returns "K" suffix between 1KB and 1MB', () => expect(formatSize(2048)).toBe('2.00K'));
  it('returns "M" suffix between 1MB and 1GB', () => expect(formatSize(5 * 1_048_576)).toBe('5.00M'));
  it('returns "G" suffix above 1GB', () => expect(formatSize(2 * 1_073_741_824)).toBe('2.00G'));
});

describe('formatOracleDate', () => {
  it('formats DD-MON-YYYY HH:MM:SS in upper-case month', () => {
    const s = formatOracleDate(new Date(2026, 4, 6, 14, 30, 22));
    expect(s).toBe('06-MAY-2026 14:30:22');
  });
});

describe('generatePieceName', () => {
  it('names an OMF backup piece under the recovery file destination', () => {
    const tag = RmanTag.of('TAG20260506T143022');
    const name = generatePieceName(
      'ORCL', tag, '/u01/app/oracle/fast_recovery_area',
      'datafile-full', new Date(2026, 4, 6, 14, 30, 22));
    expect(name).toMatch(
      /^\/u01\/app\/oracle\/fast_recovery_area\/ORCL\/backupset\/2026_05_06\/o1_mf_nnndf_TAG20260506T143022_[a-z0-9]{8}_\.bkp$/);
  });

  it('carries the OMF type code of the backup kind', () => {
    const tag = RmanTag.of('T');
    const at = new Date(2026, 4, 6);
    const piece = (kind: Parameters<typeof generatePieceName>[3]) =>
      generatePieceName('ORCL', tag, '/fra', kind, at);
    expect(piece('datafile-incremental-0')).toContain('/o1_mf_nnnd0_T_');
    expect(piece('datafile-incremental-1')).toContain('/o1_mf_nnnd1_T_');
    expect(piece('archivelog')).toContain('/o1_mf_annnn_T_');
    expect(piece('controlfile-spfile')).toContain('/o1_mf_ncsnf_T_');
    expect(piece('autobackup')).toContain('/ORCL/autobackup/2026_05_06/o1_mf_s_T_');
  });
});
