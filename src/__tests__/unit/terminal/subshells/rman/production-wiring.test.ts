/**
 * Production wiring — ReactiveRmanSubShell.create() participates in the
 * shared IEventBus, with an automatic logger actor.
 *
 * When a sub-shell is built for a real device:
 *   - the session forwards rman.* topics onto the shared bus
 *   - a RmanLoggerActor is bound for the session lifetime and emits
 *     `log` events into the project-wide logging pipeline
 *   - dispose() tears the actor down
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDefaultEventBus, __setDefaultEventBus, EventBus } from '@/events/EventBus';
import type { DomainEvent } from '@/events/types';
import { ReactiveRmanSubShell } from '@/terminal/subshells/rman';
import { removeOracleDatabase } from '@/terminal/commands/database';

function fakeDevice(id: string) {
  return {
    id,
    writeFileFromEditor: () => true,
    readFile: () => '',
    deleteFile: () => true,
  } as unknown as import('@/network').Equipment;
}

describe('ReactiveRmanSubShell — shared-bus wiring', () => {
  beforeEach(() => __setDefaultEventBus(new EventBus()));
  afterEach(() => {
    removeOracleDatabase('prod-A');
    removeOracleDatabase('prod-B');
    __setDefaultEventBus(null);
  });

  it('forwards rman.* events to the default shared bus', () => {
    const bus = getDefaultEventBus();
    const seen: DomainEvent[] = [];
    bus.subscribeAll(e => seen.push(e));

    const { subShell, banner } = ReactiveRmanSubShell.create(fakeDevice('prod-A'), ['target', '/']);
    expect(banner.length).toBeGreaterThan(0);

    subShell.processLine('BACKUP DATABASE');

    const rmanTopics = seen.map(e => e.topic).filter(t => t.startsWith('rman.'));
    expect(rmanTopics).toContain('rman.job.started');
    expect(rmanTopics).toContain('rman.job.completed');
    expect(rmanTopics).toContain('rman.backup.piece-created');

    subShell.dispose();
  });

  it('emits log events via the RmanLoggerActor', () => {
    const bus = getDefaultEventBus();
    const logs: DomainEvent[] = [];
    bus.subscribe('log', e => logs.push(e));

    const { subShell } = ReactiveRmanSubShell.create(fakeDevice('prod-A'), ['target', '/']);
    subShell.processLine('BACKUP DATABASE');

    const messages = logs.map(e => (e.payload as { message: string }).message);
    expect(messages.some(m => /BACKUP_DATABASE.*started/i.test(m))).toBe(true);
    expect(messages.some(m => /BACKUP_DATABASE.*completed/i.test(m))).toBe(true);

    subShell.dispose();
  });

  it('two concurrent sessions stay scoped by sessionId on the shared bus', () => {
    const bus = getDefaultEventBus();
    const seenByA: string[] = [];
    bus.subscribeWhere(
      'rman.job.completed',
      p => (p as { sessionId: string }).sessionId.includes('prod-A'),
      e => seenByA.push((e.payload as { jobId: string }).jobId),
    );

    const a = ReactiveRmanSubShell.create(fakeDevice('prod-A'), ['target', '/']);
    const b = ReactiveRmanSubShell.create(fakeDevice('prod-B'), ['target', '/']);

    a.subShell.processLine('BACKUP DATABASE');
    b.subShell.processLine('BACKUP DATABASE');
    b.subShell.processLine('BACKUP DATABASE');

    expect(seenByA.length).toBe(1);
    a.subShell.dispose();
    b.subShell.dispose();
  });

  it('dispose() unbinds the logger actor', () => {
    const bus = getDefaultEventBus();
    const logs: DomainEvent[] = [];
    bus.subscribe('log', e => logs.push(e));

    const { subShell } = ReactiveRmanSubShell.create(fakeDevice('prod-A'), ['target', '/']);
    subShell.processLine('BACKUP DATABASE');
    const before = logs.length;
    subShell.dispose();

    // Publishing a foreign rman event afterwards must not produce new logs
    // (we'd just confirm the actor stopped — easiest proxy: counter stable).
    bus.publish({
      topic: 'rman.job.completed',
      payload: { sessionId: 'unrelated', jobId: 'X', operation: 'BACKUP_DATABASE', elapsedMs: 1 },
    });
    expect(logs.length).toBe(before);
  });
});
