/**
 * NameServiceSwitch — the resolver.
 *
 * Faithful re-implementation of the glibc NSS dispatch logic on top of
 * a pluggable {@link INssSource} list. The class:
 *
 *   1. Reads `/etc/nsswitch.conf` (or falls back) on each query so
 *      `echo "passwd: files" > /etc/nsswitch.conf` immediately changes
 *      behaviour — matches `getent` semantics.
 *   2. Walks the source list per the declaration, asking each source
 *      for the requested lookup.
 *   3. Honours the `[STATUS=action]` rules to decide whether to stop
 *      ("return"), keep searching ("continue"), or aggregate
 *      ("merge", used for hosts where multiple sources can contribute
 *      different A/AAAA answers).
 *   4. Subscribes to IAM / host events on the device's bus so caches —
 *      when introduced layer-side — can invalidate without polling.
 *
 * The resolver does *not* cache anything itself: the file source reads
 * the VFS each call (cheap), the DNS source walks the registry each
 * call. A future LRU layer can sit on top of this class and listen to
 * the {@link cacheInvalidated} signal exposed below.
 */

import type { IEventBus, Unsubscribe } from '@/events/EventBus';
import type { VirtualFileSystem } from '../VirtualFileSystem';
import type { INssSource } from './INssSource';
import {
  DEFAULT_NSSWITCH_CONF, FALLBACK_CONFIG, effectiveAction,
  parseNsswitchConf, sourcesFor,
} from './NssConfig';
import type {
  NssDatabaseConfig, NssEnumResult, NssResult, NssSourceSpec, NssStatus,
} from './types';

/**
 * Cache-invalidation signal — every IAM / host event that could change
 * a NSS answer pushes onto this signal. Future caching layers subscribe.
 *
 * Kept on the class so consumers can `nss.cacheInvalidated(...)` without
 * needing access to the bus types.
 */
export type CacheInvalidationListener = (database: string) => void;

export class NameServiceSwitch {
  /** Cache-invalidation listeners (downstream caches subscribe). */
  private readonly invalidationListeners = new Set<CacheInvalidationListener>();
  /** Disposable event-bus subscriptions, cleared on dispose(). */
  private readonly busSubscriptions: Unsubscribe[] = [];

  /**
   * @param vfs       VFS owning `/etc/nsswitch.conf`.
   * @param sources   Registered sources keyed by name. Provide the
   *                  `files` source at minimum; add `dns`, `systemd`,
   *                  `compat`, … as needed.
   * @param bus       Optional bus for reactive invalidation.
   * @param deviceId  When `bus` is provided, used to scope invalidation
   *                  to this device's IAM events.
   */
  constructor(
    private readonly vfs: VirtualFileSystem,
    private readonly sources: Map<string, INssSource>,
    private readonly bus: IEventBus | null = null,
    private readonly deviceId: string | null = null,
  ) {
    if (this.bus) this.wireBusInvalidation(this.bus);
  }

  // ─── Public API ─────────────────────────────────────────────────────

  /** Register a cache-invalidation listener. Returns an unsubscribe. */
  onCacheInvalidated(listener: CacheInvalidationListener): () => void {
    this.invalidationListeners.add(listener);
    return () => this.invalidationListeners.delete(listener);
  }

  /** Add or replace a source. Idempotent — last writer wins. */
  registerSource(source: INssSource): void {
    this.sources.set(source.name, source);
  }

  /** Remove a source. */
  unregisterSource(name: string): void {
    this.sources.delete(name);
  }

  /** Dispose bus subscriptions — call on device power-off / tear-down. */
  dispose(): void {
    for (const u of this.busSubscriptions) u();
    this.busSubscriptions.length = 0;
    this.invalidationListeners.clear();
  }

  // ─── Single-key dispatch ────────────────────────────────────────────

