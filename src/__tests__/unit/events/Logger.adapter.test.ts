import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Logger } from '@/network/core/Logger';
import { EventBus } from '@/events/EventBus';
import type { DomainEvent } from '@/events/types';

describe('Logger ↔ EventBus adapter (Phase 2)', () => {
  let bus: EventBus;
  let captured: DomainEvent[];

  beforeEach(() => {
    bus = new EventBus();
    captured = [];
    Logger.__setBus(bus);
    bus.subscribe('log', (e) => captured.push(e));
  });

  afterEach(() => {
    Logger.__setBus(null);
    Logger.reset();
  });

  it('publishes a log event on bus for every Logger.info call', () => {
    Logger.info('dev1', 'arp:request', 'who-has 10.0.0.1', { iface: 'eth0' });

    expect(captured).toHaveLength(1);
    expect(captured[0].topic).toBe('log');
    expect(captured[0].payload).toMatchObject({
      level: 'info',
      source: 'dev1',
      event: 'arp:request',
      message: 'who-has 10.0.0.1',
      data: { iface: 'eth0' },
    });
  });

  it('mirrors the four levels (debug/info/warn/error)', () => {
    Logger.debug('s', 'e', 'm');
    Logger.info('s', 'e', 'm');
    Logger.warn('s', 'e', 'm');
    Logger.error('s', 'e', 'm');

    expect(captured.map((e) => (e as DomainEvent & { topic: 'log' }).payload.level))
      .toEqual(['debug', 'info', 'warn', 'error']);
  });

  it('still notifies legacy subscribers with the correct filter behaviour', () => {
    const seen: string[] = [];
    const id = Logger.subscribe(
      (entry) => seen.push(entry.event),
      { source: 'dev2', event: 'frame:' },
    );

    Logger.info('dev1', 'frame:received', 'no');
    Logger.info('dev2', 'arp:reply', 'no');
    Logger.info('dev2', 'frame:received', 'yes');

    Logger.unsubscribe(id);

    expect(seen).toEqual(['frame:received']);
    // Bus mirror still received all three.
    expect(captured).toHaveLength(3);
  });

  it('keeps the in-memory log buffer working', () => {
    Logger.info('dev', 'evt', 'first');
    Logger.warn('dev', 'evt', 'second');

    const logs = Logger.getLogs();
    expect(logs).toHaveLength(2);
    expect(logs[0].message).toBe('first');
    expect(logs[1].level).toBe('warn');
  });

  it('does not stop on a misbehaving legacy subscriber', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    Logger.subscribe(() => { throw new Error('subscriber failure'); });
    const seen: string[] = [];
    Logger.subscribe((entry) => seen.push(entry.message));

    expect(() => Logger.info('s', 'e', 'still works')).not.toThrow();
    expect(seen).toContain('still works');
    spy.mockRestore();
  });
});
