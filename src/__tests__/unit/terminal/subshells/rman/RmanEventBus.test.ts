/**
 * RmanEventBus — typed sub-streams over a private RmanSubject<RmanEvent>.
 *
 * Validates that emit() reaches every typed stream (jobStarted$,
 * pieceCreated$, channelAllocated$, …) and only those whose discriminant
 * matches.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { RmanEventBus } from '@/terminal/subshells/rman/reactive/RmanEventBus';
import { BackupKey } from '@/terminal/subshells/rman/values/BackupKey';
import { RmanTag } from '@/terminal/subshells/rman/values/RmanTag';
import { Scn } from '@/terminal/subshells/rman/values/Scn';
import type { RmanEvent } from '@/terminal/subshells/rman/core/types';

describe('RmanEventBus', () => {
  let bus: RmanEventBus;
  beforeEach(() => { bus = new RmanEventBus(); BackupKey._reset(); });

  it('events$ receives every emission', () => {
    const seen: RmanEvent[] = [];
    bus.events$.subscribe(e => seen.push(e));
    bus.emit({ type: 'DISCONNECTED' });
    bus.emit({ type: 'JOB_STARTED', jobId: 'j1', operation: 'BACKUP_DATABASE', startedAt: 0 });
    expect(seen.length).toBe(2);
  });

  it('jobStarted$ only sees JOB_STARTED', () => {
    const seen: RmanEvent[] = [];
    bus.jobStarted$.subscribe(e => seen.push(e));
    bus.emit({ type: 'JOB_STARTED', jobId: 'j1', operation: 'BACKUP_DATABASE', startedAt: 0 });
    bus.emit({ type: 'DISCONNECTED' });
    expect(seen.length).toBe(1);
    expect(seen[0].type).toBe('JOB_STARTED');
  });

  it('channelAllocated$ filters by type', () => {
    const seen: RmanEvent[] = [];
    bus.channelAllocated$.subscribe(e => seen.push(e));
    bus.emit({ type: 'CHANNEL_ALLOCATED', channelId: 'ORA_DISK_1', sid: 100, deviceType: 'DISK' });
    bus.emit({ type: 'CHANNEL_RELEASED', channelId: 'ORA_DISK_1' });
    expect(seen.length).toBe(1);
  });

  it('pieceCreated$ exposes a typed payload', () => {
    const seen: Extract<RmanEvent, { type: 'BACKUP_PIECE_CREATED' }>[] = [];
    bus.pieceCreated$.subscribe(e => seen.push(e));
    const key = BackupKey.next();
    bus.emit({
      type: 'BACKUP_PIECE_CREATED', jobId: 'j', channelId: 'c',
      piece: { key, tag: RmanTag.of('T'), path: '/p', sizeBytes: 1, checkpointScn: Scn.ZERO },
    });
    expect(seen[0].piece.sizeBytes).toBe(1);
  });

  it('sessionState$ tracks transitions', () => {
    const seen: string[] = [];
    bus.sessionState$.subscribe(e => seen.push(`${e.from}→${e.to}`));
    bus.emit({ type: 'SESSION_STATE_CHANGED', from: 'IDLE', to: 'CONNECTED' });
    bus.emit({ type: 'SESSION_STATE_CHANGED', from: 'CONNECTED', to: 'RUNNING_JOB' });
    expect(seen).toEqual(['IDLE→CONNECTED', 'CONNECTED→RUNNING_JOB']);
  });

  it('dispose() blocks further emissions', () => {
    const seen: RmanEvent[] = [];
    bus.events$.subscribe(e => seen.push(e));
    bus.dispose();
    bus.emit({ type: 'DISCONNECTED' });
    expect(seen).toEqual([]);
  });
});