  /**
   * Run a single-key lookup against every source for `database`,
   * following the `[STATUS=action]` rules. Returns the first SUCCESS
   * stopped on by a `return` action (the default), or NOTFOUND if no
   * source ever succeeds.
   */
  lookup<T>(
    database: string,
    invoke: (source: INssSource) => NssResult<T> | undefined,
  ): NssResult<T> {
    const config = this.parsedConfig();
    const specs = sourcesFor(config, database);
    /**
     * Track the strongest negative answer we have observed. NOTFOUND
     * from a *registered* source beats UNAVAIL from a missing one
     * (glibc semantics: getent returns exit 2 "Key not found" as long
     * as at least one source said NOTFOUND, even if the next source
     * is unavailable).
     */
    let sawNotFound = false;
    let sawUnavail = false;

    for (const spec of specs) {
      const src = this.sources.get(spec.name);
      if (!src) {
        sawUnavail = true;
        const action = effectiveAction(spec, 'UNAVAIL');
        if (action === 'return') return { status: 'UNAVAIL' };
        continue;
      }

      const r = invoke(src);
      if (!r) {
        sawUnavail = true;
        const action = effectiveAction(spec, 'UNAVAIL');
        if (action === 'return') return { status: 'UNAVAIL' };
        continue;
      }

      if (r.status === 'NOTFOUND') sawNotFound = true;
      if (r.status === 'UNAVAIL')  sawUnavail = true;

      const action = effectiveAction(spec, r.status);
      if (r.status === 'SUCCESS' && action === 'return') return r;
      if (action === 'return') return r;
      // 'continue' / 'merge' → try next source. (We treat 'merge' as
      // continue for single-key lookups — it only meaningfully differs
      // for enumeration of hosts; see enumerate() below.)
    }

    if (sawNotFound) return { status: 'NOTFOUND' };
    if (sawUnavail)  return { status: 'UNAVAIL' };
    return { status: 'NOTFOUND' };
  }

  lookupVia<T>(
    sourceName: string,
    invoke: (source: INssSource) => NssResult<T> | undefined,
  ): NssResult<T> {
    const src = this.sources.get(sourceName);
    if (!src) return { status: 'UNAVAIL' };
    return invoke(src) ?? { status: 'UNAVAIL' };
  }

  enumerateVia<T>(
    sourceName: string,
    invoke: (source: INssSource) => NssEnumResult<T> | undefined,
  ): NssEnumResult<T> {
    const src = this.sources.get(sourceName);
    if (!src) return { status: 'UNAVAIL', entries: [] };
    return invoke(src) ?? { status: 'UNAVAIL', entries: [] };
  }

  /**
   * Run an enumeration against every source. Concatenates results in
   * declaration order. SUCCESS once at least one source returned
   * entries; NOTFOUND if all sources were silent.
   */
  enumerate<T>(
    database: string,
    invoke: (source: INssSource) => NssEnumResult<T> | undefined,
  ): NssEnumResult<T> {
    const config = this.parsedConfig();
    const specs = sourcesFor(config, database);
    const aggregate: T[] = [];
    let lastStatus: NssStatus = 'NOTFOUND';

    for (const spec of specs) {
      const src = this.sources.get(spec.name);
      if (!src) {
        lastStatus = 'UNAVAIL';
        const action = effectiveAction(spec, 'UNAVAIL');
        if (action === 'return' && aggregate.length === 0) {
          return { status: 'UNAVAIL', entries: [] };
        }
        continue;
      }

      const r = invoke(src);
      if (!r) {
        lastStatus = 'UNAVAIL';
        const action = effectiveAction(spec, 'UNAVAIL');
        if (action === 'return' && aggregate.length === 0) {
          return { status: 'UNAVAIL', entries: [] };
        }
        continue;
      }

      lastStatus = r.status;
      if (r.status === 'SUCCESS') {
        aggregate.push(...r.entries);
        const action = effectiveAction(spec, 'SUCCESS');
        if (action === 'return') return { status: 'SUCCESS', entries: aggregate };
        // 'continue' / 'merge' → keep accumulating.
      } else {
        const action = effectiveAction(spec, r.status);
        if (action === 'return' && aggregate.length === 0) return r;
      }
    }

    if (aggregate.length) return { status: 'SUCCESS', entries: aggregate };
    return { status: lastStatus, entries: [] };
  }

