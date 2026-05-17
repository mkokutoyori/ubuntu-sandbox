/**
 * RmanScriptParser + multi-line / RUN block accumulation in RmanSession.
 *
 * Per design doc §8.4:
 *   - Pure function: parseRmanScript(text) → ParsedLine[].
 *   - Strips `#` comments, blanks, semicolons.
 *   - Tracks RUN { ... } block depth.
 *
 * Per design doc DEF-RMAN-10/11:
 *   - processLine handles a trailing `;` for one-shot lines.
 *   - When the user types `RUN {` (or `RUN`), the session enters block
 *     mode: lines accumulate but don't execute until `}`.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { parseRmanScript } from '@/terminal/subshells/rman/commands/RmanScriptParser';
import {
  RmanSession, RmanSessionOptionsBuilder, DbId, BackupKey, ok,
  type IRmanOracleContext,
} from '@/terminal/subshells/rman';

function ctx(): IRmanOracleContext {
  return {
    dbId: DbId.DEFAULT, dbName: 'ORCL',
    vfs: {
      writeFile: () => ok(undefined), readFile: () => ok(new Uint8Array(0)),
      fileExists: () => true, deleteFile: () => ok(undefined),
      availableBytes: () => 1e10,
    },
    getDatafiles: () => [
      { fileNo: 1, path: '/u01/oradata/ORCL/system01.dbf', sizeBytes: 1, tablespace: 'SYSTEM' },
    ],
    getSpfileParam: () => undefined,
  };
}

describe('parseRmanScript', () => {
  it('classifies blank lines and comments', () => {
    const r = parseRmanScript('\n  \n# hello\n');
    expect(r.map(l => l.kind)).toEqual(['blank', 'blank', 'comment', 'blank']);
  });

  it('strips trailing semicolons from commands', () => {
    const r = parseRmanScript('BACKUP DATABASE;');
    expect(r[0].kind).toBe('command');
    if (r[0].kind === 'command') expect(r[0].text).toBe('BACKUP DATABASE');
  });

  it('tracks RUN { … } blocks', () => {
    const text = 'RUN {\n  BACKUP DATABASE;\n}\n';
    const r = parseRmanScript(text);
    expect(r.map(l => l.kind)).toEqual(['block_start', 'command', 'block_end', 'blank']);
  });

  it('treats a bare { / } as block delimiters', () => {
    const r = parseRmanScript('{\nBACKUP DATABASE;\n}\n');
    expect(r[0].kind).toBe('block_start');
    expect(r[2].kind).toBe('block_end');
  });

  it('numbers every line starting at 1', () => {
    const r = parseRmanScript('a\nb\nc');
    expect(r.map(l => l.lineNo)).toEqual([1, 2, 3]);
  });
});

describe('RmanSession — multi-line + RUN blocks', () => {
  beforeEach(() => BackupKey._reset());

  it('accepts a one-shot command terminated by ;', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), ctx());
    s.connect();
    const types: string[] = [];
    s.events$.subscribe(e => types.push(e.type));
    const r = s.processLine('BACKUP DATABASE;');
    expect(r.ok).toBe(true);
    expect(types).toContain('JOB_COMPLETED');
  });

  it('accumulates lines inside a RUN { ... } block until }', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), ctx());
    s.connect();
    const r1 = s.processLine('RUN {');
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.value).toEqual([]);

    const r2 = s.processLine('  BACKUP DATABASE;');
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.value).toEqual([]); // not executed yet

    const types: string[] = [];
    s.events$.subscribe(e => types.push(e.type));
    const r3 = s.processLine('}');
    expect(r3.ok).toBe(true);
    expect(types).toContain('JOB_COMPLETED');
  });

  it('rejects a } outside any block as a syntax error', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), ctx());
    s.connect();
    const r = s.processLine('}');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('RMAN_00558');
  });

  it('ignores comment-only and blank lines silently', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), ctx());
    s.connect();
    const r1 = s.processLine('# a comment');
    const r2 = s.processLine('   ');
    expect(r1.ok && r1.value).toEqual([]);
    expect(r2.ok && r2.value).toEqual([]);
  });

  it('inside a block, multiple BACKUP DATABASE; lines all execute on }', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), ctx());
    s.connect();
    s.processLine('RUN {');
    s.processLine('BACKUP DATABASE;');
    s.processLine('BACKUP DATABASE;');
    const types: string[] = [];
    s.events$.subscribe(e => types.push(e.type));
    s.processLine('}');
    const completed = types.filter(t => t === 'JOB_COMPLETED').length;
    expect(completed).toBe(2);
  });
});
