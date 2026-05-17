/**
 * ReactiveChannelPool — N-channel pool with per-config parallelism.
 *
 * Allocates the first config slot with `busyCount < parallelism`,
 * naming channels `${cfg.id}_${idx}`. Emits CHANNEL_ALLOCATED /
 * CHANNEL_RELEASED on dedicated subjects exposed as observables.
 */

import { RmanSubject, type RmanObservable } from '../reactive/RmanSubject';
import { ok, err, type Result } from '../core/Result';
import type { RmanError } from '../core/RmanError';
import type { IChannelPool } from './IChannelPool';
import type { ChannelConfig, ChannelHandle, ChannelState, ChannelStats } from './types';
import type { RmanEvent } from '../core/types';

export class ReactiveChannelPool implements IChannelPool {
  private readonly _handles = new Map<string, { handle: ChannelHandle; state: ChannelState }>();
  private _sidCounter = 100;

  private readonly _alloc$ = new RmanSubject<Extract<RmanEvent, { type: 'CHANNEL_ALLOCATED' }>>();
  private readonly _rel$   = new RmanSubject<Extract<RmanEvent, { type: 'CHANNEL_RELEASED' }>>();

  readonly allocations$: RmanObservable<Extract<RmanEvent, { type: 'CHANNEL_ALLOCATED' }>>
    = this._alloc$.asObservable();
  readonly releases$: RmanObservable<Extract<RmanEvent, { type: 'CHANNEL_RELEASED' }>>
    = this._rel$.asObservable();

  private _stats: ChannelStats = { totalAllocated: 0, totalReleased: 0, currentBusy: 0, errors: 0 };

  constructor(private readonly _configs: ReadonlyArray<ChannelConfig>) {}

  allocate(alias?: string): Result<ChannelHandle, RmanError> {
    for (const cfg of this._configs) {
      const busyCount = [...this._handles.values()]
        .filter(e => e.handle.id.startsWith(cfg.id + '_') && e.state === 'BUSY').length;

      if (busyCount < cfg.parallelism) {
        const idx = busyCount + 1;
        const id = alias ?? `${cfg.id}_${idx}`;
        const sid = this._sidCounter++;
        const handle: ChannelHandle = Object.freeze({
          id, deviceType: cfg.deviceType, sid, allocatedAt: Date.now(),
        });
        this._handles.set(id, { handle, state: 'BUSY' });
        this._stats = {
          ...this._stats,
          totalAllocated: this._stats.totalAllocated + 1,
          currentBusy:    this._stats.currentBusy + 1,
        };
        this._alloc$.next({ type: 'CHANNEL_ALLOCATED', channelId: id, sid, deviceType: cfg.deviceType });
        return ok(handle);
      }
    }
    return err({ code: 'NO_CHANNEL_AVAILABLE', message: 'All channels are busy' });
  }

  release(handle: ChannelHandle): Result<void, RmanError> {
    const entry = this._handles.get(handle.id);
    if (!entry) return ok(undefined); // idempotent
    entry.state = 'RELEASED';
    this._handles.delete(handle.id);
    this._stats = {
      ...this._stats,
      totalReleased: this._stats.totalReleased + 1,
      currentBusy:   Math.max(0, this._stats.currentBusy - 1),
    };
    this._rel$.next({ type: 'CHANNEL_RELEASED', channelId: handle.id });
    return ok(undefined);
  }

  getStats(): ChannelStats { return this._stats; }

  dispose(): void {
    this._alloc$.complete();
    this._rel$.complete();
    this._handles.clear();
  }
}