  // ─── Config materialisation ─────────────────────────────────────────

  /**
   * Parse the live `/etc/nsswitch.conf`. On a missing file, we still
   * return a parsed copy of `DEFAULT_NSSWITCH_CONF` — a fresh Ubuntu
   * always has the file, so this is the realistic happy path.
   */
  parsedConfig(): ReadonlyArray<NssDatabaseConfig> {
    const content = this.vfs.readFile('/etc/nsswitch.conf');
    if (!content) return [...FALLBACK_CONFIG];
    const parsed = parseNsswitchConf(content);
    return parsed.length ? parsed : [...FALLBACK_CONFIG];
  }

  /** Seed `/etc/nsswitch.conf` if it's missing — called from device boot. */
  seedConfigIfMissing(): void {
    if (this.vfs.readFile('/etc/nsswitch.conf') == null) {
      this.vfs.writeFile('/etc/nsswitch.conf', DEFAULT_NSSWITCH_CONF, 0, 0, 0o022);
    }
  }

  // ─── Reactive invalidation ──────────────────────────────────────────

  /**
   * Subscribe to IAM and host events so layered caches know when to
   * drop entries. We only forward to listeners — `NameServiceSwitch`
   * itself is stateless.
   *
   * The deviceId filter (when set) ensures a multi-host bus does not
   * cross-pollute invalidations.
   */
  private wireBusInvalidation(bus: IEventBus): void {
    const matches = (deviceId: string): boolean =>
      !this.deviceId || this.deviceId === deviceId;

    const fwd = (db: string) => {
      for (const l of this.invalidationListeners) l(db);
    };

    // ── IAM events ──────────────────────────────────────────────────
    this.busSubscriptions.push(bus.subscribe('linux.iam.user.created', (e) => {
      if (matches(e.payload.deviceId)) fwd('passwd');
    }));
    this.busSubscriptions.push(bus.subscribe('linux.iam.user.deleted', (e) => {
      if (matches(e.payload.deviceId)) fwd('passwd');
    }));
    this.busSubscriptions.push(bus.subscribe('linux.iam.user.modified', (e) => {
      if (matches(e.payload.deviceId)) fwd('passwd');
    }));
    this.busSubscriptions.push(bus.subscribe('linux.iam.user.password-changed', (e) => {
      if (matches(e.payload.deviceId)) fwd('shadow');
    }));
    this.busSubscriptions.push(bus.subscribe('linux.iam.user.lock-state-changed', (e) => {
      if (matches(e.payload.deviceId)) fwd('shadow');
    }));
    this.busSubscriptions.push(bus.subscribe('linux.iam.user.gecos-changed', (e) => {
      if (matches(e.payload.deviceId)) fwd('passwd');
    }));
    this.busSubscriptions.push(bus.subscribe('linux.iam.group.created', (e) => {
      if (matches(e.payload.deviceId)) fwd('group');
    }));
    this.busSubscriptions.push(bus.subscribe('linux.iam.group.deleted', (e) => {
      if (matches(e.payload.deviceId)) fwd('group');
    }));
    this.busSubscriptions.push(bus.subscribe('linux.iam.group.modified', (e) => {
      if (matches(e.payload.deviceId)) fwd('group');
    }));
    this.busSubscriptions.push(bus.subscribe('linux.iam.group.membership-changed', (e) => {
      if (matches(e.payload.deviceId)) fwd('group');
    }));

    // ── Host / topology events ─────────────────────────────────────
    // Power-cycles and IP changes invalidate the `dns` source's view.
    this.busSubscriptions.push(bus.subscribe('device.power-on', () => fwd('hosts')));
    this.busSubscriptions.push(bus.subscribe('device.power-off', () => fwd('hosts')));
    this.busSubscriptions.push(bus.subscribe('port.config.ip-changed', () => fwd('hosts')));
  }
}
